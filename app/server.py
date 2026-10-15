#!/usr/bin/env python3
"""Trip Tracker add-on backend.

Flask (served by waitress) behind HA ingress, plus two background threads:
  - MQTT client: ingests track points / trip control from the MyMessages app
  - immich poller: matches newly-uploaded photos to the active trip

State of record is the recorder Postgres `trips` schema.
"""
import datetime as dt
import json
import logging
import os
import threading
import time

import psycopg2
import psycopg2.extras
import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from psycopg2 import pool as pgpool
import paho.mqtt.client as mqtt

import matcher

# --------------------------------------------------------------------------- config
DB_URI = os.environ["TT_DB_URI"]
IMMICH_URL = (os.environ.get("TT_IMMICH_URL") or "").rstrip("/")
IMMICH_KEY = os.environ.get("TT_IMMICH_KEY") or ""
_ha_url = (os.environ.get("TT_HA_URL") or "").strip()
HA_URL = (_ha_url if _ha_url and _ha_url.lower() != "null" else "http://homeassistant:8123").rstrip("/")
_ha_tok = (os.environ.get("TT_HA_TOKEN") or "").strip()
HA_TOKEN = "" if _ha_tok.lower() == "null" else _ha_tok
_gkey = (os.environ.get("TT_GOOGLE_MAPS_KEY") or "").strip()
GOOGLE_KEY = "" if _gkey.lower() == "null" else _gkey
MQTT_HOST = os.environ.get("TT_MQTT_HOST") or "172.20.1.100"
MQTT_PORT = int(os.environ.get("TT_MQTT_PORT") or 1883)
MQTT_USER = os.environ.get("TT_MQTT_USER") or None
MQTT_PASSWORD = os.environ.get("TT_MQTT_PASSWORD") or None
BASE = (os.environ.get("TT_BASE_TOPIC") or "trips").strip("/")
PHOTO_POLL_S = int(os.environ.get("TT_PHOTO_POLL_S") or 20)
TOL_S = int(os.environ.get("TT_MATCH_TOLERANCE_S") or 120)
RADIUS_M = int(os.environ.get("TT_NEAR_TRACK_RADIUS_M") or 300)
try:
    _mx = float(os.environ.get("TT_MAX_SPEED_KMPH") or 150)
except (TypeError, ValueError):
    _mx = 150.0
MAX_SPEED_MS = (_mx if _mx > 0 else 150.0) / 3.6   # reject track points implying a faster-than-real speed
MAP_LAT = float(os.environ.get("TT_MAP_CENTER_LAT") or 12.9716)
MAP_LON = float(os.environ.get("TT_MAP_CENTER_LON") or 77.5946)
MAP_ZOOM = int(os.environ.get("TT_MAP_ZOOM") or 13)
LOG_LEVEL = (os.environ.get("TT_LOG_LEVEL") or "info").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("trip-tracker")

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------- db
_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = pgpool.ThreadedConnectionPool(1, 8, dsn=DB_URI, connect_timeout=10)
        return _pool


def _reset_pool():
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.closeall()
            except Exception:
                pass
            _pool = None


def dbx(sql, args=None, fetch=None, dict_cur=False):
    """Execute SQL; fetch in {None,'one','all'}. Retries once over a dropped
    connection (the recorder DB is known to restart — see CLAUDE.md)."""
    last = None
    for attempt in range(3):
        p = _get_pool()
        conn = None
        ok = False
        try:
            conn = p.getconn()
            cur = conn.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor if dict_cur else None
            )
            cur.execute(sql, args or ())
            out = cur.fetchone() if fetch == "one" else cur.fetchall() if fetch == "all" else None
            conn.commit()
            cur.close()
            ok = True
            return out
        except psycopg2.OperationalError as e:
            last = e
            log.warning("DB operational error (attempt %d): %s", attempt + 1, e)
            _reset_pool()
            time.sleep(0.5 * (attempt + 1))
        finally:
            if conn is not None:
                if ok:
                    try:
                        p.putconn(conn)
                    except Exception:
                        pass
                else:
                    try:
                        conn.close()
                    except Exception:
                        pass
    raise last


SCHEMA_SQL = """
CREATE SCHEMA IF NOT EXISTS trips;
CREATE TABLE IF NOT EXISTS trips.trip (
  id          serial PRIMARY KEY,
  name        text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz,
  active      boolean NOT NULL DEFAULT true,
  interval_s  integer NOT NULL DEFAULT 15,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trips.track_point (
  id        bigserial PRIMARY KEY,
  trip_id   integer NOT NULL REFERENCES trips.trip(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL,
  lat       double precision NOT NULL,
  lon       double precision NOT NULL,
  accuracy  real,
  speed     real,
  altitude  real,
  source    text
);
CREATE INDEX IF NOT EXISTS track_point_trip_id_idx ON trips.track_point(trip_id, id);
CREATE INDEX IF NOT EXISTS track_point_trip_ts_idx ON trips.track_point(trip_id, ts);
CREATE TABLE IF NOT EXISTS trips.photo (
  id                serial PRIMARY KEY,
  trip_id           integer NOT NULL REFERENCES trips.trip(id) ON DELETE CASCADE,
  immich_asset_id   text NOT NULL,
  capture_ts        timestamptz,
  lat               double precision,
  lon               double precision,
  matched_by        text,
  original_filename text,
  processed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, immich_asset_id)
);
CREATE INDEX IF NOT EXISTS photo_trip_idx ON trips.photo(trip_id, id);
"""


def bootstrap_schema():
    dbx(SCHEMA_SQL)
    log.info("trips schema ready")


# --------------------------------------------------------------------------- helpers
def iso(d):
    if d is None:
        return None
    if isinstance(d, str):
        return d
    return d.astimezone(dt.timezone.utc).isoformat()


def parse_ts(v):
    """epoch ms / epoch s / ISO string → aware UTC datetime (now() on failure)."""
    if v is None:
        return dt.datetime.now(dt.timezone.utc)
    try:
        if isinstance(v, (int, float)):
            s = v / 1000.0 if v > 1e12 else float(v)
            return dt.datetime.fromtimestamp(s, dt.timezone.utc)
        s = str(v).strip()
        if s.replace(".", "", 1).isdigit():
            n = float(s)
            n = n / 1000.0 if n > 1e12 else n
            return dt.datetime.fromtimestamp(n, dt.timezone.utc)
        return matcher.parse_iso(s)
    except Exception:
        return dt.datetime.now(dt.timezone.utc)


def default_name():
    return "Trip " + dt.datetime.now().strftime("%d %b %H:%M")


def get_active_trip():
    return dbx(
        "SELECT id,name,started_at,stopped_at,active,interval_s FROM trips.trip "
        "WHERE active=true ORDER BY id DESC LIMIT 1",
        fetch="one",
        dict_cur=True,
    )


def trip_public(r):
    if r is None:
        return None
    d = dict(r)
    for k in ("started_at", "stopped_at", "created_at"):
        if d.get(k) is not None:
            d[k] = iso(d[k])
    for k in ("id", "interval_s", "points", "photos"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


# --------------------------------------------------------------------------- trip lifecycle
def start_trip(name, interval_s, origin):
    dbx("UPDATE trips.trip SET active=false, stopped_at=COALESCE(stopped_at, now()) WHERE active=true")
    row = dbx(
        "INSERT INTO trips.trip(name, interval_s, active) VALUES (%s,%s,true) "
        "RETURNING id,name,started_at,stopped_at,active,interval_s",
        (name or default_name(), interval_s),
        fetch="one",
        dict_cur=True,
    )
    publish_state()
    # nudge the phone to begin sending (source=addon so our own echo is ignored)
    mqtt_publish(
        f"{BASE}/control",
        {"cmd": "start", "trip_id": row["id"], "name": row["name"], "interval_s": interval_s, "source": "addon"},
    )
    log.info("trip START id=%s name=%s interval=%ss origin=%s", row["id"], row["name"], interval_s, origin)
    return row


def stop_trip(origin):
    t = get_active_trip()
    dbx("UPDATE trips.trip SET active=false, stopped_at=now() WHERE active=true")
    publish_state()
    mqtt_publish(f"{BASE}/control", {"cmd": "stop", "source": "addon"})
    log.info("trip STOP origin=%s id=%s", origin, t["id"] if t else None)
    if t:
        threading.Thread(target=_safe_sync, args=(t["id"],), daemon=True).start()
    return t


# --------------------------------------------------------------------------- immich sync
def _safe_sync(trip_id):
    try:
        sync_photos(trip_id)
    except Exception as e:
        log.warning("sync_photos(%s) failed: %s", trip_id, e)


def sync_photos(trip_id):
    if not IMMICH_KEY:
        return {"error": "immich_key not set", "added": 0}
    t = dbx(
        "SELECT id, started_at, stopped_at FROM trips.trip WHERE id=%s",
        (trip_id,),
        fetch="one",
        dict_cur=True,
    )
    if not t:
        return {"error": "no such trip", "added": 0}
    after = t["started_at"]
    before = t["stopped_at"] or dt.datetime.now(dt.timezone.utc)

    existing = {r[0] for r in dbx(
        "SELECT immich_asset_id FROM trips.photo WHERE trip_id=%s", (trip_id,), fetch="all")}

    pts_rows = dbx(
        "SELECT EXTRACT(EPOCH FROM ts) AS e, lat, lon FROM trips.track_point "
        "WHERE trip_id=%s ORDER BY ts", (trip_id,), fetch="all")
    pts = [(float(e), float(la), float(lo)) for (e, la, lo) in pts_rows]

    assets = matcher.fetch_assets(IMMICH_URL, IMMICH_KEY, iso(after), iso(before))
    added = 0
    for a in assets:
        aid = a.get("id")
        if not aid or aid in existing:
            continue
        cap = matcher.capture_epoch(a)
        ex = a.get("exifInfo") or {}
        lat = lon = None
        matched_by = None
        if ex.get("latitude") is not None and ex.get("longitude") is not None:
            lat, lon = float(ex["latitude"]), float(ex["longitude"])
            matched_by = "exif"
            # near-track filter: drop unrelated uploads from the same time window
            if pts and not matcher.near_track(pts, lat, lon, RADIUS_M):
                existing.add(aid)
                continue
        else:
            if cap is None or not pts:
                continue  # can't place yet; a later poll (after track grows) may
            loc = matcher.interpolate_on_track(pts, cap, TOL_S)
            if loc is None:
                continue
            lat, lon = loc
            matched_by = "track"
        cap_dt = dt.datetime.fromtimestamp(cap, dt.timezone.utc) if cap else None
        dbx(
            "INSERT INTO trips.photo(trip_id, immich_asset_id, capture_ts, lat, lon, matched_by, original_filename) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trip_id, immich_asset_id) DO NOTHING",
            (trip_id, aid, cap_dt, lat, lon, matched_by, a.get("originalFileName")),
        )
        existing.add(aid)
        added += 1
    log.info("sync_photos trip=%s scanned=%d added=%d", trip_id, len(assets), added)
    return {"scanned": len(assets), "added": added}


def poller():
    while True:
        try:
            t = get_active_trip()
            if t:
                sync_photos(t["id"])
        except Exception as e:
            log.warning("poller error: %s", e)
        time.sleep(PHOTO_POLL_S)


# --------------------------------------------------------------------------- mqtt
_mqtt = None


def mqtt_publish(topic, payload, retain=False, qos=1):
    if _mqtt is None:
        return
    try:
        body = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        _mqtt.publish(topic, body, qos=qos, retain=retain)
    except Exception as e:
        log.warning("mqtt publish failed: %s", e)


def publish_state():
    t = get_active_trip()
    if t:
        payload = {
            "active": True,
            "trip_id": int(t["id"]),
            "name": t["name"],
            "interval_s": int(t["interval_s"]),
            "started_at": iso(t["started_at"]),
        }
    else:
        payload = {"active": False, "trip_id": None, "name": None, "interval_s": None, "started_at": None}
    mqtt_publish(f"{BASE}/state", payload, retain=True)


def handle_track(msg):
    t = get_active_trip()
    if not t:
        log.debug("track dropped — no active trip")
        return
    if "lat" not in msg or "lon" not in msg:
        return
    ts = parse_ts(msg.get("ts"))
    lat, lon = float(msg["lat"]), float(msg["lon"])

    # GPS-outlier guard: reject a point that would imply an impossible speed from the last accepted
    # point (a GPS glitch), so it never enters the track / photo-matching / renderers.
    last = dbx(
        "SELECT EXTRACT(EPOCH FROM ts) AS e, lat, lon FROM trips.track_point "
        "WHERE trip_id=%s ORDER BY id DESC LIMIT 1",
        (int(t["id"]),), fetch="one", dict_cur=True,
    )
    if last:
        dist = matcher.haversine(float(last["lat"]), float(last["lon"]), lat, lon)
        dt_s = ts.timestamp() - float(last["e"])
        if dt_s > 0:
            if dist / dt_s > MAX_SPEED_MS:
                log.info("track point REJECTED trip=%s: %.0f km/h (>%.0f) over %.0fm/%.1fs",
                         t["id"], (dist / dt_s) * 3.6, MAX_SPEED_MS * 3.6, dist, dt_s)
                return
        elif dist > 1000:
            # no forward time but a >1 km jump — almost certainly a glitch
            log.info("track point REJECTED trip=%s: %.0fm jump with no time advance", t["id"], dist)
            return

    dbx(
        "INSERT INTO trips.track_point(trip_id, ts, lat, lon, accuracy, speed, altitude, source) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            int(t["id"]),
            ts,
            float(msg["lat"]),
            float(msg["lon"]),
            msg.get("acc"),
            msg.get("speed"),
            msg.get("alt"),
            msg.get("source", "app"),
        ),
    )


def handle_control(msg):
    if msg.get("source") == "addon":
        return  # our own echo to the phone
    cmd = msg.get("cmd")
    if cmd == "start":
        start_trip(msg.get("name"), int(msg.get("interval_s") or 15), origin="app")
    elif cmd == "stop":
        stop_trip(origin="app")


def _on_connect(client, userdata, flags, reason_code, properties=None):
    log.info("mqtt connected (rc=%s); subscribing %s/track and %s/control", reason_code, BASE, BASE)
    client.subscribe(f"{BASE}/track", qos=1)
    client.subscribe(f"{BASE}/control", qos=1)
    publish_state()


def _on_message(client, userdata, m):
    try:
        payload = json.loads(m.payload.decode("utf-8")) if m.payload else {}
    except Exception:
        log.debug("bad mqtt payload on %s", m.topic)
        return
    try:
        if m.topic == f"{BASE}/track":
            handle_track(payload)
        elif m.topic == f"{BASE}/control":
            handle_control(payload)
    except Exception as e:
        log.warning("mqtt handler error on %s: %s", m.topic, e)


def start_mqtt():
    global _mqtt
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="trip-tracker-addon")
    if MQTT_USER:
        c.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    c.on_connect = _on_connect
    c.on_message = _on_message
    c.reconnect_delay_set(min_delay=1, max_delay=30)
    while True:
        try:
            c.connect(MQTT_HOST, MQTT_PORT, keepalive=45)
            break
        except Exception as e:
            log.warning("mqtt connect to %s:%s failed: %s — retrying in 5s", MQTT_HOST, MQTT_PORT, e)
            time.sleep(5)
    _mqtt = c
    c.loop_start()


# --------------------------------------------------------------------------- admin (ingress user)
_admin_cache = {"ids": None, "ts": 0.0}
_admin_lock = threading.Lock()


def _fetch_admin_ids():
    """Set of HA user_ids that are admins (owner or in the system-admin group), via the WS
    config/auth/list call. None when it can't be determined (no token / HA unreachable)."""
    if not HA_TOKEN:
        return None
    try:
        import websocket  # websocket-client
    except Exception:
        return None
    ws_url = HA_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
    conn = None
    try:
        conn = websocket.create_connection(ws_url, timeout=10)
        json.loads(conn.recv())  # auth_required
        conn.send(json.dumps({"type": "auth", "access_token": HA_TOKEN}))
        while True:
            m = json.loads(conn.recv())
            if m.get("type") == "auth_ok":
                break
            if m.get("type") == "auth_invalid":
                return None
        conn.send(json.dumps({"id": 1, "type": "config/auth/list"}))
        while True:
            m = json.loads(conn.recv())
            if m.get("id") == 1 and m.get("type") == "result":
                if not m.get("success"):
                    return None
                admins = set()
                for u in m.get("result", []) or []:
                    if u.get("is_owner") or ("system-admin" in (u.get("group_ids") or [])):
                        admins.add(u.get("id"))
                return admins
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def admin_ids():
    with _admin_lock:
        now = time.time()
        if _admin_cache["ids"] is None or (now - _admin_cache["ts"]) > 300:
            try:
                ids = _fetch_admin_ids()
                if ids is not None:
                    _admin_cache["ids"] = ids
                    _admin_cache["ts"] = now
            except Exception as e:
                log.warning("admin list fetch failed: %s", e)
        return _admin_cache["ids"]


def request_is_admin():
    """Whether this request is from a logged-in HA ADMIN.

    Only authenticated **ingress** requests carry `X-Remote-User-Id`. Direct host-port (:8099) access
    has no HA session at all, so it's treated as non-admin → view-only map, no controls (the requirement:
    the control panel shows only for a logged-in admin session). An authenticated HA user whose admin
    status can't be verified (admin list unavailable — no token / HA unreachable) is allowed, so a
    transient WS hiccup never locks the owner out of their own ingress panel."""
    uid = request.headers.get("X-Remote-User-Id")
    if not uid:
        return False  # no logged-in HA (ingress) session → view-only
    ids = admin_ids()
    if ids is None:
        return True  # authenticated HA user, admin list momentarily unavailable → don't lock out the owner
    return uid in ids


def require_admin():
    if not request_is_admin():
        abort(403)


# --------------------------------------------------------------------------- shared settings (/data)
STATE_FILE = "/data/tt_state.json"
_state_lock = threading.Lock()


def _load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(d):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(d, f)
    except Exception as e:
        log.warning("state save failed: %s", e)


def admin_basemap():
    # the base map the admin last selected — non-admin viewers follow this; default Google Roadmap
    return _load_state().get("basemap") or "g_roadmap"


# --------------------------------------------------------------------------- web
app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="/static")


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/state")
def api_state():
    t = get_active_trip()
    return jsonify(
        {
            "active": bool(t),
            "admin": request_is_admin(),
            "admin_basemap": admin_basemap(),
            "trip": trip_public(t) if t else None,
            "config": {
                "photo_poll_s": PHOTO_POLL_S,
                "match_tolerance_s": TOL_S,
                "near_track_radius_m": RADIUS_M,
                "immich": bool(IMMICH_KEY),
                "google_key": GOOGLE_KEY,
                "map": {"lat": MAP_LAT, "lon": MAP_LON, "zoom": MAP_ZOOM},
            },
        }
    )


@app.route("/api/trips")
def api_trips():
    rows = dbx(
        """SELECT t.id, t.name, t.started_at, t.stopped_at, t.active, t.interval_s,
                  (SELECT count(*) FROM trips.track_point p WHERE p.trip_id=t.id) AS points,
                  (SELECT count(*) FROM trips.photo ph WHERE ph.trip_id=t.id)      AS photos
             FROM trips.trip t ORDER BY t.started_at DESC""",
        fetch="all",
        dict_cur=True,
    )
    return jsonify([trip_public(r) for r in rows])


@app.route("/api/trips/start", methods=["POST"])
def api_start():
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    start_trip(b.get("name"), int(b.get("interval_s") or 15), origin="web")
    return jsonify(trip_public(get_active_trip()))


@app.route("/api/trips/stop", methods=["POST"])
def api_stop():
    require_admin()
    stop_trip(origin="web")
    return jsonify({"ok": True})


@app.route("/api/basemap", methods=["POST"])
def api_basemap():
    # an admin's basemap choice becomes the shared default that non-admin viewers get
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    key = (b.get("key") or "").strip()
    if key:
        with _state_lock:
            s = _load_state()
            s["basemap"] = key
            _save_state(s)
    return jsonify({"ok": True, "basemap": admin_basemap()})


@app.route("/api/trips/<int:tid>/rename", methods=["POST"])
def api_rename(tid):
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    dbx("UPDATE trips.trip SET name=%s WHERE id=%s", (b.get("name"), tid))
    t = get_active_trip()
    if t and int(t["id"]) == tid:
        publish_state()
    return jsonify({"ok": True})


@app.route("/api/trips/<int:tid>", methods=["DELETE"])
def api_delete(tid):
    require_admin()
    dbx("DELETE FROM trips.trip WHERE id=%s", (tid,))
    return jsonify({"ok": True})


@app.route("/api/trips/<int:tid>/track")
def api_track(tid):
    since = int(request.args.get("since_id") or 0)
    rows = dbx(
        "SELECT id, EXTRACT(EPOCH FROM ts) AS ts, lat, lon, accuracy, speed, altitude "
        "FROM trips.track_point WHERE trip_id=%s AND id>%s ORDER BY id",
        (tid, since),
        fetch="all",
        dict_cur=True,
    )
    return jsonify(
        [
            {
                "id": int(r["id"]),
                "ts": float(r["ts"]),
                "lat": r["lat"],
                "lon": r["lon"],
                "acc": r["accuracy"],
                "speed": r["speed"],
                "alt": r["altitude"],
            }
            for r in rows
        ]
    )


@app.route("/api/trips/<int:tid>/photos")
def api_photos(tid):
    since = int(request.args.get("since_id") or 0)
    rows = dbx(
        "SELECT id, immich_asset_id, EXTRACT(EPOCH FROM capture_ts) AS cts, lat, lon, matched_by, original_filename "
        "FROM trips.photo WHERE trip_id=%s AND id>%s AND lat IS NOT NULL ORDER BY id",
        (tid, since),
        fetch="all",
        dict_cur=True,
    )
    return jsonify(
        [
            {
                "id": int(r["id"]),
                "asset": r["immich_asset_id"],
                "ts": float(r["cts"]) if r["cts"] is not None else None,
                "lat": r["lat"],
                "lon": r["lon"],
                "matched_by": r["matched_by"],
                "name": r["original_filename"],
            }
            for r in rows
        ]
    )


@app.route("/api/trips/<int:tid>/sync_photos", methods=["POST"])
def api_sync(tid):
    require_admin()
    return jsonify(sync_photos(tid))


def _immich_proxy(path, params):
    if not IMMICH_KEY:
        abort(503)
    r = requests.get(
        f"{IMMICH_URL}{path}",
        headers={"x-api-key": IMMICH_KEY},
        params=params,
        stream=True,
        timeout=30,
    )
    if r.status_code != 200:
        abort(r.status_code)
    ct = r.headers.get("Content-Type", "application/octet-stream")
    return Response(r.iter_content(8192), content_type=ct)


@app.route("/api/photo/<asset>/thumbnail")
def api_thumb(asset):
    # small + fast — used for the marker popup image
    return _immich_proxy(f"/api/assets/{asset}/thumbnail", {"size": "thumbnail"})


@app.route("/api/photo/<asset>/preview")
def api_preview(asset):
    # larger (~1440px) — used for the full-screen lightbox
    return _immich_proxy(f"/api/assets/{asset}/thumbnail", {"size": "preview"})


@app.route("/api/photo/<asset>/original")
def api_original(asset):
    return _immich_proxy(f"/api/assets/{asset}/original", {})


# --------------------------------------------------------------------------- main
def main():
    bootstrap_schema()
    start_mqtt()
    threading.Thread(target=poller, daemon=True).start()
    from waitress import serve

    # :8098 is proxied by HA ingress; :8099 is published as a host port for direct access outside HA.
    log.info("serving web UI on :8098 (ingress) and :8099 (direct)")
    serve(app, listen="0.0.0.0:8098 0.0.0.0:8099", threads=8)


if __name__ == "__main__":
    main()
