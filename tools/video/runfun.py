#!/usr/bin/env python3
"""runfun: playful beat-cut edit straight from RAW footage + the live runhud HUD.

Shot effects (plan JSON):  cut | zoom (punch-in) | lapse (fast-forward with a xN badge) | snap (shutter flash ->
polaroid freeze with a handwritten note). Captions are v5 style (orange kicker + white title, under the HUD).

  python3 tools/video/runfun.py plan.json out.mp4

plan.json:
  {"raw": "...mp4", "run": "run.json", "offset": 103, "zoom": 1.3, "yfrac": 0.9, "title": "Kenneth Hahn",
   "music": "song.wav", "music_start": 17.2, "amb": 0.22,
   "shots": [{"t": "0:20", "beats": 4, "fx": "cut", "cap": {"kicker": "...", "title": "..."}},
             {"t": "4:00", "beats": 4, "fx": "lapse", "speed": 10},
             {"t": "18:01", "beats": 4, "fx": "zoom", "focus": [540, 1100], "z": 1.25},
             {"t": "18:03", "beats": 4, "fx": "snap", "note": "MLK Memorial", "sub": "Kenneth Hahn · 2018", "crop_y": 0.6}]}
t is the RAW clip time (m:ss). Needs pillow, numpy, ffmpeg; macOS fonts. Reuses runhud.HUD and runedit.beats.
"""
import json, math, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runhud, runedit

FF = runedit.FF; W, H, FPS = 1080, 1920, 30000 / 1001; SR = 48000
ACC = runedit.ACC; F = runedit.F; AV = runedit.AV; HG = runedit.HG
HAND = '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf'

def tsec(t): return t if isinstance(t, (int, float)) else (lambda p: int(p[0]) * 60 + float(p[1]))(t.split(':'))
def ease(x): x = min(1, max(0, x)); return 1 - (1 - x) ** 3

class Reader:
    def __init__(s, raw, t, n, crop, speed=1):
        vf = (f'setpts=PTS/{speed},' if speed != 1 else '') + f'fps={FPS},{crop},scale={W}:{H}:flags=bicubic'
        s.p = subprocess.Popen([FF, '-v', 'error', '-ss', f'{t:.3f}', '-i', raw, '-an', '-vf', vf, '-frames:v', str(n + 2),
                                '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL); s.last = None
    def next(s):
        b = s.p.stdout.read(W * H * 3)
        if len(b) == W * H * 3: s.last = Image.frombuffer('RGB', (W, H), b).copy()
        return s.last
    def close(s): s.p.stdout.close(); s.p.wait()

def badge(text):
    f = F(AV, 44, 2); bb = f.getbbox(text); w, h = bb[2] - bb[0] + 56, 82
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], 41, fill=ACC + (240,)); d.text((28 - bb[0], (h - (bb[3] - bb[1])) // 2 - bb[1]), text, font=f, fill=(255, 255, 255))
    return im

def polaroid(img, note, sub, cy=0.3):
    pw = 700; ph = int(pw * img.height / img.width * 0.62)
    chh = int(img.width * ph / pw); y0 = int(cy * (img.height - chh))
    crop = img.crop((0, y0, img.width, y0 + chh)).resize((pw, ph), Image.LANCZOS)
    P = Image.new('RGBA', (pw + 60, ph + 220), (252, 251, 247, 255)); P.paste(crop, (30, 30)); d = ImageDraw.Draw(P)
    fh = F(HAND, 54) if os.path.exists(HAND) else F(AV, 50, 2)
    cjk = any(ord(c) > 0x2e80 for c in note); fn = F(HG, 54, 2) if cjk else fh
    d.text((pw // 2 + 30, ph + 70), note, font=fn, fill=(40, 40, 46), anchor='mm')
    if sub: d.text((pw // 2 + 30, ph + 150), sub, font=F(AV, 30, 0), fill=(110, 110, 118), anchor='mm')
    sh = Image.new('RGBA', (P.width + 80, P.height + 80), (0, 0, 0, 0)); ImageDraw.Draw(sh).rectangle([40, 52, 40 + P.width, 52 + P.height], fill=(0, 0, 0, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(18)); sh.alpha_composite(P, (40, 40)); return sh

def shutter():
    n = int(0.09 * SR); r = np.random.default_rng(7); x = r.normal(0, 1, n) * np.exp(-np.linspace(0, 9, n))
    x = np.convolve(x, np.ones(6) / 6, 'same') * 0.6; y = np.zeros(int(0.16 * SR)); y[:n] += x; y[int(0.07 * SR):int(0.07 * SR) + n] += x * 0.7
    return np.stack([y, y], 1)

def audio_seg(raw, t, dur):
    b = subprocess.run([FF, '-v', 'error', '-ss', f'{t:.3f}', '-t', f'{dur:.3f}', '-i', raw, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    a = np.frombuffer(b, np.float32).reshape(-1, 2).copy(); n = int(dur * SR)
    a = np.pad(a, ((0, max(0, n - len(a))), (0, 0)))[:n]; r = min(len(a) // 4, int(0.03 * SR))
    if r: a[:r] *= np.linspace(0, 1, r)[:, None]; a[-r:] *= np.linspace(1, 0, r)[:, None]
    return a

def main():
    P = json.load(open(sys.argv[1])); out = sys.argv[2]
    raw, off = os.path.expanduser(P['raw']), P['offset']; z, yf = P.get('zoom', 1.0), P.get('yfrac', .5)
    crop = f'crop=iw/{z}:ih/{z}:(iw-iw/{z})/2:(ih-ih/{z})*{yf}'
    run = json.load(open(os.path.expanduser(P['run']))); hud = runhud.HUD(run, runhud.parse_targets(P.get('targets', '')), P.get('title'))
    b, bpm = runedit.beats(os.path.expanduser(P['music'])); i0 = int(np.searchsorted(b, P.get('music_start', 0))); i0 -= i0 % 4
    shots, k = [], i0
    for s in P['shots']:
        d = float(b[k + s['beats']] - b[k]); k += s['beats']; s = dict(s, t=tsec(s['t']), dur=d); shots.append(s)
    total = sum(s['dur'] for s in shots); NF = int(round(total * FPS))
    enc = subprocess.Popen([FF, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                            '-c:v', 'h264_videotoolbox', '-b:v', '16M', '-pix_fmt', 'yuv420p', out + '.v.mp4'], stdin=subprocess.PIPE)
    amb = np.zeros((int(total * SR) + SR, 2), np.float32)
    hcache = {}; caps = {}; fi = 0; t_out = 0.0; last_img = None
    for si, s in enumerate(shots):
        nfr = int(round((t_out + s['dur']) * FPS)) - fi; fx = s.get('fx', 'cut'); sp = s.get('speed', 1) if fx == 'lapse' else 1
        rd = None if fx == 'snap' else Reader(raw, s['t'], nfr, crop, sp)
        frozen = None
        if fx == 'snap':
            rr = Reader(raw, s['t'], 1, crop); frozen = rr.next(); rr.close()
            pol = polaroid(frozen, s.get('note', ''), s.get('sub', ''), s.get('crop_y', .3)); bgf = frozen.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * .62))
        a0 = int(t_out * SR)
        if fx in ('cut', 'zoom'): seg = audio_seg(raw, s['t'], s['dur']) * P.get('amb', .22); amb[a0:a0 + len(seg)] += seg
        if fx == 'snap': sh = shutter(); amb[a0:a0 + len(sh)] += sh
        if s.get('cap'):
            key = json.dumps(s['cap'], ensure_ascii=False)
            if key not in caps:
                p = f'{out}.cap{si}.png'; runedit.caption_png(s['cap'], p); caps[key] = Image.open(p).convert('RGBA'); os.remove(p)
            cap = caps[key]
        else: cap = None
        bd = badge(f'×{sp} SPEED') if fx == 'lapse' else None
        for j in range(nfr):
            lt = j / FPS; src_t = s['t'] + lt * sp
            if fx == 'snap':
                x = ease(lt / 0.35); sc = 1 - 0.36 * x; rot = -6 * x
                fr = Image.blend(frozen, bgf, x).convert('RGBA')
                g = pol.resize((int(pol.width * (sc / .64) * .64 + 1), int(pol.height * (sc / .64) * .64 + 1)), Image.BILINEAR) if x < 1 else pol
                if x < 1:   # the photo itself shrinks from full frame into the polaroid
                    full = frozen.resize((int(W * sc), int(H * sc)), Image.BILINEAR).rotate(rot, expand=True, resample=Image.BICUBIC)
                    fr.paste(full, ((W - full.width) // 2, int(1060 - full.height / 2 + (H / 2 - 1060) * (1 - x))))
                    if x > .6: gp = g.rotate(rot, expand=True, resample=Image.BICUBIC); gp.putalpha(gp.getchannel('A').point(lambda v: int(v * (x - .6) / .4))); fr.alpha_composite(gp, ((W - gp.width) // 2, 1060 - gp.height // 2))
                else:
                    if 'rotp' not in s: s['rotp'] = pol.rotate(-6, expand=True, resample=Image.BICUBIC)
                    gp = s['rotp']; fr.alpha_composite(gp, ((W - gp.width) // 2, 1060 - gp.height // 2))
                if lt < 0.22: fr = Image.blend(fr, Image.new('RGBA', (W, H), (255, 255, 255, 255)), (1 - lt / 0.22) * .9)
                src_t = s['t']
            else:
                img = rd.next() or last_img; last_img = img; fr = img.convert('RGBA')
                if fx == 'zoom':
                    zz = 1 + (s.get('z', 1.22) - 1) * ease(lt / max(.3, s['dur'] * .8)); fx_, fy_ = s.get('focus', [540, 1150])
                    cw, ch = W / zz, H / zz; x0 = min(max(0, fx_ - cw / 2), W - cw); y0 = min(max(0, fy_ - ch / 2), H - ch)
                    fr = fr.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch))).resize((W, H), Image.BILINEAR)
            hk = round((src_t + off) * 10) / 10
            if hk not in hcache:
                if len(hcache) > 400: hcache.clear()
                hcache[hk] = hud.frame(hk).convert('RGBA')
            fr.alpha_composite(hcache[hk], (48, 150))
            if cap is not None:
                a = min(1, max(0, (lt - .2) / .4), max(0, (s['dur'] - .15 - lt) / .3))
                if a > 0:
                    c2 = cap if a >= 1 else cap.copy()
                    if a < 1: c2.putalpha(c2.getchannel('A').point(lambda v: int(v * a)))
                    fr.alpha_composite(c2, (0, int((1 - min(1, (lt - .2) / .4 if lt > .2 else 0)) ** 2 * 24)))
            if bd is not None: fr.alpha_composite(bd, (W - bd.width - 56, 590 + (int(lt * 4) % 2) * 0))
            if fi >= NF - 12: fr = Image.blend(fr, Image.new('RGBA', (W, H), (0, 0, 0, 255)), (fi - (NF - 12)) / 12)
            enc.stdin.write(fr.convert('RGB').tobytes()); fi += 1
        if rd: rd.close()
        t_out += s['dur']; print(f"  {t_out - s['dur']:5.1f}s  {fx:5s} raw {s['t']:6.1f}  {s['dur']:.2f}s  {(s.get('cap') or {}).get('title', '') or s.get('note', '')}", flush=True)
    enc.stdin.close(); enc.wait()
    # audio: music from the bar + live sound; loudness to -15 LUFS
    mus = runedit.load_audio(os.path.expanduser(P['music']), SR, ss=b[i0], t=total + 1); mus = np.stack([mus, mus], 1)[:len(amb)]
    mix = amb[:int(total * SR)].copy(); m = mus[:len(mix)]; mix[:len(m)] += m * 0.85
    fo = int(1.6 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None]
    mix.astype(np.float32).tofile(out + '.a.f32')
    subprocess.run([FF, '-v', 'error', '-y', '-i', out + '.v.mp4', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', out + '.a.f32',
                    '-af', 'loudnorm=I=-15:TP=-2,aresample=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
                    '-movflags', '+faststart', '-shortest', out], check=True)
    os.remove(out + '.v.mp4'); os.remove(out + '.a.f32')
    print(f'{out}: {total:.1f}s, {len(shots)} shots, {bpm:.0f} bpm')

if __name__ == '__main__':
    main()
