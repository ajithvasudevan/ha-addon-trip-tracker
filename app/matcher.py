"""Geo + immich helpers for Trip Tracker.

A "track point" here is a tuple (epoch_seconds, lat, lon), the list sorted
ascending by epoch_seconds.
"""
import bisect
import datetime as dt
import math

import requests

EARTH_R = 6371000.0  # metres


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def near_track(points, lat, lon, radius_m):
    """True if (lat,lon) is within radius_m of any track point."""
    for _, pla, plo in points:
        if haversine(lat, lon, pla, plo) <= radius_m:
            return True
    return False


def interpolate_on_track(points, t_epoch, tol_s):
    """Position on the track at time t_epoch.

    Returns (lat, lon) when a track point lies within tol_s of t_epoch
    (linearly interpolating between the two bracketing points for precision),
    else None.
    """
    if not points:
        return None
    es = [p[0] for p in points]
    if t_epoch <= es[0]:
        return (points[0][1], points[0][2]) if (es[0] - t_epoch) <= tol_s else None
    if t_epoch >= es[-1]:
        return (points[-1][1], points[-1][2]) if (t_epoch - es[-1]) <= tol_s else None
    i = bisect.bisect_left(es, t_epoch)
    a, b = points[i - 1], points[i]
    # need at least one bracketing point within tolerance in time
    if min(abs(t_epoch - a[0]), abs(b[0] - t_epoch)) > tol_s:
        return None
    if b[0] == a[0]:
        return (a[1], a[2])
    f = (t_epoch - a[0]) / (b[0] - a[0])
    return (a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2]))


def parse_iso(s):
    """Parse an immich ISO timestamp (handles trailing Z and offsets) → aware UTC datetime."""
    s = str(s).strip().replace("Z", "+00:00")
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def capture_epoch(asset):
    """Best capture time for an immich asset, as epoch seconds (UTC), or None."""
    ex = asset.get("exifInfo") or {}
    for v in (ex.get("dateTimeOriginal"), asset.get("localDateTime"), asset.get("fileCreatedAt")):
        if v:
            try:
                return parse_iso(v).timestamp()
            except Exception:
                continue
    return None


def fetch_assets(base_url, api_key, after_iso, before_iso, page_size=1000, max_pages=50, timeout=30):
    """All IMAGE assets taken in [after_iso, before_iso] via immich search/metadata."""
    url = f"{base_url}/api/search/metadata"
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    out, page = [], 1
    while page <= max_pages:
        body = {
            "takenAfter": after_iso,
            "takenBefore": before_iso,
            "withExif": True,
            "type": "IMAGE",
            "size": page_size,
            "page": page,
        }
        r = requests.post(url, headers=headers, json=body, timeout=timeout)
        r.raise_for_status()
        assets = (r.json() or {}).get("assets", {}) or {}
        out.extend(assets.get("items", []) or [])
        nxt = assets.get("nextPage")
        if not nxt:
            break
        try:
            page = int(nxt)
        except (TypeError, ValueError):
            break
    return out
