# Trip Tracker (Home Assistant add-on)

A live **trip map** in the HA sidebar: a GPS track that grows as you travel, plus **photo markers**
pulled from immich. Click a marker → a medium popup of the picture taken at that spot.

- **Track** comes from the **MyMessages** app (Trip tab) over MQTT, at a configurable interval.
- **Photos** come from **immich**: EXIF GPS is used when present; otherwise the marker is placed on the
  track by fuzzy-matching the photo's capture time to the nearest track point (within a tolerance). A
  photo counts for a trip only if it was taken during the trip **and** near the track.
- **Data** lives in the recorder Postgres under a dedicated `trips` schema (separate from
  `notifications`; survives recorder purges).

## Configuration
Most fields auto-resolve, so the defaults usually just work:

| Option | Default | Notes |
| --- | --- | --- |
| `db_uri` | *(blank)* | Recorder Postgres DSN. Blank → read `recorder_db_url` from `/config/secrets.yaml`. |
| `immich_url` | `http://172.20.1.127:2283` | immich base URL. |
| `immich_key` | *(blank)* | Blank → read `immich_key` from `/config/secrets.yaml`. Photo markers off until set. |
| `mqtt_host`/`mqtt_port`/`mqtt_user`/`mqtt_password` | *(blank)* | Blank → use the Supervisor MQTT service (`mqtt:want`); else paste the broker user/pass. |
| `base_topic` | `trips` | MQTT topic namespace. |
| `photo_poll_s` | `20` | immich poll cadence while a trip is live. |
| `match_tolerance_s` | `120` | Max time gap (s) to place a no-GPS photo on the track. |
| `near_track_radius_m` | `300` | Max distance (m) an EXIF-GPS photo may be from the track to count. |
| `map_center_*` / `map_zoom` | Bangalore | Initial map view; auto-fits to a trip once one is loaded. |

## MQTT contract (base topic `trips`)
| Topic | Direction | Payload |
| --- | --- | --- |
| `trips/control` | both | `{cmd:"start"\|"stop", name?, interval_s?, trip_id?, source:"app"\|"addon"}` |
| `trips/track` | app → addon | `{trip_id, ts, lat, lon, acc?, speed?, alt?}` (`ts` epoch-ms, epoch-s, or ISO) |
| `trips/state` | addon → app (retained) | `{active, trip_id, name, interval_s, started_at}` |

The add-on allocates the authoritative `trip_id` (Postgres serial) and advertises it on the retained
`trips/state`; the phone reads that to learn which trip to tag points with. A start/stop from the web
side-panel publishes `state` + a `control` nudge so the phone begins/stops sending.

## Map
No API key. Leaflet with an OpenStreetMap "Streets" base and an Esri "Satellite" layer (toggle,
top-right). Leaflet is vendored into the image at build time, so the panel needs no CDN at runtime.
