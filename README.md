# Trip Tracker (Home Assistant add-on)

A live **trip map** in the HA sidebar: a GPS track that grows as you travel, plus **photo markers**
pulled from immich. Click a marker → a popup of the picture taken at that spot.

- **Track** comes from the **[MyMessages](https://github.com/ajithvasudevan/mymessages)** app
  (Trip tab) over MQTT, at a configurable interval.
- **Photos** come from **immich**: EXIF GPS is used when present; otherwise the marker is placed on the
  track by fuzzy-matching the photo's capture time to the nearest track point (within a tolerance). A
  photo counts for a trip only if it was taken during the trip **and** near the track.
- **Data** lives in the recorder Postgres under a dedicated `trips` schema (separate from
  `notifications`; survives recorder purges).
- A matching **[native Android app](https://github.com/ajithvasudevan/triptracker)**
  (`dev.ajithv.triptracker`) is a first-class client of this add-on.

---

## Access & auth

| Entry | Port | Who | Rights |
| --- | --- | --- | --- |
| HA sidebar (ingress) | `8098` | logged-in HA user | **admin** |
| Direct web UI | `8099` | anyone on the LAN | **read-only** (hidden trips not shown) |
| Direct + `X-TT-Token` header | `8099` | the native app | **admin** (token = `app_token`) |
| Public share link | `trips.ajithv.in/share/<token>` | anyone with the link | scoped read-only (one trip, tagged photos) |

Admin unlocks start/stop, point spacing, rename, recolour, hide/show, delete, re-sync, basemap-share,
track editing, gap-fill, and sharing. The native app has no HA session, so it sends the shared
`X-TT-Token` header instead (see `app_token` below).

---

## Configuration

Most fields auto-resolve, so the defaults usually just work. Secrets left blank fall back to
`/config/secrets.yaml`; nothing sensitive is stored in the repo.

| Option | Default | Notes |
| --- | --- | --- |
| `db_uri` | *(blank)* | Recorder Postgres DSN. Blank → read `recorder_db_url` from `secrets.yaml`. |
| `ha_url` | `http://homeassistant:8123` | HA base URL (used for optional HA WebSocket lookups). |
| `ha_token` | *(blank)* | HA long-lived token for those lookups; blank disables them. |
| `immich_url` | `http://172.20.1.127:2283` | immich base URL. |
| `immich_key` | *(blank)* | Blank → read `immich_key` from `secrets.yaml`. Photo markers off until set. |
| `google_maps_key` | *(blank)* | Maps-JS key → enables the Google basemaps + the share page map. Blank = Google options hidden. |
| `app_token` | *(blank)* | Admin token for the native app's `X-TT-Token` header. Blank → `trip_tracker_app_token` from `secrets.yaml`. |
| `mqtt_host`/`mqtt_port`/`mqtt_user`/`mqtt_password` | *(blank)* | Blank → use the Supervisor MQTT service (`mqtt:want`); else paste the broker user/pass. |
| `base_topic` | `trips` | MQTT topic namespace. |
| `photo_poll_s` | `20` | immich poll cadence while a trip is live. |
| `match_tolerance_s` | `120` | Max time gap (s) to place a no-GPS photo on the track. |
| `near_track_radius_m` | `300` | Max distance (m) an EXIF-GPS photo may be from the track to count. |
| `max_speed_kmph` | `150` | Speed sanity ceiling used to drop outlier fixes. |
| `map_center_lat` / `map_center_lon` / `map_zoom` | Bangalore / 13 | Initial map view; auto-fits to a trip once one is loaded. |
| `log_level` | `info` | `trace`…`fatal`. |

---

## Map

**No API key required** for the default basemaps. The web UI uses **Leaflet** with:

- **CARTO Voyager** — a MapLibre-GL vector style (via the `leaflet-maplibre-gl` plugin).
- **Esri raster** — Streets, Topographic, and Satellite tile layers.
- **Native Google Maps JS** — Roadmap / Satellite / Hybrid / Terrain, shown only when
  `google_maps_key` is set (loaded as a separate engine so Google's own controls work).

Leaflet + the MapLibre-GL plugin are vendored into the image at build time, so the panel needs no CDN at
runtime (Google Maps JS, if enabled, loads from Google). The admin's basemap choice is shared to read-only
viewers via `POST /api/basemap`.

## Tracks & editing

- The live track grows as points arrive and is drawn with gaps left as gaps (no false straight chords).
- **Manual editing** (admin): move / delete / add / join / densify points, with timestamps either kept or
  recomputed by distance.
- **Gap-fill** (`app/gapfill.py`): reconstruct a missing stretch and insert `source='filled'` points
  (rendered dotted, fully removable; real fixes are never altered):
  - **Rail** gaps → shortest path along OSM `railway=rail` (Overpass, openstreetmap.fr mirror, disk-cached).
  - **Road** gaps → a public OSRM driving route.
  Pure-stdlib (`urllib`), so it runs inside the add-on image unchanged.

## Sharing

Admins mint a public link scoped to one trip and one photo tag — `relatives` → **Relatives**-tagged photos,
`world` → **World**-tagged photos. The `/share/<token>` page (`app/static/share.html`, Google-Maps-based)
shows that trip's track and only the photos carrying the matching tag. Tokens are created / listed / revoked
via `POST /api/trips/<id>/share`, `GET …/shares`, `POST …/unshare`.

---

## MQTT contract (base topic `trips`)

| Topic | Direction | Payload |
| --- | --- | --- |
| `trips/control` | both | `{cmd:"start"\|"stop", name?, interval_s?, trip_id?, source:"app"\|"addon"}` |
| `trips/track` | app → addon | `{trip_id, ts, lat, lon, acc?, speed?, alt?}` (`ts` epoch-ms, epoch-s, or ISO) |
| `trips/state` | addon → app (retained) | `{active, trip_id, name, interval_s, started_at}` |

The add-on allocates the authoritative `trip_id` (Postgres serial) and advertises it on the retained
`trips/state`; the phone reads that to learn which trip to tag points with. A start/stop from the web
side-panel publishes `state` + a `control` nudge so the phone begins/stops sending.

---

## HTTP API (admin unless noted)

- **State / trips:** `GET /api/state`, `GET /api/trips`, `POST /api/trips/{start,stop}`,
  `POST /api/trips/<id>/{spacing,rename}`, `DELETE /api/trips/<id>`, `POST /api/basemap`.
- **Track:** `GET /api/trips/<id>/track` *(read-only ok)*, `POST /api/trips/<id>/points/{move,delete,add,join,densify}`,
  `POST /api/trips/<id>/{fill_gaps,unfill_gaps}`, `GET /api/trips/<id>/fill_status`.
- **Photos:** `GET /api/trips/<id>/photos` *(read-only ok)*, `POST /api/trips/<id>/sync_photos`,
  `POST /api/photo/<asset>/tag`, `DELETE /api/photo/<asset>`,
  `GET /api/photo/<asset>/{thumbnail,preview,original,video}` (immich proxy).
- **Export:** `GET /api/trips/<id>/export.{gpx,geojson}` *(read-only ok)*.
- **Sharing:** `POST /api/trips/<id>/share`, `GET /api/trips/<id>/shares`, `POST /api/trips/<id>/unshare`;
  public `GET /share/<token>[/data|/track|/photos|/photo/<asset>/<size>]`.

---

## Related projects

- **[triptracker](https://github.com/ajithvasudevan/triptracker)** — the native Android viewer app.
- **[mymessages](https://github.com/ajithvasudevan/mymessages)** — the phone app that publishes the live
  GPS track (and other features).
