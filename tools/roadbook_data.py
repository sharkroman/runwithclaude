#!/usr/bin/env python3
"""Build the embedded `routeData` JSON for a race/route roadbook (races/<slug>/index.html) from a GPX.

    python3 tools/roadbook_data.py route.gpx out.json --name "Courtyard 8K" [--zoom 15] [--contour 2]

Terrain: AWS Terrarium DEM tiles (elevation-tiles-prod, public) -> soft hillshade PNG (water <= 0.3 m in blue)
+ contour paths, in a 1000x1000 SVG space (web-mercator, square around the route). Same schema as the
Catalina roadbook: meta{..., splits, km, dem_totals, dem_splits}, route[{lat,lon,ele,d,x,y,dem}],
profile[{d,ele}] every 20 m (DEM, smoothed), terrain{contours[{level,path}], image, extent, zoom, span,
meters_per_unit}. Needs numpy, pillow, matplotlib.
"""
import argparse, base64, io, json, math, re, urllib.request
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("gpx"); ap.add_argument("out")
ap.add_argument("--name"); ap.add_argument("--zoom", type=int, default=15)
ap.add_argument("--contour", type=float, default=2, help="contour interval in metres")
ap.add_argument("--margin", type=float, default=0.12, help="padding around the route, fraction of span")
ap.add_argument("--px", type=int, default=900, help="terrain image size")
ap.add_argument("--exaggerate", type=float, default=4, help="hillshade vertical exaggeration")
a = ap.parse_args()

src = open(a.gpx, encoding="utf-8").read()
pts = [(float(la), float(lo)) for la, lo in re.findall(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)"', src)]
gele = [float(e) for e in re.findall(r"<trkpt[^>]*>\s*<ele>([-\d.]+)</ele>", src)]
name = a.name or (re.search(r"<name>(.*?)</name>", src) or [None, "Route"])[1]
link = re.search(r'<link href="(https://www.strava.com/routes/(\d+))"', src)

def hav(p, q):
    R = 6371008.8; la1, lo1, la2, lo2 = map(math.radians, (*p, *q))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
dist = [0.0]
for p, q in zip(pts, pts[1:]): dist.append(dist[-1] + hav(p, q))
T = dist[-1]

# --- web mercator in tile units at zoom z
Z = a.zoom; N = 2 ** Z
def tx(lon): return (lon + 180) / 360 * N
def ty(lat): r = math.radians(lat); return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * N
xs = [tx(lo) for _, lo in pts]; ys = [ty(la) for la, _ in pts]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
span = max(max(xs) - min(xs), max(ys) - min(ys)) * (1 + 2 * a.margin)
x0, y0 = cx - span / 2, cy - span / 2
lat_c = sum(p[0] for p in pts) / len(pts)
m_per_tile = 40075016.686 * math.cos(math.radians(lat_c)) / N
meters_per_unit = span * m_per_tile / 1000

# --- DEM mosaic
tiles = {}
for X in range(int(x0), int(x0 + span) + 1):
    for Y in range(int(y0), int(y0 + span) + 1):
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{X}/{Y}.png"
        im = np.asarray(Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=30).read())).convert("RGB")).astype(float)
        tiles[(X, Y)] = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
def dem_at(fx, fy):  # fx, fy in tile units, bilinear
    X, Y = int(fx), int(fy); u, v = (fx - X) * 256 - 0.5, (fy - Y) * 256 - 0.5
    t = tiles.get((X, Y))
    if t is None: return 0.0
    i0, j0 = int(np.clip(math.floor(v), 0, 255)), int(np.clip(math.floor(u), 0, 255))
    i1, j1 = min(i0 + 1, 255), min(j0 + 1, 255); dv, du = np.clip(v - i0, 0, 1), np.clip(u - j0, 0, 1)
    return float(t[i0, j0] * (1 - du) * (1 - dv) + t[i0, j1] * du * (1 - dv) + t[i1, j0] * (1 - du) * dv + t[i1, j1] * du * dv)
G = a.px
gx = x0 + (np.arange(G) + 0.5) / G * span; gy = y0 + (np.arange(G) + 0.5) / G * span
grid = np.array([[dem_at(fx, fy) for fx in gx] for fy in gy])
# light smoothing (3x3 box) to remove tile noise
k = np.pad(grid, 1, mode="edge"); grid_s = sum(k[i:i + G, j:j + G] for i in range(3) for j in range(3)) / 9

# --- hillshade (sun NW, 45 deg), Catalina palette
cell = span * m_per_tile / G
dzdy, dzdx = np.gradient(grid_s * a.exaggerate, cell)
slope = np.arctan(np.hypot(dzdx, dzdy)); aspect = np.arctan2(-dzdx, dzdy)
az, alt = math.radians(315), math.radians(45)
shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
shade = np.clip((shade - shade.min()) / (np.ptp(shade) or 1), 0, 1)
light, dark, water = np.array([248, 245, 233]), np.array([222, 219, 206]), np.array([215, 230, 229])
t = np.clip((0.78 - shade) / 0.5, 0, 1)[..., None]
rgb = light * (1 - t) + dark * t
rgb[grid_s <= 0.3] = water
buf = io.BytesIO(); Image.fromarray(rgb.astype(np.uint8)).save(buf, "PNG", optimize=True)
image = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

# --- contours in SVG units
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
lo_l = math.ceil(max(grid_s.min(), 0.5) / a.contour) * a.contour
levels = np.arange(lo_l, grid_s.max(), a.contour)
contours = []
if len(levels):
    cs = plt.contour((np.arange(G) + 0.5) / G * 1000, (np.arange(G) + 0.5) / G * 1000, grid_s, levels=levels)
    for lev, segs in zip(cs.levels, cs.allsegs):
        for seg in segs:
            if len(seg) < 8: continue
            seg = seg[:: max(1, len(seg) // 400)]
            length = float(np.hypot(*np.diff(seg, axis=0).T).sum())
            mid = seg[len(seg) // 2]
            contours.append({"level": int(round(lev)) if float(lev).is_integer() else round(float(lev), 1),
                             "path": "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in seg),
                             "length": round(length, 1), "label": [round(float(mid[0]), 1), round(float(mid[1]), 1)]})

# --- route + DEM along it
route = []
for (la, lo), d, e, X, Y in zip(pts, dist, gele or [0] * len(pts), xs, ys):
    route.append({"lat": round(la, 7), "lon": round(lo, 7), "ele": round(e, 2), "d": round(d, 2),
                  "x": round((X - x0) / span * 1000, 2), "y": round((Y - y0) / span * 1000, 2),
                  "dem": round(dem_at(X, Y), 2)})
def at(d, key):
    for i in range(1, len(route)):
        if route[i]["d"] >= d:
            p, q = route[i - 1], route[i]; f = (d - p["d"]) / ((q["d"] - p["d"]) or 1)
            return p[key] + f * (q[key] - p[key])
    return route[-1][key]
ds = np.arange(0, T, 20.0).tolist() + [T]
raw = np.array([dem_at(x0 + at(d, "x") / 1000 * span, y0 + at(d, "y") / 1000 * span) for d in ds])
w = 5; sm = np.convolve(np.pad(raw, w // 2, mode="edge"), np.ones(w) / w, mode="valid")
profile = [{"d": round(d, 1), "ele": round(float(e), 2)} for d, e in zip(ds, sm)]

def stats(series, s, e):
    z = [p["ele"] for p in series if s * 1000 <= p["d"] <= e * 1000]
    g = sum(max(0, b - c) for c, b in zip(z, z[1:])); l = sum(max(0, c - b) for c, b in zip(z, z[1:]))
    net = (z[-1] - z[0]) if z else 0
    return {"start": round(s, 4), "end": round(e, 4), "gain": round(g, 1), "loss": round(l, 1),
            "net": round(net, 1), "grade": round(net / ((e - s) * 10 or 1), 1)}
gser = [{"d": r["d"], "ele": r["ele"]} for r in route]
bounds = [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]
km_edges = list(range(0, int(T // 1000) + 1)) + ([T / 1000] if T % 1000 > 50 else [])
km_edges = sorted(set(km_edges))
spans = list(zip(km_edges, km_edges[1:]))
peak = max(profile, key=lambda p: p["ele"])
meta = {
    "name": name, "points": len(pts),
    "source_type": "Strava route GPX" if link else "GPX",
    "source_id": link[2] if link else "", "source_url": link[1] if link else "", "source_updated": "",
    "distance_km": round(T / 1000, 4), "geodesic_km": round(T / 1000, 4),
    "elevation_min": round(min(gele), 2) if gele else 0, "elevation_max": round(max(gele), 2) if gele else 0,
    "peak_km": round(route[max(range(len(route)), key=lambda i: route[i]["ele"])]["d"] / 1000, 3),
    "bounds": bounds, "totals": stats(gser, 0, T / 1000),
    "source_gain": round(sum(max(0, b - c) for c, b in zip(gele, gele[1:])), 1) if gele else 0,
    "splits": [stats(gser, s, e) for s, e in spans],
    "km": [{"km": k, "lat": round(at(k * 1000, "lat"), 8), "lon": round(at(k * 1000, "lon"), 8),
            "ele": round(at(k * 1000, "ele"), 2)} for k in range(int(T // 1000) + 1)],
    "dem_totals": stats(profile, 0, T / 1000), "dem_splits": [stats(profile, s, e) for s, e in spans],
    "dem_peak_km": round(peak["d"] / 1000, 2), "dem_peak": round(peak["ele"], 1),
}
out = {"meta": meta, "route": route, "profile": profile,
       "terrain": {"contours": contours, "image": image, "extent": [x0, y0, x0 + span, y0 + span],
                   "zoom": Z, "span": span, "meters_per_unit": meters_per_unit}}
json.dump(out, open(a.out, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{name}: {T/1000:.2f} km, {len(pts)} pts, DEM {grid_s.min():.1f}-{grid_s.max():.1f} m, "
      f"{len(contours)} contours, {meters_per_unit:.2f} m/unit, DEM +{meta['dem_totals']['gain']}/-{meta['dem_totals']['loss']} m, "
      f"peak {peak['ele']:.1f} m @ {peak['d']/1000:.2f} km")
