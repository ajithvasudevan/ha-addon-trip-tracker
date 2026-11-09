// Alert zones (admin only). Additive module: reuses the app's globals (lmap, gmap, engine, cfg, isAdmin,
// jget/jpost/jdel, mapCenter/mapCenterOn, renderActiveEngine, setCollapsed). Data lives in the add-on DB
// (/api/zones), the same source of truth the native app uses. Create/edit by panning the map under a fixed
// centre pin (engine-agnostic), set radius + name + enter/leave, Save. Circles render on the active engine.
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var zones = [];
  var lCircles = [], gCircles = [];
  var lPrev = null, gPrev = null;
  var place = null;          // {editId, name, radius, enter, exit} while placing/editing
  var gMoveL = null;
  var searchMarker = null, searchMarkerLL = null;   // temporary pin at the searched place
  var searchHist = [];                               // recent picks (localStorage)
  var searchToken = null, searchTimer = null, lastQuery = "";
  function genToken() { try { return crypto.randomUUID(); } catch (e) { return "" + Date.now() + Math.random(); } }

  function apiUrl(p) { return (typeof API !== "undefined" ? API : "api") + p; }

  var waiter = setInterval(function () {
    if (typeof lmap === "undefined" || !lmap || typeof cfg === "undefined" || !cfg) return;
    clearInterval(waiter);
    try { init(); } catch (e) { console.warn("zones init failed", e); }
  }, 150);

  function init() {
    if (typeof isAdmin !== "undefined" && isAdmin === false) return;   // admin only
    var tabBtn = document.querySelector('#panel-tabs .ptab[data-tab="zones"]');
    if (tabBtn) { tabBtn.hidden = false; tabBtn.onclick = function () { if (typeof activateTab === "function") activateTab("zones"); renderList(); }; }
    if ($("zone-add")) $("zone-add").onclick = function () { startPlacement(null); };
    if ($("zone-search")) $("zone-search").oninput = renderList;
    if ($("zpf-save")) $("zpf-save").onclick = savePlacement;
    if ($("zpf-cancel")) $("zpf-cancel").onclick = exitPlacement;
    if ($("zpf-delete")) $("zpf-delete").onclick = deletePlacement;
    if ($("zpf-radius")) $("zpf-radius").oninput = function () { if (place) { place.radius = parseFloat(this.value) || 0; updatePreview(); } };
    if ($("zpf-name")) $("zpf-name").oninput = function () { if (place) place.name = this.value; };
    if ($("zpf-enter")) $("zpf-enter").onchange = function () { if (place) place.enter = this.checked; };
    if ($("zpf-leave")) $("zpf-leave").onchange = function () { if (place) place.exit = this.checked; };
    // ---- place search (lens + autocomplete + temporary marker) ----
    loadHistory();
    if ($("zone-lens")) { $("zone-lens").hidden = false; $("zone-lens").onclick = openSearch; }
    if ($("zps-close")) $("zps-close").onclick = closeSearch;
    if ($("zps-input")) {
      $("zps-input").oninput = onSearchInput;
      $("zps-input").onfocus = function () { if (!this.value.trim()) renderSearchHistory(); };
    }
    // keep zone circles + search marker after a basemap/engine switch
    if (typeof renderActiveEngine === "function") {
      var orig = renderActiveEngine;
      renderActiveEngine = function () { orig(); try { renderZones(); drawSearchMarker(); if (place) updatePreview(); } catch (e) {} };
    }
    load();
  }

  async function load() {
    try { zones = (await jget(apiUrl("/zones"))) || []; } catch (e) { zones = []; }
    renderZones(); renderList();
  }

  // ---------- map circles (display) ----------
  function clearCircles() {
    lCircles.forEach(function (c) { try { lmap.removeLayer(c); } catch (e) {} }); lCircles = [];
    gCircles.forEach(function (c) { try { c.setMap(null); } catch (e) {} }); gCircles = [];
  }
  function renderZones() {
    clearCircles();
    var useG = (typeof engine !== "undefined" && engine === "google" && typeof gmap !== "undefined" && gmap);
    zones.forEach(function (z) {
      if (place && place.editId != null && place.editId === z.id) return;   // hidden while editing (the preview represents it)
      if (useG) {
        gCircles.push(new google.maps.Circle({ center: { lat: z.lat, lng: z.lon }, radius: z.radius_m, map: gmap,
          strokeColor: "#8b0000", strokeWeight: 2, strokeOpacity: 0.95, fillColor: "#ff0000", fillOpacity: 0.3, clickable: false, zIndex: 1 }));
        gCircles.push(new google.maps.Marker({ position: { lat: z.lat, lng: z.lon }, map: gmap, clickable: false, zIndex: 2,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: "#8b0000", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 } }));
      } else if (typeof lmap !== "undefined" && lmap && typeof L !== "undefined") {
        lCircles.push(L.circle([z.lat, z.lon], { radius: z.radius_m, color: "#8b0000", weight: 2, opacity: 0.95,
          fillColor: "#ff0000", fillOpacity: 0.3, interactive: false }).addTo(lmap));
        lCircles.push(L.circleMarker([z.lat, z.lon], { radius: 5, color: "#ffffff", weight: 2, fillColor: "#8b0000", fillOpacity: 1, interactive: false }).addTo(lmap));
      }
    });
  }

  // ---------- list ----------
  function zName(z) { return (z.name && z.name.trim()) ? z.name : (z.lat.toFixed(4) + ", " + z.lon.toFixed(4)); }
  function renderList() {
    var host = $("zone-list"); if (!host) return;
    var q = (($("zone-search") || {}).value || "").trim().toLowerCase();
    host.innerHTML = "";
    var items = zones.filter(function (z) { return !q || zName(z).toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return zName(a).toLowerCase().localeCompare(zName(b).toLowerCase()); });
    if (!items.length) { host.innerHTML = '<li class="zone-empty">' + (zones.length ? "No matches" : "No alert zones yet") + "</li>"; return; }
    items.forEach(function (z) {
      var li = document.createElement("li"); li.className = "zone-row";
      var flags = z.enter && z.exit ? "enter + leave" : z.exit ? "leave" : "enter";
      var main = document.createElement("div"); main.className = "zone-main";
      var nm = document.createElement("div"); nm.className = "zone-name"; nm.textContent = zName(z);
      var sub = document.createElement("div"); sub.className = "zone-sub"; sub.textContent = Math.round(z.radius_m) + " m · " + flags;
      main.appendChild(nm); main.appendChild(sub);
      main.onclick = function () { if (typeof mapCenterOn === "function") mapCenterOn(z.lat, z.lon, true); if (typeof setCollapsed === "function") setCollapsed(true); };
      var edit = document.createElement("button"); edit.className = "zone-btn"; edit.textContent = "✎"; edit.title = "Edit";
      edit.onclick = function (e) { e.stopPropagation(); startPlacement(z); };
      var del = document.createElement("button"); del.className = "zone-btn"; del.textContent = "✕"; del.title = "Delete";
      del.onclick = async function (e) {
        e.stopPropagation();
        try { await jdel(apiUrl("/zones/" + z.id)); } catch (err) {}
        zones = zones.filter(function (x) { return x.id !== z.id; }); renderZones(); renderList();
      };
      li.appendChild(main); li.appendChild(edit); li.appendChild(del);
      host.appendChild(li);
    });
  }

  // ---------- placement (create / edit) ----------
  function startPlacement(z) {
    place = z ? { editId: z.id, name: z.name || "", radius: z.radius_m, enter: !!z.enter, exit: !!z.exit }
              : { editId: null, name: "", radius: 100, enter: true, exit: false };
    clearSearchMarker();   // any add/edit removes the temporary search pin
    $("zpf-name").value = place.name;
    $("zpf-radius").value = place.radius;
    $("zpf-enter").checked = place.enter;
    $("zpf-leave").checked = place.exit;
    $("zpf-delete").style.display = place.editId ? "" : "none";
    $("zone-placer").hidden = false;
    $("zone-crosshair").hidden = false;
    if (typeof setCollapsed === "function") setCollapsed(true);   // reveal the map
    if (z && typeof mapCenterOn === "function") mapCenterOn(z.lat, z.lon, false);
    attachMove();
    renderZones();   // hide the zone being edited from the committed layer
    updatePreview();
  }
  function exitPlacement() {
    place = null;
    if ($("zone-placer")) $("zone-placer").hidden = true;
    if ($("zone-crosshair")) $("zone-crosshair").hidden = true;
    detachMove();
    clearPreview();
    renderZones();   // restore the committed circle (edit saved or cancelled)
  }
  function clearPreview() {
    if (lPrev) { try { lmap.removeLayer(lPrev); } catch (e) {} lPrev = null; }
    if (gPrev) { try { gPrev.setMap(null); } catch (e) {} gPrev = null; }
  }
  function updatePreview() {
    if (!place || typeof mapCenter !== "function") return;
    var c = mapCenter(); var r = place.radius > 0 ? place.radius : 1;
    var useG = (typeof engine !== "undefined" && engine === "google" && typeof gmap !== "undefined" && gmap);
    if (useG) {
      if (lPrev) { try { lmap.removeLayer(lPrev); } catch (e) {} lPrev = null; }
      if (!gPrev) gPrev = new google.maps.Circle({ map: gmap, strokeColor: "#8b0000", strokeWeight: 2, fillColor: "#ff0000", fillOpacity: 0.3, clickable: false, zIndex: 3 });
      gPrev.setCenter({ lat: c[0], lng: c[1] }); gPrev.setRadius(r);
    } else if (typeof lmap !== "undefined" && lmap) {
      if (gPrev) { try { gPrev.setMap(null); } catch (e) {} gPrev = null; }
      if (!lPrev) lPrev = L.circle([c[0], c[1]], { radius: r, color: "#8b0000", weight: 2, fillColor: "#ff0000", fillOpacity: 0.3, interactive: false }).addTo(lmap);
      else { lPrev.setLatLng([c[0], c[1]]); lPrev.setRadius(r); }
    }
  }
  function attachMove() {
    if (typeof lmap !== "undefined" && lmap) lmap.on("move zoom", updatePreview);
    if (typeof gmap !== "undefined" && gmap) gMoveL = gmap.addListener("center_changed", updatePreview);
  }
  function detachMove() {
    if (typeof lmap !== "undefined" && lmap) lmap.off("move zoom", updatePreview);
    if (gMoveL) { try { google.maps.event.removeListener(gMoveL); } catch (e) {} gMoveL = null; }
  }
  async function savePlacement() {
    if (!place || typeof mapCenter !== "function") return;
    var c = mapCenter(); var r = place.radius;
    if (!(r > 0)) { alert("Enter a radius greater than 0"); return; }
    if (!place.enter && !place.exit) { alert("Choose entering, leaving, or both"); return; }
    var body = { lat: c[0], lon: c[1], radius_m: r, enter: place.enter, exit: place.exit, name: (place.name || "").trim() };
    var editId = place.editId, blank = !body.name;
    try {
      var saved = editId ? await jpost(apiUrl("/zones/" + editId), body) : await jpost(apiUrl("/zones"), body);
      if (!saved || saved.id == null) throw new Error("bad response");
      if (editId) zones = zones.map(function (z) { return z.id === editId ? saved : z; });
      else zones.push(saved);
      exitPlacement(); renderZones(); renderList();
      if (blank) autoName(saved);
    } catch (e) { alert("Couldn't save the zone"); }
  }
  async function deletePlacement() {
    if (!place || !place.editId) return;
    var id = place.editId;
    try { await jdel(apiUrl("/zones/" + id)); } catch (e) {}
    zones = zones.filter(function (z) { return z.id !== id; });
    exitPlacement(); renderZones(); renderList();
  }

  // ---------- reverse-geocode naming (client-side Google Geocoder; skips Plus Codes) ----------
  function pickName(results) {
    var pri = ["point_of_interest", "premise", "establishment", "tourist_attraction", "park", "natural_feature",
      "neighborhood", "sublocality_level_1", "sublocality", "locality", "administrative_area_level_3", "administrative_area_level_2"];
    for (var p = 0; p < pri.length; p++)
      for (var i = 0; i < results.length; i++) {
        var comps = results[i].address_components || [];
        for (var j = 0; j < comps.length; j++) if (comps[j].types.indexOf(pri[p]) >= 0) return comps[j].long_name;
      }
    return "";
  }
  async function autoName(z) {
    var key = (typeof cfg !== "undefined" && cfg) ? cfg.google_key : "";
    if (!key) return;
    try {
      var r = await fetch("https://maps.googleapis.com/maps/api/geocode/json?latlng=" + z.lat + "," + z.lon + "&key=" + encodeURIComponent(key));
      var j = await r.json();
      if (j.status !== "OK" || !j.results || !j.results.length) return;
      var n = pickName(j.results); if (!n) return;
      var saved = await jpost(apiUrl("/zones/" + z.id), { name: n });
      if (saved && saved.id != null) { zones = zones.map(function (x) { return x.id === z.id ? saved : x; }); renderList(); }
    } catch (e) {}
  }

  // ================= place search (Places API New + Geocoding, browser fetch via CORS) =================
  function openSearch() {
    if ($("zone-lens")) $("zone-lens").hidden = true;
    if ($("zone-search-bar")) $("zone-search-bar").hidden = false;
    searchToken = genToken();
    var inp = $("zps-input"); if (inp) { inp.value = ""; inp.focus(); }
    renderSearchHistory();
  }
  function closeSearch() {
    if ($("zone-search-bar")) $("zone-search-bar").hidden = true;
    if ($("zone-lens")) $("zone-lens").hidden = false;
    if ($("zps-results")) $("zps-results").innerHTML = "";
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  }
  function onSearchInput() {
    var q = (this.value || "").trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { renderSearchHistory(); return; }
    if (q.length < 2) { if ($("zps-results")) $("zps-results").innerHTML = ""; return; }
    lastQuery = q;
    searchTimer = setTimeout(function () { doAutocomplete(q); }, 250);
  }
  async function doAutocomplete(q) {
    var key = (typeof cfg !== "undefined" && cfg) ? cfg.google_key : "";
    if (!key) return;
    var body = { input: q, sessionToken: searchToken };
    try { var c = mapCenter(); if (c) body.locationBias = { circle: { center: { latitude: c[0], longitude: c[1] }, radius: 50000.0 } }; } catch (e) {}
    try {
      var r = await fetch("https://places.googleapis.com/v1/places:autocomplete",
        { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key }, body: JSON.stringify(body) });
      var j = await r.json();
      if (q !== lastQuery) return;   // a newer keystroke superseded this
      var preds = (j.suggestions || []).map(function (s) { return s.placePrediction; }).filter(Boolean);
      renderSearchResults(preds);
    } catch (e) {}
  }
  function textOf(pred) {
    var sf = pred.structuredFormat || {};
    var m = sf.mainText && sf.mainText.text;
    var s = sf.secondaryText && sf.secondaryText.text;
    return { main: m || (pred.text && pred.text.text) || "", sec: s || "" };
  }
  function renderSearchResults(preds) {
    var host = $("zps-results"); if (!host) return;
    host.innerHTML = "";
    if (!preds.length) { host.innerHTML = '<div class="zps-empty">No matches</div>'; return; }
    preds.forEach(function (p) {
      var t = textOf(p);
      var row = document.createElement("div"); row.className = "zps-row";
      var wrap = document.createElement("div"); wrap.className = "zps-histmain";
      var a = document.createElement("div"); a.className = "zps-main"; a.textContent = t.main;
      wrap.appendChild(a);
      if (t.sec) { var b = document.createElement("div"); b.className = "zps-sub"; b.textContent = t.sec; wrap.appendChild(b); }
      row.appendChild(wrap);
      row.onclick = function () { pickPlace(p, t); };
      host.appendChild(row);
    });
  }
  async function pickPlace(pred, t) {
    var key = (typeof cfg !== "undefined" && cfg) ? cfg.google_key : "";
    if (!key || !pred.placeId) return;
    try {
      var r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(pred.placeId),
        { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "location" } });
      var j = await r.json();
      if (j.location) { var lat = j.location.latitude, lon = j.location.longitude; addHistory(t.main, t.sec, lat, lon); gotoAndMark(lat, lon); }
    } catch (e) {}
    searchToken = genToken();   // close the autocomplete session
  }
  function gotoAndMark(lat, lon) {
    try {
      if (typeof mapSetView === "function") mapSetView(lat, lon, Math.max((typeof mapZoom === "function" ? mapZoom() : 15), 15));
      else if (typeof mapCenterOn === "function") mapCenterOn(lat, lon, true);
    } catch (e) {}
    showSearchMarker(lat, lon);
    closeSearch();
  }
  // ---- search history (localStorage) ----
  function loadHistory() { try { searchHist = JSON.parse(localStorage.getItem("tt_zone_search_hist") || "[]") || []; } catch (e) { searchHist = []; } }
  function saveHistory() { try { localStorage.setItem("tt_zone_search_hist", JSON.stringify(searchHist)); } catch (e) {} }
  function addHistory(name, sec, lat, lon) {
    searchHist = searchHist.filter(function (h) { return !(h.name === name && h.sec === sec); });
    searchHist.unshift({ name: name, sec: sec, lat: lat, lon: lon });
    if (searchHist.length > 100) searchHist = searchHist.slice(0, 100);
    saveHistory();
  }
  function renderSearchHistory() {
    var host = $("zps-results"); if (!host) return;
    host.innerHTML = "";
    if (!searchHist.length) return;
    searchHist.forEach(function (h) {
      var row = document.createElement("div"); row.className = "zps-row";
      var wrap = document.createElement("div"); wrap.className = "zps-histmain";
      var main = document.createElement("div"); main.className = "zps-main"; main.textContent = h.name || (h.lat.toFixed(4) + ", " + h.lon.toFixed(4));
      wrap.appendChild(main);
      if (h.sec) { var b = document.createElement("div"); b.className = "zps-sub"; b.textContent = h.sec; wrap.appendChild(b); }
      wrap.onclick = function () { addHistory(h.name, h.sec, h.lat, h.lon); gotoAndMark(h.lat, h.lon); };
      var x = document.createElement("button"); x.className = "zps-x"; x.textContent = "✕"; x.title = "Remove";
      x.onclick = function (e) { e.stopPropagation(); searchHist = searchHist.filter(function (z) { return z !== h; }); saveHistory(); renderSearchHistory(); };
      row.appendChild(wrap); row.appendChild(x);
      host.appendChild(row);
    });
  }
  // ---- temporary search marker (click it to add a zone there) ----
  function showSearchMarker(lat, lon) { searchMarkerLL = { lat: lat, lon: lon }; drawSearchMarker(); }
  function clearSearchMarker() { searchMarkerLL = null; removeSearchMarker(); }
  function removeSearchMarker() {
    if (searchMarker) { try { if (searchMarker.setMap) searchMarker.setMap(null); else lmap.removeLayer(searchMarker); } catch (e) {} searchMarker = null; }
  }
  function drawSearchMarker() {
    removeSearchMarker();
    if (!searchMarkerLL) return;
    var lat = searchMarkerLL.lat, lon = searchMarkerLL.lon;
    var useG = (typeof engine !== "undefined" && engine === "google" && typeof gmap !== "undefined" && gmap);
    if (useG) {
      searchMarker = new google.maps.Marker({ position: { lat: lat, lng: lon }, map: gmap, zIndex: 20,
        icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png", title: "Tap to add a zone here" });
      searchMarker.addListener("click", onSearchMarkerClick);
    } else if (typeof lmap !== "undefined" && lmap && typeof L !== "undefined") {
      searchMarker = L.marker([lat, lon], { title: "Tap to add a zone here",
        icon: L.divIcon({ className: "zps-pin", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="zps-pin-in"></div>' }) }).addTo(lmap);
      searchMarker.on("click", onSearchMarkerClick);
    }
  }
  function onSearchMarkerClick() {
    var ll = searchMarkerLL; if (!ll) return;
    try { if (typeof mapCenterOn === "function") mapCenterOn(ll.lat, ll.lon, false); } catch (e) {}
    startPlacement(null);   // clears the marker, opens the add form centred here
  }
})();
