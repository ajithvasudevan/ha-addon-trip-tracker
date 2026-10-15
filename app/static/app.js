/* Trip Tracker web UI. All fetches are RELATIVE ("api/...") so HA ingress's path prefix is honoured.
   Two map engines share one data model:
     - Leaflet  → CARTO Voyager (vector) + Esri raster basemaps
     - native Google Maps JS → the Google basemaps (so Google's own controls work and overlays render)
   Everything (track, photo markers, balloon, locate, lightbox) works on whichever engine is active. */
"use strict";

const API = "api";
const GOOGLE_TYPES = { g_roadmap: "roadmap", g_satellite: "satellite", g_hybrid: "hybrid", g_terrain: "terrain" };

let cfg = null;
let isAdmin = true;
let engine = "leaflet";          // "leaflet" | "google"
let lmap = null, gmap = null;    // Leaflet map, native Google map
let baseLayers = {};             // Leaflet base layers
let lTrack = null, lPhotoLayer = null, lHead = null;
let gTrack = null, gMarkers = [], gHead = null;
let currentBaseKey = null;

let selected = null, activeTripId = null, centeredTripId = null;
let lastPointId = 0, lastPhotoId = 0;
let trackLatLngs = [];
let photos = [];                 // {id,asset,ts,lat,lon,matched_by,name,_lmarker,_gmarker}
let photoSorted = [], curPhoto = -1, fsOpen = false;

const camIcon = () => L.divIcon({ className: "cam-marker", html: "📷", iconSize: [26, 26], iconAnchor: [13, 13] });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const preview = (a) => `${API}/photo/${encodeURIComponent(a)}/preview`;
const thumb = (a) => `${API}/photo/${encodeURIComponent(a)}/thumbnail`;
const original = (a) => `${API}/photo/${encodeURIComponent(a)}/original`;

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
  lTrack = L.polyline([], { color: "#1565c0", weight: 5, opacity: 0.85 }).addTo(lmap);
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
  lmap.on("dragstart", closeBalloon);

  addBaseOptions();
  // Admin: own per-browser choice (default Google Roadmap). Viewer: always the admin's last choice.
  let initBase;
  if (isAdmin) { try { initBase = localStorage.getItem("tt_basemap"); } catch (e) {} initBase = initBase || "g_roadmap"; }
  else { initBase = st.admin_basemap || "g_roadmap"; }
  if (GOOGLE_TYPES[initBase] && !cfg.google_key) initBase = "carto";
  setBasemap(initBase);

  wireUI();
  renderCfg();
  await refreshTrips();
  if (st.active) { await selectTrip(st.trip.id, true); }
  updateActiveBox(st);
  setInterval(tick, 4000);
  [150, 400, 900].forEach((d) => setTimeout(resizeActive, d));
  window.addEventListener("resize", () => setTimeout(resizeActive, 100));
  window.addEventListener("orientationchange", () => setTimeout(resizeActive, 300));
  // Auto re-fit the active map whenever its container changes size (panel collapse, rotate, etc.)
  if (window.ResizeObserver) {
    try { new ResizeObserver(() => resizeActive()).observe(document.getElementById("mapwrap")); } catch (e) {}
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
  gmap.addListener("dragstart", closeBalloon);
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
function mapFitTrack() {
  if (!trackLatLngs.length) return;
  if (engine === "google") {
    const b = new google.maps.LatLngBounds();
    trackLatLngs.forEach(([la, lo]) => b.extend({ lat: la, lng: lo }));
    gmap.fitBounds(b, 50);
  } else {
    try { lmap.fitBounds(lTrack.getBounds().pad(0.2)); } catch (e) {}
  }
}
function resizeActive() {
  if (engine === "google" && gmap) google.maps.event.trigger(gmap, "resize");
  else if (lmap) lmap.invalidateSize();
}

// ----------------------------------------------------------------------------- rendering (both engines)
function renderTrack() {
  const head = trackLatLngs[trackLatLngs.length - 1];
  if (engine === "google") {
    const path = trackLatLngs.map(([la, lo]) => ({ lat: la, lng: lo }));
    if (!gTrack) gTrack = new google.maps.Polyline({ path: path, strokeColor: "#1565c0", strokeOpacity: 0.9, strokeWeight: 5, map: gmap });
    else gTrack.setPath(path);
    if (head) {
      if (!gHead) gHead = new google.maps.Marker({ position: { lat: head[0], lng: head[1] }, map: gmap, icon: gHeadIcon(), zIndex: 9999 });
      else gHead.setPosition({ lat: head[0], lng: head[1] });
    }
  } else {
    lTrack.setLatLngs(trackLatLngs);
    if (head) {
      if (!lHead) lHead = L.circleMarker(head, { radius: 7, color: "#fff", weight: 2, fillColor: "#e53935", fillOpacity: 1 }).addTo(lmap);
      else lHead.setLatLng(head);
    }
  }
}
function gHeadIcon() {
  return { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: "#e53935", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
}
function addLMarker(ph) {
  const m = L.marker([ph.lat, ph.lon], { icon: camIcon() }).addTo(lPhotoLayer);
  m.on("click", () => openPhoto(ph.asset, false));
  ph._lmarker = m;
}
function addGMarker(ph) {
  const m = new google.maps.Marker({ position: { lat: ph.lat, lng: ph.lon }, map: gmap, label: { text: "📷", fontSize: "20px" }, title: ph.name || "" });
  m.addListener("click", () => openPhoto(ph.asset, false));
  ph._gmarker = m;
  gMarkers.push(m);
}
function addMarkerActive(ph) { if (engine === "google" && gmap) addGMarker(ph); else addLMarker(ph); }
function renderPhotosFull() {
  if (engine === "google") {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    photos.forEach(addGMarker);
  } else {
    lPhotoLayer.clearLayers();
    photos.forEach(addLMarker);
  }
}
function renderActiveEngine() { renderTrack(); renderPhotosFull(); }
function clearRenders() {
  lPhotoLayer.clearLayers(); lTrack.setLatLngs([]);
  if (lHead) { lmap.removeLayer(lHead); lHead = null; }
  if (gmap) {
    gMarkers.forEach((m) => m.setMap(null)); gMarkers = [];
    if (gTrack) { gTrack.setMap(null); gTrack = null; }
    if (gHead) { gHead.setMap(null); gHead = null; }
  }
}

// ----------------------------------------------------------------------------- locate
function locateTraveler() {
  if (trackLatLngs.length) { const h = trackLatLngs[trackLatLngs.length - 1]; mapSetView(h[0], h[1], Math.max(mapZoom(), 16)); return; }
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
    (p) => mapSetView(p.coords.latitude, p.coords.longitude, 16), () => {},
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

// ----------------------------------------------------------------------------- photo balloon + lightbox
function sortPhotos() { photoSorted = photos.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)); }

// Open a photo: centre the map on it (so the balloon lands at the map centre → the ‹ › buttons keep the
// same screen position across navigations, enabling continuous clicking), show the balloon, optionally
// go full-screen too. Used by marker clicks, balloon ‹ ›, and lightbox ‹ ›.
function openPhoto(key, fullscreen) {
  sortPhotos();
  if (!photoSorted.length) return;
  let i = (typeof key === "number") ? key : photoSorted.findIndex((p) => p.asset === key);
  if (i < 0) i = 0;
  curPhoto = Math.max(0, Math.min(i, photoSorted.length - 1));
  const p = photoSorted[curPhoto];
  if (p.lat != null && p.lon != null) mapCenterOn(p.lat, p.lon, false);
  showBalloon(p);
  if (fullscreen) showLightbox(p);
}
function navPhoto(d) { if (photoSorted.length) openPhoto(curPhoto + d, fsOpen); }

function showBalloon(p) {
  const bl = document.getElementById("balloon");
  const when = p.ts ? new Date(p.ts * 1000).toLocaleString() : "";
  const badge = p.matched_by === "exif" ? "EXIF GPS" : "matched to track";
  const atStart = curPhoto === 0, atEnd = curPhoto === photoSorted.length - 1;
  bl.innerHTML =
    `<div class="bl-bubble">
       <button class="bl-x" title="Close">✕</button>
       <div class="bl-imgwrap">
         <img class="bl-img" src="${thumb(p.asset)}" alt="">
         <button class="bl-nav bl-prev ${atStart ? "off" : ""}" title="Previous">‹</button>
         <button class="bl-nav bl-next ${atEnd ? "off" : ""}" title="Next">›</button>
       </div>
       <div class="bl-meta">${esc(p.name || "")}<br><span>${esc(when)}</span> · <span class="badge">${badge}</span></div>
       <button class="bl-full">⛶ Full screen</button>
     </div>
     <div class="bl-tail"></div>`;
  bl.querySelector(".bl-prev").onclick = (e) => { e.stopPropagation(); navPhoto(-1); };
  bl.querySelector(".bl-next").onclick = (e) => { e.stopPropagation(); navPhoto(1); };
  bl.querySelector(".bl-full").onclick = (e) => { e.stopPropagation(); openPhoto(curPhoto, true); };
  bl.querySelector(".bl-x").onclick = (e) => { e.stopPropagation(); closeBalloon(); };
  bl.classList.remove("hidden");
}
function closeBalloon() { const bl = document.getElementById("balloon"); if (bl) bl.classList.add("hidden"); }

function requestFs(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (fn) { try { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
}
function showLightbox(p) {
  const lb = document.getElementById("lightbox");
  document.getElementById("lb-img").src = preview(p.asset);
  document.getElementById("lb-orig").href = original(p.asset);
  document.getElementById("lb-prev").classList.toggle("lb-nav-off", curPhoto === 0);
  document.getElementById("lb-next").classList.toggle("lb-nav-off", curPhoto === photoSorted.length - 1);
  lb.classList.remove("lb-hidden");
  if (!fsOpen) { requestFs(lb); fsOpen = true; }
}
function closeLightbox() {
  const lb = document.getElementById("lightbox");
  lb.classList.add("lb-hidden");
  document.getElementById("lb-img").src = "";
  if (document.fullscreenElement || document.webkitFullscreenElement) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
  fsOpen = false;
  // the balloon stays open + the map stays centred on the current photo (req 8)
}
function onFsChange() {
  if (!(document.fullscreenElement || document.webkitFullscreenElement) && fsOpen) {
    const lb = document.getElementById("lightbox");
    lb.classList.add("lb-hidden"); document.getElementById("lb-img").src = ""; fsOpen = false;
  }
}

// ----------------------------------------------------------------------------- panel collapse
function initCollapse() {
  let saved = null;
  try { saved = localStorage.getItem("tt_collapsed"); } catch (e) {}
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const collapsed = saved != null ? saved === "1" : mobile;   // default collapsed on phones
  document.body.classList.toggle("collapsed", collapsed);
}
function setCollapsed(v) {
  document.body.classList.toggle("collapsed", v);
  try { localStorage.setItem("tt_collapsed", v ? "1" : "0"); } catch (e) {}
  setTimeout(resizeActive, 220);
}

// ----------------------------------------------------------------------------- UI wiring
function wireUI() {
  const sel = document.getElementById("basemap");
  if (sel) sel.onchange = (e) => setBasemap(e.target.value);

  document.getElementById("panel-toggle").onclick = () => setCollapsed(true);
  document.getElementById("panel-show").onclick = () => setCollapsed(false);

  const lb = document.getElementById("lightbox");
  document.getElementById("lb-close").onclick = (e) => { e.stopPropagation(); closeLightbox(); };
  document.getElementById("lb-prev").onclick = (e) => { e.stopPropagation(); navPhoto(-1); };
  document.getElementById("lb-next").onclick = (e) => { e.stopPropagation(); navPhoto(1); };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  document.addEventListener("keydown", (e) => {
    if (!lb || lb.classList.contains("lb-hidden")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") navPhoto(-1);
    else if (e.key === "ArrowRight") navPhoto(1);
  });

  const po = document.getElementById("popout");
  if (po) po.href = location.protocol + "//" + location.hostname + ":8099/";

  // admin-only controls (buttons are hidden for viewers via CSS, but guard anyway)
  const iv = document.getElementById("trip-interval");
  const ivl = document.getElementById("iv-label");
  if (iv) iv.oninput = () => (ivl.textContent = iv.value);
  const bStart = document.getElementById("btn-start");
  if (bStart) bStart.onclick = async () => {
    const name = document.getElementById("trip-name").value.trim();
    const interval_s = parseInt(iv.value, 10);
    const t = await jpost(`${API}/trips/start`, { name, interval_s });
    document.getElementById("trip-name").value = "";
    await refreshTrips();
    if (t && t.id) await selectTrip(t.id, true);
  };
  const bStop = document.getElementById("btn-stop");
  if (bStop) bStop.onclick = async () => { await jpost(`${API}/trips/stop`, {}); await refreshTrips(); };
}

function renderCfg() {
  document.getElementById("cfg-box").innerHTML =
    `Photo match: within <b>${cfg.match_tolerance_s}s</b> of a track point and <b>${cfg.near_track_radius_m}m</b> of the track.<br>` +
    `immich: ${cfg.immich ? "connected ✓" : "not configured ✗"} · polls every ${cfg.photo_poll_s}s while a trip is live.`;
}

// ----------------------------------------------------------------------------- live loop + trips
async function tick() {
  try {
    const st = await jget(`${API}/state`);
    activeTripId = st.active ? st.trip.id : null;
    updateActiveBox(st);
    if (st.active && selected == null) { await selectTrip(st.trip.id, true); await refreshTrips(); return; }
    if (selected != null) await appendTripData(selected);
    if (st.active && selected === st.trip.id && centeredTripId !== st.trip.id && trackLatLngs.length) {
      const h = trackLatLngs[trackLatLngs.length - 1];
      mapSetView(h[0], h[1], Math.max(mapZoom(), 16));   // auto-centre ONCE at trip start
      centeredTripId = st.trip.id;
    }
  } catch (e) { console.warn("tick", e); }
}

function updateActiveBox(st) {
  const box = document.getElementById("active-box");
  const stop = document.getElementById("btn-stop");
  const start = document.getElementById("btn-start");
  if (st.active) {
    const t = st.trip;
    const since = new Date(t.started_at).toLocaleTimeString();
    box.innerHTML = `<div class="active"><span class="live">● LIVE</span> <b>${esc(t.name || ("Trip " + t.id))}</b>
      <div class="t-sub">since ${since} · every ${t.interval_s}s · ${t.points} points · ${t.photos} 📷</div></div>`;
    if (stop) stop.hidden = false; if (start) start.hidden = true;
  } else {
    box.innerHTML = `<div class="idle">No active trip</div>`;
    if (stop) stop.hidden = true; if (start) start.hidden = false;
  }
}

async function refreshTrips() {
  const trips = await jget(`${API}/trips`);
  const ul = document.getElementById("trip-list");
  ul.innerHTML = "";
  for (const t of trips) {
    const li = document.createElement("li");
    if (t.id === selected) li.classList.add("sel");
    const started = new Date(t.started_at).toLocaleString();
    li.innerHTML =
      `<div class="t-main"><b>${esc(t.name || ("Trip " + t.id))}</b> ${t.active ? '<span class="live">● LIVE</span>' : ""}
         <div class="t-sub">${started} · ${t.points} pts · ${t.photos} 📷</div></div>
       <div class="t-act">
         <button data-a="sync" title="Re-scan immich for photos">⟳</button>
         <button data-a="rename" title="Rename">✎</button>
         <button data-a="del" title="Delete">🗑</button>
       </div>`;
    li.querySelector(".t-main").onclick = () => selectTrip(t.id, true);
    li.querySelector('[data-a="sync"]').onclick = async (e) => {
      e.stopPropagation();
      const r = await jpost(`${API}/trips/${t.id}/sync_photos`, {});
      if (selected === t.id) { lastPhotoId = 0; photos = []; renderPhotosFull(); await appendTripData(t.id); }
      await refreshTrips();
      if (r && r.added != null) console.info("sync added", r.added, "scanned", r.scanned);
    };
    li.querySelector('[data-a="rename"]').onclick = async (e) => {
      e.stopPropagation();
      const n = prompt("Trip name", t.name || "");
      if (n != null) { await jpost(`${API}/trips/${t.id}/rename`, { name: n }); await refreshTrips(); }
    };
    li.querySelector('[data-a="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (confirm("Delete this trip and all its track points and photo markers?")) {
        await jdel(`${API}/trips/${t.id}`);
        if (selected === t.id) { selected = null; trackLatLngs = []; photos = []; clearRenders(); closeBalloon(); }
        await refreshTrips();
      }
    };
    ul.appendChild(li);
  }
}

async function selectTrip(tid, fit) {
  selected = tid;
  lastPointId = 0; lastPhotoId = 0; trackLatLngs = []; photos = []; photoSorted = []; curPhoto = -1;
  clearRenders();
  closeBalloon();
  highlightList();
  await appendTripData(tid);
  if (fit && trackLatLngs.length) { mapFitTrack(); centeredTripId = tid; }
}

function highlightList() {
  document.querySelectorAll("#trip-list li").forEach((li) => li.classList.remove("sel"));
}

async function appendTripData(tid) {
  const pts = await jget(`${API}/trips/${tid}/track?since_id=${lastPointId}`);
  if (pts.length) {
    for (const p of pts) { trackLatLngs.push([p.lat, p.lon]); if (p.id > lastPointId) lastPointId = p.id; }
    renderTrack();
  }
  const phs = await jget(`${API}/trips/${tid}/photos?since_id=${lastPhotoId}`);
  for (const ph of phs) { photos.push(ph); addMarkerActive(ph); if (ph.id > lastPhotoId) lastPhotoId = ph.id; }
}

document.addEventListener("DOMContentLoaded", init);
