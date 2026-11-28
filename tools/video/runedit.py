#!/usr/bin/env python3
"""runedit: cut 30s / 90s highlight edits from a full-length runhud render.

Picks moments from the run data (start, steepest climb, summit, fastest descent, stairs, last stretch) plus evenly
spaced fillers, slides each one to the nearby stretch with the least sky in frame, cuts on the music's beats, adds
v5-style captions (orange kicker + white title, placed under the HUD) and mixes the music over a little live sound.

  python3 tools/video/runedit.py --hud full_hud.mp4 --run runs/<id>.json --offset <run s at hud t=0> \
      --music song.mp3 --length 30 --out edit_30s.mp4 [--captions caps.json] [--title "Kenneth Hahn"]

captions JSON (optional) overrides the automatic ones: {"start": {"kicker": "...", "title": "..."}, "climb": {...}, ...}
Needs pillow, numpy, ffmpeg; macOS fonts.
"""
import argparse, json, os, subprocess, tempfile, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FF = '/opt/homebrew/bin/ffmpeg' if os.path.exists('/opt/homebrew/bin/ffmpeg') else 'ffmpeg'
W, H = 1080, 1920
AV = '/System/Library/Fonts/Avenir Next.ttc'; HG = '/System/Library/Fonts/Hiragino Sans GB.ttc'
ACC = (236, 140, 98); WHITE = (255, 255, 255)
F = lambda p, s, i=0: ImageFont.truetype(p, s, index=i)
CAP_Y = 600


# ---------- music beats (spectral-flux onsets + autocorrelation tempo) ----------
def load_audio(path, sr=22050, ss=0, t=None):
    cmd = [FF, '-v', 'error', '-ss', str(ss)] + (['-t', str(t)] if t else []) + ['-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-']
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32)

def beats(path):
    sr, hop = 22050, 512; x = load_audio(path, sr)
    fr = np.lib.stride_tricks.sliding_window_view(x, 2048)[::hop]
    S = np.log1p(np.abs(np.fft.rfft(fr * np.hanning(2048), axis=1)))
    flux = np.maximum(np.diff(S, axis=0), 0).sum(1); flux = flux - np.convolve(flux, np.ones(16) / 16, 'same'); flux = np.maximum(flux, 0)
    fps = sr / hop; ac = np.correlate(flux, flux, 'full')[len(flux) - 1:]
    lags = np.arange(len(ac)); bpm = 60 * fps / np.maximum(lags, 1); m = (bpm > 80) & (bpm < 170)
    w = np.exp(-0.5 * (np.log2(bpm / 120) / 0.6) ** 2)     # prefer ~120 bpm
    lag = lags[m][np.argmax((ac * w)[m])]
    period = lag
    ph = max(range(int(period)), key=lambda p: flux[p::int(period)].sum() if int(period) else 0)
    # track: step one period at a time and snap to the strongest onset within +-20% of a period
    sf = np.convolve(flux, np.hanning(5), 'same'); out = [ph]; r = max(1, int(period * .2))
    while out[-1] + period + r < len(sf):
        g = int(out[-1] + period); w0 = g - r; j = w0 + int(np.argmax(sf[w0:g + r + 1]))
        out.append(j if sf[j] > np.median(sf) * 2 else g)
    b = (np.array(out) + 1) / fps + 1024 / sr      # flux[j] belongs to frame j+1; use the window centre
    return b, 60 * fps / period


# ---------- run moments ----------
def moments(run, offset, vdur):
    st = run['streams']; T = np.array(st['time'], float); A = np.array(st['alt'], float)
    V = np.array(st['vel'], float); G = np.array(st['grade'], float)
    sec = np.arange(0, int(T[-1]) + 1); al = np.interp(sec, T, A); sp = np.interp(sec, T, V); gr = np.interp(sec, T, G)
    sm = lambda x, k: np.convolve(x, np.ones(k) / k, 'same')
    lo, hi = int(max(0, offset)), int(min(sec[-1], offset + vdur))
    inside = lambda s: lo + 6 <= s <= hi - 8
    def pick(score):
        s = np.where([inside(i) for i in sec], score, -1e9); return int(np.argmax(s))
    out = {'start': lo + 4}
    g30 = sm(gr, 31); out['climb'] = pick(g30); climb_g = g30[out['climb']]
    out['summit'] = pick(al)
    dn = sm(sp, 15) * (sm(gr, 31) < -3); out['descent'] = pick(dn)
    if g30.min() < -15:
        s = pick(-g30)
        if -g30[s] > 15: out['stairs'] = s
    out['end'] = hi - 8
    info = dict(climb_g=round(float(climb_g)), summit_alt=round(float(al.max())), desc_v=float(sp[out['descent']]),
                km=lambda s: float(np.interp(s, T, st['dist'])) / 1000)
    return out, info


# ---------- per-second sky / shake score of the HUD render (lower part only) ----------
def shot_scores(hud):
    w, h = 54, 96
    raw = subprocess.run([FF, '-v', 'error', '-i', hud, '-vf', f'fps=2,scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    v = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(np.float32)[:, int(h * .34):]   # below the HUD
    r, g, b = v[..., 0], v[..., 1], v[..., 2]
    sky = ((b > r + 18) & (b > 120) | ((r + g + b) / 3 > 215)).mean((1, 2))
    shake = np.r_[0, np.abs(np.diff(v.mean(3), axis=0)).mean((1, 2))]
    n = len(sky) // 2
    sky = sky[:n * 2].reshape(n, 2).mean(1); shake = shake[:n * 2].reshape(n, 2).mean(1)
    return sky, shake

def best_start(want, dur, sky, shake, lo, hi, radius=25, used=()):
    best, bs = want, 1e9
    for s in range(max(lo, want - radius), min(hi - int(dur) - 1, want + radius) + 1):
        seg = slice(s, s + int(math.ceil(dur)) + 1)
        sc = sky[seg].mean() * 2 + shake[seg].mean() / 25 + abs(s - want) / 200
        if any(s < u1 + 2 and s + dur > u0 - 2 for u0, u1 in used): sc += 10
        if sc < bs: bs, best = sc, s
    return best


# ---------- captions (v5 style, under the HUD, soft local shade) ----------
def caption_png(c, path):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im); X = 72; y = CAP_Y
    if c.get('kicker'):
        d.rectangle([X, y + 14, X + 36, y + 18], fill=ACC); d.text((X + 52, y), c['kicker'], font=F(AV, 26, 2), fill=ACC); y += 54
    if c.get('title'): d.text((X, y), c['title'], font=F(HG, 68, 2), fill=WHITE)
    a = im.getchannel('A'); bb = a.getbbox(); glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    if bb:
        ImageDraw.Draw(glow).rounded_rectangle([bb[0] - 40, bb[1] - 30, bb[2] + 40, bb[3] + 30], radius=60, fill=(0, 0, 0, 95)); glow = glow.filter(ImageFilter.GaussianBlur(38))
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0)); sh.putalpha(a); sh = sh.filter(ImageFilter.GaussianBlur(8))
    Image.alpha_composite(Image.alpha_composite(glow, sh), im).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hud', required=True); ap.add_argument('--run', required=True); ap.add_argument('--offset', type=float, required=True)
    ap.add_argument('--music', required=True); ap.add_argument('--music-start', type=float, default=None, help='seconds into the song (default: first strong bar after 10%%)')
    ap.add_argument('--length', type=int, default=30); ap.add_argument('--out', required=True)
    ap.add_argument('--title'); ap.add_argument('--place', default=''); ap.add_argument('--captions'); ap.add_argument('--amb', type=float, default=0.18)
    a = ap.parse_args()
    run = json.load(open(a.run)); vdur = float(subprocess.check_output([FF.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.hud]))
    M, info = moments(run, a.offset, vdur)
    sky, shake = shot_scores(a.hud)
    b, bpm = beats(a.music); spb = 60 / bpm
    # shot length in beats: 30s -> 2 beats (fast), 90s -> 4 beats
    nb = 2 if a.length <= 45 else 4
    i0 = int(np.searchsorted(b, a.music_start if a.music_start is not None else b[-1] * 0.1)); i0 -= i0 % 4
    extra = (nb * 2 + max(nb * 2, 8 if a.length > 45 else 4) - 2 * nb) if a.length > 45 else (max(nb, 4) - nb)
    nshots = int((a.length / spb - extra) // nb)
    # moment order along the run + fillers spread evenly
    key = sorted(M.items(), key=lambda kv: kv[1])
    lo, hi = int(a.offset), int(a.offset + vdur)
    fill = list(np.linspace(lo + 20, hi - 20, max(0, nshots - len(key)) + 2)[1:-1].astype(int))
    allm = sorted([(s, k) for k, s in key] + [(int(s), None) for s in fill])
    allm = allm[:nshots] if len(allm) > nshots else allm
    title = (a.title or run.get('name', 'RUN')).upper()
    km = run.get('distance_km'); gain = run.get('elev_gain_m')
    caps = {
        'start': dict(kicker=f"{title}{' · ' + a.place if a.place else ''}", title='出发'),
        'climb': dict(kicker=f"CLIMB +{info['climb_g']}%", title='爬坡'),
        'summit': dict(kicker=f"{info['summit_alt']} M", title='最高点'),
        'descent': dict(kicker=f"{info['desc_v'] * 3.6:.1f} KM/H", title='冲下坡'),
        'stairs': dict(kicker='STAIRS', title='下台阶'),
        'end': dict(kicker=f"{km} KM · +{gain} M · {run.get('pace', '')}/KM", title='收工'),
    }
    if a.captions: caps.update(json.load(open(a.captions)))
    tmp = tempfile.mkdtemp(prefix='runedit_')
    segs, t_out, k, used = [], 0.0, i0, []
    for j, (s_run, kind) in enumerate(allm):
        n = nb * (2 if kind in ('start', 'end') and a.length > 45 else 1)
        if j == len(allm) - 1: n = max(n, 8 if a.length > 45 else 4)
        dur = float(b[min(k + n, len(b) - 1)] - b[k]); k += n
        vt = best_start(int(s_run - a.offset) - 1, dur, sky, shake, 0, int(vdur) - 1, used=used); used.append((vt, vt + dur))
        cap = caps.get(kind) if kind else None
        segs.append(dict(vt=vt, dur=dur, t=t_out, cap=cap, kind=kind)); t_out += dur
    total = t_out
    # ffmpeg graph
    args = [FF, '-v', 'error', '-y']; fc = []; vlabels = []
    for i, s in enumerate(segs):
        args += ['-ss', f"{s['vt']:.3f}", '-t', f"{s['dur'] + 0.1:.3f}", '-i', a.hud]
    ci = len(segs)
    for i, s in enumerate(segs):
        fc.append(f"[{i}:v]trim=0:{s['dur']:.4f},setpts=PTS-STARTPTS,fps=30000/1001,format=yuv420p[v{i}]"); vlabels.append(f'[v{i}]')
    fc.append(''.join(vlabels) + f'concat=n={len(segs)}:v=1:a=0[base]')
    last = 'base'
    for i, s in enumerate(segs):
        if not s['cap']: continue
        p = os.path.join(tmp, f'cap{i}.png'); caption_png(s['cap'], p)
        args += ['-loop', '1', '-t', f"{s['dur']:.3f}", '-i', p]
        t0 = s['t'] + 0.2; d = s['dur']
        fc.append(f"[{ci}:v]format=rgba,fade=t=in:st=0.2:d=0.4:alpha=1,fade=t=out:st={max(0.6, d - 0.45):.3f}:d=0.35:alpha=1,setpts=PTS-STARTPTS+{s['t']:.3f}/TB[c{i}]")
        fc.append(f"[{last}][c{i}]overlay=0:0:eof_action=pass[o{i}]"); last = f'o{i}'; ci += 1
    # audio: live sound from each segment (quiet) + music from beat i0
    for i, s in enumerate(segs):
        fc.append(f"[{i}:a]atrim=0:{s['dur']:.4f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={a.amb}[a{i}]")
    fc.append(''.join(f'[a{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=0:a=1[amb]')
    args += ['-ss', f'{b[i0]:.3f}', '-t', f'{total + 0.5:.3f}', '-i', a.music]
    fc.append(f"[{ci}:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st={total - 1.6:.3f}:d=1.6[mus]")
    fc.append(f"[mus][amb]amix=inputs=2:normalize=0,loudnorm=I=-15:TP=-2,aresample=48000,atrim=0:{total:.3f}[aout]")
    fc.append(f"[{last}]fade=t=out:st={total - 0.4:.3f}:d=0.4[vout]")
    args += ['-filter_complex', ';'.join(fc), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
             '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', f'{total:.3f}', a.out]
    subprocess.run(args, check=True)
    print(f'{a.out}: {total:.1f}s, {len(segs)} shots, {bpm:.0f} bpm, music from {b[i0]:.1f}s')
    for s in segs: print(f"  {s['t']:5.1f}s  hud {s['vt']:5d}s  {s['dur']:.2f}s  {s['kind'] or ''}  {(s['cap'] or {}).get('title', '')}")


if __name__ == '__main__':
    main()
