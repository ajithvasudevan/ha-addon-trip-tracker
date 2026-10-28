"""Gap filling for Trip Tracker tracks.

A "gap" is a pair of consecutive real fixes further apart than MIN_GAP_M — the phone recorded nothing
across it (signal loss / doze), so the rendered polyline breaks (or would draw a false straight chord).
This module reconstructs the missing geometry:

  * RAIL gap  -> shortest path along OSM `railway=rail` (Overpass), the track the train actually followed.
  * ROAD gap  -> OSRM driving route (the car legs at the trip ends).

Each inserted "fill" point's timestamp is extrapolated between the two gap-end timestamps by its cumulative
distance along the filled path (constant-pace). Fill points are flagged source='filled' by the caller and
are fully removable; real fixes are never touched.

Network: Overpass (openstreetmap.fr mirror — the others are unreliable) + public OSRM. Overpass responses
are cached on disk so re-runs are cheap. Pure stdlib (urllib) so it runs inside the add-on image as-is.
"""
import math, os, json, time, heapq, urllib.request, urllib.parse
from collections import defaultdict

MIN_GAP_M   = 300.0       # fill gaps whose straight endpoint distance exceeds this
MAX_GAP_M   = 40000.0     # skip absurd jumps (likely a genuine multi-hour break, not a signal outage)
SNAP_M      = 120.0       # an endpoint must be within this of rail for the gap to count as rail
RAIL_RATIO  = 1.6         # rail path must be < this x the straight chord (else it's a junction/loop artifact)
ROAD_RATIO  = 3.0         # road route may detour up to this x the chord
DENSIFY_M   = 40.0        # rail geometry is densified to this so nearest-vertex ~= nearest-point-on-line
OVERPASS_MIRRORS = [                       # ordered by observed reliability/latency (fastest-to-succeed first)
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
CACHE_DIR   = "/data/gapfill_cache"
UA          = "trip-tracker-gapfill/1.0"


def hav(a, b, c, d):
    R = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    dphi = math.radians(c - a); dl = math.radians(d - b)
    return 2*R*math.asin(math.sqrt(math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2))


def _http(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass_rail(s, w, n, e):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        key = os.path.join(CACHE_DIR, f"{s:.4f}_{w:.4f}_{n:.4f}_{e:.4f}.json")
        if os.path.exists(key) and (time.time() - os.path.getmtime(key)) < 30*86400:
            return json.load(open(key)).get("elements", [])
    except Exception:
        key = None
    q = f'[out:json][timeout:60];way[railway~"^(rail|light_rail|narrow_gauge)$"]({s},{w},{n},{e});out geom;'
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in OVERPASS_MIRRORS:                 # public Overpass is flaky; try several, first success wins
        try:
            body = _http(ep, data=data, timeout=90)
            els = json.loads(body).get("elements", [])
            if key:
                try: open(key, "wb").write(body)
                except Exception: pass
            return els
        except Exception as e:
            last = e
    raise last if last else RuntimeError("no overpass mirror")


def build_rail_graph(elements, step=DENSIFY_M):
    adj = defaultdict(list); coords = {}
    def key(la, lo): return (round(la, 7), round(lo, 7))
    def add_edge(la1, lo1, la2, lo2):
        k1 = key(la1, lo1); k2 = key(la2, lo2)
        if k1 == k2: return
        coords[k1] = (la1, lo1); coords[k2] = (la2, lo2)
        w = hav(la1, lo1, la2, lo2)
        adj[k1].append((k2, w)); adj[k2].append((k1, w))
    for el in elements:
        g = el.get("geometry") or []
        for j in range(1, len(g)):
            la1, lo1 = g[j-1]["lat"], g[j-1]["lon"]; la2, lo2 = g[j]["lat"], g[j]["lon"]
            d = hav(la1, lo1, la2, lo2)
            if d <= step:
                add_edge(la1, lo1, la2, lo2)
            else:
                nseg = int(d // step) + 1; pla, plo = la1, lo1
                for sidx in range(1, nseg):
                    f = sidx / nseg; mla = la1 + (la2-la1)*f; mlo = lo1 + (lo2-lo1)*f
                    add_edge(pla, plo, mla, mlo); pla, plo = mla, mlo
                add_edge(pla, plo, la2, lo2)
    return adj, coords


def candidates(coords, lat, lon, within, maxn):
    """Up to maxn nearby rail vertices, mutually >12 m apart (so parallel tracks are both represented).
    Pairing A- and B-candidates and taking the SHORTEST Dijkstra path avoids two artifacts at once:
    a station siding (wrong component -> no path, discarded) and a double-track crossover detour
    (opposite-track pairing is longer -> discarded)."""
    ds = sorted(((hav(lat, lon, c[0], c[1]), k) for k, c in coords.items()), key=lambda x: x[0])
    out = []
    for d, k in ds:
        if d > within: break
        if all(hav(coords[k][0], coords[k][1], coords[o][0], coords[o][1]) > 12 for o in out):
            out.append(k)
            if len(out) >= maxn: break
    return out


def dijkstra(adj, src, dst):
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst: break
        if d > dist.get(u, 1e18): continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if dst not in dist: return None, 1e18
    path = [dst]
    while path[-1] != src: path.append(prev[path[-1]])
    path.reverse()
    return path, dist[dst]


def osrm_road(A, B):
    url = (f"https://router.project-osrm.org/route/v1/driving/"
           f"{A[2]},{A[1]};{B[2]},{B[1]}?overview=full&geometries=geojson")
    j = json.loads(_http(url, timeout=40))
    if j.get("code") != "Ok" or not j.get("routes"): return None
    return [(c[1], c[0]) for c in j["routes"][0]["geometry"]["coordinates"]]


def _polyline_len(line):
    return sum(hav(line[k-1][0], line[k-1][1], line[k][0], line[k][1]) for k in range(1, len(line)))


def _fill_one(A, B, log):
    """A,B = (ts,lat,lon). Returns (cls, line_latlon) or None. line_latlon includes both endpoints."""
    chord = hav(A[1], A[2], B[1], B[2])
    s, n = min(A[1], B[1]), max(A[1], B[1]); w, e = min(A[2], B[2]), max(A[2], B[2])
    pad = 0.01
    # --- rail ---
    try:
        els = overpass_rail(s-pad, w-pad, n+pad, e+pad)
        adj, coords = build_rail_graph(els)
        if coords:
            ca = candidates(coords, A[1], A[2], SNAP_M + 40, 4)
            cb = candidates(coords, B[1], B[2], SNAP_M + 40, 4)
            best = None
            for ka in ca:
                for kb in cb:
                    p, L = dijkstra(adj, ka, kb)
                    if p and (best is None or L < best[1]):
                        da = hav(A[1], A[2], *coords[ka]); db = hav(B[1], B[2], *coords[kb])
                        best = (p, L, da, db)
            if best:
                p, L, da, db = best
                if da < SNAP_M and db < SNAP_M and L < RAIL_RATIO * chord:
                    return "rail", [(A[1], A[2])] + [coords[k] for k in p] + [(B[1], B[2])]
    except Exception as ex:
        log(f"gapfill rail error: {ex}")
    # --- road ---
    try:
        rd = osrm_road(A, B)
        if rd:
            line = [(A[1], A[2])] + rd + [(B[1], B[2])]
            if _polyline_len(line) < ROAD_RATIO * chord:
                return "road", line
    except Exception as ex:
        log(f"gapfill road error: {ex}")
    return None


def fill_trip_gaps(points, log=print):
    """points: list of (ts_epoch_float, lat, lon), ordered by ts. Returns (filled, summary):
       filled  = list of (ts, lat, lon) interior fill points to insert (source='filled' set by caller).
       summary = per-gap dicts {idx, chord_m, dt_s, cls, fill_pts, path_m, ratio}."""
    filled = []; summary = []
    for i in range(1, len(points)):
        A, B = points[i-1], points[i]
        chord = hav(A[1], A[2], B[1], B[2])
        if chord <= MIN_GAP_M or chord > MAX_GAP_M:
            continue
        dt = B[0] - A[0]
        res = _fill_one(A, B, log)
        if not res:
            summary.append({"idx": i, "chord_m": round(chord), "dt_s": round(dt), "cls": "skip", "fill_pts": 0})
            continue
        cls, line = res
        # extrapolate interior timestamps by cumulative distance along the fill
        cum = [0.0]
        for k in range(1, len(line)):
            cum.append(cum[-1] + hav(line[k-1][0], line[k-1][1], line[k][0], line[k][1]))
        total = cum[-1] or 1.0
        spd = (total / dt) if dt > 0 else None     # constant pace across the fill (m/s), for speed-colour + stats
        interior = []
        for k in range(1, len(line)-1):
            f = cum[k] / total
            interior.append((A[0] + f*(B[0]-A[0]), line[k][0], line[k][1], spd))
        filled.extend(interior)
        summary.append({"idx": i, "chord_m": round(chord), "dt_s": round(dt), "cls": cls,
                        "fill_pts": len(interior), "path_m": round(total), "ratio": round(total/chord, 2)})
        log(f"gapfill gap#{i} chord={chord:.0f}m dt={dt:.0f}s -> {cls} pts={len(interior)} path={total:.0f}m x{total/chord:.2f}")
    return filled, summary
