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
let gTrackSegs = [], gMarkers = [], gHead = null, gEnds = [];
let gInfo = null, gPickInfo = null;   // reused Google InfoWindows (track-point popup / cluster picker)
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
let gridOpen = false, _gridKey = "";   // photo-grid overlay (replaces the map) state
let tagMode = false;                   // grid "Tag" mode: per-thumbnail Relatives/World badges (admin)
const assetTags = new Map();           // asset → Set of visibility tags ('Relatives'/'World'); client cache
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
  lmap.on("zoomend", () => { if (views.size) { renderTracks(); renderPhotosFull(); } });   // re-trim the head + re-cluster photos on zoom

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
  gmap.addListener("zoom_changed", () => { if (views.size) { renderTracks(); renderPhotosFull(); } });   // re-trim the head + re-cluster photos on zoom
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
  // While a track is being edited, NEVER break its polyline at gaps — draw it fully connected so every
  // stretch (deletions, joins, large gaps) stays visible and clickable. Normal view keeps gap-breaking.
  if (editMode && v.id === etTripId) return v.latlngs.length ? [v.latlngs.slice()] : [];
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
  if (editMode && v.id === etTripId) return v.latlngs.length ? [{ band: 0, color: v.color, pts: v.latlngs.slice() }] : [];
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
  let best = null, bd = Infinity, bv = null, bi = -1;
  for (const v of views.values()) for (let i = 0; i < v.pts.length; i++) {
    const p = v.pts[i], d = haversineM(lat, lon, p.lat, p.lon);
    if (d < bd) { bd = d; best = p; bv = v; bi = i; }
  }
  return best ? { p: best, v: bv, i: bi } : null;
}
// Cumulative along-track distance (metres) from the trip's first point to pts[idx].
function distFromStart(v, idx) {
  let d = 0;
  for (let k = 1; k <= idx && k < v.pts.length; k++)
    d += haversineM(v.pts[k - 1].lat, v.pts[k - 1].lon, v.pts[k].lat, v.pts[k].lon);
  return d;
}
function showTrackPopup(lat, lon) {
  const hit = nearestTrackPt(lat, lon);
  if (!hit) return;
  const p = hit.p;
  const kmh = (p.speed != null) ? (Math.round(Math.max(0, p.speed * 3.6)) + " km/h") : "– km/h";
  const when = p.ts ? new Date(p.ts * 1000).toLocaleTimeString() : "";
  const fromStart = fmtDist(distFromStart(hit.v, hit.i));
  const html = `<div class="tk-pop"><button class="tk-x" onclick="ttCloseTrackPopup()" title="Close">×</button>` +
    `<b>${kmh}</b><br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${when ? `<br><span>${esc(when)}</span>` : ""}` +
    `<br><span>${fromStart} from start</span></div>`;
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
  if (editMode) { suppressMapClick = true; setTimeout(() => { suppressMapClick = false; }, 60); handleEditTrackClick(lat, lon); return; }
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
    gEnds.forEach((m) => m.setMap(null)); gEnds = [];
    for (const v of views.values()) drawGoogleTrack(v, v === live ? hs : null);
    for (const v of views.values()) addGoogleEnds(v, v === live);
    if (hs) {
      const pos = { lat: hs.head[0], lng: hs.head[1] };
      if (!gHead) gHead = new google.maps.Marker({ position: pos, map: gmap, icon: gHeadIcon(hs), zIndex: 9999 });
      else { gHead.setPosition(pos); gHead.setIcon(gHeadIcon(hs)); gHead.setMap(gmap); }
    } else if (gHead) { gHead.setMap(null); gHead = null; }
  } else {
    lTrackLayer.clearLayers(); lSpeedLayer.clearLayers();
    for (const v of views.values()) drawLeafletTrack(v, v === live ? hs : null);
    for (const v of views.values()) addLeafletEnds(v, v === live);
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
// Small start (green) / end (red) markers for each shown track. The live trip's end is its moving head, so
// only its start is marked; finished trips get both.
function endStyle(kind) {
  return kind === "start" ? { fill: "#22c55e", ring: "#0f5132" } : { fill: "#ef4444", ring: "#7f1d1d" };
}
function addLeafletEnds(v, isLive) {
  if (!v.latlngs.length) return;
  const mk = (ll, kind, title) => {
    const s = endStyle(kind);
    L.circleMarker(ll, { radius: 5, weight: 2, color: s.ring, fillColor: s.fill, opacity: 1, fillOpacity: 1 })
      .bindTooltip(title, { direction: "top" }).addTo(lTrackLayer).bringToFront();
  };
  mk(v.latlngs[0], "start", "Start");
  if (!isLive && v.latlngs.length > 1) mk(v.latlngs[v.latlngs.length - 1], "end", "End");
}
function addGoogleEnds(v, isLive) {
  if (!v.latlngs.length) return;
  const mk = (ll, kind, title) => {
    const s = endStyle(kind);
    gEnds.push(new google.maps.Marker({ position: { lat: ll[0], lng: ll[1] }, map: gmap, title, zIndex: 9000,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: s.fill, fillOpacity: 1, strokeColor: s.ring, strokeWeight: 2 } }));
  };
  mk(v.latlngs[0], "start", "Start");
  if (!isLive && v.latlngs.length > 1) mk(v.latlngs[v.latlngs.length - 1], "end", "End");
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
// Each rendered marker (dot OR cluster) registers how to toggle its "current" highlight, keyed by every
// asset it represents — so selecting any photo (incl. one inside a cluster) can light up its marker at once.
let photoEntries = [], photoByAsset = new Map(), _curEntry = null;
function registerPhotoEntry(assets, setCur) {
  const e = { setCur };
  photoEntries.push(e);
  for (const a of assets) photoByAsset.set(a, e);
}
function addLMarker(ph) {
  const cur = ph.asset === currentAsset();
  const m = L.circleMarker([ph.lat, ph.lon], lDotStyle(cur)).addTo(lPhotoLayer);
  m.on("click", () => openPhoto(ph.asset, false));
  ph._lmarker = m;
  if (cur) m.bringToFront();
  registerPhotoEntry([ph.asset], (on) => { m.setStyle(lDotStyle(on)); if (on) m.bringToFront(); });
}
function addGMarker(ph) {
  const cur = ph.asset === currentAsset();
  const m = new google.maps.Marker({ position: { lat: ph.lat, lng: ph.lon }, map: gmap,
    icon: gDotIcon(cur), title: ph.name || "", zIndex: cur ? 1000 : 1 });
  m.addListener("click", () => openPhoto(ph.asset, false));
  ph._gmarker = m;
  gMarkers.push(m);
  registerPhotoEntry([ph.asset], (on) => { m.setIcon(gDotIcon(on)); m.setZIndex(on ? 1000 : 1); });
}
function addMarkerActive(ph) { if (engine === "google" && gmap) addGMarker(ph); else addLMarker(ph); }
// ---- photo clustering (screen-proximity; re-clustered on zoom). Singletons = dots; groups = count badges. ----
const CLUSTER_PX = 44;
function mapMaxZoom() { return engine === "google" ? 21 : (lmap && lmap.getMaxZoom ? lmap.getMaxZoom() : 19); }
function buildClusters(list) {
  const out = [], used = new Array(list.length).fill(false);
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const thr = Math.max(metersPerPixel(list[i].lat) * CLUSTER_PX, 1);
    const members = [list[i]]; used[i] = true;
    let sumLat = list[i].lat, sumLon = list[i].lon, spread = 0;
    for (let j = i + 1; j < list.length; j++) {
      if (used[j]) continue;
      const d = haversineM(list[i].lat, list[i].lon, list[j].lat, list[j].lon);
      if (d < thr) { used[j] = true; members.push(list[j]); sumLat += list[j].lat; sumLon += list[j].lon; if (d > spread) spread = d; }
    }
    out.push({ photos: members, lat: sumLat / members.length, lon: sumLon / members.length, spread });
  }
  return out;
}
function clusterSize(n) { return n < 10 ? 32 : n < 100 ? 38 : 44; }
function addLClusterMarker(c) {
  const n = c.photos.length, sz = clusterSize(n);
  const mk = (cur) => L.divIcon({ className: "", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    html: `<div class="photo-cluster${cur ? " cur" : ""}" style="width:${sz}px;height:${sz}px">${n}</div>` });
  const m = L.marker([c.lat, c.lon], { zIndexOffset: 500, icon: mk(c.photos.some((p) => p.asset === currentAsset())) }).addTo(lPhotoLayer);
  m.on("click", () => onClusterClick(c));
  registerPhotoEntry(c.photos.map((p) => p.asset), (on) => m.setIcon(mk(on)));
}
function addGClusterMarker(c) {
  const n = c.photos.length, sz = clusterSize(n);
  const icon = (cur) => ({ path: google.maps.SymbolPath.CIRCLE, scale: sz / 2, fillColor: cur ? "#ffd400" : "#1565c0", fillOpacity: 0.92, strokeColor: "#fff", strokeWeight: 2 });
  const label = (cur) => ({ text: String(n), color: cur ? "#000" : "#fff", fontSize: n < 100 ? "12px" : "11px", fontWeight: "700" });
  const isCur = c.photos.some((p) => p.asset === currentAsset());
  const m = new google.maps.Marker({ position: { lat: c.lat, lng: c.lon }, map: gmap, zIndex: 500, icon: icon(isCur), label: label(isCur) });
  m.addListener("click", () => onClusterClick(c));
  gMarkers.push(m);
  registerPhotoEntry(c.photos.map((p) => p.asset), (on) => { m.setIcon(icon(on)); m.setLabel(label(on)); });
}
function onClusterClick(c) {
  const z = mapZoom(), zmax = mapMaxZoom();
  if (c.spread > 1 && z < zmax - 0.5) mapSetView(c.lat, c.lon, Math.min(zmax, Math.round(z) + 2));   // zoom in to split (re-clusters on zoomend)
  else openClusterPicker(c);                                                                          // co-located / max zoom → pick from thumbnails
}
function openClusterPicker(c) {
  const n = c.photos.length;
  const html = `<div class="cl-pick-title">${n} photo${n === 1 ? "" : "s"} here</div><div class="cl-pick">`
    + c.photos.map((p) => `<img class="cl-th" title="${esc(p.name || "")}" src="${thumb(p.asset)}" loading="lazy" onclick="ttPickPhoto('${esc(p.asset)}')">`).join("") + "</div>";
  if (engine === "google") {
    if (!gPickInfo) gPickInfo = new google.maps.InfoWindow();
    gPickInfo.setContent(html); gPickInfo.setPosition({ lat: c.lat, lng: c.lon }); gPickInfo.open(gmap);
  } else {
    L.popup({ autoPan: true, maxWidth: 560 }).setLatLng([c.lat, c.lon]).setContent(html).openOn(lmap);
  }
}
window.ttPickPhoto = function (asset) { try { if (lmap) lmap.closePopup(); } catch (e) {} try { if (gPickInfo) gPickInfo.close(); } catch (e) {} openPhoto(asset, false); };
function renderPhotosFull() {
  photos.forEach((ph) => { ph._lmarker = null; ph._gmarker = null; });   // drop stale refs
  photoEntries = []; photoByAsset = new Map(); _curEntry = null;
  sortPhotos();
  const clusters = buildClusters(photoSorted);
  if (engine === "google") {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    for (const c of clusters) (c.photos.length === 1) ? addGMarker(c.photos[0]) : addGClusterMarker(c);
  } else {
    lPhotoLayer.clearLayers();
    for (const c of clusters) (c.photos.length === 1) ? addLMarker(c.photos[0]) : addLClusterMarker(c);
  }
  const ca = currentAsset();
  _curEntry = ca ? (photoByAsset.get(ca) || null) : null;
}
// Move the "current" highlight (yellow) to whatever marker — dot OR cluster — represents the current photo.
function updatePhotoDots() {
  const ca = currentAsset();
  const e = ca ? (photoByAsset.get(ca) || null) : null;
  if (_curEntry && _curEntry !== e) _curEntry.setCur(false);
  if (e) e.setCur(true);
  _curEntry = e;
  updateGridCurrent();   // keep the grid's current-photo highlight in sync with the map dot
}
function renderActiveEngine() {
  renderTracks(); renderPhotosFull();
  if (editMode) { ensureEditClickHandlers(); renderEditMarkers(); }
  if (replayOn && replayView && replayView.pts[replayIdx]) { clearReplayMarker(); placeReplayMarker(replayView.pts[replayIdx].lat, replayView.pts[replayIdx].lon); }
}
function clearRenders() {
  if (lPhotoLayer) lPhotoLayer.clearLayers();
  if (lTrackLayer) lTrackLayer.clearLayers();
  if (lSpeedLayer) lSpeedLayer.clearLayers();
  if (lHead) { lmap.removeLayer(lHead); lHead = null; }
  if (gmap) {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    gTrackSegs.forEach((pl) => pl.setMap(null)); gTrackSegs = [];
    gEnds.forEach((m) => m.setMap(null)); gEnds = [];
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
  // People = AND: the photo must contain EVERY selected person.
  if (filterPeople.size) { const pl = ph.people || []; if (![...filterPeople].every((n) => pl.includes(n))) return false; }
  // Cameras = OR: the photo's (single) camera must be any one of the selected.
  if (filterCameras.size && !filterCameras.has(ph.camera || "")) return false;
  return true;
}
// Distinct images shown on the track(s) under the active filter → the Filter tab's "nn images" readout.
function filterShownCount() {
  const seen = new Set();
  for (const ph of photos) if (photoPasses(ph)) seen.add(ph.asset);
  return seen.size;
}
function updateFilterCount() {
  const el = document.getElementById("filter-count");
  if (!el) return;
  const n = filterShownCount();
  el.textContent = `${n} image${n === 1 ? "" : "s"}`;
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
  updateFilterCount();
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
  updateFilterCount();
  if (gridOpen) renderPhotoGrid();          // keep the open grid in sync with the filter
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
  // Double-tap: if zoomed in → reset to fit. If ALREADY at fit → zoom to MAX toward the tap when the view asks
  // for it (opts.doubleTapZoom, fullscreen), else the view's own action (opts.onDoubleTap): the dock opens
  // fullscreen. No onDoubleTap → just reset. (fx,fy) = the tap's focal point in screen px.
  function onDouble(fx, fy) {
    if (canZoom && scale > 1.001) { reset(true); return; }                     // zoomed → reset to fit (unchanged)
    if (canZoom && opts.doubleTapZoom) { zoomAt(fx, fy, MAX, true); return; }   // at fit → zoom to max toward the tap
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
  function zoomAt(fx, fy, ns, anim) {                        // zoom toward focal point (fx,fy) in screen px
    ns = Math.max(MIN, Math.min(MAX, ns));
    const g = geom(), k = 1 - ns / scale;                    // keep the focal element-point under the finger/cursor
    tx += ((fx - g.cx) - tx) * k; ty += ((fy - g.cy) - ty) * k;
    scale = ns; clamp(); apply(!!anim);
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
        if (now - lastTap < 320) { try { e.preventDefault(); } catch (x) {} onDouble(e.clientX, e.clientY); lastTap = 0; }   // double → reset-fit / zoom-max / open
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
  updateGridCurrent();        // keep the grid outline + top progress bar following navigation
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
  updateDockTags();               // admin Relatives/World buttons for this photo
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

// ---- photo visibility tags (admin): Relatives / World, mirrored into immich by the backend ----
function tagsOf(asset) { let s = assetTags.get(asset); if (!s) { s = new Set(); assetTags.set(asset, s); } return s; }
function hasTag(asset, tag) { return tagsOf(asset).has(tag); }
function ingestTags(ph) { if (ph && ph.asset) assetTags.set(ph.asset, new Set(ph.tags || [])); }
function cssq(s) { return String(s).replace(/["\\]/g, "\\$&"); }
async function setTag(asset, tag, on) {
  const s = tagsOf(asset); if (on) s.add(tag); else s.delete(tag);
  updateTagCounts(); refreshTagUI(asset);
  try { await jpost(`${API}/photo/${encodeURIComponent(asset)}/tag`, { tag, on }); }
  catch (e) { if (on) s.delete(tag); else s.add(tag); updateTagCounts(); refreshTagUI(asset); }
}
async function tagAllShown(tag) {
  const targets = photoSorted.filter((p) => !hasTag(p.asset, tag)).map((p) => p.asset);
  if (!targets.length) return;
  for (const a of targets) tagsOf(a).add(tag);
  updateTagCounts(); if (gridOpen) renderPhotoGrid(true); updateDockTags();
  for (const a of targets) { try { await jpost(`${API}/photo/${encodeURIComponent(a)}/tag`, { tag, on: true }); } catch (e) {} }
}
// Reflect one asset's tag state into the open grid cell + the dock buttons (no full re-render).
function refreshTagUI(asset) {
  if (asset == null) return;
  const wrap = document.getElementById("pg-items");
  if (wrap) {
    const cell = wrap.querySelector(`.pg-cell[data-asset="${cssq(asset)}"]`);
    if (cell) cell.querySelectorAll(".pg-tag").forEach((b) => b.classList.toggle("on", hasTag(asset, b.dataset.tag)));
  }
  if (currentAsset() === asset) updateDockTags();
}
function updateTagCounts() {
  const el = document.getElementById("pg-tagcounts"); if (!el) return;
  let rel = 0, wor = 0;
  for (const p of photoSorted) { if (hasTag(p.asset, "Relatives")) rel++; if (hasTag(p.asset, "World")) wor++; }
  el.textContent = `👪 ${rel}\u2003🌍 ${wor}`;
}
function updateDockTags() {
  const box = document.getElementById("pv-tags"); if (!box) return;
  const a = currentAsset();
  const show = isAdmin && a != null;
  box.hidden = !show;
  if (show) box.querySelectorAll(".pv-tag[data-tag]").forEach((b) => b.classList.toggle("on", hasTag(a, b.dataset.tag)));
}
// Delete the current photo from immich (move to trash) + drop its marker. Confirms first.
async function deletePhoto() {
  const a = currentAsset(); if (!a || !isAdmin) return;
  if (!confirm("Delete this photo?\nIt will be moved to the immich trash (recoverable there).")) return;
  try { await jdel(`${API}/photo/${encodeURIComponent(a)}`); } catch (e) { alert("Delete failed"); return; }
  const nextAsset = (photoSorted[curPhoto + 1] && photoSorted[curPhoto + 1].asset)
                 || (photoSorted[curPhoto - 1] && photoSorted[curPhoto - 1].asset) || null;
  for (const v of views.values()) v.photos = v.photos.filter((p) => p.asset !== a);
  assetTags.delete(a);
  photos = []; for (const v of views.values()) for (const ph of v.photos) photos.push(ph);
  rebuildFilterOptions();
  renderPhotosFull();
  sortPhotos();
  if (gridOpen) renderPhotoGrid(true);
  if (!photoSorted.length) { closeDock(); }
  else {
    const target = (nextAsset && photoSorted.some((p) => p.asset === nextAsset))
      ? nextAsset : photoSorted[Math.min(curPhoto, photoSorted.length - 1)].asset;
    openPhoto(target, fsOpen);
  }
  refreshTrips().catch(() => {});   // update the trip list's photo count
}
// Red current-photo position bar + trip name at the top of the grid.
function updateGridProgress() {
  const fill = document.getElementById("pg-progress-fill"); if (!fill) return;
  const total = photoSorted.length;
  const frac = (total > 0 && curPhoto >= 0 && curPhoto < total) ? (curPhoto + 1) / total : 0;
  fill.style.width = (frac * 100).toFixed(2) + "%";
}
function updateGridTripName() {
  const el = document.getElementById("pg-trip"); if (!el) return;
  const tid = (focusId != null) ? focusId : (views.size ? [...views.keys()][0] : null);
  const t = (tid != null) ? tripsById[tid] : null;
  el.textContent = t ? (t.name || ("Trip " + tid)) : "";
}
function applyTagModeUI() {
  const on = tagMode && isAdmin;
  const cb = document.getElementById("pg-tagmode"); if (cb) cb.checked = tagMode;
  ["pg-tagall-rel", "pg-tagall-world"].forEach((id) => { const b = document.getElementById(id); if (b) b.hidden = !on; });
  const tc = document.getElementById("pg-tagcounts"); if (tc) tc.hidden = !on;
  const tm = document.getElementById("pg-tagmode-row"); if (tm) tm.hidden = !isAdmin;
  if (gridOpen) renderPhotoGrid(true);
}

// ---- photo grid: a close button on the map replaces it with a configurable grid of the CURRENT (filtered)
// thumbnails; the grid's own close button brings the map back. Tapping a thumbnail opens it in the dock. ----
function gridCols() {
  let n = 4;
  try { n = parseInt(localStorage.getItem("tt_gridcols") || "4", 10); } catch (e) {}
  return Math.min(20, Math.max(2, n || 4));
}
function renderPhotoGrid(force) {
  const wrap = document.getElementById("pg-items");
  if (!wrap) return;
  sortPhotos();
  const items = photoSorted;
  const cnt = document.getElementById("pg-count");
  if (cnt) cnt.textContent = `${items.length} image${items.length === 1 ? "" : "s"}`;
  wrap.style.gridTemplateColumns = `repeat(${gridCols()}, 1fr)`;
  updateGridProgress(); updateGridTripName(); updateTagCounts();
  const tagging = tagMode && isAdmin;
  const key = (tagging ? "T:" : "") + items.map((p) => p.asset).join(",");
  if (!force && key === _gridKey) return;   // same photos → keep the DOM (no image-reload flicker)
  _gridKey = key;
  wrap.innerHTML = "";
  const ca = currentAsset();
  for (const p of items) {
    const cell = document.createElement("button");
    cell.className = "pg-cell"; cell.title = p.name || ""; cell.dataset.asset = p.asset;
    if (p.asset === ca) cell.classList.add("pg-cur");
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = p.name || ""; img.src = thumb(p.asset);
    cell.appendChild(img);
    if (p.type === "video") { const pl = document.createElement("span"); pl.className = "pg-play"; pl.textContent = "▶"; cell.appendChild(pl); }
    if (tagging) {
      for (const tg of [["Relatives", "rel", "👪"], ["World", "world", "🌍"]]) {
        const b = document.createElement("span");
        b.className = "pg-tag " + tg[1] + (hasTag(p.asset, tg[0]) ? " on" : "");
        b.dataset.tag = tg[0]; b.textContent = tg[2];
        b.onclick = (e) => { e.stopPropagation(); const on = !hasTag(p.asset, tg[0]); b.classList.toggle("on", on); setTag(p.asset, tg[0], on); };
        cell.appendChild(b);
      }
    }
    cell.onclick = () => openPhoto(p.asset, false);   // open in the dock, same as clicking a map dot
    wrap.appendChild(cell);
  }
}
function openPhotoGrid() {
  gridOpen = true;
  document.body.classList.add("grid-open");
  const g = document.getElementById("photogrid"); if (g) g.hidden = false;
  applyTagModeUI();
  renderPhotoGrid(true);
  updateGridCurrent();   // if a photo is already open, scroll its cell into view
}
function closePhotoGrid() {
  gridOpen = false;
  document.body.classList.remove("grid-open");
  const g = document.getElementById("photogrid"); if (g) g.hidden = true;
  setTimeout(resizeActive, 60);           // map revealed again → re-fit
}
// Outline the grid cell of the photo currently open in the dock (follows dock/fullscreen navigation) and,
// while the grid is open, scroll it just enough to keep that cell fully visible.
function updateGridCurrent() {
  const wrap = document.getElementById("pg-items");
  if (!wrap) return;
  const ca = currentAsset();
  let cur = null;
  wrap.querySelectorAll(".pg-cell").forEach((c) => { const on = c.dataset.asset === ca; c.classList.toggle("pg-cur", on); if (on) cur = c; });
  if (gridOpen && cur) {
    const w = wrap.getBoundingClientRect(), c = cur.getBoundingClientRect();
    if (c.top < w.top) wrap.scrollTop -= (w.top - c.top);          // above the viewport → scroll up to its top
    else if (c.bottom > w.bottom) wrap.scrollTop += (c.bottom - w.bottom);   // below → scroll down to its bottom
  }
  updateGridProgress();
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
  if (editMode) return;                                         // edit mode handles map clicks itself
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
  const mg = document.getElementById("map-grid"); if (mg) mg.onclick = openPhotoGrid;
  const ms = document.getElementById("map-stats"); if (ms) ms.onclick = openStats;
  const sx = document.getElementById("stats-close"); if (sx) sx.onclick = closeStats;
  const me = document.getElementById("map-edit"); if (me) me.onclick = toggleTrackEdit;
  const et = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  et("et-box", () => { editSelectMode = !editSelectMode; if (editSelectMode) { editAddArmed = false; joinState = 0; } updateEditToolbar(); });
  et("et-all", selectAll);
  et("et-add", () => { editAddArmed = !editAddArmed; if (editAddArmed) { joinState = 0; editSelectMode = false; } updateEditToolbar(); });
  et("et-del", editDelete);
  et("et-clear", clearSelection);
  et("et-join", editJoinPressed);
  et("et-fill", fillSelection);
  et("et-ts", () => { editTsAuto = !editTsAuto; updateEditToolbar(); });
  et("et-undo", doUndo); et("et-redo", doRedo);
  et("et-left", () => nudgeSelected(-4, 0)); et("et-up", () => nudgeSelected(0, -4));
  et("et-down", () => nudgeSelected(0, 4)); et("et-right", () => nudgeSelected(4, 0));
  et("et-close", exitTrackEdit);
  try { snapPx = Math.min(100, Math.max(5, parseInt(localStorage.getItem("tt_snap_px") || "25", 10) || 25)); } catch (e) {}
  const snapI = document.getElementById("et-snap");
  if (snapI) { snapI.value = String(snapPx); snapI.onchange = () => { snapPx = Math.min(100, Math.max(5, parseInt(snapI.value, 10) || 25)); snapI.value = String(snapPx); try { localStorage.setItem("tt_snap_px", String(snapPx)); } catch (e) {} }; }
  const mwrap = document.getElementById("mapwrap");
  if (mwrap) {
    mwrap.addEventListener("mousedown", onBoxMouseDown, true);
    mwrap.addEventListener("mousemove", onEditHover);
    mwrap.addEventListener("mouseleave", () => { if (editMode) clearHighlights(); });
  }
  // Delete / Backspace key = the Delete button (when editing, and not typing in a field)
  document.addEventListener("keydown", (e) => {
    if (!editMode) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && editSel.size) { e.preventDefault(); editDelete(); }
  });
  const mr = document.getElementById("map-replay"); if (mr) mr.onclick = toggleReplay;
  const rpp = document.getElementById("rp-play"); if (rpp) rpp.onclick = () => { if (replayPlaying) stopReplayPlay(); else startReplayPlay(); };
  const rps = document.getElementById("rp-slider"); if (rps) rps.oninput = () => { stopReplayPlay(); setReplayIdx(+rps.value); };
  const rpx = document.getElementById("rp-close"); if (rpx) rpx.onclick = closeReplay;
  const pgx = document.getElementById("pg-close"); if (pgx) pgx.onclick = closePhotoGrid;
  const pgc = document.getElementById("pg-cols");
  if (pgc) {
    try { pgc.value = String(gridCols()); } catch (e) {}
    const upd = () => {
      const v = document.getElementById("pg-cols-v"); if (v) v.textContent = pgc.value;
      try { localStorage.setItem("tt_gridcols", pgc.value); } catch (e) {}
      const w = document.getElementById("pg-items"); if (w) w.style.gridTemplateColumns = `repeat(${gridCols()}, 1fr)`;
    };
    pgc.oninput = upd; upd();
  }
  const tgm = document.getElementById("pg-tagmode"); if (tgm) tgm.onchange = () => { tagMode = tgm.checked; applyTagModeUI(); };
  const taR = document.getElementById("pg-tagall-rel"); if (taR) taR.onclick = () => tagAllShown("Relatives");
  const taW = document.getElementById("pg-tagall-world"); if (taW) taW.onclick = () => tagAllShown("World");
  document.querySelectorAll("#pv-tags .pv-tag[data-tag]").forEach((b) => b.onclick = () => {
    const a = currentAsset(); if (a == null) return;
    const on = !hasTag(a, b.dataset.tag); b.classList.toggle("on", on); setTag(a, b.dataset.tag, on);
  });
  const pvd = document.getElementById("pv-del"); if (pvd) pvd.onclick = deletePhoto;
  // edit dialog: gap fill/unfill
  const efill = document.getElementById("edit-fill");
  if (efill) efill.onclick = async () => { if (editTripId == null) return; const el = document.getElementById("edit-fill-status"); if (el) el.textContent = "Filling gaps…"; await jpost(`${API}/trips/${editTripId}/fill_gaps`, {}); pollFillStatus(editTripId); };
  const eunfill = document.getElementById("edit-unfill");
  if (eunfill) eunfill.onclick = async () => { if (editTripId == null) return; await jpost(`${API}/trips/${editTripId}/unfill_gaps`, {}); const el = document.getElementById("edit-fill-status"); if (el) el.textContent = "Removed filled points"; const v = views.get(editTripId); if (v) { v.lastPointId = 0; v.pts = []; v.latlngs = []; v.ts = []; await appendViewData(v, false); } };
  // edit dialog: share links
  document.querySelectorAll(".share-row").forEach((row) => {
    const scope = row.dataset.scope, inp = row.querySelector(".share-url");
    row.querySelector(".share-make").onclick = async () => { if (editTripId == null) return; try { const r = await jpost(`${API}/trips/${editTripId}/share`, { scope }); setShareRow(scope, r.url); } catch (e) {} };
    row.querySelector(".share-copy").onclick = () => { inp.select(); try { navigator.clipboard.writeText(inp.value); } catch (e) { try { document.execCommand("copy"); } catch (e2) {} } };
    row.querySelector(".share-del").onclick = async () => { if (editTripId == null) return; await jpost(`${API}/trips/${editTripId}/unshare`, { scope }); setShareRow(scope, ""); };
  });
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
  // Fullscreen: pinch/drag zoom; double-tap zooms to max toward the tap when at fit, resets to fit when zoomed.
  lbZoom = createZoomPan(document.getElementById("lb-img"), {
    surface: document.getElementById("lightbox"),            // gestures work over the whole overlay incl. letterbox
    doubleTapZoom: true,                                     // at fit, double-tap zooms to MAX toward the tap (not close)
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
  // Trip time (hh:mm:ss from started_at, falling back to the first point) + distance so far — shown under speed.
  const t = tripsById[activeTripId];
  let startedEpoch = null;
  if (t && t.started_at) { const ms = Date.parse(t.started_at); if (!isNaN(ms)) startedEpoch = ms / 1000; }
  if (startedEpoch == null && v.ts && v.ts.length) startedEpoch = v.ts[0];
  const hms = (startedEpoch != null) ? fmtHMS(Date.now() / 1000 - startedEpoch) : "00:00:00";
  const dist = fmtDist(distFromStart(v, v.pts.length - 1));
  const sub = ` <small class="so-sep">·</small> <small>⏱ ${hms}</small> <small class="so-sep">·</small> <small>${dist}</small>`;
  if (v.latestSpeed == null) {
    el.style.background = "rgba(0,0,0,0.66)";
    el.innerHTML = `– <small>km/h</small>${sub}`;
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
  el.innerHTML = `${stale ? "~" : ""}${kmh} <small>km/h${ageTxt}</small>${sub}`;   // ~ = last-known (stale)
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

// Human-readable track distance: metres under 1 km, else km to one decimal.
function fmtDist(m) {
  m = +m || 0;
  return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
}
// Elapsed seconds → hh:mm:ss.
function fmtHMS(s) {
  s = Math.max(0, Math.floor(s));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
async function refreshTrips() {
  const trips = await jget(`${API}/trips`);
  tripsById = {};
  for (const t of trips) tripsById[t.id] = t;
  latestTripId = trips.length ? trips[0].id : null;   // API orders by started_at DESC → [0] is most recent
  for (const t of trips) { const v = views.get(t.id); if (v) { v.color = t.color || DEFAULT_COLOR; v.meta = metaOf(t); } }
  // Drop any loaded view whose trip is no longer visible to us (deleted, or hidden from a non-admin viewer).
  let prunedHidden = false;
  for (const id of [...views.keys()]) if (!tripsById[id]) { views.delete(id); if (focusId === id) focusId = null; prunedHidden = true; }
  if (prunedHidden) { rebuildPhotos(); renderActiveEngine(); if (!views.size) closeDock(); }
  const ul = document.getElementById("trip-list");
  ul.innerHTML = "";
  for (const t of trips) {
    const li = document.createElement("li");
    li.dataset.tripId = t.id;
    if (views.has(t.id)) li.classList.add("sel");
    if (t.hidden) li.classList.add("trip-hidden");   // admin-only: hidden from viewers → grey the name
    const started = new Date(t.started_at).toLocaleString();
    const color = t.color || DEFAULT_COLOR;
    li.innerHTML =
      `<div class="t-main"><b><span class="t-swatch" style="background:${esc(color)}"></span>${esc(t.name || ("Trip " + t.id))}</b> ${t.active ? '<span class="live">● LIVE</span>' : ""}
         <div class="t-sub">${started} · ${fmtDist(t.distance_m)} · ${t.photos} 📷</div></div>
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
  if (gridOpen) renderPhotoGrid();   // reflect added/removed photos in the open grid
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
    for (const p of pts) { v.pts.push({ lat: p.lat, lon: p.lon, ts: p.ts, id: p.id, speed: p.speed, alt: p.alt, source: p.source }); if (p.id > v.lastPointId) v.lastPointId = p.id; }
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
    ingestTags(ph);
    if (ph.id > v.lastPhotoId) v.lastPhotoId = ph.id;
  }
  if (added) { rebuildPhotos(); renderPhotosFull(); }
  if (fit && v.latlngs.length) { fitViews(); centeredTripId = v.id; }
  followIfNeeded();
}

// ---- trip stats + charts (computed client-side from the focused trip's points) ----
function statsView() { return (focusId != null && views.get(focusId)) ? views.get(focusId) : (views.size ? [...views.values()][0] : null); }
function kmh(ms) { return ms * 3.6; }
function fmtSpeed(ms) { return kmh(ms).toFixed(1) + " km/h"; }
function tripStats(v) {
  const pts = v.pts, n = pts.length; if (!n) return null;
  let dist = 0, movT = 0, up = 0, down = 0, maxSpd = 0, haveAlt = false;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i], dt = b.ts - a.ts, gap = isGap(v, i);
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (!gap) {
      dist += d;
      if (a.alt != null && b.alt != null) { haveAlt = true; const da = b.alt - a.alt; if (da > 0) up += da; else down -= da; }
      if (dt > 0 && d > 1.5) movT += dt;
    }
    const sp = (b.speed != null) ? b.speed : (!gap && dt > 0 ? d / dt : 0);
    if (sp > maxSpd) maxSpd = sp;
  }
  const dur = pts[n - 1].ts - pts[0].ts;
  return { n, dist, dur, movT, avg: dur > 0 ? dist / dur : 0, movAvg: movT > 0 ? dist / movT : 0,
           maxSpd, up, down, haveAlt, start: pts[0].ts, end: pts[n - 1].ts };
}
// Cumulative-distance (km) series; yFn maps a point→value (null skips).
function distSeries(v, yFn) {
  const pts = v.pts, out = []; let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && !isGap(v, i)) cum += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    const y = yFn(pts[i], i);
    if (y != null && isFinite(y)) out.push([cum / 1000, y]);
  }
  return out;
}
// "Nice" axis ticks (auto-spaced round numbers) + down-sampling + smoothing for clean charts.
function niceNum(x, round) {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x)), f = x / Math.pow(10, exp);
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}
function niceTicks(min, max, n) {
  if (!(max > min)) max = min + 1;
  const step = niceNum(niceNum(max - min, false) / Math.max(1, n - 1), true) || 1;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(+(Math.round(v / step) * step).toFixed(6));
  return { ticks, lo, hi };
}
function resample(series, n) {
  if (series.length <= n) return series;
  const x0 = series[0][0], x1 = series[series.length - 1][0], span = (x1 - x0) || 1;
  const b = Array.from({ length: n }, () => [0, 0, 0]);
  for (const s of series) { let i = Math.floor((s[0] - x0) / span * n); if (i >= n) i = n - 1; if (i < 0) i = 0; b[i][0] += s[0]; b[i][1] += s[1]; b[i][2]++; }
  const out = []; for (const e of b) if (e[2]) out.push([e[0] / e[2], e[1] / e[2]]);
  return out;
}
function smooth(series, win) {
  if (series.length < 3 || win < 2) return series;
  const half = Math.floor(win / 2), out = [];
  for (let i = 0; i < series.length; i++) {
    let sy = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j++) { sy += series[j][1]; c++; }
    out.push([series[i][0], sy / c]);
  }
  return out;
}
// Render `full` (full-resolution series, sorted by x) within the x-window [vx0,vx1]; y auto-fits the visible
// data; the line/fill are clipped to the plot rect. Down-samples + smooths the visible slice per render.
function lineChartSVG(full, color, yUnit, W, vx0, vx1) {
  if (!full || full.length < 2) return '<div class="hint">not enough data</div>';
  W = Math.max(360, Math.round(W || 900));
  const H = Math.max(140, Math.round(W * 180 / 640));
  const PL = 58, PR = 14, PT = 12, PB = 26;
  if (vx0 == null) vx0 = full[0][0];
  if (vx1 == null) vx1 = full[full.length - 1][0];
  if (!(vx1 > vx0)) vx1 = vx0 + 1;
  // visible slice (+ one point just outside each edge) via binary search on x
  let loI = 0, hiI = full.length - 1;
  while (loI < hiI) { const mid = (loI + hiI) >> 1; if (full[mid][0] < vx0) loI = mid + 1; else hiI = mid; }
  const startI = Math.max(0, loI - 1);
  const vis = [];
  for (let i = startI; i < full.length; i++) { vis.push(full[i]); if (full[i][0] > vx1) break; }
  if (vis.length < 2) return '<div class="hint">zoom out to see data</div>';
  const plotPx = Math.max(100, W - PL - PR);
  const rs = smooth(resample(vis, Math.min(vis.length, Math.max(140, Math.round(plotPx)))), 7);
  const ys = rs.map((p) => p[1]);
  const yt = niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 5), y0 = yt.lo, y1 = yt.hi;
  const xt = niceTicks(vx0, vx1, 6);
  const xr = (vx1 - vx0) || 1, yr = (y1 - y0) || 1, span = vx1 - vx0;
  const px = (x) => PL + (x - vx0) / xr * (W - PL - PR);
  const py = (y) => PT + (1 - (y - y0) / yr) * (H - PT - PB);
  const line = rs.map((p, i) => (i ? "L" : "M") + px(p[0]).toFixed(1) + "," + py(p[1]).toFixed(1)).join(" ");
  const area = line + ` L ${px(rs[rs.length - 1][0]).toFixed(1)},${(H - PB).toFixed(1)} L ${px(rs[0][0]).toFixed(1)},${(H - PB).toFixed(1)} Z`;
  const gid = "cg" + Math.random().toString(36).slice(2, 8);
  const kmMode = vx1 >= 1;
  const xfmt = (v) => v === 0 ? "0 m" : kmMode ? v.toFixed(span < 4 ? 2 : 1) + " km" : Math.round(v) + " m";
  const yfmt = (v) => Math.round(v) + (yUnit ? " " + yUnit : "");
  let grid = "", lab = "";
  for (const t of yt.ticks) {
    if (t < y0 - 1e-9 || t > y1 + 1e-9) continue;
    const y = py(t);
    grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${(W - PR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.08"/>`;
    lab += `<text x="${PL - 8}" y="${(y + 4).toFixed(1)}" fill="#8b98a5" font-size="13" text-anchor="end">${yfmt(t)}</text>`;
  }
  for (const t of xt.ticks) {
    if (t < vx0 - 1e-9 || t > vx1 + 1e-9) continue;
    const X = px(t);
    grid += `<line x1="${X.toFixed(1)}" y1="${PT}" x2="${X.toFixed(1)}" y2="${(H - PB).toFixed(1)}" stroke="#ffffff" stroke-opacity="0.06"/>`;
    const anchor = X < PL + 18 ? "start" : X > W - PR - 18 ? "end" : "middle";
    lab += `<text x="${X.toFixed(1)}" y="${H - 8}" fill="#8b98a5" font-size="13" text-anchor="${anchor}">${xfmt(t)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <clipPath id="clip${gid}"><rect x="${PL}" y="${PT}" width="${(W - PL - PR).toFixed(1)}" height="${(H - PT - PB).toFixed(1)}"/></clipPath>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.32"/><stop offset="1" stop-color="${color}" stop-opacity="0.03"/></linearGradient>
    </defs>
    ${grid}
    <g clip-path="url(#clip${gid})">
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </g>
    ${lab}
  </svg>`;
}
// Interactive chart: wheel = zoom about the cursor's x, drag = pan, double-click = reset to full extent.
function makeChart(host, full, color, yUnit) {
  if (!host) return;
  if (!full || full.length < 2) { host.innerHTML = '<div class="hint">not enough data</div>'; return; }
  const fullX0 = full[0][0], fullX1 = full[full.length - 1][0];
  let vx0 = fullX0, vx1 = fullX1, raf = 0;
  const minSpan = Math.max((fullX1 - fullX0) / 400, 1e-4);
  const PL = 58, PR = 14;
  function clampView() {
    if (vx1 - vx0 < minSpan) { const c = (vx0 + vx1) / 2; vx0 = c - minSpan / 2; vx1 = c + minSpan / 2; }
    if (vx1 - vx0 >= fullX1 - fullX0) { vx0 = fullX0; vx1 = fullX1; return; }
    if (vx0 < fullX0) { vx1 += fullX0 - vx0; vx0 = fullX0; }
    if (vx1 > fullX1) { vx0 -= vx1 - fullX1; vx1 = fullX1; }
    if (vx0 < fullX0) vx0 = fullX0;
    if (vx1 > fullX1) vx1 = fullX1;
  }
  function render() { host.innerHTML = lineChartSVG(full, color, yUnit, Math.round(host.clientWidth || 900), vx0, vx1); }
  function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function dataXAt(clientX) {
    const r = host.getBoundingClientRect(), W = host.clientWidth, plotW = Math.max(1, W - PL - PR);
    let f = (clientX - r.left - PL) / plotW; f = Math.max(0, Math.min(1, f));
    return vx0 + f * (vx1 - vx0);
  }
  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    const xc = dataXAt(e.clientX), k = e.deltaY < 0 ? 0.82 : 1 / 0.82;
    vx0 = xc - (xc - vx0) * k; vx1 = xc + (vx1 - xc) * k;
    clampView(); schedule();
  }, { passive: false });
  let dragging = false, lastX = 0;
  host.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; try { host.setPointerCapture(e.pointerId); } catch (e2) {} host.style.cursor = "grabbing"; });
  host.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const W = host.clientWidth, plotW = Math.max(1, W - PL - PR);
    const dxData = -(e.clientX - lastX) / plotW * (vx1 - vx0); lastX = e.clientX;
    vx0 += dxData; vx1 += dxData; clampView(); schedule();
  });
  const end = (e) => { if (dragging) { dragging = false; host.style.cursor = ""; try { host.releasePointerCapture(e.pointerId); } catch (e2) {} } };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
  host.addEventListener("dblclick", () => { vx0 = fullX0; vx1 = fullX1; schedule(); });
  render();
}
function openStats() {
  const v = statsView();
  document.body.classList.add("stats-open");
  const ov = document.getElementById("stats-overlay"); if (ov) ov.hidden = false;
  const title = document.getElementById("stats-title");
  const t = v ? tripsById[v.id] : null;
  if (title) title.textContent = t ? (t.name || ("Trip " + v.id)) : "Trip stats";
  const body = document.getElementById("stats-body"); if (!body) return;
  if (!v || !v.pts.length) { body.innerHTML = '<div class="hint">No track data for this trip.</div>'; return; }
  const s = tripStats(v);
  const nph = (v.photos || []).length;
  const tile = (val, lab) => `<div class="stat-tile"><div class="sv">${esc(val)}</div><div class="sl">${esc(lab)}</div></div>`;
  let html = '<div class="stat-grid">';
  html += tile(fmtDist(s.dist), "Distance");
  html += tile(fmtHMS(s.dur), "Duration");
  html += tile(fmtHMS(s.movT), "Moving time");
  html += tile(fmtSpeed(s.avg), "Avg speed");
  html += tile(fmtSpeed(s.movAvg), "Moving avg");
  html += tile(fmtSpeed(s.maxSpd), "Max speed");
  if (s.haveAlt) { html += tile("↑ " + Math.round(s.up) + " m", "Elevation gain"); html += tile("↓ " + Math.round(s.down) + " m", "Elevation loss"); }
  html += tile(nph, "Photos");
  html += tile(s.n, "Track points");
  html += tile(new Date(s.start * 1000).toLocaleString(), "Start");
  html += tile(new Date(s.end * 1000).toLocaleString(), "End");
  html += "</div>";
  if (s.haveAlt) html += `<div class="chart-card"><h3>Elevation <span class="hint">scroll = zoom · drag = pan · double-click = reset</span></h3><div class="chart-host" data-k="elev"></div></div>`;
  html += `<div class="chart-card"><h3>Speed <span class="hint">scroll = zoom · drag = pan · double-click = reset</span></h3><div class="chart-host" data-k="speed"></div></div>`;
  body.innerHTML = html;
  if (s.haveAlt) makeChart(body.querySelector('[data-k="elev"]'), distSeries(v, (p) => p.alt), "#3b82f6", "m");
  makeChart(body.querySelector('[data-k="speed"]'), distSeries(v, (p) => p.speed != null ? kmh(p.speed) : null), "#4caf50", "km/h");
}
function closeStats() {
  document.body.classList.remove("stats-open");
  const ov = document.getElementById("stats-overlay"); if (ov) ov.hidden = true;
}

// ---- trip edit modal (name + track colour) ----
let editTripId = null;
function openEditModal(t) {
  editTripId = t.id;
  const nm = document.getElementById("edit-name"), cl = document.getElementById("edit-color");
  if (nm) nm.value = t.name || "";
  if (cl) cl.value = t.color || DEFAULT_COLOR;
  const hd = document.getElementById("edit-hidden");
  if (hd) hd.checked = !!t.hidden;
  const gx = document.getElementById("edit-gpx"); if (gx) gx.href = `${API}/trips/${t.id}/export.gpx`;
  const gj = document.getElementById("edit-geojson"); if (gj) gj.href = `${API}/trips/${t.id}/export.geojson`;
  const fs = document.getElementById("edit-fill-status"); if (fs) fs.textContent = "";
  loadShares(t.id);
  pollFillStatus(t.id);       // reflect / resume polling an in-progress fill
  const m = document.getElementById("edit-modal");
  if (m) m.classList.remove("modal-hidden");
}
// ---- share links ----
function setShareRow(scope, url) {
  const row = document.querySelector(`.share-row[data-scope="${scope}"]`); if (!row) return;
  const inp = row.querySelector(".share-url"), mk = row.querySelector(".share-make"),
        cp = row.querySelector(".share-copy"), dl = row.querySelector(".share-del");
  inp.value = url || ""; const has = !!url;
  inp.hidden = !has; mk.hidden = has; cp.hidden = !has; dl.hidden = !has;
}
async function loadShares(tid) {
  setShareRow("relatives", ""); setShareRow("world", "");
  try { const s = await jget(`${API}/trips/${tid}/shares`); for (const sc of ["relatives", "world"]) if (s[sc]) setShareRow(sc, s[sc].url); } catch (e) {}
}
// ---- gap fill ----
function pollFillStatus(tid) {
  const el = document.getElementById("edit-fill-status"); if (!el) return;
  jget(`${API}/trips/${tid}/fill_status`).then((s) => {
    if (editTripId !== tid) return;
    if (s.state === "running") { el.textContent = "Filling gaps…"; setTimeout(() => pollFillStatus(tid), 1500); }
    else if (s.state === "done") {
      const r = s.result || {}; el.textContent = `Filled ${r.added || 0} pts across ${r.gaps || 0} gap(s)`;
      const v = views.get(tid); if (v) { v.lastPointId = 0; v.pts = []; v.latlngs = []; v.ts = []; appendViewData(v, false); }
    } else if (s.state === "error") { el.textContent = "Fill error: " + (s.error || ""); }
    else el.textContent = "";
  }).catch(() => {});
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
  const hidden = !!(document.getElementById("edit-hidden") || {}).checked;
  await jpost(`${API}/trips/${editTripId}/rename`, { name, color, hidden });
  const v = views.get(editTripId);
  if (v) v.color = color;
  if (tripsById[editTripId]) { tripsById[editTripId].name = name; tripsById[editTripId].color = color; tripsById[editTripId].hidden = hidden; }
  closeEditModal();
  renderTracks();
  await refreshTrips();
}

// ===================== track editor (admin) =====================
let editMode = false, etTripId = null;
const editSel = new Set();
let editAddArmed = false, editTsAuto = false;
let joinState = 0, joinFirstId = -1;
let editMarkers = [];
const undoStack = [], redoStack = [];
let _editClickLset = false, _editClickG = null;
let editSelectMode = false, _boxStart = null, _gOverlay = null;
let editBridged = [];                 // session-only [tsLo,tsHi] ranges "joined" by the user (drawn connected)
const editNewPts = new Set();         // ids added this session (manual/densify) → always auto-timestamp
let snapPx = 25;                      // click-to-select snap radius in pixels (configurable)
let hlLayer = null, hlGMarkers = [], _hlRaf = 0, _hlX = 0, _hlY = 0;   // cursor-proximity highlight
let _selRaf = 0, _selMoveG = [];                                      // selection-overlay canvas repaint
let editHandleIds = new Set();                                        // selected ids that have a drag handle (skip on canvas)

function editView() { return etTripId != null ? views.get(etTripId) : null; }
function metersPerPixel(lat) { return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, mapZoom() + 8); }
function ensureEditClickHandlers() {
  if (lmap && !_editClickLset) { lmap.on("click", editMapClickL); lmap.on("move zoom moveend zoomend viewreset", scheduleSelDraw); _editClickLset = true; }
  if (gmap && !_editClickG) { _editClickG = gmap.addListener("click", editMapClickG); }
  if (gmap && !_gOverlay) {
    _gOverlay = new google.maps.OverlayView();
    _gOverlay.onAdd = function () {}; _gOverlay.onRemove = function () {};
    // draw() runs AFTER Google updates the projection on every pan/zoom → repaint the overlay in sync (no drift)
    _gOverlay.draw = function () { if (editMode && engine === "google") scheduleSelDraw(); };
    _gOverlay.setMap(gmap);
  }
  if (gmap) gmap.setOptions({ draggableCursor: "crosshair" });   // edit-mode crosshair on the Google engine
}
function removeEditClickHandlers() {
  if (lmap && _editClickLset) { lmap.off("click", editMapClickL); lmap.off("move zoom moveend zoomend viewreset", scheduleSelDraw); _editClickLset = false; }
  if (_editClickG) { google.maps.event.removeListener(_editClickG); _editClickG = null; }
  for (const h of _selMoveG) { try { google.maps.event.removeListener(h); } catch (e) {} }
  _selMoveG = [];
}
// ---- selection overlay: a fast canvas marking EVERY selected point (drag handles are capped; this isn't) ----
function projectToMapPx(lat, lon) {
  if (engine === "google" && gmap) {
    const proj = _gOverlay && _gOverlay.getProjection && _gOverlay.getProjection();
    if (!proj) return null;
    const pt = proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lon));
    return pt ? { x: pt.x, y: pt.y } : null;
  }
  if (lmap) { const p = lmap.latLngToContainerPoint([lat, lon]); return { x: p.x, y: p.y }; }
  return null;
}
function mapLatLonBounds() {
  try {
    if (engine === "google" && gmap) { const b = gmap.getBounds(); if (!b) return null; const ne = b.getNorthEast(), sw = b.getSouthWest(); return { latMin: sw.lat(), latMax: ne.lat(), lonMin: sw.lng(), lonMax: ne.lng() }; }
    if (lmap) { const b = lmap.getBounds(); return { latMin: b.getSouth(), latMax: b.getNorth(), lonMin: b.getWest(), lonMax: b.getEast() }; }
  } catch (e) {}
  return null;
}
function drawSelCanvas() {
  const cv = document.getElementById("edit-selcanvas"); if (!cv) return;
  if (!editMode) { cv.style.display = "none"; return; }
  const mapEl = editMapEl(); if (!mapEl) return;
  const w = mapEl.clientWidth, h = mapEl.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px"; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  cv.style.display = "block";
  const v = editView(); if (!v || !editSel.size) return;
  const b = mapLatLonBounds();
  const padLat = b ? (b.latMax - b.latMin) * 0.05 : 0, padLon = b ? (b.lonMax - b.lonMin) * 0.05 : 0;
  const byId = new Map(v.pts.map((p) => [p.id, p]));
  ctx.fillStyle = "rgba(255,212,0,0.95)"; ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1;
  for (const id of editSel) {
    if (editHandleIds.has(id)) continue;   // those already have a (bigger) drag handle
    const p = byId.get(id); if (!p) continue;
    if (b && (p.lat < b.latMin - padLat || p.lat > b.latMax + padLat || p.lon < b.lonMin - padLon || p.lon > b.lonMax + padLon)) continue;
    const s = projectToMapPx(p.lat, p.lon); if (!s) continue;
    if (s.x < -4 || s.y < -4 || s.x > w + 4 || s.y > h + 4) continue;
    ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, 6.2832); ctx.fill(); ctx.stroke();
  }
}
function scheduleSelDraw() { if (_selRaf) return; _selRaf = requestAnimationFrame(() => { _selRaf = 0; drawSelCanvas(); }); }
function toggleTrackEdit() {
  if (!isAdmin) return;
  if (editMode) { exitTrackEdit(); return; }
  const v = statsView();
  if (!v) { alert("Load a trip first"); return; }
  enterTrackEdit(v.id);
}
function enterTrackEdit(id) {
  etTripId = id; editMode = true;
  editSel.clear(); editAddArmed = false; joinState = 0; joinFirstId = -1; editBridged = []; editNewPts.clear();
  undoStack.length = 0; redoStack.length = 0;
  autoFollowLive = false; setFollow(false);
  document.body.classList.add("edit-open");
  const me = document.getElementById("map-edit"); if (me) me.classList.add("on");
  const tb = document.getElementById("edit-tb"); if (tb) tb.hidden = false;
  ensureEditClickHandlers();
  renderEditMarkers(); updateEditToolbar();
}
function exitTrackEdit() {
  editMode = false; editAddArmed = false; joinState = 0; joinFirstId = -1; editSel.clear();
  editSelectMode = false; editBridged = []; editNewPts.clear();
  undoStack.length = 0; redoStack.length = 0;
  document.body.classList.remove("edit-open");
  const mw = document.getElementById("mapwrap"); if (mw) mw.classList.remove("box-select");
  const me = document.getElementById("map-edit"); if (me) me.classList.remove("on");
  const tb = document.getElementById("edit-tb"); if (tb) tb.hidden = true;
  if (gmap) gmap.setOptions({ draggableCursor: null });
  removeEditClickHandlers();
  clearEditMarkers();
  destroyHighlights();
  drawSelCanvas();  // editMode is false now → hides the selection overlay
  renderTracks();   // restore normal gap-breaking in the view
}
function editMapClickL(e) { if (suppressMapClick) { suppressMapClick = false; return; } handleEditMapClick(e.latlng.lat, e.latlng.lng); }
function editMapClickG(e) { if (suppressMapClick) { suppressMapClick = false; return; } handleEditMapClick(e.latLng.lat(), e.latLng.lng()); }
function handleEditMapClick(lat, lon) { if (editAddArmed) addPointAt(lat, lon); }
function handleEditTrackClick(lat, lon) {
  if (editAddArmed) { addPointAt(lat, lon); return; }
  const hit = nearestEditPt(lat, lon); if (!hit) return;
  if (joinState > 0) { handleJoinPick(hit); return; }
  if (editSel.has(hit.id)) editSel.delete(hit.id); else editSel.add(hit.id);
  renderEditMarkers(); updateEditToolbar();
}
// Cheap planar metres (no per-point trig) — fine over the short distances the editor cares about.
function planarM(aLat, aLon, bLat, bLon) {
  const k = Math.cos(aLat * Math.PI / 180);
  const dLat = bLat - aLat, dLon = (bLon - aLon) * k;
  return Math.sqrt(dLat * dLat + dLon * dLon) * 111320;
}
function nearestEditPt(lat, lon) {
  const v = editView(); if (!v) return null;
  let best = null, bd = Infinity;
  for (const p of v.pts) { const d = planarM(lat, lon, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
  if (!best) return null;
  const thr = Math.max(metersPerPixel(lat) * snapPx, 2);   // snap radius (px → metres at this zoom)
  return bd <= thr ? best : null;
}
function clearEditMarkers() {
  for (const m of editMarkers) { try { if (m.l && lmap) lmap.removeLayer(m.l); } catch (e) {} try { if (m.g) m.g.setMap(null); } catch (e) {} }
  editMarkers = [];
}
function renderEditMarkers() {
  clearEditMarkers();
  editHandleIds = new Set();
  const v = editView(); if (!v) return;
  const byId = new Map(v.pts.map((p) => [p.id, p]));
  const ids = [...editSel];
  const CAP = 400;                                   // cap drag handles (huge selections stay in the set, just fewer handles)
  const stride = ids.length > CAP ? Math.ceil(ids.length / CAP) : 1;
  for (let k = 0; k < ids.length; k += stride) {
    const id = ids[k], p = byId.get(id); if (!p) continue;
    editHandleIds.add(id);
    if (engine === "google" && gmap) {
      const m = new google.maps.Marker({ position: { lat: p.lat, lng: p.lon }, map: gmap, draggable: true, zIndex: 5000,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#ffd400", fillOpacity: 1, strokeColor: "#000", strokeWeight: 1 } });
      m.addListener("dragend", () => { const pos = m.getPosition(); onEditDrag(id, pos.lat(), pos.lng()); });
      editMarkers.push({ id, g: m });
    } else if (lmap) {
      const m = L.marker([p.lat, p.lon], { draggable: true, icon: L.divIcon({ className: "edit-dot", iconSize: [16, 16] }) }).addTo(lmap);
      m.on("dragend", () => { const ll = m.getLatLng(); onEditDrag(id, ll.lat, ll.lng); });
      editMarkers.push({ id, l: m });
    }
  }
  drawSelCanvas();   // mark EVERY selected point (not just the capped drag handles)
}
function rebuildViewArrays(v) {
  v.pts.sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
  v.latlngs = v.pts.map((p) => [p.lat, p.lon]);
  v.ts = v.pts.map((p) => p.ts);
}
function weightedTs(v, idx, lat, lon) {
  const prev = v.pts[idx - 1], next = v.pts[idx + 1];
  if (!prev || !next) return v.pts[idx].ts;
  const d1 = haversineM(prev.lat, prev.lon, lat, lon), d2 = haversineM(lat, lon, next.lat, next.lon);
  const f = (d1 + d2 <= 0) ? 0.5 : d1 / (d1 + d2);
  return prev.ts + f * (next.ts - prev.ts);
}
async function applyMoveSet(v, moves, forward) {
  for (const m of moves) {
    const idx = v.pts.findIndex((p) => p.id === m.id); if (idx < 0) continue;
    const lat = forward ? m.nLat : m.oLat, lon = forward ? m.nLon : m.oLon, ts = forward ? m.nTs : m.oTs;
    v.pts[idx] = Object.assign({}, v.pts[idx], { lat, lon, ts });
    try { await jpost(`${API}/trips/${v.id}/points/move`, { id: m.id, lat, lon, ts }); } catch (e) {}
  }
  rebuildViewArrays(v); renderTracks(); renderEditMarkers();
}
function onEditDrag(id, lat, lon) {
  const v = editView(); if (!v) return;
  const idx = v.pts.findIndex((p) => p.id === id); if (idx < 0) return;
  const old = v.pts[idx];
  const auto = editTsAuto || editNewPts.has(id);   // new points always re-timestamp to their position
  const nTs = auto ? weightedTs(v, idx, lat, lon) : old.ts;
  const moves = [{ id, oLat: old.lat, oLon: old.lon, oTs: old.ts, nLat: lat, nLon: lon, nTs }];
  (async () => { await applyMoveSet(v, moves, true); pushCmd({ undo: () => applyMoveSet(v, moves, false), redo: () => applyMoveSet(v, moves, true) }); })();
}
function nudgeSelected(dxPx, dyPx) {
  const v = editView(); if (!v || !editSel.size) return;
  const moves = [];
  for (const id of editSel) {
    const idx = v.pts.findIndex((p) => p.id === id); if (idx < 0) continue;
    const p = v.pts[idx], mpp = metersPerPixel(p.lat);
    const dLat = (-dyPx * mpp) / 111320, dLon = (dxPx * mpp) / ((111320 * Math.cos(p.lat * Math.PI / 180)) || 1);
    const nLat = p.lat + dLat, nLon = p.lon + dLon;
    const nTs = (editTsAuto || editNewPts.has(id)) ? weightedTs(v, idx, nLat, nLon) : p.ts;
    moves.push({ id, oLat: p.lat, oLon: p.lon, oTs: p.ts, nLat, nLon, nTs });
  }
  if (!moves.length) return;
  (async () => { await applyMoveSet(v, moves, true); pushCmd({ undo: () => applyMoveSet(v, moves, false), redo: () => applyMoveSet(v, moves, true) }); })();
}
function segDist(lat, lon, a, b) {
  const kx = Math.cos(lat * Math.PI / 180);
  const ax = a.lon * kx, ay = a.lat, bx = b.lon * kx, by = b.lat, px = lon * kx, py = lat;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const f = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + f * dx, cy = ay + f * dy;
  return { d: Math.hypot(px - cx, py - cy), f };
}
function addPointAt(lat, lon) {
  const v = editView(); if (!v) return;
  editAddArmed = false;
  let bi = -1, bd = Infinity, bf = 0;
  for (let i = 1; i < v.pts.length; i++) { const r = segDist(lat, lon, v.pts[i - 1], v.pts[i]); if (r.d < bd) { bd = r.d; bi = i; bf = r.f; } }
  const ts = (bi >= 1) ? v.pts[bi - 1].ts + bf * (v.pts[bi].ts - v.pts[bi - 1].ts)
                       : ((v.pts.length ? v.pts[v.pts.length - 1].ts : Date.now() / 1000) + 1);
  const cmd = { _id: null,
    redo: async () => { try { const r = await jpost(`${API}/trips/${v.id}/points/add`, { lat, lon, ts }); cmd._id = r.id; } catch (e) { return; } v.pts.push({ lat, lon, ts, id: cmd._id, speed: null, alt: null, source: "edited" }); editNewPts.add(cmd._id); rebuildViewArrays(v); editSel.clear(); editSel.add(cmd._id); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
    undo: async () => { if (cmd._id == null) return; try { await jpost(`${API}/trips/${v.id}/points/delete`, { ids: [cmd._id] }); } catch (e) {} v.pts = v.pts.filter((p) => p.id !== cmd._id); editSel.delete(cmd._id); editNewPts.delete(cmd._id); cmd._id = null; rebuildViewArrays(v); renderTracks(); renderEditMarkers(); updateEditToolbar(); } };
  (async () => { await cmd.redo(); if (cmd._id != null) { pushCmd(cmd); updateEditToolbar(); } })();
}
function editDelete() {
  const v = editView(); if (!v || !editSel.size) return;
  const pts0 = [...editSel].map((id) => v.pts.find((p) => p.id === id)).filter(Boolean).map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts, source: p.source }));
  if (!pts0.length) return;
  let ids = [...editSel];
  const cmd = {
    redo: async () => { try { await jpost(`${API}/trips/${v.id}/points/delete`, { ids }); } catch (e) {} const s = new Set(ids); v.pts = v.pts.filter((p) => !s.has(p.id)); ids.forEach((id) => editNewPts.delete(id)); editSel.clear(); rebuildViewArrays(v); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
    undo: async () => { const newIds = []; for (const p of pts0) { try { const r = await jpost(`${API}/trips/${v.id}/points/add`, { lat: p.lat, lon: p.lon, ts: p.ts }); newIds.push(r.id); editNewPts.add(r.id); v.pts.push({ lat: p.lat, lon: p.lon, ts: p.ts, id: r.id, speed: null, alt: null, source: p.source || "edited" }); } catch (e) {} } ids = newIds; rebuildViewArrays(v); renderTracks(); renderEditMarkers(); updateEditToolbar(); } };
  (async () => { await cmd.redo(); pushCmd(cmd); })();
}
function isEndpoint(v, id) {
  const i = v.pts.findIndex((p) => p.id === id); if (i < 0) return false;
  if (i === 0 || i === v.pts.length - 1) return true;
  return isGap(v, i) || isGap(v, i + 1);
}
function editJoinPressed() {
  const v = editView(); if (!v) return;
  editAddArmed = false; editSelectMode = false;
  const eps = [...editSel].filter((id) => isEndpoint(v, id));
  if (eps.length >= 2) { joinState = 0; startJoinConfirm(v, eps[0], eps[1]); }
  else if (eps.length === 1) { joinFirstId = eps[0]; joinState = 2; editSel.clear(); editSel.add(eps[0]); renderEditMarkers(); updateEditToolbar(); }
  else { joinState = 1; joinFirstId = -1; editSel.clear(); renderEditMarkers(); updateEditToolbar(); }
}
function handleJoinPick(p) {
  const v = editView(); if (!v) return;
  if (!isEndpoint(v, p.id)) { setEditHint("Not a segment endpoint — pick an end next to a gap"); return; }
  if (joinState === 1) { joinFirstId = p.id; joinState = 2; editSel.clear(); editSel.add(p.id); renderEditMarkers(); updateEditToolbar(); return; }
  if (p.id === joinFirstId) return;
  joinState = 0; startJoinConfirm(v, joinFirstId, p.id);
}
// Join = connect the two endpoints with a straight line and NO intermediate points. It just marks the gap's
// ts-range as "bridged" so the edited track renders connected there (clickable to add + shape points). Use the
// Fill tool at the end to densify. Undoable.
function startJoinConfirm(v, aId, bId) {
  const a = v.pts.find((p) => p.id === aId), b = v.pts.find((p) => p.id === bId);
  if (!a || !b) { resetJoin(); return; }
  const range = [Math.min(a.ts, b.ts), Math.max(a.ts, b.ts)];
  editBridged.push(range);
  renderTracks();
  pushCmd({
    redo: () => { if (editBridged.indexOf(range) < 0) editBridged.push(range); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
    undo: () => { const i = editBridged.indexOf(range); if (i >= 0) editBridged.splice(i, 1); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
  });
  joinState = 0; joinFirstId = -1; editSel.clear(); renderEditMarkers(); updateEditToolbar();
}
// Fill: densify the big gaps WITHIN the selected points' span with intermediate points (backend), undoable.
function fillSelection() {
  const v = editView(); if (!v || editSel.size < 2) return;
  const ids = [...editSel];
  setEditHint("Filling gaps…");
  (async () => {
    const before = new Set(v.pts.map((p) => p.id));
    try { await jpost(`${API}/trips/${v.id}/points/densify`, { ids, min_gap_m: 40, spacing_m: 25 }); } catch (e) { updateEditToolbar(); return; }
    await reloadEditView(v);
    const cmd = {
      _added: v.pts.filter((p) => !before.has(p.id)).map((p) => p.id),
      redo: async () => { const b2 = new Set(v.pts.map((p) => p.id)); try { await jpost(`${API}/trips/${v.id}/points/densify`, { ids, min_gap_m: 40, spacing_m: 25 }); } catch (e) {} await reloadEditView(v); cmd._added = v.pts.filter((p) => !b2.has(p.id)).map((p) => p.id); cmd._added.forEach((id) => editNewPts.add(id)); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
      undo: async () => { (cmd._added || []).forEach((id) => editNewPts.delete(id)); if (cmd._added && cmd._added.length) { try { await jpost(`${API}/trips/${v.id}/points/delete`, { ids: cmd._added }); } catch (e) {} } await reloadEditView(v); renderTracks(); renderEditMarkers(); updateEditToolbar(); },
    };
    cmd._added.forEach((id) => editNewPts.add(id));
    pushCmd(cmd);
    renderTracks(); renderEditMarkers(); updateEditToolbar();
  })();
}
// ---- cursor-proximity highlight (light dots on points near the cursor) ----
function clearHighlights() {
  if (hlLayer && lmap) { lmap.removeLayer(hlLayer); hlLayer = null; }
  for (const m of hlGMarkers) m.setMap(null);   // keep the Google pool, just hide
}
function destroyHighlights() { clearHighlights(); hlGMarkers = []; }
function renderHighlights(latlngs) {
  if (engine === "google" && gmap) {
    if (hlLayer && lmap) { lmap.removeLayer(hlLayer); hlLayer = null; }
    while (hlGMarkers.length < latlngs.length) hlGMarkers.push(new google.maps.Marker({ map: gmap, clickable: false, zIndex: 4500,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: "#ffffff", fillOpacity: 0.5, strokeColor: "#ffffff", strokeOpacity: 0.9, strokeWeight: 1 } }));
    for (let i = 0; i < hlGMarkers.length; i++) {
      if (i < latlngs.length) { hlGMarkers[i].setPosition({ lat: latlngs[i][0], lng: latlngs[i][1] }); hlGMarkers[i].setMap(gmap); }
      else hlGMarkers[i].setMap(null);
    }
  } else if (lmap) {
    for (const m of hlGMarkers) m.setMap(null);
    if (hlLayer) lmap.removeLayer(hlLayer);
    hlLayer = L.layerGroup();
    for (const ll of latlngs) L.circleMarker(ll, { radius: 6, color: "#fff", weight: 1, opacity: 0.9, fillColor: "#fff", fillOpacity: 0.4, interactive: false }).addTo(hlLayer);
    hlLayer.addTo(lmap);
  }
}
function doHighlight(cx, cy) {
  const v = editView(); if (!v) { clearHighlights(); return; }
  const mapEl = editMapEl(); if (!mapEl) { clearHighlights(); return; }
  const r = mapEl.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) { clearHighlights(); return; }
  const ll = boxLatLng(cx - r.left, cy - r.top); if (!ll) { clearHighlights(); return; }
  const radM = Math.max(metersPerPixel(ll[0]) * snapPx, 2);
  const near = [];
  // Highlight only real GPS/track points that are NOT already selected (the candidates a click would add).
  for (const p of v.pts) { if (editSel.has(p.id)) continue; if (planarM(ll[0], ll[1], p.lat, p.lon) <= radM) { near.push([p.lat, p.lon]); if (near.length >= 30) break; } }
  renderHighlights(near);
}
function onEditHover(e) {
  if (!editMode || editSelectMode || _boxStart) return;
  _hlX = e.clientX; _hlY = e.clientY;
  if (_hlRaf) return;
  _hlRaf = requestAnimationFrame(() => { _hlRaf = 0; if (editMode && !editSelectMode && !_boxStart) doHighlight(_hlX, _hlY); });
}
function resetJoin() { joinState = 0; joinFirstId = -1; editSel.clear(); renderEditMarkers(); updateEditToolbar(); }
function clearSelection() { editSel.clear(); renderEditMarkers(); updateEditToolbar(); }
function selectAll() {
  const v = editView(); if (!v) return;
  editSel.clear();
  for (const p of v.pts) editSel.add(p.id);
  editSelectMode = false; editAddArmed = false;
  renderEditMarkers(); updateEditToolbar();
}
// ---- box (rubber-band) select ----
function editMapEl() { return document.getElementById(engine === "google" ? "gmap" : "map"); }
function boxLatLng(px, py) {
  if (engine === "google" && gmap) {
    const proj = _gOverlay && _gOverlay.getProjection && _gOverlay.getProjection();
    if (!proj) return null;
    const ll = proj.fromContainerPixelToLatLng(new google.maps.Point(px, py));
    return ll ? [ll.lat(), ll.lng()] : null;
  }
  if (lmap) { const ll = lmap.containerPointToLatLng(L.point(px, py)); return [ll.lat, ll.lng]; }
  return null;
}
function updateBox(cx, cy) {
  const el = document.getElementById("edit-rubber"); if (!el || !_boxStart) return;
  const mw = document.getElementById("mapwrap").getBoundingClientRect();
  el.style.left = (Math.min(_boxStart.x, cx) - mw.left) + "px";
  el.style.top = (Math.min(_boxStart.y, cy) - mw.top) + "px";
  el.style.width = Math.abs(cx - _boxStart.x) + "px";
  el.style.height = Math.abs(cy - _boxStart.y) + "px";
}
function onBoxMouseDown(e) {
  if (!editMode || !editSelectMode || e.button !== 0) return;
  const mapEl = editMapEl(); if (!mapEl) return;
  const r = mapEl.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  _boxStart = { x: e.clientX, y: e.clientY };
  if (engine === "google" && gmap) gmap.setOptions({ draggable: false }); else if (lmap) lmap.dragging.disable();
  const el = document.getElementById("edit-rubber"); if (el) { el.style.display = "block"; updateBox(e.clientX, e.clientY); }
  document.addEventListener("mousemove", onBoxMouseMove, true);
  document.addEventListener("mouseup", onBoxMouseUp, true);
  e.preventDefault(); e.stopPropagation();
}
function onBoxMouseMove(e) { updateBox(e.clientX, e.clientY); e.preventDefault(); }
function onBoxMouseUp(e) {
  document.removeEventListener("mousemove", onBoxMouseMove, true);
  document.removeEventListener("mouseup", onBoxMouseUp, true);
  const start = _boxStart; _boxStart = null;
  const el = document.getElementById("edit-rubber"); if (el) el.style.display = "none";
  if (engine === "google" && gmap) gmap.setOptions({ draggable: true }); else if (lmap) lmap.dragging.enable();
  if (!start) return;
  if (Math.abs(e.clientX - start.x) < 4 && Math.abs(e.clientY - start.y) < 4) return;   // a click, not a box
  const r = editMapEl().getBoundingClientRect();
  const p0 = boxLatLng(Math.min(start.x, e.clientX) - r.left, Math.min(start.y, e.clientY) - r.top);
  const p1 = boxLatLng(Math.max(start.x, e.clientX) - r.left, Math.max(start.y, e.clientY) - r.top);
  if (!p0 || !p1) return;
  const latMin = Math.min(p0[0], p1[0]), latMax = Math.max(p0[0], p1[0]);
  const lonMin = Math.min(p0[1], p1[1]), lonMax = Math.max(p0[1], p1[1]);
  const v = editView(); if (!v) return;
  for (const p of v.pts) if (p.lat >= latMin && p.lat <= latMax && p.lon >= lonMin && p.lon <= lonMax) editSel.add(p.id);
  renderEditMarkers(); updateEditToolbar();
  e.preventDefault(); e.stopPropagation();
}
async function reloadEditView(v) { v.pts = []; v.latlngs = []; v.ts = []; v.lastPointId = 0; await appendViewData(v, false); }
function pushCmd(cmd) { undoStack.push(cmd); if (undoStack.length > 40) undoStack.shift(); redoStack.length = 0; updateEditToolbar(); }
async function doUndo() { const c = undoStack.pop(); if (!c) return; try { await c.undo(); } catch (e) {} redoStack.push(c); updateEditToolbar(); }
async function doRedo() { const c = redoStack.pop(); if (!c) return; try { await c.redo(); } catch (e) {} undoStack.push(c); updateEditToolbar(); }
function setEditHint(t) { const el = document.getElementById("edit-hint"); if (el) el.textContent = t; }
function updateEditToolbar() {
  const addB = document.getElementById("et-add"); if (addB) addB.classList.toggle("armed", editAddArmed);
  const boxB = document.getElementById("et-box"); if (boxB) boxB.classList.toggle("armed", editSelectMode);
  const mw = document.getElementById("mapwrap"); if (mw) mw.classList.toggle("box-select", editMode && editSelectMode);
  const tsB = document.getElementById("et-ts"); if (tsB) tsB.textContent = "ts: " + (editTsAuto ? "auto" : "keep");
  const hasSel = editSel.size > 0;
  ["et-left", "et-up", "et-down", "et-right", "et-del", "et-clear"].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = !hasSel; });
  const fb = document.getElementById("et-fill"); if (fb) fb.disabled = editSel.size < 2;
  const u = document.getElementById("et-undo"); if (u) u.disabled = !undoStack.length;
  const r = document.getElementById("et-redo"); if (r) r.disabled = !redoStack.length;
  setEditHint(editSelectMode ? "Drag a box on the map to select the points inside it"
    : editAddArmed ? "Click the map/track to add a point"
    : joinState === 1 ? "Join: click the FIRST segment endpoint"
    : joinState === 2 ? "Join: click the SECOND endpoint"
    : `Click track to select · drag a dot or use arrows to move · ${editSel.size} selected`);
}

// ===================== replay (scrub the focused trip) =====================
let replayOn = false, replayView = null, replayIdx = 0, replayTimer = null, replayPlaying = false, replayMarker = null;
function toggleReplay() {
  if (replayOn) { closeReplay(); return; }
  const v = statsView(); if (!v || !v.pts.length) { alert("Load a trip first"); return; }
  if (editMode) exitTrackEdit();
  replayOn = true; replayView = v; replayIdx = 0;
  document.body.classList.add("replay-open");
  const bar = document.getElementById("replay-bar"); if (bar) bar.hidden = false;
  const s = document.getElementById("rp-slider"); if (s) { s.max = String(Math.max(1, v.pts.length - 1)); s.value = "0"; }
  const rb = document.getElementById("map-replay"); if (rb) rb.classList.add("on");
  setReplayIdx(0);
}
function closeReplay() {
  stopReplayPlay(); replayOn = false; replayView = null;
  document.body.classList.remove("replay-open");
  const bar = document.getElementById("replay-bar"); if (bar) bar.hidden = true;
  const rb = document.getElementById("map-replay"); if (rb) rb.classList.remove("on");
  clearReplayMarker();
}
function setReplayIdx(i) {
  const v = replayView; if (!v || !v.pts.length) return;
  replayIdx = Math.max(0, Math.min(i, v.pts.length - 1));
  const p = v.pts[replayIdx];
  placeReplayMarker(p.lat, p.lon);
  const s = document.getElementById("rp-slider"); if (s && +s.value !== replayIdx) s.value = String(replayIdx);
  const tl = document.getElementById("rp-time");
  if (tl) tl.textContent = `${new Date(p.ts * 1000).toLocaleTimeString()} · ${fmtDist(distFromStart(v, replayIdx))} · ${replayIdx + 1}/${v.pts.length}`;
  if (replayPlaying) mapCenterOn(p.lat, p.lon, true);
}
function startReplayPlay() {
  if (replayPlaying || !replayView) return;
  replayPlaying = true;
  const btn = document.getElementById("rp-play"); if (btn) btn.textContent = "⏸";
  if (replayIdx >= replayView.pts.length - 1) setReplayIdx(0);
  const n = replayView.pts.length, step = Math.max(1, Math.floor(n / 240));
  replayTimer = setInterval(() => {
    if (!replayView) { stopReplayPlay(); return; }
    const ni = replayIdx + step;
    if (ni >= replayView.pts.length - 1) { setReplayIdx(replayView.pts.length - 1); stopReplayPlay(); return; }
    setReplayIdx(ni);
  }, 80);
}
function stopReplayPlay() {
  replayPlaying = false;
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  const btn = document.getElementById("rp-play"); if (btn) btn.textContent = "⏵";
}
function clearReplayMarker() {
  if (replayMarker) { try { if (replayMarker.l && lmap) lmap.removeLayer(replayMarker.l); } catch (e) {} try { if (replayMarker.g) replayMarker.g.setMap(null); } catch (e) {} replayMarker = null; }
}
function placeReplayMarker(lat, lon) {
  if (engine === "google" && gmap) {
    if (replayMarker && replayMarker.g) { replayMarker.g.setPosition({ lat, lng: lon }); return; }
    clearReplayMarker();
    const m = new google.maps.Marker({ position: { lat, lng: lon }, map: gmap, zIndex: 6000,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#ff7f0e", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } });
    replayMarker = { g: m };
  } else if (lmap) {
    if (replayMarker && replayMarker.l) { replayMarker.l.setLatLng([lat, lon]); return; }
    clearReplayMarker();
    const m = L.marker([lat, lon], { icon: L.divIcon({ className: "replay-dot", iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(lmap);
    replayMarker = { l: m };
  }
}

document.addEventListener("DOMContentLoaded", init);
