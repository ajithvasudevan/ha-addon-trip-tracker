#!/usr/bin/env python3
"""Trip Tracker add-on backend.

Flask (served by waitress) behind HA ingress, plus two background threads:
  - MQTT client: ingests track points / trip control from the MyMessages app
  - immich poller: matches newly-uploaded photos to the active trip

State of record is the recorder Postgres `trips` schema.
"""
import datetime as dt
import gzip
import html
import json
import logging
import os
import re
import secrets
import threading
import time

import psycopg2
import psycopg2.extras
import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from psycopg2 import pool as pgpool

import gapfill  # rail/road gap-filling engine (same dir)
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
# Shared secret for the native Android app: a request carrying header `X-TT-Token` matching this value is
# treated as a logged-in ADMIN (the app hits the direct host port :8099, which has no HA ingress session).
_app_tok = (os.environ.get("TT_APP_TOKEN") or "").strip()
APP_TOKEN = "" if _app_tok.lower() == "null" else _app_tok
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
MAX_SPEED_MS = (_mx if _mx > 0 else 150.0) / 3.6   # (legacy) absolute speed sanity ceiling
# Adaptive GPS-outlier guard: a point is an outlier if it lands farther from the last accepted point than
# max(OUTLIER_BASE_M, recent_speed * dt * OUTLIER_K). Scales with recent speed (train/plane friendly),
# while BASE catches teleports from near-stationary. Only applied for dt <= OUTLIER_GAP_S (a larger dt is a
# real data gap — the predecessor is stale, so we don't outlier-gate it).
OUTLIER_BASE_M   = float(os.environ.get("TT_OUTLIER_BASE_M") or 50)
OUTLIER_K        = float(os.environ.get("TT_OUTLIER_K") or 2.0)
OUTLIER_GAP_S    = float(os.environ.get("TT_OUTLIER_GAP_S") or 20)
RECENT_WINDOW_S  = float(os.environ.get("TT_RECENT_WINDOW_S") or 20)
ALT_MAX_VERT     = float(os.environ.get("TT_ALT_MAX_VERT_MS") or 2.0)   # m/s: steeper vertical rate = bad altitude reading
SHARE_BASE       = os.environ.get("TT_SHARE_BASE") or "https://trips.ajithv.in"   # public base for share links
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
  interval_s  integer NOT NULL DEFAULT 5,
  mode        text NOT NULL DEFAULT 'time',
  min_distance_m integer,
  color       text,
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
  media_type        text NOT NULL DEFAULT 'image',
  camera            text,
  people            text,
  processed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, immich_asset_id)
);
CREATE INDEX IF NOT EXISTS photo_trip_idx ON trips.photo(trip_id, id);
-- upgrade older installs (columns added after first release)
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'time';
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS min_distance_m integer;
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS distance_m double precision NOT NULL DEFAULT 0;
ALTER TABLE trips.trip ADD COLUMN IF NOT EXISTS share_token text;
CREATE INDEX IF NOT EXISTS trip_share_idx ON trips.trip(share_token);
ALTER TABLE trips.photo ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image';
ALTER TABLE trips.photo ADD COLUMN IF NOT EXISTS camera text;
ALTER TABLE trips.photo ADD COLUMN IF NOT EXISTS people text;
-- admin-applied visibility tags per immich asset ('Relatives' / 'World'); drive the scoped share links
CREATE TABLE IF NOT EXISTS trips.photo_tag (
  immich_asset_id text NOT NULL,
  tag             text NOT NULL,
  PRIMARY KEY (immich_asset_id, tag)
);
-- scoped public share tokens: one per (trip, scope) where scope in ('relatives','world')
CREATE TABLE IF NOT EXISTS trips.share (
  token      text PRIMARY KEY,
  trip_id    integer NOT NULL REFERENCES trips.trip(id) ON DELETE CASCADE,
  scope      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, scope)
);
"""


# One authoritative recompute of every trip's total track distance (great-circle sum of consecutive hops,
# ordered by ts,id). Run at boot so trips.distance_m is exact and self-heals any drift from the per-insert
# incremental update in handle_track. Only runs at startup — never per request.
BACKFILL_DIST_SQL = """
UPDATE trips.trip SET distance_m = 0;
UPDATE trips.trip t SET distance_m = s.dist FROM (
  SELECT trip_id, COALESCE(SUM(seg), 0) AS dist FROM (
    SELECT trip_id, 2*6371000*asin(LEAST(1.0, sqrt(
             power(sin(radians(lat - plat) / 2), 2)
             + cos(radians(plat)) * cos(radians(lat)) * power(sin(radians(lon - plon) / 2), 2)))) AS seg
      FROM (
        SELECT trip_id, lat, lon,
               lag(lat) OVER (PARTITION BY trip_id ORDER BY ts, id) AS plat,
               lag(lon) OVER (PARTITION BY trip_id ORDER BY ts, id) AS plon
          FROM trips.track_point
      ) q WHERE plat IS NOT NULL
  ) seg_q GROUP BY trip_id
) s WHERE s.trip_id = t.id;
"""


def bootstrap_schema():
    dbx(SCHEMA_SQL)
    dbx(BACKFILL_DIST_SQL)
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
        "SELECT id,name,started_at,stopped_at,active,interval_s,mode,min_distance_m,color FROM trips.trip "
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
    for k in ("id", "interval_s", "min_distance_m", "points", "photos"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


# --------------------------------------------------------------------------- trip lifecycle
def norm_mode(mode):
    m = str(mode or "").strip().lower()
    return m if m in ("time", "distance", "hybrid") else "hybrid"


def start_trip(name, interval_s, origin, mode="hybrid", min_distance_m=None, color=None):
    mode = norm_mode(mode)
    color = (str(color).strip() or None) if color else None
    if not color:
        color = "#1565c0"
    if mode in ("distance", "hybrid"):   # both use the distance threshold
        try:
            min_distance_m = int(min_distance_m)
        except (TypeError, ValueError):
            min_distance_m = 25
        if min_distance_m < 1:
            min_distance_m = 25
    else:
        min_distance_m = None
    dbx("UPDATE trips.trip SET active=false, stopped_at=COALESCE(stopped_at, now()) WHERE active=true")
    row = dbx(
        "INSERT INTO trips.trip(name, interval_s, mode, min_distance_m, color, active) VALUES (%s,%s,%s,%s,%s,true) "
        "RETURNING id,name,started_at,stopped_at,active,interval_s,mode,min_distance_m,color",
        (name or default_name(), interval_s, mode, min_distance_m, color),
        fetch="one",
        dict_cur=True,
    )
    publish_state()
    # nudge the phone to begin sending (source=addon so our own echo is ignored)
    ctrl = {"cmd": "start", "trip_id": row["id"], "name": row["name"],
            "interval_s": interval_s, "mode": mode, "source": "addon"}
    if min_distance_m is not None:
        ctrl["min_distance_m"] = min_distance_m
    mqtt_publish(f"{BASE}/control", ctrl)
    log.info("trip START id=%s name=%s mode=%s interval=%ss dist=%sm origin=%s",
             row["id"], row["name"], mode, interval_s, min_distance_m, origin)
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


def _camera_of(a):
    ex = a.get("exifInfo") or {}
    make = (ex.get("make") or "").strip()
    model = (ex.get("model") or "").strip()
    # some phones repeat the make inside the model ("OnePlus" + "OnePlus 13s") — don't double it
    if make and model and model.lower().startswith(make.lower()):
        cam = model
    else:
        cam = (make + " " + model).strip()
    return cam or None


def _people_of(a):
    out, seen = [], set()
    for p in (a.get("people") or []):
        n = (p.get("name") or "").strip()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return json.dumps(out) if out else None


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
        if not aid:
            continue
        cam, ppl = _camera_of(a), _people_of(a)
        if aid in existing:
            # already synced → backfill camera/people on rows that predate those columns (cheap: only when null)
            dbx("UPDATE trips.photo SET camera=COALESCE(camera,%s), people=COALESCE(people,%s) "
                "WHERE trip_id=%s AND immich_asset_id=%s AND (camera IS NULL OR people IS NULL)",
                (cam, ppl, trip_id, aid))
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
        mtype = "video" if a.get("type") == "VIDEO" else "image"
        dbx(
            "INSERT INTO trips.photo(trip_id, immich_asset_id, capture_ts, lat, lon, matched_by, original_filename, media_type, camera, people) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (trip_id, immich_asset_id) DO NOTHING",
            (trip_id, aid, cap_dt, lat, lon, matched_by, a.get("originalFileName"), mtype, cam, ppl),
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
            "mode": norm_mode(t.get("mode")),
            "min_distance_m": int(t["min_distance_m"]) if t.get("min_distance_m") is not None else None,
            "started_at": iso(t["started_at"]),
        }
    else:
        payload = {"active": False, "trip_id": None, "name": None, "interval_s": None,
                   "mode": None, "min_distance_m": None, "started_at": None}
    mqtt_publish(f"{BASE}/state", payload, retain=True)


def handle_track(msg):
    if "lat" not in msg or "lon" not in msg:
        return
    # Prefer the trip_id carried in the payload: the phone buffers fixes during an MQTT/network outage
    # and replays them on reconnect, possibly AFTER the trip was stopped — those must still land in
    # their own trip. Fall back to the current active trip when the payload omits it.
    tid = None
    mtid = msg.get("trip_id")
    if mtid:
        row = dbx("SELECT id FROM trips.trip WHERE id=%s", (int(mtid),), fetch="one")
        if row:
            tid = int(row[0])
    if tid is None:
        t = get_active_trip()
        tid = int(t["id"]) if t else None
    if tid is None:
        log.debug("track dropped — no trip")
        return
    ts = parse_ts(msg.get("ts"))
    lat, lon = float(msg["lat"]), float(msg["lon"])

    # Adaptive GPS-outlier guard. Compare against the TIME-predecessor and a short recent window (greatest
    # ts <= this one), NOT the last-inserted row — replayed buffered points arrive with a newer id but an
    # OLDER ts, so "last by id" would be the wrong neighbour.
    hop_m = 0.0   # great-circle distance from the predecessor → added to trips.distance_m after insert
    recent = dbx(
        "SELECT EXTRACT(EPOCH FROM ts) AS e, lat, lon, altitude FROM trips.track_point "
        "WHERE trip_id=%s AND ts <= %s ORDER BY ts DESC, id DESC LIMIT 5",
        (tid, ts), fetch="all", dict_cur=True,
    )
    if recent:
        last = recent[0]
        dist = matcher.haversine(float(last["lat"]), float(last["lon"]), lat, lon)
        hop_m = dist
        dt_s = ts.timestamp() - float(last["e"])
        if dt_s <= 0:
            if dist > 1000:   # same timestamp but a >1 km jump — almost certainly a glitch
                log.info("track point REJECTED trip=%s: %.0fm jump with no time advance", tid, dist)
                return
        elif dt_s <= OUTLIER_GAP_S:
            # recent average speed over the window (oldest -> newest), within RECENT_WINDOW_S
            win = [r for r in recent if float(last["e"]) - float(r["e"]) <= RECENT_WINDOW_S]
            win.reverse()
            recent_ms = 0.0
            if len(win) >= 2:
                td = sum(matcher.haversine(float(win[i - 1]["lat"]), float(win[i - 1]["lon"]),
                                           float(win[i]["lat"]), float(win[i]["lon"]))
                         for i in range(1, len(win)))
                tt = float(win[-1]["e"]) - float(win[0]["e"])
                if tt > 0:
                    recent_ms = td / tt
            allow = max(OUTLIER_BASE_M, recent_ms * dt_s * OUTLIER_K)
            if dist > allow:
                log.info("track point REJECTED trip=%s: %.0fm jump > %.0fm allowed (recent %.0f km/h, dt %.1fs) — GPS outlier",
                         tid, dist, allow, recent_ms * 3.6, dt_s)
                return
        # dt_s > OUTLIER_GAP_S → a real data gap (signal loss); predecessor is stale, so don't outlier-gate.

    # Altitude spike gate (like the position guard): drop an altitude whose vertical rate vs the last
    # reading is impossible for ground travel — keeps the point, just not the bad altitude.
    alt = msg.get("alt")
    if alt is not None and recent:
        try:
            la = recent[0].get("altitude"); dt_a = ts.timestamp() - float(recent[0]["e"])
            if la is not None and dt_a > 0 and abs(float(alt) - float(la)) / dt_a > ALT_MAX_VERT:
                log.info("altitude spike dropped trip=%s: %.0fm/%.1fs", tid, abs(float(alt) - float(la)), dt_a)
                alt = None
        except (TypeError, ValueError):
            pass
    dbx(
        "INSERT INTO trips.track_point(trip_id, ts, lat, lon, accuracy, speed, altitude, source) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (tid, ts, lat, lon, msg.get("acc"), msg.get("speed"), alt, msg.get("source", "app")),
    )
    if hop_m > 0:   # keep the running total fresh without re-summing the whole track per /api/trips call
        dbx("UPDATE trips.trip SET distance_m = distance_m + %s WHERE id=%s", (hop_m, tid))


def handle_control(msg):
    if msg.get("source") == "addon":
        return  # our own echo to the phone
    cmd = msg.get("cmd")
    if cmd == "start":
        start_trip(msg.get("name"), int(msg.get("interval_s") or 5), origin="app",
                   mode=msg.get("mode"), min_distance_m=msg.get("min_distance_m"))
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
    transient WS hiccup never locks the owner out of their own ingress panel.

    The native Android app has no HA session, so it authenticates with a shared `X-TT-Token` header
    (set to the `app_token` add-on option) → full admin over the direct host port."""
    if APP_TOKEN:
        tok = request.headers.get("X-TT-Token")
        if tok and tok == APP_TOKEN:
            return True
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


@app.after_request
def _gzip(resp):
    """gzip JSON/text replies (a big trip's first full-track fetch is ~1-2 MB). Skips streamed image/video
    proxy responses (binary + already compressed, and streaming — never buffer them into memory)."""
    try:
        if "gzip" not in request.headers.get("Accept-Encoding", ""):
            return resp
        if resp.direct_passthrough or resp.status_code < 200 or resp.status_code >= 300:
            return resp
        ct = (resp.content_type or "")
        if not (ct.startswith("application/json") or ct.startswith("text/")):
            return resp
        if "Content-Encoding" in resp.headers:
            return resp
        data = resp.get_data()
        if len(data) < 500:
            return resp
        comp = gzip.compress(data, 6)
        resp.set_data(comp)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"] = str(len(comp))
        resp.headers["Vary"] = "Accept-Encoding"
    except Exception as e:
        log.debug("gzip skipped: %s", e)
    return resp


def _asset_version():
    """A token that changes whenever a static file changes (newest mtime), so `?v=` busts stale caches."""
    try:
        files = ("index.html", "app.js", "app.css")
        return str(int(max(os.path.getmtime(os.path.join(app.static_folder, f)) for f in files)))
    except Exception:
        return str(int(time.time()))


@app.route("/")
def index():
    with open(os.path.join(app.static_folder, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    return Response(html.replace("__V__", _asset_version()), mimetype="text/html")


@app.after_request
def _no_store_shell(resp):
    # The app shell (HTML + JS + CSS) must never be cached by the HA ingress WebView — it ignores
    # `no-cache` revalidation and serves stale code. `no-store` + versioned `?v=` URLs force fresh loads.
    # (immich photo proxies under /api/photo/... keep their own cacheable headers — they're immutable by id.)
    p = request.path or ""
    if p == "/" or p.startswith("/static/app."):   # index.html, app.js, app.css (vendor libs keep no-cache)
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


@app.route("/api/state")
def api_state():
    t = get_active_trip()
    admin = request_is_admin()
    # A hidden live trip must not be revealed to non-admin viewers: no active state → no pill, no auto-follow.
    if t and not admin and trip_is_hidden(int(t["id"])):
        t = None
    return jsonify(
        {
            "active": bool(t),
            "admin": admin,
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
    # distance_m is maintained incrementally (handle_track) + recomputed exactly at boot (backfill), so the
    # list no longer re-sums the whole track_point table on every call.
    rows = dbx(
        """SELECT t.id, t.name, t.started_at, t.stopped_at, t.active, t.interval_s, t.mode, t.min_distance_m, t.color, t.hidden, t.distance_m,
                  (SELECT count(*) FROM trips.track_point p WHERE p.trip_id=t.id) AS points,
                  (SELECT count(*) FROM trips.photo ph WHERE ph.trip_id=t.id)      AS photos
             FROM trips.trip t ORDER BY t.started_at DESC""",
        fetch="all",
        dict_cur=True,
    )
    # Hidden trips are admin-only: non-admin viewers never see them in the list (nor their track/photos).
    admin = request_is_admin()
    out = []
    for r in rows:
        if not admin and r.get("hidden"):
            continue
        d = trip_public(r)
        d["distance_m"] = round(float(r.get("distance_m") or 0.0), 1)
        out.append(d)
    return jsonify(out)


@app.route("/api/trips/start", methods=["POST"])
def api_start():
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    start_trip(b.get("name"), int(b.get("interval_s") or 5), origin="web",
               mode=b.get("mode"), min_distance_m=b.get("min_distance_m"), color=b.get("color"))
    return jsonify(trip_public(get_active_trip()))


@app.route("/api/trips/stop", methods=["POST"])
def api_stop():
    require_admin()
    stop_trip(origin="web")
    return jsonify({"ok": True})


@app.route("/api/trips/<int:tid>/spacing", methods=["POST"])
def api_spacing(tid):
    # Change a trip's spacing LIVE. For the active trip this republishes the retained trips/state, which
    # the phone's onState picks up and re-requests GPS with the new mode/interval/distance — same trip.
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    mode = norm_mode(b.get("mode"))
    try:
        interval_s = int(b.get("interval_s") or 5)
    except (TypeError, ValueError):
        interval_s = 5
    if mode in ("distance", "hybrid"):
        try:
            md = int(b.get("min_distance_m"))
        except (TypeError, ValueError):
            md = 25
        if md < 1:
            md = 25
    else:
        md = None
    dbx("UPDATE trips.trip SET mode=%s, interval_s=%s, min_distance_m=%s WHERE id=%s",
        (mode, interval_s, md, tid))
    t = get_active_trip()
    live = bool(t and int(t["id"]) == tid)
    if live:
        publish_state()   # retained → phone re-requests GPS with the new spacing, no restart
    log.info("spacing update trip=%s mode=%s interval=%ss dist=%sm live=%s", tid, mode, interval_s, md, live)
    return jsonify({"ok": True, "live": live, "trip": trip_public(get_active_trip()) if live else None})


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
    # Edit a trip's name and/or track colour (only the provided fields are changed).
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    sets, params = [], []
    if "name" in b:
        sets.append("name=%s"); params.append(b.get("name"))
    if b.get("color"):
        sets.append("color=%s"); params.append(str(b.get("color")).strip())
    if "hidden" in b:
        sets.append("hidden=%s"); params.append(bool(b.get("hidden")))
    if sets:
        params.append(tid)
        dbx(f"UPDATE trips.trip SET {', '.join(sets)} WHERE id=%s", tuple(params))
    t = get_active_trip()
    if t and int(t["id"]) == tid:
        publish_state()
    return jsonify({"ok": True})


@app.route("/api/trips/<int:tid>", methods=["DELETE"])
def api_delete(tid):
    require_admin()
    dbx("DELETE FROM trips.trip WHERE id=%s", (tid,))
    return jsonify({"ok": True})


def trip_is_hidden(tid):
    """True if the trip is flagged hidden (admin-only). Gates track/photos for non-admin viewers."""
    r = dbx("SELECT hidden FROM trips.trip WHERE id=%s", (tid,), fetch="one")
    return bool(r and r[0])


@app.route("/api/trips/<int:tid>/track")
def api_track(tid):
    if not request_is_admin() and trip_is_hidden(tid):
        return jsonify([])
    since = int(request.args.get("since_id") or 0)
    rows = dbx(
        "SELECT id, EXTRACT(EPOCH FROM ts) AS ts, lat, lon, accuracy, speed, altitude, source "
        "FROM trips.track_point WHERE trip_id=%s AND id>%s ORDER BY ts, id",
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
                "source": r["source"],
            }
            for r in rows
        ]
    )


def _insert_filled(tid, rows):
    """Bulk-insert reconstructed fill points (source='filled'). rows: list of (ts_epoch, lat, lon, speed)."""
    if not rows:
        return 0
    p = _get_pool(); conn = p.getconn()
    try:
        cur = conn.cursor()
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO trips.track_point(trip_id, ts, lat, lon, speed, source) VALUES %s",
            [(tid, ts, lat, lon, spd) for (ts, lat, lon, spd) in rows],
            template="(%s, to_timestamp(%s), %s, %s, %s, 'filled')",
        )
        conn.commit(); cur.close()
        return len(rows)
    finally:
        try: p.putconn(conn)
        except Exception:
            try: conn.close()
            except Exception: pass


_fill_jobs = {}            # tid -> {"state": running|done|error, ...}
_fill_lock = threading.Lock()


def _run_fill(tid):
    try:
        rows = dbx(
            "SELECT EXTRACT(EPOCH FROM ts) AS ts, lat, lon FROM trips.track_point "
            "WHERE trip_id=%s AND (source IS DISTINCT FROM 'filled') ORDER BY ts, id",
            (tid,), fetch="all", dict_cur=True,
        )
        pts = [(float(r["ts"]), float(r["lat"]), float(r["lon"])) for r in rows]
        if len(pts) < 2:
            with _fill_lock: _fill_jobs[tid] = {"state": "error", "error": "no track"}
            return
        # clear any prior fill so the action is idempotent (reconstruct from the real fixes only)
        dbx("DELETE FROM trips.track_point WHERE trip_id=%s AND source='filled'", (tid,))
        filled, summary = gapfill.fill_trip_gaps(pts, log=lambda m: log.info(m))
        added = _insert_filled(tid, filled)
        dbx(BACKFILL_DIST_SQL)   # keep distance_m exact now that the geometry changed
        result = {
            "added": added, "gaps": len(summary),
            "rail": sum(1 for s in summary if s["cls"] == "rail"),
            "road": sum(1 for s in summary if s["cls"] == "road"),
            "skipped": sum(1 for s in summary if s["cls"] == "skip"),
            "detail": summary,
        }
        with _fill_lock: _fill_jobs[tid] = {"state": "done", "result": result}
    except Exception as e:
        log.exception("fill_gaps failed for trip %s", tid)
        with _fill_lock: _fill_jobs[tid] = {"state": "error", "error": str(e)}


@app.route("/api/trips/<int:tid>/fill_gaps", methods=["POST"])
def api_fill_gaps(tid):
    require_admin()
    with _fill_lock:
        if _fill_jobs.get(tid, {}).get("state") == "running":
            return jsonify({"state": "running"})
        _fill_jobs[tid] = {"state": "running"}
    threading.Thread(target=_run_fill, args=(tid,), daemon=True).start()
    return jsonify({"state": "running"})


@app.route("/api/trips/<int:tid>/fill_status")
def api_fill_status(tid):
    require_admin()
    with _fill_lock:
        return jsonify(_fill_jobs.get(tid, {"state": "idle"}))


@app.route("/api/trips/<int:tid>/unfill_gaps", methods=["POST"])
def api_unfill_gaps(tid):
    require_admin()
    dbx("DELETE FROM trips.track_point WHERE trip_id=%s AND source='filled'", (tid,))
    dbx(BACKFILL_DIST_SQL)
    with _fill_lock:
        _fill_jobs.pop(tid, None)
    return jsonify({"ok": True})


# ---------------------------------------------------------------- manual track editing (admin)
@app.route("/api/trips/<int:tid>/points/move", methods=["POST"])
def api_point_move(tid):
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    pid, lat, lon, ts = b.get("id"), b.get("lat"), b.get("lon"), b.get("ts")
    if pid is None or lat is None or lon is None:
        abort(400)
    if ts is not None:
        dbx("UPDATE trips.track_point SET lat=%s, lon=%s, ts=to_timestamp(%s) WHERE trip_id=%s AND id=%s",
            (lat, lon, float(ts), tid, int(pid)))
    else:
        dbx("UPDATE trips.track_point SET lat=%s, lon=%s WHERE trip_id=%s AND id=%s", (lat, lon, tid, int(pid)))
    dbx(BACKFILL_DIST_SQL)
    return jsonify({"ok": True})


@app.route("/api/trips/<int:tid>/points/delete", methods=["POST"])
def api_point_delete(tid):
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    ids = [int(i) for i in (b.get("ids") or [])]
    if not ids:
        abort(400)
    dbx("DELETE FROM trips.track_point WHERE trip_id=%s AND id = ANY(%s)", (tid, ids))
    dbx(BACKFILL_DIST_SQL)
    return jsonify({"ok": True, "deleted": len(ids)})


@app.route("/api/trips/<int:tid>/points/add", methods=["POST"])
def api_point_add(tid):
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    lat, lon, ts = b.get("lat"), b.get("lon"), b.get("ts")
    if lat is None or lon is None or ts is None:
        abort(400)
    row = dbx("INSERT INTO trips.track_point(trip_id, ts, lat, lon, source) "
              "VALUES (%s, to_timestamp(%s), %s, %s, 'edited') RETURNING id",
              (tid, float(ts), lat, lon), fetch="one")
    dbx(BACKFILL_DIST_SQL)
    return jsonify({"id": int(row[0])})


@app.route("/api/trips/<int:tid>/points/join", methods=["POST"])
def api_point_join(tid):
    """Bridge two segment endpoints with a straight line of interpolated points (ts linearly spread), so the
    gap between them renders as one continuous track. Bridge points are source='filled' (drawn dotted)."""
    require_admin()
    b = request.get_json(force=True, silent=True) or {}
    ia, ib = b.get("id_a"), b.get("id_b")
    if ia is None or ib is None:
        abort(400)
    rows = dbx("SELECT id, EXTRACT(EPOCH FROM ts) AS ts, lat, lon FROM trips.track_point "
               "WHERE trip_id=%s AND id IN (%s,%s)", (tid, int(ia), int(ib)), fetch="all", dict_cur=True)
    if not rows or len(rows) != 2:
        abort(404)
    a, c = sorted(rows, key=lambda r: float(r["ts"]))
    ta, tc = float(a["ts"]), float(c["ts"])
    d = gapfill.hav(a["lat"], a["lon"], c["lat"], c["lon"])
    n = max(2, int(d // 40) + 1)
    pts = []
    for k in range(1, n):
        f = k / n
        pts.append((ta + f * (tc - ta), a["lat"] + f * (c["lat"] - a["lat"]), a["lon"] + f * (c["lon"] - a["lon"]), None))
    added = _insert_filled(tid, pts)
    dbx(BACKFILL_DIST_SQL)
    return jsonify({"ok": True, "added": added})


@app.route("/api/trips/<int:tid>/points/densify", methods=["POST"])
def api_point_densify(tid):
    """Fill the big gaps WITHIN the ts-span of the selected points: every track segment longer than
    min_gap_m inside that span gets interpolated points (source='filled') spaced ~spacing_m."""
    require_admin()
    body = request.get_json(force=True, silent=True) or {}
    ids = body.get("ids") or []
    if len(ids) < 2:
        abort(400)
    ids = [int(x) for x in ids]
    spacing = max(5.0, float(body.get("spacing_m") or 25))
    min_gap = max(spacing, float(body.get("min_gap_m") or 40))
    sel = dbx("SELECT EXTRACT(EPOCH FROM ts) AS ts FROM trips.track_point WHERE trip_id=%s AND id = ANY(%s)",
              (tid, ids), fetch="all")
    if not sel:
        abort(404)
    tss = [float(r[0]) for r in sel]
    tmin, tmax = min(tss), max(tss)
    rows = dbx("SELECT EXTRACT(EPOCH FROM ts) AS ts, lat, lon FROM trips.track_point "
               "WHERE trip_id=%s AND ts BETWEEN to_timestamp(%s) AND to_timestamp(%s) ORDER BY ts, id",
               (tid, tmin, tmax), fetch="all", dict_cur=True)
    pts = []
    for i in range(1, len(rows)):
        a, c = rows[i - 1], rows[i]
        ta, tc = float(a["ts"]), float(c["ts"])
        d = gapfill.hav(a["lat"], a["lon"], c["lat"], c["lon"])
        if d <= min_gap:
            continue
        n = max(2, int(d // spacing) + 1)
        for k in range(1, n):
            f = k / n
            pts.append((ta + f * (tc - ta), a["lat"] + f * (c["lat"] - a["lat"]), a["lon"] + f * (c["lon"] - a["lon"]), None))
    added = _insert_filled(tid, pts) if pts else 0
    if pts:
        dbx(BACKFILL_DIST_SQL)
    return jsonify({"ok": True, "added": added})


@app.route("/api/trips/<int:tid>/photos")
def api_photos(tid):
    admin = request_is_admin()
    if not admin and trip_is_hidden(tid):
        return jsonify([])
    since = int(request.args.get("since_id") or 0)
    # non-admin (e.g. the direct :8099 web viewer, view-only) sees ONLY World-tagged photos; admin sees all
    world = "" if admin else (" AND EXISTS(SELECT 1 FROM trips.photo_tag pw "
                              "WHERE pw.immich_asset_id=p.immich_asset_id AND pw.tag='World')")
    rows = dbx(
        "SELECT p.id, p.immich_asset_id, EXTRACT(EPOCH FROM p.capture_ts) AS cts, p.lat, p.lon, p.matched_by, "
        "p.original_filename, p.media_type, p.camera, p.people, "
        "(SELECT array_agg(pt.tag) FROM trips.photo_tag pt WHERE pt.immich_asset_id=p.immich_asset_id) AS tags "
        "FROM trips.photo p WHERE p.trip_id=%s AND p.id>%s AND p.lat IS NOT NULL" + world + " ORDER BY p.id",
        (tid, since),
        fetch="all",
        dict_cur=True,
    )
    def _people(v):
        try:
            return json.loads(v) if v else []
        except Exception:
            return []
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
                "type": r.get("media_type") or "image",
                "camera": r.get("camera"),
                "people": _people(r.get("people")),
                "tags": r.get("tags") or [],
            }
            for r in rows
        ]
    )


def _export_rows(tid):
    trip = dbx("SELECT name FROM trips.trip WHERE id=%s", (tid,), fetch="one", dict_cur=True)
    if not trip:
        abort(404)
    rows = dbx(
        "SELECT EXTRACT(EPOCH FROM ts) AS ts, lat, lon, altitude, speed "
        "FROM trips.track_point WHERE trip_id=%s ORDER BY ts, id",
        (tid,), fetch="all", dict_cur=True,
    )
    name = trip["name"] or f"Trip {tid}"
    fname = (re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:60] or f"trip_{tid}")
    return name, fname, rows


@app.route("/api/trips/<int:tid>/export.gpx")
def api_export_gpx(tid):
    if not request_is_admin() and trip_is_hidden(tid):
        abort(404)
    name, fname, rows = _export_rows(tid)
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="Trip Tracker" xmlns="http://www.topografix.com/GPX/1/1">',
           f"<trk><name>{html.escape(name)}</name><trkseg>"]
    prev = None
    for r in rows:
        ts = float(r["ts"])
        if prev is not None and ts - prev > 60:   # a data gap → start a new track segment
            out.append("</trkseg><trkseg>")
        prev = ts
        p = f'<trkpt lat="{r["lat"]}" lon="{r["lon"]}">'
        if r["altitude"] is not None:
            p += f"<ele>{r['altitude']}</ele>"
        p += "<time>" + dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat().replace("+00:00", "Z") + "</time></trkpt>"
        out.append(p)
    out.append("</trkseg></trk></gpx>")
    return Response("\n".join(out), content_type="application/gpx+xml",
                    headers={"Content-Disposition": f'attachment; filename="{fname}.gpx"'})


@app.route("/api/trips/<int:tid>/export.geojson")
def api_export_geojson(tid):
    if not request_is_admin() and trip_is_hidden(tid):
        abort(404)
    name, fname, rows = _export_rows(tid)
    coords = []
    for r in rows:
        c = [r["lon"], r["lat"]]
        if r["altitude"] is not None:
            c.append(r["altitude"])
        coords.append(c)
    feats = [{"type": "Feature", "properties": {"name": name, "kind": "track"},
              "geometry": {"type": "LineString", "coordinates": coords}}]
    phs = dbx(
        "SELECT immich_asset_id, lat, lon, camera FROM trips.photo WHERE trip_id=%s AND lat IS NOT NULL ORDER BY id",
        (tid,), fetch="all", dict_cur=True,
    )
    for ph in phs:
        feats.append({"type": "Feature",
                      "properties": {"kind": "photo", "asset": ph["immich_asset_id"], "camera": ph.get("camera")},
                      "geometry": {"type": "Point", "coordinates": [ph["lon"], ph["lat"]]}})
    body = json.dumps({"type": "FeatureCollection", "features": feats})
    return Response(body, content_type="application/geo+json",
                    headers={"Content-Disposition": f'attachment; filename="{fname}.geojson"'})


@app.route("/api/trips/<int:tid>/sync_photos", methods=["POST"])
def api_sync(tid):
    require_admin()
    return jsonify(sync_photos(tid))


# ---------------------------------------------------------------- photo visibility tags (admin)
TAGS = {"Relatives", "World"}
SCOPE_TAG = {"relatives": "Relatives", "world": "World"}   # share scope -> required photo tag

# Mirror visibility tags into immich as real immich tags (so they show up / are managed there too). The
# add-on's trips.photo_tag table stays the fast source for share filtering + the app; immich is kept in sync.
_immich_tag_ids = {}
_immich_tag_lock = threading.Lock()


def _immich_tag_id(name):
    with _immich_tag_lock:
        if name in _immich_tag_ids:
            return _immich_tag_ids[name]
    if not IMMICH_KEY:
        return None
    try:
        r = requests.put(f"{IMMICH_URL}/api/tags",
                         headers={"x-api-key": IMMICH_KEY, "Content-Type": "application/json"},
                         json={"tags": [name]}, timeout=15)
        if r.status_code == 200:
            for t in r.json():
                if t.get("name") == name:
                    with _immich_tag_lock:
                        _immich_tag_ids[name] = t["id"]
                    return t["id"]
    except Exception as e:
        log.warning("immich tag upsert failed: %s", e)
    return None


def _immich_tag_asset(asset, name, on):
    """Best-effort: add/remove an immich tag on an asset. Never fails the caller (the local table is authoritative)."""
    tid = _immich_tag_id(name)
    if not tid:
        return False
    try:
        url = f"{IMMICH_URL}/api/tags/{tid}/assets"
        hdr = {"x-api-key": IMMICH_KEY, "Content-Type": "application/json"}
        r = (requests.put(url, headers=hdr, json={"ids": [asset]}, timeout=15) if on
             else requests.delete(url, headers=hdr, json={"ids": [asset]}, timeout=15))
        return r.status_code == 200
    except Exception as e:
        log.warning("immich tag asset update failed: %s", e)
        return False


def _backfill_immich_tags():
    """Push every existing local tag into immich at boot (idempotent) so tags created before this feature
    (or while immich was unreachable) still appear in immich."""
    try:
        rows = dbx("SELECT immich_asset_id, tag FROM trips.photo_tag", fetch="all", dict_cur=True) or []
        for r in rows:
            _immich_tag_asset(r["immich_asset_id"], r["tag"], True)
            time.sleep(0.05)
        if rows:
            log.info("immich tag backfill pushed %d rows", len(rows))
    except Exception as e:
        log.warning("immich tag backfill failed: %s", e)


def _immich_delete_asset(asset):
    """Move an immich asset to trash (force=False, recoverable). Best-effort."""
    if not IMMICH_KEY:
        return False
    try:
        r = requests.delete(f"{IMMICH_URL}/api/assets",
                            headers={"x-api-key": IMMICH_KEY, "Content-Type": "application/json"},
                            json={"ids": [asset], "force": False}, timeout=20)
        return r.status_code in (200, 204)
    except Exception as e:
        log.warning("immich asset delete failed: %s", e)
        return False


@app.route("/api/photo/<asset>", methods=["DELETE"])
def api_photo_delete(asset):
    require_admin()
    ok = _immich_delete_asset(asset)                                  # move to immich trash
    dbx("DELETE FROM trips.photo WHERE immich_asset_id=%s", (asset,))  # drop the marker(s)
    dbx("DELETE FROM trips.photo_tag WHERE immich_asset_id=%s", (asset,))
    return jsonify({"ok": True, "immich": ok})


@app.route("/api/photo/<asset>/tag", methods=["POST"])
def api_photo_tag(asset):
    require_admin()
    body = request.get_json(force=True, silent=True) or {}
    tag = body.get("tag"); on = bool(body.get("on"))
    if tag not in TAGS:
        abort(400)
    if on:
        dbx("INSERT INTO trips.photo_tag(immich_asset_id, tag) VALUES (%s,%s) ON CONFLICT DO NOTHING", (asset, tag))
    else:
        dbx("DELETE FROM trips.photo_tag WHERE immich_asset_id=%s AND tag=%s", (asset, tag))
    _immich_tag_asset(asset, tag, on)   # mirror into immich (best-effort; local table is authoritative)
    return jsonify({"ok": True})


# ---------------------------------------------------------------- public share links (token-gated, read-only)
# Each share link is scoped: "relatives" shows only photos tagged 'Relatives', "world" only 'World'.
# A photo tagged with neither never appears in any share. The admin UI (authenticated) still sees all photos.
@app.route("/api/trips/<int:tid>/share", methods=["POST"])
def api_share(tid):
    require_admin()
    body = request.get_json(force=True, silent=True) or {}
    scope = body.get("scope")
    if scope not in SCOPE_TAG:
        abort(400)
    if not dbx("SELECT 1 FROM trips.trip WHERE id=%s", (tid,), fetch="one"):
        abort(404)
    row = dbx("SELECT token FROM trips.share WHERE trip_id=%s AND scope=%s", (tid, scope), fetch="one")
    token = row[0] if row else secrets.token_urlsafe(24)
    if not row:
        dbx("INSERT INTO trips.share(token, trip_id, scope) VALUES (%s,%s,%s)", (token, tid, scope))
    return jsonify({"token": token, "scope": scope, "url": SHARE_BASE.rstrip("/") + "/share/" + token})


@app.route("/api/trips/<int:tid>/shares")
def api_shares(tid):
    require_admin()
    rows = dbx("SELECT scope, token FROM trips.share WHERE trip_id=%s", (tid,), fetch="all") or []
    base = SHARE_BASE.rstrip("/")
    return jsonify({r[0]: {"token": r[1], "url": base + "/share/" + r[1]} for r in rows})


@app.route("/api/trips/<int:tid>/unshare", methods=["POST"])
def api_unshare(tid):
    require_admin()
    body = request.get_json(force=True, silent=True) or {}
    scope = body.get("scope")
    if scope not in SCOPE_TAG:
        abort(400)
    dbx("DELETE FROM trips.share WHERE trip_id=%s AND scope=%s", (tid, scope))
    return jsonify({"ok": True})


def _trip_by_token(token):
    if not token:
        return None
    return dbx("SELECT t.id, t.name, t.color, t.active, t.distance_m, s.scope "
               "FROM trips.share s JOIN trips.trip t ON t.id=s.trip_id WHERE s.token=%s",
               (token,), fetch="one", dict_cur=True)


@app.route("/share/<token>")
def share_page(token):
    if not _trip_by_token(token):
        abort(404)
    return send_from_directory(app.static_folder, "share.html")


@app.route("/share/<token>/data")
def share_data(token):
    t = _trip_by_token(token)
    if not t:
        abort(404)
    tid = int(t["id"]); tag = SCOPE_TAG.get(t.get("scope"))
    tr = dbx("SELECT id, EXTRACT(EPOCH FROM ts) AS ts, lat, lon FROM trips.track_point WHERE trip_id=%s ORDER BY ts, id",
             (tid,), fetch="all", dict_cur=True)
    ph = dbx("SELECT p.id, p.immich_asset_id, p.lat, p.lon FROM trips.photo p WHERE p.trip_id=%s AND p.lat IS NOT NULL "
             "AND EXISTS(SELECT 1 FROM trips.photo_tag pt WHERE pt.immich_asset_id=p.immich_asset_id AND pt.tag=%s) ORDER BY p.id",
             (tid, tag), fetch="all", dict_cur=True)
    return jsonify({
        "name": t["name"], "color": t.get("color"), "active": t["active"],
        "distance_m": round(float(t.get("distance_m") or 0), 1),
        "google_key": GOOGLE_KEY,   # same key the web viewer uses (referrer-restricted to this domain)
        "track": [{"id": int(r["id"]), "ts": float(r["ts"]), "lat": r["lat"], "lon": r["lon"]} for r in tr],
        "photos": [{"id": int(r["id"]), "asset": r["immich_asset_id"], "lat": r["lat"], "lon": r["lon"]} for r in ph],
    })


@app.route("/share/<token>/track")
def share_track(token):
    t = _trip_by_token(token)
    if not t:
        abort(404)
    since = int(request.args.get("since_id") or 0)
    tr = dbx("SELECT id, EXTRACT(EPOCH FROM ts) AS ts, lat, lon FROM trips.track_point WHERE trip_id=%s AND id>%s ORDER BY ts, id",
             (int(t["id"]), since), fetch="all", dict_cur=True)
    return jsonify([{"id": int(r["id"]), "ts": float(r["ts"]), "lat": r["lat"], "lon": r["lon"]} for r in tr])


@app.route("/share/<token>/photos")
def share_photos(token):
    t = _trip_by_token(token)
    if not t:
        abort(404)
    since = int(request.args.get("since_id") or 0); tag = SCOPE_TAG.get(t.get("scope"))
    ph = dbx("SELECT p.id, p.immich_asset_id, p.lat, p.lon FROM trips.photo p WHERE p.trip_id=%s AND p.id>%s AND p.lat IS NOT NULL "
             "AND EXISTS(SELECT 1 FROM trips.photo_tag pt WHERE pt.immich_asset_id=p.immich_asset_id AND pt.tag=%s) ORDER BY p.id",
             (int(t["id"]), since, tag), fetch="all", dict_cur=True)
    return jsonify([{"id": int(r["id"]), "asset": r["immich_asset_id"], "lat": r["lat"], "lon": r["lon"]} for r in ph])


@app.route("/share/<token>/photo/<asset>/<size>")
def share_photo(token, asset, size):
    t = _trip_by_token(token)
    if not t:
        abort(404)
    # the asset MUST belong to this trip AND carry this share's tag — stops the token fetching arbitrary
    # immich assets, or a photo not meant for this audience (e.g. a 'World' token pulling a 'Relatives' photo)
    tag = SCOPE_TAG.get(t.get("scope"))
    if not dbx("SELECT 1 FROM trips.photo p JOIN trips.photo_tag pt ON pt.immich_asset_id=p.immich_asset_id "
               "WHERE p.trip_id=%s AND p.immich_asset_id=%s AND pt.tag=%s LIMIT 1",
               (int(t["id"]), asset, tag), fetch="one"):
        abort(404)
    if size == "original":
        return _immich_proxy(f"/api/assets/{asset}/original", {})
    return _immich_proxy(f"/api/assets/{asset}/thumbnail", {"size": "preview" if size == "preview" else "thumbnail"})


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
    # immich assets are immutable by id → let the browser cache them hard so photo nav is instant on revisit.
    return Response(r.iter_content(8192), content_type=ct,
                    headers={"Cache-Control": "private, max-age=604800, immutable"})


def _immich_proxy_range(path):
    """Proxy a (large/seekable) immich stream, forwarding the browser's Range header and passing back
    206/Content-Range so a <video> element can seek. Used for video playback."""
    if not IMMICH_KEY:
        abort(503)
    headers = {"x-api-key": IMMICH_KEY}
    rng = request.headers.get("Range")
    if rng:
        headers["Range"] = rng
    r = requests.get(f"{IMMICH_URL}{path}", headers=headers, stream=True, timeout=60)
    if r.status_code not in (200, 206):
        abort(r.status_code)
    out = {}
    for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
        if h in r.headers:
            out[h] = r.headers[h]
    out.setdefault("Accept-Ranges", "bytes")
    return Response(r.iter_content(64 * 1024), status=r.status_code, headers=out)


def _nonadmin_may_see(asset):
    """Non-admin photo access (e.g. the direct :8099 viewer) is limited to World-tagged assets, matching
    the api_photos filter — so a non-admin can't fetch an untagged/Relatives-only photo by guessing its id."""
    if request_is_admin():
        return True
    return bool(dbx("SELECT 1 FROM trips.photo_tag WHERE immich_asset_id=%s AND tag='World' LIMIT 1",
                    (asset,), fetch="one"))


@app.route("/api/photo/<asset>/video")
def api_video(asset):
    if not _nonadmin_may_see(asset): abort(404)
    # immich-transcoded playback stream (range-aware → seekable in <video>)
    return _immich_proxy_range(f"/api/assets/{asset}/video/playback")


@app.route("/api/photo/<asset>/thumbnail")
def api_thumb(asset):
    if not _nonadmin_may_see(asset): abort(404)
    # small + fast — used for the marker popup image
    return _immich_proxy(f"/api/assets/{asset}/thumbnail", {"size": "thumbnail"})


@app.route("/api/photo/<asset>/preview")
def api_preview(asset):
    if not _nonadmin_may_see(asset): abort(404)
    # larger (~1440px) — used for the full-screen lightbox
    return _immich_proxy(f"/api/assets/{asset}/thumbnail", {"size": "preview"})


@app.route("/api/photo/<asset>/original")
def api_original(asset):
    if not _nonadmin_may_see(asset): abort(404)
    return _immich_proxy(f"/api/assets/{asset}/original", {})


# --------------------------------------------------------------------------- main
def main():
    bootstrap_schema()
    start_mqtt()
    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=_backfill_immich_tags, daemon=True).start()
    from waitress import serve

    # :8098 is proxied by HA ingress; :8099 is published as a host port for direct access outside HA.
    log.info("serving web UI on :8098 (ingress) and :8099 (direct)")
    serve(app, listen="0.0.0.0:8098 0.0.0.0:8099", threads=8)


if __name__ == "__main__":
    main()
