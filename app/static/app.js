/* Trip Tracker web UI. All fetches are RELATIVE ("api/...") so HA ingress's path prefix is honoured.
   Two map engines share one data model:
     - Leaflet  → CARTO Voyager (vector) + Esri raster basemaps
     - native Google Maps JS → the Google basemaps (so Google's own controls work and overlays render)
   Everything (track, photo dots, locate, docked photo viewer, fullscreen) works on whichever engine is active. */
"use strict";

const API = "api";
const GOOGLE_TYPES = { g_roadmap: "roadmap", g_satellite: "satellite", g_hybrid: "hybrid", g_terrain: "terrain" };
const DOT_CUR = "#ffd400", DOT_REST = "#c9d1d9";   // photo dots on the track: current = yellow, others = light grey

let cfg = null;
let isAdmin = true;
let engine = "leaflet";          // "leaflet" | "google"
let lmap = null, gmap = null;    // Leaflet map, native Google map
let baseLayers = {};             // Leaflet base layers
let lTrackLayer = null, lPhotoLayer = null, lHead = null, lSpeedLayer = null, lSpeedCanvas = null;
let gTrackSegs = [], gMarkers = [], gHead = null;
let gInfo = null;                // reused Google InfoWindow for track-point popups
let suppressMapClick = false;    // set by a track click so it doesn't also collapse the panel
let currentBaseKey = null;

let activeTripId = null, centeredTripId = null, focusId = null;
let latestTripId = null;         // most-recent trip (first in the started_at-desc list) → initial pick when none live
let autoFollowLive = true;       // keep showing the live trip as it appears/changes, until the user picks one
// Multiple trips can be shown at once. Each selected trip is a "view": its own points/photos/colour.
//   { id, color, meta:{mode,interval_s,min_distance_m}, pts:[{lat,lon,ts,id,speed}], latlngs:[], ts:[],
//     lastPointId, lastPhotoId, photos:[], latestSpeed, latestSpeedTs }
let views = new Map();                  // tripId → view
let tripsById = {};                     // id → trip record (name/mode/interval/min_distance/color)
const DEFAULT_COLOR = "#1565c0";
let photos = [];                 // AGGREGATE of all selected trips' photos (for the viewer); {asset,ts,lat,lon,…,_lmarker,_gmarker}
let photoSorted = [], curPhoto = -1, fsOpen = false;
let pvZoom = null, lbZoom = null;      // image zoom/pan controllers (docked viewer + fullscreen overlay)
const imgCache = new Map();            // url → preloaded <img>, kept so the browser retains the decoded bitmap (LRU)
const IMG_CACHE_MAX = 36;              // bounds decoded-bitmap memory; evicted items still reload instant from HTTP cache
let followMode = false;          // locate button ON → keep re-centring on the head; a user drag turns it OFF
let spacingPrefillId = null;     // active trip id whose spacing we've prefilled into the controls
let tickN = 0;                   // tick counter → throttle the trips-list refresh
let speedColorOn = false;        // "Colour track by speed" switch (per-browser, everyone)

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const preview = (a) => `${API}/photo/${encodeURIComponent(a)}/preview`;
const thumb = (a) => `${API}/photo/${encodeURIComponent(a)}/thumbnail`;
const original = (a) => `${API}/photo/${encodeURIComponent(a)}/original`;
const video = (a) => `${API}/photo/${encodeURIComponent(a)}/video`;

async function jget(u) { const r = await fetch(u); return r.json(); }
async function jpost(u, b) {
  const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return r.json();
}
async function jdel(u) { const r = await fetch(u, { method: "DELETE" }); return r.json(); }

// ----------------------------------------------------------------------------- init
async function init() {
  const st = await jget(`${API}/state`);
  cfg = st.config;
  isAdmin = st.admin !== false;
  document.body.classList.toggle("viewer", !isAdmin);
  initCollapse();   // decide panel collapsed/expanded BEFORE creating the map so it gets the right size
  applyLayout();    // set portrait/landscape BEFORE creating the map so it's sized right from the start
  speedColorOn = false;   // always start with "Colour track by speed" OFF on a fresh load (not remembered)

  lmap = L.map("map", { zoomControl: false }).setView([cfg.map.lat, cfg.map.lon], cfg.map.zoom);
  L.control.zoom({ position: "topright" }).addTo(lmap);   // top-left is kept clear for the panel-show button
  try { L.Icon.Default.imagePath = "static/vendor/images/"; } catch (e) {}
  baseLayers = {
    carto: L.maplibreGL({
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }),
    streets: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Map © Esri, © OpenStreetMap contributors" }),
    topo: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Map © Esri" }),
    sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery © Esri" }),
  };
  lTrackLayer = L.layerGroup().addTo(lmap);                  // holds every selected trip's coloured polyline(s)
  lSpeedCanvas = L.canvas({ padding: 0.5 });                 // canvas renderer handles many gradient polylines
  lSpeedLayer = L.layerGroup().addTo(lmap);                  // holds the per-speed coloured polylines
  lPhotoLayer = L.layerGroup().addTo(lmap);
  lmap.addControl(new (L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      const a = L.DomUtil.create("a", "tt-locate");
      a.href = "#"; a.title = "Center on current location"; a.innerHTML = locateSvg();
      L.DomEvent.on(a, "click", L.DomEvent.stop).on(a, "click", locateTraveler);
      return a;
    },
  }))());
  lmap.on("dragstart", onUserDrag);
  lmap.on("click", collapseIfShown);
  lmap.on("zoomend", () => { if (views.size) renderTracks(); });   // re-trim the head (pixel-based) on zoom

  addBaseOptions();
  // Admin: own per-browser choice (default Google Roadmap). Viewer: always the admin's last choice.
  let initBase;
  if (isAdmin) { try { initBase = localStorage.getItem("tt_basemap"); } catch (e) {} initBase = initBase || "g_roadmap"; }
  else { initBase = st.admin_basemap || "g_roadmap"; }
  if (GOOGLE_TYPES[initBase] && !cfg.google_key) initBase = "carto";
  setBasemap(initBase);

  wireUI();
  wireTabs();
  await refreshTrips();
  // On open: the live trip if there is one, else the most recent trip.
  activeTripId = st.active ? st.trip.id : null;   // set BEFORE the first render so the live trip gets its head
  if (st.active) await setOnlyTrip(st.trip.id, true);
  else if (latestTripId != null) await setOnlyTrip(latestTripId, true);
  updateActiveBox(st);
  updateSpeedOverlay();
  setInterval(tick, 4000);
  setInterval(updateSpeedOverlay, 1000);   // keep the speed pill's staleness fade/age moving between ticks
  [150, 400, 900].forEach((d) => setTimeout(() => { applyLayout(); resizeActive(); }, d));
  window.addEventListener("resize", () => setTimeout(() => { applyLayout(); resizeActive(); }, 100));
  window.addEventListener("orientationchange", () => setTimeout(() => { applyLayout(); resizeActive(); }, 300));
  try { if (window.screen && window.screen.orientation) window.screen.orientation.addEventListener("change", () => setTimeout(() => { applyLayout(); resizeActive(); }, 300)); } catch (e) {}
  // Re-pick portrait/landscape + re-fit the active map whenever the area changes (panel collapse, rotate, iframe resize).
  if (window.ResizeObserver) {
    try { new ResizeObserver(() => { applyLayout(); resizeActive(); }).observe(document.getElementById("mapwrap")); } catch (e) {}
  }
}

function locateSvg() {
  return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/>' +
    '<line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/>' +
    '<line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></g>' +
    '<circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
}

// ----------------------------------------------------------------------------- basemaps / engines
function addBaseOptions() {
  const sel = document.getElementById("basemap");
  const opts = [];
  if (cfg.google_key) opts.push(["g_roadmap", "Google Roadmap"], ["g_satellite", "Google Satellite"],
    ["g_hybrid", "Google Hybrid"], ["g_terrain", "Google Terrain"]);
  opts.push(["carto", "CARTO Voyager"], ["streets", "Streets (Esri)"], ["topo", "Topographic"], ["sat", "Satellite"]);
  sel.innerHTML = "";
  opts.forEach(([k, label]) => { const o = document.createElement("option"); o.value = k; o.textContent = label; sel.appendChild(o); });
}

function persistBasemap(key) {
  if (!isAdmin) return;                                   // viewers follow the admin; no persistence
  try { localStorage.setItem("tt_basemap", key); } catch (e) {}
  jpost(`${API}/basemap`, { key }).catch(() => {});       // share the choice with viewers
}

let _googlePromise = null;
function loadGoogleApi() {
  if (window.google && window.google.maps) return Promise.resolve();
  if (_googlePromise) return _googlePromise;
  _googlePromise = new Promise((resolve, reject) => {
    if (!cfg || !cfg.google_key) { reject(new Error("no google_maps_key configured")); return; }
    window.__ttGoogleReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(cfg.google_key) + "&callback=__ttGoogleReady";
    s.async = true; s.defer = true;
    s.onerror = () => reject(new Error("Google Maps JS failed to load (check key / billing / referrer)"));
    document.head.appendChild(s);
  });
  return _googlePromise;
}

function createGoogleMap() {
  if (gmap) return gmap;
  gmap = new google.maps.Map(document.getElementById("gmap"), {
    center: { lat: cfg.map.lat, lng: cfg.map.lon }, zoom: cfg.map.zoom,
    mapTypeId: "roadmap", mapTypeControl: false, fullscreenControl: false,
    streetViewControl: true, zoomControl: true, rotateControl: true, scaleControl: true,
    gestureHandling: "greedy",
  });
  // native-style "center on current location" control
  const btn = document.createElement("div");
  btn.className = "g-locate"; btn.title = "Center on current location"; btn.innerHTML = locateSvg();
  btn.onclick = locateTraveler;
  gmap.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(btn);
  gmap.addListener("dragstart", onUserDrag);
  gmap.addListener("click", collapseIfShown);
  gmap.addListener("zoom_changed", () => { if (views.size) renderTracks(); });   // re-trim the head on zoom
  return gmap;
}

async function showEngine(to) {
  if (to === "google") { await loadGoogleApi(); if (!gmap) createGoogleMap(); }
  if (engine === to) { resizeActive(); return; }
  const c = mapCenter(), z = mapZoom();
  engine = to;
  document.getElementById("map").style.display = (to === "leaflet") ? "block" : "none";
  document.getElementById("gmap").style.display = (to === "google") ? "block" : "none";
  if (to === "google") {
    gmap.setCenter({ lat: c[0], lng: c[1] }); gmap.setZoom(Math.round(z));
    setTimeout(() => google.maps.event.trigger(gmap, "resize"), 0);
  } else {
    setTimeout(() => { lmap.invalidateSize(); lmap.setView(c, z); }, 0);
  }
  renderActiveEngine();
}

function setLeafletBase(key) {
  const layer = baseLayers[key] || baseLayers.carto;
  for (const k in baseLayers) if (baseLayers[k] !== layer && lmap.hasLayer(baseLayers[k])) lmap.removeLayer(baseLayers[k]);
  if (!lmap.hasLayer(layer)) layer.addTo(lmap);
  if (typeof layer.bringToBack === "function") layer.bringToBack();
}

function setBasemap(key) {
  if (GOOGLE_TYPES[key] && !cfg.google_key) key = "carto";
  currentBaseKey = key;
  persistBasemap(key);
  const sel = document.getElementById("basemap");
  if (sel && sel.value !== key) sel.value = key;
  if (GOOGLE_TYPES[key]) {
    showEngine("google")
      .then(() => { if (currentBaseKey === key && gmap) gmap.setMapTypeId(GOOGLE_TYPES[key]); })
      .catch((e) => { console.warn("Google Maps unavailable:", e.message); setBasemap("carto"); });
  } else {
    showEngine("leaflet");
    setLeafletBase(key);
  }
}

// ----------------------------------------------------------------------------- map helpers (engine-agnostic)
function mapZoom() { return engine === "google" ? gmap.getZoom() : lmap.getZoom(); }
function mapCenter() {
  if (engine === "google") { const c = gmap.getCenter(); return [c.lat(), c.lng()]; }
  const c = lmap.getCenter(); return [c.lat, c.lng];
}
function mapSetView(lat, lon, zoom) {
  if (engine === "google") { gmap.setCenter({ lat: lat, lng: lon }); if (zoom != null) gmap.setZoom(Math.round(zoom)); }
  else lmap.setView([lat, lon], zoom != null ? zoom : lmap.getZoom(), { animate: true });
}
function mapCenterOn(lat, lon, animate) {
  if (engine === "google") { animate ? gmap.panTo({ lat: lat, lng: lon }) : gmap.setCenter({ lat: lat, lng: lon }); }
  else lmap.setView([lat, lon], lmap.getZoom(), { animate: !!animate });
}
// Fit the map to the union of ALL selected trips' points.
function fitViews() {
  const all = [];
  for (const v of views.values()) for (const ll of v.latlngs) all.push(ll);
  if (!all.length) return;
  if (engine === "google") {
    const b = new google.maps.LatLngBounds();
    all.forEach(([la, lo]) => b.extend({ lat: la, lng: lo }));
    gmap.fitBounds(b, 50);
  } else {
    try { lmap.fitBounds(L.latLngBounds(all).pad(0.2)); } catch (e) {}
  }
}
function resizeActive() {
  if (engine === "google" && gmap) google.maps.event.trigger(gmap, "resize");
  else if (lmap) lmap.invalidateSize();
}
// Choose the responsive layout from the DEVICE ORIENTATION, not a px media query (the HA ingress iframe
// mis-reports the CSS viewport width/aspect on a phone, so screen-width/box-aspect heuristics forced "stacked"
// even in landscape). `screen.orientation` is reliable inside the iframe — it reflects the real device screen.
//   portrait → stacked (map on top, dock at the bottom); landscape → side-by-side (330px panel · map · right-40% dock).
function isPortrait() {
  const s = window.screen || {};
  const ot = (s.orientation && s.orientation.type) || "";
  if (ot.indexOf("portrait") === 0) return true;
  if (ot.indexOf("landscape") === 0) return false;
  if (typeof window.orientation === "number") return Math.abs(window.orientation) !== 90;   // older iOS
  if (s.width && s.height) return s.width <= s.height;
  const el = document.getElementById("app");                                                // last resort: box aspect
  return el ? el.clientHeight > el.clientWidth : window.innerHeight >= window.innerWidth;
}
function applyLayout() {
  const el = document.getElementById("app");
  if (!el) return;
  const portrait = isPortrait();
  if (document.body.classList.contains("portrait") !== portrait) {
    document.body.classList.toggle("portrait", portrait);
    setTimeout(resizeActive, 60);   // the split changed → re-fit the map
  }
}

// ----------------------------------------------------------------------------- rendering (both engines)
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
// A "gap" = a stretch where the phone sent nothing (lost MQTT / poor GPS); the two bracketing points
// must NOT be joined by a straight chord. Distance mode: flag when far beyond normal ~min_distance
// spacing. Time mode: flag a long time gap (several expected fixes missed).
function isGap(v, i) {
  const a = v.latlngs[i - 1], b = v.latlngs[i], m = v.meta;
  // distance & hybrid are distance-spaced (small gaps even at speed), so a large jump = a real data gap
  if (m.mode === "distance" || m.mode === "hybrid") {
    const thr = Math.max(150, 6 * (m.min_distance_m || 25));
    return haversineM(a[0], a[1], b[0], b[1]) > thr;
  }
  const dt = (v.ts[i] && v.ts[i - 1]) ? (v.ts[i] - v.ts[i - 1]) : 0;
  return dt > Math.max(30, 3 * (m.interval_s || 15));
}
// Split a view's flat track into continuous segments, breaking at gaps.
function trackSegments(v) {
  const segs = [];
  let cur = null;
  for (let i = 0; i < v.latlngs.length; i++) {
    if (i === 0 || isGap(v, i)) { cur = [v.latlngs[i]]; segs.push(cur); }
    else cur.push(v.latlngs[i]);
  }
  return segs;
}
// Initial-bearing (degrees from north, clockwise) from point A to point B.
function bearingDeg(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Decide the head indicator: a red dot when still/<2 km/h, else a speed-coloured arrow along the heading.
function headState(v) {
  const n = v.latlngs.length;
  if (!n) return null;
  const head = v.latlngs[n - 1];
  let kmh = (v.latestSpeed != null) ? v.latestSpeed * 3.6 : NaN;
  let brg = 0, dist = 0;
  const hasPrev = n >= 2;
  if (hasPrev) {
    const prev = v.latlngs[n - 2];
    dist = haversineM(prev[0], prev[1], head[0], head[1]);
    brg = bearingDeg(prev[0], prev[1], head[0], head[1]);
    if (isNaN(kmh)) {   // no GPS speed on the point → derive from the last two fixes
      const dt = (v.ts[n - 1] && v.ts[n - 2]) ? (v.ts[n - 1] - v.ts[n - 2]) : 0;
      if (dt > 0) kmh = dist / dt * 3.6;
    }
  }
  if (isNaN(kmh)) kmh = 0;
  if (kmh < 2) return { head, kind: "still" };          // still/<2 km/h → red dot
  if (!hasPrev || dist < 1) return { head, kind: "unknown" };  // moving but no reliable heading → grey dot
  return { head, kind: "arrow", brg, color: gradientColor(Math.min(kmh, 100) / 100) };   // same palette as the speed heatmap
}
function lHeadIcon(hs) {
  if (hs.kind === "arrow") {
    const html = `<svg width="30" height="30" viewBox="0 0 30 30" style="transform:rotate(${hs.brg}deg)">` +
      `<path d="M15 2 L26 27 L4 27 Z" fill="${hs.color}" stroke-linejoin="round"/></svg>`;   // solid (covers the trimmed line end)
    return L.divIcon({ className: "tt-head", html, iconSize: [30, 30], iconAnchor: [15, 15] });
  }
  const fill = hs.kind === "unknown" ? "#9e9e9e" : "#e53935";
  return L.divIcon({
    className: "tt-head", iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="${fill}" stroke="#fff" stroke-width="2"/></svg>`,
  });
}
// ---- speed → colour gradient (smooth, 0 … 100+ km/h) ----
const SPEED_STOPS = [
  [0.00, [21, 101, 192]],   // blue   (slow / 0)
  [0.20, [0, 188, 212]],    // cyan
  [0.40, [67, 160, 71]],    // green
  [0.60, [255, 214, 0]],    // yellow
  [0.80, [251, 140, 0]],    // orange
  [1.00, [229, 57, 53]],    // red    (100+)
];
function gradientColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    if (t <= SPEED_STOPS[i][0]) {
      const [t0, c0] = SPEED_STOPS[i - 1], [t1, c1] = SPEED_STOPS[i];
      const f = (t - t0) / ((t1 - t0) || 1);
      return `rgb(${Math.round(c0[0] + f * (c1[0] - c0[0]))},${Math.round(c0[1] + f * (c1[1] - c0[1]))},${Math.round(c0[2] + f * (c1[2] - c0[2]))})`;
    }
  }
  const c = SPEED_STOPS[SPEED_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const SPEED_LEVELS = 20;   // quantise so same-speed runs merge into one polyline (still visually smooth)
function segSpeedKmh(a, b) {
  const v = (a.speed != null && b.speed != null) ? (a.speed + b.speed) / 2
    : (b.speed != null ? b.speed : (a.speed != null ? a.speed : 0));
  return Math.max(0, v * 3.6);
}
function colorBand(a, b) { return Math.round(Math.min(segSpeedKmh(a, b), 100) / 100 * SPEED_LEVELS); }
// Build contiguous same-speed-band runs (each a polyline), broken at gaps.
function buildColoredSegments(v) {
  const runs = [];
  let run = null;
  for (let i = 1; i < v.pts.length; i++) {
    if (isGap(v, i)) { run = null; continue; }
    const a = v.pts[i - 1], b = v.pts[i], band = colorBand(a, b);
    if (run && run.band === band) run.pts.push([b.lat, b.lon]);
    else { run = { band, color: gradientColor(band / SPEED_LEVELS), pts: [[a.lat, a.lon], [b.lat, b.lon]] }; runs.push(run); }
  }
  return runs;
}
// ---- click the track → show the actual speed + coordinates at the nearest recorded point ----
function nearestTrackPt(lat, lon) {
  let best = null, bd = Infinity;
  for (const v of views.values()) for (const p of v.pts) { const d = haversineM(lat, lon, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
  return best;
}
function showTrackPopup(lat, lon) {
  const p = nearestTrackPt(lat, lon);
  if (!p) return;
  const kmh = (p.speed != null) ? (Math.round(Math.max(0, p.speed * 3.6)) + " km/h") : "– km/h";
  const when = p.ts ? new Date(p.ts * 1000).toLocaleTimeString() : "";
  const html = `<div class="tk-pop"><button class="tk-x" onclick="ttCloseTrackPopup()" title="Close">×</button>` +
    `<b>${kmh}</b><br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${when ? `<br><span>${esc(when)}</span>` : ""}</div>`;
  if (engine === "google") {
    if (!gInfo) gInfo = new google.maps.InfoWindow({ headerDisabled: true });   // use our own close (.tk-x)
    gInfo.setContent(html); gInfo.setPosition({ lat: p.lat, lng: p.lon }); gInfo.open(gmap);
  } else {
    L.popup({ autoPan: false, closeButton: false }).setLatLng([p.lat, p.lon]).setContent(html).openOn(lmap);
  }
}
function ttCloseTrackPopup() {   // global (classic script) — closes the track speed popup on either engine
  try { if (lmap) lmap.closePopup(); } catch (e) {}
  try { if (gInfo) gInfo.close(); } catch (e) {}
}
function trackClickAt(lat, lon) {
  suppressMapClick = true;
  setTimeout(() => { suppressMapClick = false; }, 60);   // so the shared map-click handler doesn't also collapse
  showTrackPopup(lat, lon);
}
// Pull the rendered track's final vertex back toward the previous point by `px` SCREEN pixels, so the
// line ends short of the head and the head marker hides the gap (the real data endpoint is untouched).
function pullBackL(prev, head, px) {
  const pH = lmap.latLngToLayerPoint(L.latLng(head[0], head[1]));
  const pP = lmap.latLngToLayerPoint(L.latLng(prev[0], prev[1]));
  const dx = pP.x - pH.x, dy = pP.y - pH.y, len = Math.hypot(dx, dy);
  if (len < 1) return head;
  const t = Math.min(px, len) / len;
  const ll = lmap.layerPointToLatLng(L.point(pH.x + dx * t, pH.y + dy * t));
  return [ll.lat, ll.lng];
}
function pullBackG(prev, head, px) {
  const proj = gmap.getProjection();
  if (!proj) return head;
  const scale = Math.pow(2, gmap.getZoom());
  const wH = proj.fromLatLngToPoint(new google.maps.LatLng(head[0], head[1]));
  const wP = proj.fromLatLngToPoint(new google.maps.LatLng(prev[0], prev[1]));
  const dx = (wP.x - wH.x) * scale, dy = (wP.y - wH.y) * scale, len = Math.hypot(dx, dy);
  if (len < 1) return head;
  const t = Math.min(px, len) / len;
  const nw = new google.maps.Point(wH.x + (wP.x - wH.x) * t, wH.y + (wP.y - wH.y) * t);
  const ll = proj.fromPointToLatLng(nw);
  return [ll.lat(), ll.lng()];
}
function trimmedHead(v, hs) {
  const n = v.latlngs.length;
  if (n < 2 || isGap(v, n - 1)) return null;   // nothing connected to the head → nothing to trim
  const px = (hs && hs.kind === "arrow") ? 11 : 5;
  const head = v.latlngs[n - 1], prev = v.latlngs[n - 2];
  return (engine === "google") ? pullBackG(prev, head, px) : pullBackL(prev, head, px);
}
function applyTrim(v, ptsArr, hs) {   // replace the last (head) vertex of the last polyline with the trimmed one
  const th = trimmedHead(v, hs);
  if (th && ptsArr && ptsArr.length >= 2) ptsArr[ptsArr.length - 1] = th;
}
// Draw EVERY selected trip's track (each in its own colour, or speed-coloured when the toggle is on). Only the
// live trip gets the moving head indicator.
function renderTracks() {
  const live = (activeTripId != null) ? views.get(activeTripId) : null;
  const hs = live ? headState(live) : null;
  if (engine === "google") {
    gTrackSegs.forEach((pl) => pl.setMap(null)); gTrackSegs = [];
    for (const v of views.values()) drawGoogleTrack(v, v === live ? hs : null);
    if (hs) {
      const pos = { lat: hs.head[0], lng: hs.head[1] };
      if (!gHead) gHead = new google.maps.Marker({ position: pos, map: gmap, icon: gHeadIcon(hs), zIndex: 9999 });
      else { gHead.setPosition(pos); gHead.setIcon(gHeadIcon(hs)); gHead.setMap(gmap); }
    } else if (gHead) { gHead.setMap(null); gHead = null; }
  } else {
    lTrackLayer.clearLayers(); lSpeedLayer.clearLayers();
    for (const v of views.values()) drawLeafletTrack(v, v === live ? hs : null);
    if (hs) {
      if (!lHead) lHead = L.marker(hs.head, { icon: lHeadIcon(hs), zIndexOffset: 1000 }).addTo(lmap);
      else { lHead.setLatLng(hs.head); lHead.setIcon(lHeadIcon(hs)); }
    } else if (lHead) { lmap.removeLayer(lHead); lHead = null; }
  }
}
function drawLeafletTrack(v, hs) {
  if (speedColorOn) {
    const runs = buildColoredSegments(v);
    if (hs && runs.length) applyTrim(v, runs[runs.length - 1].pts, hs);
    for (const r of runs) {
      const pl = L.polyline(r.pts, { color: r.color, weight: 5, opacity: 0.95, renderer: lSpeedCanvas });
      pl.on("click", (e) => trackClickAt(e.latlng.lat, e.latlng.lng));
      pl.addTo(lSpeedLayer);
    }
  } else {
    const segs = trackSegments(v);
    if (hs && segs.length) applyTrim(v, segs[segs.length - 1], hs);
    for (const s of segs) {
      const pl = L.polyline(s, { color: v.color, weight: 5, opacity: 0.9 });
      pl.on("click", (e) => trackClickAt(e.latlng.lat, e.latlng.lng));
      pl.addTo(lTrackLayer);
    }
  }
}
function drawGoogleTrack(v, hs) {
  if (speedColorOn) {
    const runs = buildColoredSegments(v);
    if (hs && runs.length) applyTrim(v, runs[runs.length - 1].pts, hs);
    for (const r of runs) {
      const pl = new google.maps.Polyline({ path: r.pts.map(([la, lo]) => ({ lat: la, lng: lo })), strokeColor: r.color, strokeOpacity: 0.95, strokeWeight: 5, map: gmap });
      pl.addListener("click", (e) => trackClickAt(e.latLng.lat(), e.latLng.lng()));
      gTrackSegs.push(pl);
    }
  } else {
    const segs = trackSegments(v);
    if (hs && segs.length) applyTrim(v, segs[segs.length - 1], hs);
    for (const s of segs) {
      const pl = new google.maps.Polyline({ path: s.map(([la, lo]) => ({ lat: la, lng: lo })), strokeColor: v.color, strokeOpacity: 0.9, strokeWeight: 5, map: gmap });
      pl.addListener("click", (e) => trackClickAt(e.latLng.lat(), e.latLng.lng()));
      gTrackSegs.push(pl);
    }
  }
}
function gHeadIcon(hs) {
  if (hs && hs.kind === "arrow") {
    return { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5, rotation: hs.brg,
             fillColor: hs.color, fillOpacity: 1, strokeWeight: 0 };
  }
  const fill = (hs && hs.kind === "unknown") ? "#9e9e9e" : "#e53935";
  return { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: fill, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
}
// Photo pins are now small DOTS centred on the point (= on the track). Current photo = yellow, rest = grey.
function lDotStyle(cur) {
  return { radius: cur ? 8 : 6, weight: 2, opacity: 1, fillOpacity: 1,
           color: cur ? "#7a5c00" : "#5b636e", fillColor: cur ? DOT_CUR : DOT_REST };
}
function gDotIcon(cur) {
  return { path: google.maps.SymbolPath.CIRCLE, scale: cur ? 8 : 6, fillOpacity: 1,
           fillColor: cur ? DOT_CUR : DOT_REST, strokeColor: cur ? "#7a5c00" : "#5b636e", strokeWeight: 2 };
}
function addLMarker(ph) {
  const cur = ph.asset === currentAsset();
  const m = L.circleMarker([ph.lat, ph.lon], lDotStyle(cur)).addTo(lPhotoLayer);
  m.on("click", () => openPhoto(ph.asset, false));
  ph._lmarker = m;
  if (cur) m.bringToFront();
}
function addGMarker(ph) {
  const cur = ph.asset === currentAsset();
  const m = new google.maps.Marker({ position: { lat: ph.lat, lng: ph.lon }, map: gmap,
    icon: gDotIcon(cur), title: ph.name || "", zIndex: cur ? 1000 : 1 });
  m.addListener("click", () => openPhoto(ph.asset, false));
  ph._gmarker = m;
  gMarkers.push(m);
}
function addMarkerActive(ph) { if (engine === "google" && gmap) addGMarker(ph); else addLMarker(ph); }
function renderPhotosFull() {
  photos.forEach((ph) => { ph._lmarker = null; ph._gmarker = null; });   // drop stale refs (filtered-out photos get none)
  const shown = photos.filter(photoPasses);
  if (engine === "google") {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    shown.forEach(addGMarker);
  } else {
    lPhotoLayer.clearLayers();
    shown.forEach(addLMarker);
  }
}
// Recolour the dots to match the current selection (yellow = current, grey = rest) WITHOUT touching the map.
function updatePhotoDots() {
  const ca = currentAsset();
  if (engine === "google") {
    photos.forEach((ph) => { if (ph._gmarker) { const cur = ph.asset === ca; ph._gmarker.setIcon(gDotIcon(cur)); ph._gmarker.setZIndex(cur ? 1000 : 1); } });
  } else {
    photos.forEach((ph) => { if (ph._lmarker) { const cur = ph.asset === ca; ph._lmarker.setStyle(lDotStyle(cur)); if (cur) ph._lmarker.bringToFront(); } });
  }
}
function renderActiveEngine() { renderTracks(); renderPhotosFull(); }
function clearRenders() {
  if (lPhotoLayer) lPhotoLayer.clearLayers();
  if (lTrackLayer) lTrackLayer.clearLayers();
  if (lSpeedLayer) lSpeedLayer.clearLayers();
  if (lHead) { lmap.removeLayer(lHead); lHead = null; }
  if (gmap) {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    gTrackSegs.forEach((pl) => pl.setMap(null)); gTrackSegs = [];
    if (gHead) { gHead.setMap(null); gHead = null; }
  }
}
// The trip that follow/centre/speed-pill track: the live trip if it's shown, else the last-focused one.
function liveOrFocusView() {
  if (activeTripId != null && views.has(activeTripId)) return views.get(activeTripId);
  if (focusId != null && views.has(focusId)) return views.get(focusId);
  return null;
}

// ----------------------------------------------------------------------------- locate
function setFollow(on) {
  followMode = on;
  document.querySelectorAll(".tt-locate, .g-locate").forEach((el) => el.classList.toggle("following", on));
}
// While follow is on, keep the latest point centred (keeping the current zoom); called as the track grows.
function followIfNeeded() {
  const v = liveOrFocusView();
  if (followMode && v && v.latlngs.length) {
    const h = v.latlngs[v.latlngs.length - 1];
    mapCenterOn(h[0], h[1], true);
  }
}
// A user pan/drag of the map cancels follow (programmatic re-centres don't fire dragstart, so they don't).
function onUserDrag() { setFollow(false); }

function locateTraveler() {
  setFollow(true);   // clicking locate turns follow ON; dragging the map turns it OFF
  const v = liveOrFocusView();
  if (v && v.latlngs.length) { const h = v.latlngs[v.latlngs.length - 1]; mapSetView(h[0], h[1], Math.max(mapZoom(), 16)); return; }
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
    (p) => mapSetView(p.coords.latitude, p.coords.longitude, 16), () => {},
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

// ----------------------------------------------------------------------------- photo dock + fullscreen
// ---- photo filter (people + camera). Options = the union across all SHOWN trips' photos. Available to everyone. ----
const filterPeople = new Set();     // selected person names (empty = don't filter by people)
const filterCameras = new Set();    // selected camera labels (empty = don't filter by camera); "" = unknown
function photoPasses(ph) {
  if (filterPeople.size) { const pl = ph.people || []; if (!pl.some((n) => filterPeople.has(n))) return false; }
  if (filterCameras.size && !filterCameras.has(ph.camera || "")) return false;
  return true;
}
function sortPhotos() {
  // Dedupe by asset (a photo must never appear twice) AND drop anything the active filter excludes.
  const seen = new Set();
  photoSorted = photos.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .filter((p) => photoPasses(p) && (seen.has(p.asset) ? false : (seen.add(p.asset), true)));
}
// Rebuild the People/Camera option lists from the shown photos, keeping existing selections that still exist.
function rebuildFilterOptions() {
  const people = new Set(), cams = new Set();
  for (const ph of photos) { (ph.people || []).forEach((n) => people.add(n)); cams.add(ph.camera || ""); }
  for (const n of [...filterPeople]) if (!people.has(n)) filterPeople.delete(n);
  for (const c of [...filterCameras]) if (!cams.has(c)) filterCameras.delete(c);
  renderFilterGroup("filter-people", [...people].sort(), filterPeople, "(unknown)");
  renderFilterGroup("filter-camera", [...cams].sort(), filterCameras, "(no camera)");
}
function renderFilterGroup(id, options, selSet, emptyLabel) {
  const box = document.getElementById(id);
  if (!box) return;
  box.innerHTML = "";
  if (!options.length) { box.innerHTML = '<div class="filter-empty">none</div>'; return; }
  for (const opt of options) {
    const label = document.createElement("label");
    label.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = selSet.has(opt);
    cb.onchange = () => { if (cb.checked) selSet.add(opt); else selSet.delete(opt); applyPhotoFilter(); };
    const span = document.createElement("span");
    span.textContent = (opt === "" ? emptyLabel : opt);
    label.appendChild(cb); label.appendChild(span);
    box.appendChild(label);
  }
}
// Re-render dots for the filtered set, and keep the open photo consistent (close the viewer if it's filtered out).
function applyPhotoFilter() {
  renderPhotosFull();
  if (document.body.classList.contains("pv-open")) {
    const ca = currentAsset();
    sortPhotos();
    const i = (ca != null) ? photoSorted.findIndex((p) => p.asset === ca) : -1;
    if (i < 0) closeDock(); else { curPhoto = i; updatePhotoDots(); }
  }
}
function currentAsset() { return (curPhoto >= 0 && photoSorted[curPhoto]) ? photoSorted[curPhoto].asset : null; }
// Portrait (dock at the bottom) vs landscape (dock on the right) is decided by applyLayout() from the real
// #app box, so the thumbnail-vs-preview choice follows the same signal: portrait → thumbnail, landscape → preview.
function isMobileView() { return document.body.classList.contains("portrait"); }
function dockSrc(p) { return isMobileView() ? thumb(p.asset) : preview(p.asset); }

// ---- photo preloading / in-memory cache (instant nav) ----
// Each shown URL is fetched once and held as a decoded <img>; setting a real #pv-img/#lb-img src to the same
// URL then paints from cache in the same frame, so a nav click shows the next photo immediately.
function cacheBump(url) { const im = imgCache.get(url); if (im) { imgCache.delete(url); imgCache.set(url, im); } return im; }
function preloadUrl(url) {
  if (!url) return;
  if (imgCache.has(url)) { cacheBump(url); return; }
  const im = new Image();
  im.decoding = "async";
  im.src = url;
  if (im.decode) im.decode().catch(() => {});   // force-decode ahead of time so the later swap is instant
  imgCache.set(url, im);
  while (imgCache.size > IMG_CACHE_MAX) { imgCache.delete(imgCache.keys().next().value); }   // evict oldest
}
// Warm the current photo + up to 5 on either side so dock AND fullscreen nav are instant. Preloads the
// fullscreen resolution (preview) for the whole ±5 window and the dock resolution for ±1. Videos stream on demand.
const PRELOAD_RADIUS = 5;
function preloadAround(i) {
  const cur = photoSorted[i];
  if (cur && cur.type !== "video") { preloadUrl(preview(cur.asset)); preloadUrl(dockSrc(cur)); }
  for (let d = 1; d <= PRELOAD_RADIUS; d++) {
    for (const p of [photoSorted[i + d], photoSorted[i - d]]) {
      if (!p || p.type === "video") continue;
      preloadUrl(preview(p.asset));   // fullscreen resolution
      preloadUrl(dockSrc(p));         // dock resolution (thumbnail on mobile) — warm ±5 too
    }
  }
}
// Point an <img> at a URL WITHOUT ever flashing the previous image: if the target is already in the cache it's
// shown instantly; otherwise the element is blanked (shows black) and the real src is set only once the image
// has loaded. A data-url guard means a later navigation wins, so a slow image can't pop in after you've moved on.
function setImg(imgEl, url) {
  if (!imgEl || !url) return;
  if (imgEl.getAttribute("data-url") === url && imgEl.getAttribute("src") === url) return;   // already showing it
  imgEl.setAttribute("data-url", url);
  preloadUrl(url);                                     // ensure it's loading/loaded in the cache
  const im = imgCache.get(url);
  if (im && im.complete && im.naturalWidth) { imgEl.src = url; return; }   // ready → paint immediately
  imgEl.removeAttribute("src");                        // NOT ready → black placeholder, never the previous photo
  if (im) im.addEventListener("load", () => { if (imgEl.getAttribute("data-url") === url) imgEl.src = url; }, { once: true });
}

// Pinch/drag/double-tap zoom-pan for an <img>. Used by BOTH the docked viewer (#pv-img) and the fullscreen
// overlay (#lb-img):
//   • one-finger drag / mouse drag → pan (only while zoomed in)   • pinch (two fingers) or mouse wheel → zoom
//   • double-tap / double-click → reset to fit (scale 1, centred)  • pan is clamped so the photo can't leave the frame
// Geometry is read from the element's UNtransformed layout box (offsetParent + offset*), so the focal-point
// math is unaffected by the transform we apply. Call .reset() whenever the shown photo changes.
function createZoomPan(el, opts) {
  if (!el) return { reset() {} };
  opts = opts || {};
  const canZoom = opts.zoom !== false;                       // dock passes zoom:false → tap-only, no pan/zoom
  const MIN = 1, MAX = 6;
  let scale = 1, tx = 0, ty = 0;
  const pts = new Map();                                     // live pointers: id → {x,y}
  let pinch = null, panLast = null, moved = 0, downT = 0, lastTap = 0;
  let downX = 0, downY = 0, multi = false;                   // gesture start point + "a 2nd finger was used" flag
  const ghost = opts.ghost || null;                          // neighbour image that slides in during a swipe
  const frameW = opts.frameW || (() => el.offsetWidth);      // swipe travel distance (one "slide" width)
  const neighborSrc = opts.neighborSrc || (() => null);      // cached src of the neighbour in a direction, or null
  const canSwipe = !!opts.onSwipe;
  const surf = opts.surface || el;                           // gesture surface (whole stage/overlay incl. letterbox)
  let swiping = false, axis = null, ghostDir = 0, curDx = 0, committing = false;
  el.style.transformOrigin = "center center";
  // Double-tap: if zoomed in → reset to fit. If ALREADY at fit → the view's own action (opts.onDoubleTap):
  // the dock opens fullscreen; fullscreen closes itself. No onDoubleTap → just reset.
  function onDouble() {
    if (canZoom && scale > 1.001) { reset(true); return; }
    if (opts.onDoubleTap) opts.onDoubleTap(); else reset(true);
  }

  function geom() {                                          // untransformed centre (screen px) + size
    const op = el.offsetParent || el.parentNode, r = op.getBoundingClientRect();
    return { cx: r.left + el.offsetLeft + el.offsetWidth / 2, cy: r.top + el.offsetTop + el.offsetHeight / 2,
             w: el.offsetWidth, h: el.offsetHeight };
  }
  function clamp() {
    if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; return; }
    const g = geom(), mx = (g.w / 2) * (scale - 1), my = (g.h / 2) * (scale - 1);
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
  }
  function apply(anim) {
    el.style.transition = anim ? "transform .18s ease" : "";
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    surf.style.cursor = !canZoom ? "zoom-in" : (scale > 1 ? "grab" : "default");
  }
  function zoomAt(fx, fy, ns) {                              // zoom toward focal point (fx,fy) in screen px
    ns = Math.max(MIN, Math.min(MAX, ns));
    const g = geom(), k = 1 - ns / scale;                    // keep the focal element-point under the finger/cursor
    tx += ((fx - g.cx) - tx) * k; ty += ((fy - g.cy) - ty) * k;
    scale = ns; clamp(); apply(false);
  }
  function reset(anim) { scale = 1; tx = 0; ty = 0; apply(!!anim); }

  // ---- live swipe to the neighbouring photo: the current image follows the finger while a "ghost" of the
  // neighbour slides in from the edge (preloaded cache). On release: commit if dragged far enough, else spring
  // back. doCommit() hands off to opts.onSwipe (navPhoto) which loads the real image, then the ghost is hidden
  // once that image has decoded → no flash. ----
  // Pack the two images tight: the neighbour sits one "span" away = half of each on-screen image width + a
  // 5px gutter, so it slides in right beside the current image (not a full frame away leaving a black void).
  const GAP = 20;
  function frameDims() {
    const op = el.offsetParent || el.parentNode;
    return { w: (op && op.clientWidth) || frameW() || window.innerWidth, h: (op && op.clientHeight) || window.innerHeight };
  }
  function dispW(img) {                                      // on-screen width of an object-fit:contain image
    const f = frameDims(), nw = (img && img.naturalWidth) || 0, nh = (img && img.naturalHeight) || 0;
    if (!nw || !nh) return f.w;                              // not decoded yet → assume full frame
    return nw * Math.min(f.w / nw, f.h / nh);
  }
  function slideSpan() { return dispW(el) / 2 + dispW(ghost || el) / 2 + GAP; }
  function hideGhost() { if (ghost) { ghost.style.display = "none"; ghost.style.transition = ""; ghost.style.transform = ""; ghost.removeAttribute("src"); } }
  function setupGhost(dir) {
    ghostDir = dir;
    if (!ghost) return;
    const src = neighborSrc(dir);
    // NB: must be "block" — "" reverts to the stylesheet's display:none, which left the ghost invisible.
    if (src) { if (ghost.getAttribute("src") !== src) ghost.src = src; ghost.style.transition = ""; ghost.style.transform = `translateX(${-dir * slideSpan()}px)`; ghost.style.display = "block"; }
    else ghost.style.display = "none";
  }
  function moveSwipe(ndx, dir) {
    const hasN = !!neighborSrc(dir), d = hasN ? ndx : ndx * 0.25, S = slideSpan();   // resistance at the ends
    curDx = d;
    el.style.transition = ""; el.style.transform = `translateX(${d}px)`;
    if (ghost && hasN) { ghost.style.transition = ""; ghost.style.transform = `translateX(${-dir * S + d}px)`; }
  }
  function doCommit(dir) {
    if (!committing) return;
    committing = false; curDx = 0; ghostDir = 0;
    opts.onSwipe(dir);                                       // navPhoto → setImg: el shows the new image, or BLACK until
                                                            // it's ready — never the previous photo. Then drop the ghost.
    requestAnimationFrame(() => requestAnimationFrame(hideGhost));
  }
  function finishSwipe() {
    const fw = frameDims().w, dir = ghostDir, hasN = !!neighborSrc(dir), S = slideSpan();
    const far = Math.abs(curDx) > Math.min(90, fw * 0.18);
    if (hasN && far && ghost) {                              // commit → neighbour to centre, current slides out (5px gap kept)
      committing = true;
      el.style.transition = "transform .2s ease-out"; el.style.transform = `translateX(${dir * S}px)`;
      ghost.style.transition = "transform .2s ease-out"; ghost.style.transform = "translateX(0)";
      let done = false;
      const f = () => { if (done) return; done = true; ghost.removeEventListener("transitionend", f); doCommit(dir); };
      ghost.addEventListener("transitionend", f);
      setTimeout(f, 240);                                    // fallback if transitionend doesn't fire
    } else {                                                 // spring back to the current photo
      el.style.transition = "transform .2s ease-out"; el.style.transform = "translateX(0)";
      if (ghost) { ghost.style.transition = "transform .2s ease-out"; ghost.style.transform = `translateX(${-dir * S}px)`; }
      setTimeout(() => { el.style.transition = ""; el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; hideGhost(); ghostDir = 0; curDx = 0; }, 210);
    }
  }

  surf.addEventListener("pointerdown", (e) => {
    // let taps/clicks on the real controls (nav arrows, close, full-screen, open-original, video) work normally
    if (e.target !== surf && e.target.closest && e.target.closest("button, a, video, input, select")) return;
    try { surf.setPointerCapture(e.pointerId); } catch (x) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0; downT = Date.now();
    if (pts.size === 1) { downX = e.clientX; downY = e.clientY; multi = false; panLast = { x: e.clientX, y: e.clientY }; swiping = false; axis = null; ghostDir = 0; curDx = 0; }
    else if (pts.size === 2) { multi = true; panLast = null; swiping = false; if (ghost) ghost.style.display = "none"; if (canZoom) { const a = [...pts.values()]; pinch = { dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, scale, mid: null }; } }
  });
  surf.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    if (canZoom && pts.size >= 2 && pinch) {                 // pinch (+ two-finger pan)
      const a = [...pts.values()];
      const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      const mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
      if (pinch.mid) { tx += mx - pinch.mid.x; ty += my - pinch.mid.y; }   // pan by the midpoint drift
      pinch.mid = { x: mx, y: my };
      zoomAt(mx, my, pinch.scale * (d / pinch.dist));
      e.preventDefault(); return;
    }
    if (canZoom && scale > 1.001 && panLast) {               // pan the zoomed-in image
      const dx = e.clientX - panLast.x, dy = e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      tx += dx; ty += dy; clamp(); apply(false); surf.style.cursor = "grabbing"; e.preventDefault(); return;
    }
    if (canSwipe && !multi && pts.size === 1) {              // at fit (or zoom-off) → live swipe
      const ndx = e.clientX - downX, ndy = e.clientY - downY;
      if (!axis) { if (Math.abs(ndx) < 8 && Math.abs(ndy) < 8) return; axis = Math.abs(ndx) > Math.abs(ndy) ? "x" : "y"; }
      if (axis !== "x") return;
      swiping = true; e.preventDefault();
      const dir = ndx > 0 ? 1 : -1;                          // swipe right → next (+1, = right arrow); left → previous (−1)
      if (dir !== ghostDir) setupGhost(dir);
      moveSwipe(ndx, dir);
    }
  });
  function up(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    try { surf.releasePointerCapture(e.pointerId); } catch (x) {}
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const a = [...pts.values()][0]; panLast = { x: a.x, y: a.y }; }
    else if (pts.size === 0) {
      panLast = null;
      if (swiping) { finishSwipe(); swiping = false; axis = null; lastTap = 0; return; }   // live swipe → commit/spring
      axis = null;
      if (Date.now() - downT < 300 && moved < 8) {           // a clean tap (not a drag/pinch/swipe)
        if (opts.onTap) opts.onTap();                        // single tap anywhere → un-hide the nav buttons
        const now = Date.now();
        if (now - lastTap < 320) { try { e.preventDefault(); } catch (x) {} onDouble(); lastTap = 0; }   // double → reset-fit / open / close
        else lastTap = now;
      }
      if (canZoom && scale > 1) surf.style.cursor = "grab";
    }
  }
  surf.addEventListener("pointerup", up);
  surf.addEventListener("pointercancel", up);
  // Native dblclick only suppresses the browser default — the double action is driven solely by the pointer
  // tap-pair detector above (works for mouse + touch), so onDouble fires exactly ONCE per double-tap.
  surf.addEventListener("dblclick", (e) => { e.preventDefault(); });
  if (canZoom) surf.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  return { reset: () => reset(false) };
}

// Select a photo: highlight its dot (yellow) and show it in the docked viewer. The map is NEVER re-centred
// or re-zoomed — navigating only recolours the current dot. Used by dot clicks, dock ‹ ›, and fullscreen ‹ ›.
function openPhoto(key, fullscreen, fromSwipe) {
  sortPhotos();
  if (!photoSorted.length) return;
  let i = (typeof key === "number") ? key : photoSorted.findIndex((p) => p.asset === key);
  if (i < 0) i = 0;
  curPhoto = Math.max(0, Math.min(i, photoSorted.length - 1));
  const p = photoSorted[curPhoto];
  updatePhotoDots();          // current dot → yellow, rest → grey; no pan/zoom
  showDock(p, fromSwipe);
  if (fullscreen) showLightbox(p, fromSwipe);
  preloadAround(curPhoto);    // warm current ± neighbours so the next nav click paints instantly
}
function navPhoto(d, fromSwipe) { if (photoSorted.length) openPhoto(curPhoto + d, fsOpen, fromSwipe); }

// Caption shown under each photo (dock + fullscreen): filename · date · 📷 camera · 👤 people. Terms matching
// the ACTIVE filter are highlighted. ("EXIF GPS" / "matched to track" kept but hidden — re-enable the push below.)
function photoMetaHtml(p) {
  const when = p.ts ? new Date(p.ts * 1000).toLocaleString() : "";
  const lines = [];
  if (p.camera) {                                   // line 1: camera
    const hi = filterCameras.has(p.camera) ? ' class="flt"' : "";
    lines.push(`<span>📷 <span${hi}>${esc(p.camera)}</span></span>`);
  }
  if (p.people && p.people.length) {                // line 2: people
    const names = p.people.map((n) => filterPeople.has(n) ? `<span class="flt">${esc(n)}</span>` : esc(n)).join(", ");
    lines.push(`<span>👤 ${names}</span>`);
  }
  const last = [];                                  // last line: filename · date
  if (p.name) last.push(esc(p.name));
  if (when) last.push(`<span>${esc(when)}</span>`);
  if (last.length) lines.push(last.join(" · "));
  // const badge = p.matched_by === "exif" ? "EXIF GPS" : "matched to track"; lines.push(`<span>${esc(badge)}</span>`);
  return lines.join("<br>");
}

// ---- docked viewer (bottom 40% on mobile, right 40% on desktop) ----
function showDock(p, fromSwipe) {
  document.body.classList.add("pv-open");
  const dock = document.getElementById("photodock");
  if (dock) dock.setAttribute("aria-hidden", "false");
  const img = document.getElementById("pv-img");
  setImg(img, dockSrc(p));         // black placeholder until the image is ready — never the previous photo
  if (pvZoom) pvZoom.reset();      // each photo opens fit-to-area
  const play = document.getElementById("pv-play");
  if (play) play.hidden = (p.type !== "video");
  const meta = document.getElementById("pv-meta");
  if (meta) meta.innerHTML = photoMetaHtml(p);
  document.getElementById("pv-prev").classList.toggle("off", curPhoto === 0);
  document.getElementById("pv-next").classList.toggle("off", curPhoto === photoSorted.length - 1);
  if (!fromSwipe) showNav();      // show the arrows (not on a swipe-driven change), then auto-fade after 2s
  setTimeout(resizeActive, 60);   // the map container shrank → re-fit (the ResizeObserver also catches it)
}
function closeDock() {
  document.body.classList.remove("pv-open");
  const dock = document.getElementById("photodock");
  if (dock) dock.setAttribute("aria-hidden", "true");
  const img = document.getElementById("pv-img"); if (img) img.removeAttribute("src");
  if (pvZoom) pvZoom.reset();
  if (fsOpen) closeLightbox();
  curPhoto = -1;
  resetNav();                     // viewer closed → cancel the fade timer, arrows reset for next open
  updatePhotoDots();              // all dots back to grey
  setTimeout(resizeActive, 60);
}

// Photo nav arrows (‹ ›) auto-fade 2s after they're shown/used; a single tap anywhere in the viewer brings
// them back (pinch/pan/swipe do NOT, since those aren't clean taps). While faded they're pointer-events:none,
// so a tap where an arrow was falls through to the gesture surface and re-shows them.
let navHideTimer = null;
function showNav() {
  document.body.classList.remove("nav-hidden");
  clearTimeout(navHideTimer);
  navHideTimer = setTimeout(() => document.body.classList.add("nav-hidden"), 2000);
}
function resetNav() { clearTimeout(navHideTimer); document.body.classList.remove("nav-hidden"); }

// Briefly cover the map so the stray tap/click that the OS replays once the fullscreen overlay has vanished
// (double-tap-to-close happens over the map) lands on an inert shield instead of panning/zooming the map.
let _shieldTimer = null;
function shieldMap(ms) {
  const s = document.getElementById("tap-shield");
  if (!s) return;
  s.classList.add("on");
  clearTimeout(_shieldTimer);
  _shieldTimer = setTimeout(() => s.classList.remove("on"), ms || 300);
}

// ---- real browser Fullscreen API (removes the address bar / chrome) with graceful fallback ----
// Best-effort: works in a real browser tab and in the pop-out window; inside the HA ingress iframe it only
// works if the iframe allows fullscreen — if the request is rejected we simply keep the CSS overlay below.
// (Android shows its own "…drag from the top to exit…" immersive toast while this is active — unsuppressable.)
function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement ||
         document.webkitCurrentFullScreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}
function requestFs(el) {
  try {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen ||
               el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fn) { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); }   // rejection (e.g. iframe) → fallback overlay
  } catch (e) {}
}
function exitFs() {
  try {
    if (!fsElement()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen ||
               document.mozCancelFullScreen || document.msExitFullscreen;
    if (fn) { const r = fn.call(document); if (r && r.catch) r.catch(() => {}); }
  } catch (e) {}
}
// If the user leaves fullscreen via the system (Esc / back / swipe) while the lightbox is open, close it too.
function onFsChange() {
  if (fsElement()) return;
  const lb = document.getElementById("lightbox");
  if (lb && !lb.classList.contains("lb-hidden")) { closeLightbox(); shieldMap(); }
}

// ---- fullscreen overlay (CSS overlay; upgraded to the real Fullscreen API above when allowed) ----
function stopVideo() {
  const vid = document.getElementById("lb-video");
  if (!vid) return;
  try { vid.pause(); } catch (e) {}
  vid.removeAttribute("src");
  try { vid.load(); } catch (e) {}   // release the stream
}
function showLightbox(p, fromSwipe) {
  const lb = document.getElementById("lightbox");
  const img = document.getElementById("lb-img");
  const vid = document.getElementById("lb-video");
  if (p.type === "video") {
    img.style.display = "none"; img.removeAttribute("src");
    vid.style.display = "";
    vid.src = video(p.asset);
    try { vid.currentTime = 0; } catch (e) {}
    const pr = vid.play(); if (pr && pr.catch) pr.catch(() => {});   // user-gesture play; ignore autoplay rejection
  } else {
    stopVideo();
    vid.style.display = "none";
    img.style.display = "";
    setImg(img, preview(p.asset));   // black until ready — never the previous photo
  }
  document.getElementById("lb-orig").href = original(p.asset);
  const lmeta = document.getElementById("lb-meta");
  if (lmeta) lmeta.innerHTML = photoMetaHtml(p);
  document.getElementById("lb-prev").classList.toggle("lb-nav-off", curPhoto === 0);
  document.getElementById("lb-next").classList.toggle("lb-nav-off", curPhoto === photoSorted.length - 1);
  if (lbZoom) lbZoom.reset();      // open fit-to-area; gestures take over from there
  lb.classList.remove("lb-hidden");
  if (!fromSwipe) showNav();       // arrows visible on open/nav (not on a swipe-driven change), fade after 2s
  fsOpen = true;
  if (!fsElement()) requestFs(lb);   // go truly fullscreen (no address bar); no-op/falls back if not allowed
  preloadAround(curPhoto);         // keep neighbours warm even when opened straight to fullscreen
}
function closeLightbox() {
  const lb = document.getElementById("lightbox");
  lb.classList.add("lb-hidden");   // hide the overlay FIRST so onFsChange sees it closed and doesn't re-close
  document.getElementById("lb-img").src = "";
  stopVideo();
  fsOpen = false;
  exitFs();                        // leave real fullscreen if we entered it
  showNav();                       // dock remains open → show its arrows, fade after 2s
  // the dock stays open + the map stays unchanged
}

// ----------------------------------------------------------------------------- panel collapse
function initCollapse() {
  // The sidebar always starts OPEN when the interface is opened (it can still be collapsed during the session).
  document.body.classList.remove("collapsed");
}
function setCollapsed(v) {
  document.body.classList.toggle("collapsed", v);
  try { localStorage.setItem("tt_collapsed", v ? "1" : "0"); } catch (e) {}
  setTimeout(resizeActive, 220);
}
// Tapping the map (a genuine click, not a pan, and not a marker) hides the side panel when it's showing.
function collapseIfShown() {
  if (suppressMapClick) { suppressMapClick = false; return; }   // a track click (speed popup) handled this
  if (!document.body.classList.contains("collapsed")) setCollapsed(true);
}

// ----------------------------------------------------------------------------- UI wiring
let tripLive = false;   // is a trip currently running? the spacing sliders only CHANGE a live trip
// Show the interval/distance rows for the selected mode (hybrid = both). A new trip always starts at 5s/25m,
// so while nothing is live we hide the sliders — they'd otherwise imply they set the start value (they don't).
function syncSpacingRows() {
  const sel = document.getElementById("trip-mode");
  const m = sel ? sel.value : "hybrid";
  const ivRow = document.getElementById("iv-row"), dRow = document.getElementById("dist-row");
  if (ivRow) ivRow.hidden = !tripLive || (m === "distance");
  if (dRow) dRow.hidden = !tripLive || (m === "time");
}
// Read the spacing controls into a request body (shared by Start and Apply).
function spacingBody() {
  const m = document.getElementById("trip-mode").value;
  const b = { interval_s: parseInt(document.getElementById("trip-interval").value, 10), mode: m };
  if (m === "distance" || m === "hybrid") b.min_distance_m = parseInt(document.getElementById("trip-distance").value, 10);
  return b;
}
// Fill the spacing controls from the active trip ONCE (when it changes), so edits aren't fought each tick.
function prefillSpacing(t) {
  if (t.id === spacingPrefillId) return;
  spacingPrefillId = t.id;
  const sel = document.getElementById("trip-mode");
  const iv = document.getElementById("trip-interval"), ivl = document.getElementById("iv-label");
  const d = document.getElementById("trip-distance"), dl = document.getElementById("dist-label");
  if (sel && t.mode) sel.value = t.mode;
  if (iv && t.interval_s) { iv.value = t.interval_s; if (ivl) ivl.textContent = t.interval_s; }
  if (d && t.min_distance_m) { d.value = t.min_distance_m; if (dl) dl.textContent = t.min_distance_m; }
  syncSpacingRows();
}

// Side-panel tabs: show one .ptab-page at a time.
function activateTab(name) {
  document.querySelectorAll("#panel-tabs .ptab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === name));
  document.querySelectorAll("#panel .ptab-page").forEach((p) => { p.hidden = (p.getAttribute("data-page") !== name); });
}
function wireTabs() {
  document.querySelectorAll("#panel-tabs .ptab").forEach((t) => { t.onclick = () => activateTab(t.getAttribute("data-tab")); });
}

function wireUI() {
  const sel = document.getElementById("basemap");
  if (sel) sel.onchange = (e) => setBasemap(e.target.value);

  const sc = document.getElementById("speed-color");   // colour-track-by-speed switch (everyone)
  if (sc) {
    sc.checked = speedColorOn;
    sc.onchange = () => {
      speedColorOn = sc.checked;
      try { localStorage.setItem("tt_speedcolor", speedColorOn ? "1" : "0"); } catch (e) {}
      renderTracks();
    };
  }

  document.getElementById("panel-toggle").onclick = () => setCollapsed(true);
  document.getElementById("panel-show").onclick = () => setCollapsed(false);

  const lb = document.getElementById("lightbox");
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  const ec = document.getElementById("edit-cancel"); if (ec) ec.onclick = closeEditModal;
  const es = document.getElementById("edit-save"); if (es) es.onclick = saveEditModal;
  const fcl = document.getElementById("filter-clear");
  if (fcl) fcl.onclick = () => { filterPeople.clear(); filterCameras.clear(); rebuildFilterOptions(); applyPhotoFilter(); };
  rebuildFilterOptions();   // render the (initially empty) filter groups
  const em = document.getElementById("edit-modal");
  if (em) em.onclick = (e) => { if (e.target === em) closeEditModal(); };   // click backdrop → cancel
  document.getElementById("lb-close").onclick = (e) => { e.stopPropagation(); closeLightbox(); };
  document.getElementById("lb-prev").onclick = (e) => { e.stopPropagation(); navPhoto(-1); };
  document.getElementById("lb-next").onclick = (e) => { e.stopPropagation(); navPhoto(1); };
  // docked photo viewer controls
  document.getElementById("pv-prev").onclick = (e) => { e.stopPropagation(); navPhoto(-1); };
  document.getElementById("pv-next").onclick = (e) => { e.stopPropagation(); navPhoto(1); };
  document.getElementById("pv-full").onclick = (e) => { e.stopPropagation(); if (photoSorted[curPhoto]) showLightbox(photoSorted[curPhoto]); };
  document.getElementById("pv-close").onclick = (e) => { e.stopPropagation(); closeDock(); };
  // Dock thumbnail: NO zoom/pan (it's low-res and looks bad scaled up) — double-tap opens fullscreen instead.
  pvZoom = createZoomPan(document.getElementById("pv-img"), { zoom: false,
    surface: document.getElementById("pv-stage"),            // gestures work over the whole stage incl. letterbox
    onDoubleTap: () => { if (photoSorted[curPhoto]) showLightbox(photoSorted[curPhoto]); },
    onSwipe: (d) => navPhoto(d, true),                       // swipe-driven change must NOT re-show the arrows
    onTap: showNav,
    ghost: document.getElementById("pv-ghost"),
    frameW: () => { const s = document.getElementById("pv-stage"); return (s && s.offsetWidth) || window.innerWidth; },
    neighborSrc: (d) => { const p = photoSorted[curPhoto + d]; if (!p) return null; const u = dockSrc(p); preloadUrl(u); return u; } });
  // Fullscreen: pinch/drag zoom; double-tap resets to fit when zoomed, or closes fullscreen when already at fit.
  lbZoom = createZoomPan(document.getElementById("lb-img"), {
    surface: document.getElementById("lightbox"),            // gestures work over the whole overlay incl. letterbox
    onDoubleTap: () => { closeLightbox(); shieldMap(); },
    onSwipe: (d) => navPhoto(d, true),                       // swipe-driven change must NOT re-show the arrows
    onTap: showNav,
    ghost: document.getElementById("lb-ghost"),
    frameW: () => window.innerWidth,
    neighborSrc: (d) => { const p = photoSorted[curPhoto + d]; if (!p) return null; const u = (p.type === "video") ? thumb(p.asset) : preview(p.asset); preloadUrl(u); return u; } });
  document.addEventListener("keydown", (e) => {
    const fsOn = lb && !lb.classList.contains("lb-hidden");
    const dockOn = document.body.classList.contains("pv-open");
    if (!fsOn && !dockOn) return;
    if (e.key === "Escape") { if (fsOn) closeLightbox(); else closeDock(); }
    else if (e.key === "ArrowLeft") navPhoto(-1);
    else if (e.key === "ArrowRight") navPhoto(1);
  });
  // the dock image source depends on viewport size (thumb on mobile, preview on desktop) — re-apply on resize
  window.addEventListener("resize", () => {
    if (document.body.classList.contains("pv-open") && photoSorted[curPhoto]) {
      const im = document.getElementById("pv-img"), want = dockSrc(photoSorted[curPhoto]);
      if (im && im.getAttribute("data-url") !== want) { setImg(im, want); if (pvZoom) pvZoom.reset(); }
    }
  });

  const po = document.getElementById("popout");
  if (po) po.href = location.protocol + "//" + location.hostname + ":8099/";
  const rl = document.getElementById("reload");   // force a fresh load from the server under a new URL (cache-bust)
  if (rl) rl.onclick = (e) => { e.preventDefault(); location.href = location.href.split("?")[0] + "?r=" + Date.now(); };

  // admin-only controls (buttons are hidden for viewers via CSS, but guard anyway)
  const iv = document.getElementById("trip-interval");
  const ivl = document.getElementById("iv-label");
  if (iv) iv.oninput = () => (ivl.textContent = iv.value);
  const dist = document.getElementById("trip-distance");
  const distl = document.getElementById("dist-label");
  if (dist) dist.oninput = () => (distl.textContent = dist.value);
  const mode = document.getElementById("trip-mode");
  if (mode) mode.onchange = syncSpacingRows;
  syncSpacingRows();
  const bStart = document.getElementById("btn-start");
  if (bStart) bStart.onclick = async () => {
    // A new trip ALWAYS starts at 5s / 25m (not whatever the sliders show) — the sliders only change it afterwards.
    const mode = document.getElementById("trip-mode").value;
    const body = { mode, interval_s: 5, name: document.getElementById("trip-name").value.trim() };
    if (mode === "distance" || mode === "hybrid") body.min_distance_m = 25;
    const col = document.getElementById("trip-color");
    if (col) body.color = col.value;
    const t = await jpost(`${API}/trips/start`, body);
    document.getElementById("trip-name").value = "";
    activateTab("main");     // jump back to the Trips tab to show the live trip
    autoFollowLive = true;   // follow the trip we just started
    if (t) updateActiveBox({ active: true, trip: t });   // reflect live state + prefill sliders to the real 5s/25m
    await refreshTrips();
    if (t && t.id) await setOnlyTrip(t.id, true);
  };
  const bApply = document.getElementById("btn-apply");   // change spacing on the LIVE trip (no restart)
  if (bApply) bApply.onclick = async () => {
    if (activeTripId == null) return;
    await jpost(`${API}/trips/${activeTripId}/spacing`, spacingBody());
    await refreshTrips();
  };
  const bStop = document.getElementById("btn-stop");
  if (bStop) bStop.onclick = async () => { await jpost(`${API}/trips/stop`, {}); await refreshTrips(); };
}

// ----------------------------------------------------------------------------- live loop + trips
function metaOf(t) {
  return {
    mode: (t && t.mode === "distance") ? "distance" : "time",
    interval_s: (t && t.interval_s) || 15,
    min_distance_m: (t && t.min_distance_m) || 25,
  };
}

async function tick() {
  try {
    const st = await jget(`${API}/state`);
    activeTripId = st.active ? st.trip.id : null;
    if (st.active) { tripsById[st.trip.id] = st.trip; const lv = views.get(st.trip.id); if (lv) lv.meta = metaOf(st.trip); }
    updateActiveBox(st);
    if (++tickN % 3 === 0) { try { await refreshTrips(); } catch (e) {} }   // keep trips list fresh in ALL browsers
    // Before the user has picked anything, auto-show the live trip (alone) as it appears/changes.
    if (st.active && autoFollowLive && !views.has(st.trip.id)) { await setOnlyTrip(st.trip.id, true); await refreshTrips(); updateSpeedOverlay(); return; }
    const lv = (activeTripId != null) ? views.get(activeTripId) : null;
    if (lv) await appendViewData(lv, false);                 // grow the live trip
    updateSpeedOverlay();
    if (lv && centeredTripId !== activeTripId && lv.latlngs.length) {
      const h = lv.latlngs[lv.latlngs.length - 1];
      mapSetView(h[0], h[1], Math.max(mapZoom(), 16));   // auto-centre ONCE at trip start
      centeredTripId = activeTripId;
    }
  } catch (e) { console.warn("tick", e); }
}

// Live current-speed pill: shown only while the live trip is among the shown trips.
function updateSpeedOverlay() {
  const el = document.getElementById("speed-overlay");
  if (!el) return;
  const v = (activeTripId != null) ? views.get(activeTripId) : null;
  if (!v) { el.classList.add("hidden"); return; }
  if (v.latestSpeed == null) {
    el.style.background = "rgba(0,0,0,0.66)";
    el.innerHTML = `– <small>km/h</small>`;
    el.classList.remove("hidden");
    return;
  }
  const latestSpeed = v.latestSpeed;
  const kmh = Math.round(Math.max(0, latestSpeed * 3.6));
  const age = v.latestSpeedTs ? Math.max(0, Date.now() / 1000 - v.latestSpeedTs) : 0;
  // Expected gap between points: distance mode scales with the CURRENT speed (slow driving → long gaps,
  // which are NOT stale); time mode is the fixed interval. Only fade once age exceeds that cadence, so a
  // true stop / signal loss fades promptly but normal slow driving doesn't.
  const expected = (v.meta.mode === "distance")
    ? (v.meta.min_distance_m || 25) / Math.max(latestSpeed, 0.5)
    : (v.meta.interval_s || 15);
  const staleStart = Math.max(5, 1.3 * expected);
  const staleFull = staleStart + Math.max(15, 2 * expected);
  let bgA = 0.66, ageTxt = "", stale = false;
  if (age > staleStart) {
    stale = true;
    const f = Math.min(1, (age - staleStart) / (staleFull - staleStart));
    bgA = 0.66 - f * (0.66 - 0.10);                               // dark → nearly transparent with age
    ageTxt = age < 90 ? ` · ${Math.round(age)}s` : ` · ${Math.round(age / 60)}m`;
  }
  el.style.background = `rgba(0,0,0,${bgA.toFixed(2)})`;
  el.innerHTML = `${stale ? "~" : ""}${kmh} <small>km/h${ageTxt}</small>`;   // ~ = last-known (stale)
  el.classList.remove("hidden");
}

// Keep the Start-tab buttons in sync with whether a trip is live (the live-trip card was removed — its info is
// redundant with the trips list). When live: show Stop + Apply, hide Start, and prefill spacing from the trip.
function updateActiveBox(st) {
  const stop = document.getElementById("btn-stop");
  const start = document.getElementById("btn-start");
  const apply = document.getElementById("btn-apply");
  tripLive = !!st.active;
  if (st.active) {
    if (stop) stop.hidden = false; if (start) start.hidden = true; if (apply) apply.hidden = false;
    prefillSpacing(st.trip);
  } else {
    if (stop) stop.hidden = true; if (start) start.hidden = false; if (apply) apply.hidden = true;
    spacingPrefillId = null;
  }
  syncSpacingRows();   // reveal the sliders only while a trip is live
}

async function refreshTrips() {
  const trips = await jget(`${API}/trips`);
  tripsById = {};
  for (const t of trips) tripsById[t.id] = t;
  latestTripId = trips.length ? trips[0].id : null;   // API orders by started_at DESC → [0] is most recent
  for (const t of trips) { const v = views.get(t.id); if (v) { v.color = t.color || DEFAULT_COLOR; v.meta = metaOf(t); } }
  const ul = document.getElementById("trip-list");
  ul.innerHTML = "";
  for (const t of trips) {
    const li = document.createElement("li");
    li.dataset.tripId = t.id;
    if (views.has(t.id)) li.classList.add("sel");
    const started = new Date(t.started_at).toLocaleString();
    const color = t.color || DEFAULT_COLOR;
    li.innerHTML =
      `<div class="t-main"><b><span class="t-swatch" style="background:${esc(color)}"></span>${esc(t.name || ("Trip " + t.id))}</b> ${t.active ? '<span class="live">● LIVE</span>' : ""}
         <div class="t-sub">${started} · ${t.points} pts · ${t.photos} 📷</div></div>
       <div class="t-act">
         <button data-a="sync" title="Re-scan immich for photos">⟳</button>
         <button data-a="edit" title="Edit name &amp; colour">✎</button>
         <button data-a="del" title="Delete">🗑</button>
       </div>`;
    li.querySelector(".t-main").onclick = () => { autoFollowLive = false; toggleTrip(t.id); };   // click toggles the trip on/off
    li.querySelector('[data-a="sync"]').onclick = async (e) => {
      e.stopPropagation();
      const r = await jpost(`${API}/trips/${t.id}/sync_photos`, {});
      const v = views.get(t.id);
      if (v) { v.lastPhotoId = 0; v.photos = []; await appendViewData(v, false); }
      await refreshTrips();
      if (r && r.added != null) console.info("sync added", r.added, "scanned", r.scanned);
    };
    li.querySelector('[data-a="edit"]').onclick = (e) => { e.stopPropagation(); openEditModal(t); };
    li.querySelector('[data-a="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (confirm("Delete this trip and all its track points and photo markers?")) {
        await jdel(`${API}/trips/${t.id}`);
        if (views.has(t.id)) { views.delete(t.id); if (focusId === t.id) focusId = null; rebuildPhotos(); renderActiveEngine(); if (!views.size) closeDock(); }
        await refreshTrips();
      }
    };
    ul.appendChild(li);
  }
}

function highlightList() {
  document.querySelectorAll("#trip-list li").forEach((li) => {
    li.classList.toggle("sel", views.has(parseInt(li.dataset.tripId, 10)));
  });
}

// Build a fresh (data-less) view object for a trip.
function addTripView(id) {
  const t = tripsById[id] || {};
  const v = { id, color: t.color || DEFAULT_COLOR, meta: metaOf(t),
    pts: [], latlngs: [], ts: [], lastPointId: 0, lastPhotoId: 0, photos: [], latestSpeed: null, latestSpeedTs: 0 };
  views.set(id, v);
  return v;
}
// Rebuild the aggregate `photos` from every shown trip (sortPhotos dedupes by asset).
function rebuildPhotos() {
  photos = [];
  for (const v of views.values()) for (const ph of v.photos) photos.push(ph);
  const ca = currentAsset();
  if (ca && !photos.some((p) => p.asset === ca)) closeDock();   // the open photo's trip was removed
  rebuildFilterOptions();   // refresh the People/Camera filter options to match the shown trips
}

// Show ONLY this trip (used on open + auto-follow of the live trip).
async function setOnlyTrip(id, fit) {
  views.clear();
  focusId = id;
  photos = []; photoSorted = []; curPhoto = -1;
  setFollow(false);
  clearRenders();
  closeDock();
  const v = addTripView(id);
  highlightList();
  await appendViewData(v, fit);
}

// Toggle a trip in/out of the shown set (multi-select).
async function toggleTrip(id) {
  if (views.has(id)) {
    views.delete(id);
    if (focusId === id) focusId = null;
    rebuildPhotos();
    renderActiveEngine();
    highlightList();
    if (!views.size) closeDock();
    return;
  }
  const v = addTripView(id);
  focusId = id;
  highlightList();
  await appendViewData(v, true);
}

// Fetch + append new track points / photos for ONE view, then re-render. `fit` re-fits to all shown trips.
async function appendViewData(v, fit) {
  const pts = await jget(`${API}/trips/${v.id}/track?since_id=${v.lastPointId}`);
  if (pts.length) {
    for (const p of pts) { v.pts.push({ lat: p.lat, lon: p.lon, ts: p.ts, id: p.id, speed: p.speed }); if (p.id > v.lastPointId) v.lastPointId = p.id; }
    // Points can arrive out of time-order (the phone replays outage-buffered fixes: newer id, older ts).
    v.pts.sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
    v.latlngs = v.pts.map((p) => [p.lat, p.lon]);
    v.ts = v.pts.map((p) => p.ts);
    const last = v.pts[v.pts.length - 1];
    v.latestSpeed = (last && last.speed != null) ? last.speed : null;
    v.latestSpeedTs = last ? last.ts : 0;
    renderTracks();
  }
  const phs = await jget(`${API}/trips/${v.id}/photos?since_id=${v.lastPhotoId}`);
  let added = false;
  const have = new Set(v.photos.map((p) => p.asset));
  for (const ph of phs) {
    if (!have.has(ph.asset)) { v.photos.push(ph); have.add(ph.asset); added = true; }
    if (ph.id > v.lastPhotoId) v.lastPhotoId = ph.id;
  }
  if (added) { rebuildPhotos(); renderPhotosFull(); }
  if (fit && v.latlngs.length) { fitViews(); centeredTripId = v.id; }
  followIfNeeded();
}

// ---- trip edit modal (name + track colour) ----
let editTripId = null;
function openEditModal(t) {
  editTripId = t.id;
  const nm = document.getElementById("edit-name"), cl = document.getElementById("edit-color");
  if (nm) nm.value = t.name || "";
  if (cl) cl.value = t.color || DEFAULT_COLOR;
  const m = document.getElementById("edit-modal");
  if (m) m.classList.remove("modal-hidden");
}
function closeEditModal() {
  const m = document.getElementById("edit-modal");
  if (m) m.classList.add("modal-hidden");
  editTripId = null;
}
async function saveEditModal() {
  if (editTripId == null) return;
  const name = document.getElementById("edit-name").value;
  const color = document.getElementById("edit-color").value;
  await jpost(`${API}/trips/${editTripId}/rename`, { name, color });
  const v = views.get(editTripId);
  if (v) v.color = color;
  if (tripsById[editTripId]) { tripsById[editTripId].name = name; tripsById[editTripId].color = color; }
  closeEditModal();
  renderTracks();
  await refreshTrips();
}

document.addEventListener("DOMContentLoaded", init);
