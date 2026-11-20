#!/usr/bin/env python3
"""runhud: burn the runwithclaude running dashboard (HUD) onto run footage.

The HUD is drawn from a saved run file (runs/<id>.json, Strava streams) and synced to the
clip by --offset = race elapsed seconds at the clip's first frame (find it from a landmark:
e.g. you pass the start arch at 0:17 into the clip -> offset -17).

  python3 tools/video/runhud.py --run runs/<id>.json --video clip.mp4 --offset -17 [--zoom 1.4 --yfrac .91]
  python3 tools/video/runhud.py --config races/<slug>/video.json

Panels: route map, distance / elevation / time, pace dial (min/km), terrain (climb/descent +
grade graph +/-300 m), heart rate vs roadbook target (--targets "0-1:140-150,1-3:145-155,..." in km,
optional), elevation profile, and the runwithclaude GitHub link.
Needs: python3 with pillow + numpy, ffmpeg. Fonts: macOS system fonts (Avenir Next, DIN, Hiragino).
"""
import argparse, json, math, os, subprocess, sys, tempfile, shutil
import numpy as np
from PIL import Image, ImageDraw, ImageFont

LINK = 'github.com/sharkroman/runwithclaude'
AV = '/System/Library/Fonts/Avenir Next.ttc'
DIN = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'
ACC = (236, 140, 98); WHITE = (255, 255, 255); MUTE = (255, 255, 255, 165)
GREEN = (87, 183, 126); BLUE = (110, 170, 240)
PW, PH, SS = 984, 372, 2
_fc = {}
def F(p, s, i=0):
    k = (p, s, i)
    if k not in _fc: _fc[k] = ImageFont.truetype(p, s, index=i)
    return _fc[k]
def smooth(a, w):
    return np.convolve(np.pad(a, (w // 2, w - 1 - w // 2), mode='edge'), np.ones(w) / w, 'valid')
def parse_targets(s):
    out = []
    for part in (s or '').split(','):
        if not part.strip(): continue
        d, h = part.split(':'); d0, d1 = d.split('-'); h0, h1 = h.split('-')
        out.append((float(d0) * 1000, float(d1) * 1000 if d1 else 1e9, int(h0), int(h1)))
    return out

class HUD:
    def __init__(self, run, targets=None, title=None):
        st = run['streams']; self.run = run
        self.T = np.array(st['time'], float); self.DI = np.array(st['dist'], float); self.AL = np.array(st['alt'], float)
        self.VES = smooth(np.array(st['vel'], float), 15); self.GRS = smooth(np.array(st['grade'], float), 9)
        self.HR = np.array(st['hr'], float) if st.get('hr') else None
        self.ALS = smooth(self.AL, 15)
        self.LA = np.array([p[0] for p in st['location']]); self.LO = np.array([p[1] for p in st['location']])
        self.stages = targets or []
        self.title = (title or run.get('name', 'RUN')).upper()
        self.date = run.get('date', '')[:10].replace('-', '.')
        self.end = float(self.T[-1])
        # static layer (frame, labels, full route, full profile) drawn once
        self.base = self._static()
    def proj(self, box):
        LA, LO = self.LA, self.LO; c = math.cos(math.radians(LA.mean()))
        x = (LO - LO.min()) * c; y = LA.max() - LA
        xr = max((LO.max() - LO.min()) * c, 1e-9); yr = max(LA.max() - LA.min(), 1e-9)
        bx, by, bw, bh = box; s = min(bw / xr, bh / yr)
        return bx + (bw - xr * s) / 2 + x * s, by + (bh - yr * s) / 2 + y * s
    def _static(self):
        s = SS; im = Image.new('RGBA', (PW * s, PH * s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, PW * s - 1, PH * s - 1], radius=30 * s, fill=(10, 14, 18, 125), outline=(255, 255, 255, 46), width=2 * s)
        d.ellipse([24 * s, 27 * s, 34 * s, 37 * s], fill=ACC)
        d.text((44 * s, 20 * s), self.title, font=F(AV, 21 * s, 2), fill=(255, 255, 255, 230))
        tw = d.textlength(self.title, font=F(AV, 21 * s, 2))
        d.text((44 * s + tw + 14 * s, 22 * s), self.date, font=F(AV, 19 * s, 5), fill=MUTE)
        # GitHub link, right side of the header
        lw = d.textlength(LINK, font=F(AV, 17 * s, 5))
        d.text(((PW - 24) * s, 22 * s), LINK, font=F(AV, 17 * s, 5), fill=(255, 255, 255, 190), anchor='ra')
        d.text(((PW - 24) * s - lw - 10 * s, 23 * s), 'RUNWITHCLAUDE', font=F(AV, 15 * s, 2), fill=ACC, anchor='ra')
        d.line([24 * s, 56 * s, (PW - 24) * s, 56 * s], fill=(255, 255, 255, 40), width=s)
        for xx in (226, 404, 592, 782): d.line([xx * s, 72 * s, xx * s, 262 * s], fill=(255, 255, 255, 30), width=s)
        xs, ys = self.proj((18 * s, 72 * s, 198 * s, 188 * s)); self.mxy = (xs, ys)
        d.line(list(zip(xs, ys)), fill=(255, 255, 255, 85), width=3 * s, joint='curve')
        sx, sy = xs[0], ys[0]; d.ellipse([sx - 6 * s, sy - 6 * s, sx + 6 * s, sy + 6 * s], outline=(255, 255, 255, 200), width=2 * s)
        lab = lambda x, y, t, a='la': d.text((x * s, y * s), t, font=F(AV, 15 * s, 2), fill=(255, 255, 255, 150), anchor=a)
        for j, lb in enumerate(['DISTANCE', 'ELEVATION', 'TIME']): lab(244, 72 + j * 66, lb)
        lab(498, 72, 'PACE  /KM', 'ma'); lab(610, 72, 'TERRAIN'); lab(800, 72, 'HEART RATE')
        bx, by, bw, bh = 24 * s, (PH - 82) * s, (PW - 48) * s, 50 * s; self.pbox = (bx, by, bw, bh)
        DI, AL = self.DI, self.AL; rng = max(AL.max() - AL.min(), 1)
        self.xd = bx + DI / DI[-1] * bw; self.ya = by + bh - (AL - AL.min()) / rng * bh
        d.polygon([(bx, by + bh)] + list(zip(self.xd[::4], self.ya[::4])) + [(bx + bw, by + bh)], fill=(255, 255, 255, 38))
        km = DI[-1] / 1000; step = 1 if km <= 6 else 2 if km <= 14 else 5 if km <= 35 else 10
        for kk in np.arange(0, km + 1e-6, step):
            d.text((bx + kk * 1000 / DI[-1] * bw, by + bh + 5 * s), f'{kk:g} km' if kk else '0', font=F(AV, 12 * s, 5), fill=(255, 255, 255, 110), anchor='ma' if kk else 'la')
        return im
    def frame(self, e):
        e = min(self.end, max(0, e)); s = SS; T = self.T
        im = self.base.copy(); d = ImageDraw.Draw(im)
        xs, ys = self.mxy; k = max(1, min(int(np.searchsorted(T, e)), len(T) - 1))
        if k > 1: d.line(list(zip(xs[:k], ys[:k])), fill=ACC + (255,), width=5 * s, joint='curve')
        cx, cy = float(np.interp(e, T, xs)), float(np.interp(e, T, ys))
        d.ellipse([cx - 15 * s, cy - 15 * s, cx + 15 * s, cy + 15 * s], fill=ACC + (70,)); d.ellipse([cx - 8 * s, cy - 8 * s, cx + 8 * s, cy + 8 * s], fill=WHITE, outline=ACC, width=3 * s)
        dn = float(np.interp(e, T, self.DI)); alt = float(np.interp(e, T, self.AL)); ee = int(e)
        for j, (val, unit) in enumerate([(f'{dn/1000:.2f}', 'km'), (f'{alt:.0f}', 'm'), (f'{ee//3600}:{ee%3600//60:02d}:{ee%60:02d}', '')]):
            y = 72 + j * 66 + 17; d.text((244 * s, y * s), val, font=F(DIN, 38 * s), fill=WHITE)
            if unit: d.text((244 * s + d.textlength(val, font=F(DIN, 38 * s)) + 6 * s, (y + 15) * s), unit, font=F(AV, 18 * s, 5), fill=(255, 255, 255, 190))
        # pace dial
        v = float(np.interp(e, T, self.VES)); pace = 1000 / v / 60 if v > 0.8 else None
        DX, DY, R = 498, 176, 78
        zones = [(12, 9, (108, 142, 191)), (9, 7, GREEN), (7, 6, (242, 193, 78)), (6, 4, ACC)]
        ang = lambda p: 135 + (12 - max(4, min(12, p))) / 8 * 270
        bb = [(DX - R) * s, (DY - R + 14) * s, (DX + R) * s, (DY + R + 14) * s]
        for p0, p1, c in zones: d.arc(bb, ang(p0), ang(p1), fill=c + (110,), width=12 * s)
        if pace:
            a1 = ang(pace); zc = [c for p0, p1, c in zones if p1 <= min(12, max(4, pace)) <= p0][0]
            d.arc(bb, 135, a1, fill=zc + (255,), width=12 * s)
            r = math.radians(a1); ccx, ccy = DX * s, (DY + 14) * s; px_, py_ = ccx + math.cos(r) * R * s, ccy + math.sin(r) * R * s
            d.ellipse([px_ - 9 * s, py_ - 9 * s, px_ + 9 * s, py_ + 9 * s], fill=WHITE, outline=zc, width=3 * s)
            sec = int(round(pace * 60)); txt = f'{sec//60}:{sec%60:02d}'
        else: zc = WHITE; txt = '--'
        d.text((DX * s, (DY + 2) * s), txt, font=F(DIN, 44 * s), fill=WHITE, anchor='mm')
        zname = 'STOP' if not pace else 'WALK' if pace > 9 else 'EASY' if pace > 7 else 'STEADY' if pace > 6 else 'FAST'
        d.text((DX * s, (DY + 36) * s), zname, font=F(AV, 15 * s, 2), fill=zc + (255,), anchor='mm')
        # terrain
        g = float(np.interp(e, T, self.GRS)); TX = 610
        gc, word = (ACC, 'CLIMB') if g > 1.5 else (BLUE, 'DESCENT') if g < -1.5 else ((200, 200, 200), 'FLAT')
        tx, ty = TX * s, 104 * s
        if word == 'CLIMB': d.polygon([(tx, ty + 30 * s), (tx + 17 * s, ty), (tx + 34 * s, ty + 30 * s)], fill=gc)
        elif word == 'DESCENT': d.polygon([(tx, ty), (tx + 34 * s, ty), (tx + 17 * s, ty + 30 * s)], fill=gc)
        else: d.rounded_rectangle([tx, ty + 11 * s, tx + 34 * s, ty + 19 * s], radius=3 * s, fill=gc)
        d.text((tx + 46 * s, ty - 6 * s), f'{g:+.1f}%', font=F(DIN, 38 * s), fill=WHITE)
        d.text((tx + 46 * s, ty + 36 * s), word, font=F(AV, 15 * s, 2), fill=gc)
        gx, gy, gw, gh = TX * s, 170 * s, 156 * s, 86 * s
        ds = np.linspace(dn - 300, dn + 300, 61); el = np.interp(ds, self.DI, self.ALS)
        gg = np.convolve(np.pad(np.gradient(el, ds) * 100, (3, 3), mode='edge'), np.ones(7) / 7, 'valid')
        lo, hi = el.min() - 3, max(el.max(), el.min() + 25)
        X = gx + (ds - ds[0]) / 600 * gw; Y = gy + gh - (el - lo) / (hi - lo) * gh
        for j in range(60):
            c = ACC if gg[j] > 1.5 else BLUE if gg[j] < -1.5 else (200, 200, 200)
            d.polygon([(X[j], Y[j]), (X[j + 1], Y[j + 1]), (X[j + 1], gy + gh), (X[j], gy + gh)], fill=c + (int(min(255, 90 + abs(gg[j]) * 12)),))
        d.line(list(zip(X, Y)), fill=WHITE, width=2 * s)
        mx = gx + gw / 2; my = float(np.interp(dn, ds, Y)); d.line([mx, gy - 4 * s, mx, gy + gh], fill=(255, 255, 255, 170), width=s)
        d.ellipse([mx - 6 * s, my - 6 * s, mx + 6 * s, my + 6 * s], fill=WHITE)
        d.text((gx, gy + gh + 4 * s), '−300 m', font=F(AV, 12 * s, 5), fill=(255, 255, 255, 110)); d.text((gx + gw, gy + gh + 4 * s), '+300 m', font=F(AV, 12 * s, 5), fill=(255, 255, 255, 110), anchor='ra')
        # heart rate (vs roadbook target when given)
        HX = 800; hx, hy = HX * s, 108 * s; r = 8 * s
        if self.HR is not None:
            hr = float(np.interp(e, T, self.HR)); tgt = [(a, b) for d0, d1, a, b in self.stages if d0 <= dn < d1]
            if tgt:
                lo_t, hi_t = tgt[0]
                st_c = GREEN if lo_t <= hr <= hi_t else ACC if hr > hi_t else BLUE
                st_w = 'IN TARGET' if lo_t <= hr <= hi_t else 'ABOVE TARGET' if hr > hi_t else 'BELOW TARGET'
            else: st_c, st_w, lo_t, hi_t = ACC, f"AVG {self.run.get('avg_hr','')}", None, None
            d.ellipse([hx, hy, hx + 2 * r, hy + 2 * r], fill=st_c); d.ellipse([hx + 2 * r - 2 * s, hy, hx + 4 * r - 2 * s, hy + 2 * r], fill=st_c)
            d.polygon([(hx + 1 * s, hy + r + 3 * s), (hx + 4 * r - 3 * s, hy + r + 3 * s), (hx + 2 * r - 1 * s, hy + 4 * r - 2 * s)], fill=st_c)
            d.text((hx + 44 * s, hy - 14 * s), f'{hr:.0f}', font=F(DIN, 44 * s), fill=WHITE)
            d.text((hx + 44 * s + d.textlength(f'{hr:.0f}', font=F(DIN, 44 * s)) + 6 * s, hy + 8 * s), 'bpm', font=F(AV, 18 * s, 5), fill=(255, 255, 255, 190))
            d.text((hx, hy + 44 * s), st_w, font=F(AV, 15 * s, 2), fill=st_c)
            bx, by, bw = HX * s, 206 * s, 160 * s; rg = (120, 180); f = lambda v: bx + (min(max(v, rg[0]), rg[1]) - rg[0]) / (rg[1] - rg[0]) * bw
            d.rounded_rectangle([bx, by, bx + bw, by + 10 * s], radius=5 * s, fill=(255, 255, 255, 45))
            if lo_t: d.rounded_rectangle([f(lo_t), by, f(hi_t), by + 10 * s], radius=5 * s, fill=GREEN + (170,))
            m = f(hr); d.polygon([(m - 8 * s, by - 12 * s), (m + 8 * s, by - 12 * s), (m, by - 1 * s)], fill=WHITE)
            if lo_t: d.text((bx, by + 18 * s), f'TARGET  {lo_t}–{hi_t} BPM', font=F(AV, 13 * s, 2), fill=(255, 255, 255, 150))
        else: d.text((hx, hy), '--', font=F(DIN, 44 * s), fill=WHITE)
        # elevation profile progress
        bx, by, bw, bh = self.pbox; px = float(np.interp(e, T, self.xd)); mm = self.xd <= px
        if mm.sum() > 2: d.polygon([(bx, by + bh)] + list(zip(self.xd[mm][::4], self.ya[mm][::4])) + [(float(self.xd[mm][-1]), by + bh)], fill=ACC + (150,))
        d.line([px, by - 6 * s, px, by + bh], fill=WHITE, width=2 * s)
        return im.resize((PW, PH), Image.LANCZOS)

# ---------- rendering ----------
_G = {}
def _init(run_path, targets, title):
    _G['hud'] = HUD(json.load(open(run_path)), parse_targets(targets), title)
def _job(a):
    f, e, path = a
    if not os.path.exists(path): _G['hud'].frame(e).save(path, compress_level=1)

def probe(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json', video], capture_output=True, text=True, check=True).stdout
    j = json.loads(out); s = j['streams'][0]; w, h = s['width'], s['height']
    rot = next((abs(int(x.get('rotation', 0))) for x in s.get('side_data_list', []) if 'rotation' in x), 0)
    if rot in (90, 270): w, h = h, w
    return w, h, float(j['format']['duration'])

def render(run_path, video, offset, out, zoom=1.0, yfrac=0.5, targets='', title=None, hud_fps=10, workers=None, bitrate='10M', keep=False):
    from multiprocessing import Pool
    w, h, dur = probe(video); portrait = h >= w
    W, H = (1080, 1920) if portrait else (1920, 1080); px, py = (48, 150) if portrait else (48, 48)
    tmp = tempfile.mkdtemp(prefix='runhud_'); n = int(dur * hud_fps) + 1
    jobs = [(f, f / hud_fps + offset, f'{tmp}/{f:06d}.png') for f in range(n)]
    print(f'{os.path.basename(video)}: {dur/60:.1f} min, {"portrait" if portrait else "landscape"}, offset {offset:+g}s, {n} HUD frames', flush=True)
    with Pool(workers or max(1, (os.cpu_count() or 4) - 2), initializer=_init, initargs=(run_path, targets, title)) as pl:
        for i, _ in enumerate(pl.imap_unordered(_job, jobs, chunksize=40)):
            if i % 5000 == 0: print(f'  hud {i}/{n}', flush=True)
    enc = ['-c:v', 'h264_videotoolbox', '-b:v', bitrate] if sys.platform == 'darwin' else ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium']
    vf = (f'[0:v]crop=iw/{zoom}:ih/{zoom}:(iw-iw/{zoom})/2:(ih-ih/{zoom})*{yfrac},scale={W}:{H}:flags=lanczos,setsar=1[b];'
          f'[1:v]format=rgba[o];[b][o]overlay={px}:{py}:eof_action=repeat,format=yuv420p[v]')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-stats', '-y', '-i', video, '-framerate', str(hud_fps), '-i', f'{tmp}/%06d.png',
                    '-filter_complex', vf, '-map', '[v]', '-map', '0:a?'] + enc + ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], check=True)
    if not keep: shutil.rmtree(tmp, ignore_errors=True)
    print('  ->', out, flush=True)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run'); ap.add_argument('--video'); ap.add_argument('--offset', type=float, default=0)
    ap.add_argument('--out'); ap.add_argument('--zoom', type=float, default=1.0, help='center crop factor (1 = none)')
    ap.add_argument('--yfrac', type=float, default=0.5, help='vertical crop position 0=top 1=bottom')
    ap.add_argument('--targets', default='', help='roadbook HR targets by km, e.g. "0-1:140-150,1-3:145-155,3-:140-150"')
    ap.add_argument('--title'); ap.add_argument('--hud-fps', type=int, default=10); ap.add_argument('--bitrate', default='10M')
    ap.add_argument('--config', help='JSON with run, targets, title and a clips list (file, offset, zoom, yfrac, out)')
    ap.add_argument('--footage', help='folder holding the clips named in --config (default: --outdir, then ~/Downloads/Airdrop)')
    ap.add_argument('--outdir', default='~/Movies/runwithclaude', help='where --config outputs go (served to phones by io.airdrop.stream)')
    ap.add_argument('--only', help='with --config: render just this clip file name')
    ap.add_argument('--preview', type=float, help='write one HUD PNG at this race second and exit')
    a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__)); repo = os.path.dirname(os.path.dirname(here))
    if a.config:
        c = json.load(open(a.config)); run = os.path.join(repo, c['run'])
        for cl in c['clips']:
            if a.only and cl['file'] != a.only: continue
            if a.footage: src = os.path.join(os.path.expanduser(a.footage), cl['file'])
            else:
                src = os.path.join(os.path.expanduser(a.outdir), cl['file'])
                if not os.path.exists(src): src = os.path.join(os.path.expanduser('~/Downloads/Airdrop'), os.path.basename(cl['file']))
            out = os.path.join(os.path.expanduser(a.outdir), cl.get('out') or os.path.splitext(cl['file'])[0] + '_hud.mp4')
            render(run, src, cl['offset'], out, cl.get('zoom', 1), cl.get('yfrac', .5), c.get('targets', ''), c.get('title'), a.hud_fps, bitrate=a.bitrate)
    elif a.preview is not None:
        _init(a.run, a.targets, a.title); p = a.out or 'hud_preview.png'; _G['hud'].frame(a.preview).save(p); print(p)
    else:
        if not (a.run and a.video): ap.error('--run and --video are required (or --config)')
        render(a.run, a.video, a.offset, a.out or os.path.join(os.path.expanduser(a.outdir), os.path.splitext(os.path.basename(a.video))[0] + '_hud.mp4'), a.zoom, a.yfrac, a.targets, a.title, a.hud_fps, bitrate=a.bitrate)
