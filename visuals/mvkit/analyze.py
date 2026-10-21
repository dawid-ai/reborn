"""Per-video-frame audio envelopes from a WAV: band energies (sub/bass/mid/harsh/air), rms, and
spectral-flux onset envelopes (kick-ish low flux, hat-ish high flux). Values are normalised so the
98th percentile is 1.0 and smoothed with a fast-attack / slow-release follower.

Band edges match packages/analysis/src/bands.ts closely enough for visuals.
"""
import numpy as np, scipy.io.wavfile as wf, scipy.signal as ss, os

BANDS = {'sub': (20, 60), 'bass': (60, 250), 'mid': (250, 2000), 'harsh': (2000, 6000), 'air': (6000, 20000)}


def load_wav(path):
    sr, x = wf.read(path)
    if x.dtype.kind == 'i':
        x = x.astype(np.float32) / np.iinfo(x.dtype).max
    x = x.astype(np.float32)
    mono = x.mean(axis=1) if x.ndim == 2 else x
    return sr, mono


def _norm(v, p=98):
    return np.clip(v / (np.percentile(v, p) + 1e-9), 0, 1.5)


def _follow(v, att=0.6, rel=0.12):
    out = np.zeros_like(v); s = 0.0
    for i, a in enumerate(v):
        s += (a - s) * (att if a > s else rel)
        out[i] = s
    return out


def analyze(wav_path, fps=30, cache=None):
    if cache and os.path.exists(cache):
        d = np.load(cache)
        if int(d['fps']) == fps:
            return {k: d[k] for k in d.files}
    sr, mono = load_wav(wav_path)
    hop = sr / fps
    n_fft = 4096
    nframes = int(np.ceil(len(mono) / hop))
    pad = np.pad(mono, (n_fft // 2, n_fft * 2))
    win = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    masks = {k: (freqs >= lo) & (freqs < hi) for k, (lo, hi) in BANDS.items()}
    E = {k: np.zeros(nframes, np.float32) for k in BANDS}
    rms = np.zeros(nframes, np.float32); flo = np.zeros(nframes, np.float32); fhi = np.zeros(nframes, np.float32)
    lo_m = (freqs >= 30) & (freqs < 150); hi_m = freqs >= 2000
    prev = None
    for i in range(nframes):
        a = int(round(i * hop))
        seg = pad[a:a + n_fft]
        mag = np.abs(np.fft.rfft(seg * win))
        for k, m in masks.items():
            E[k][i] = np.sqrt((mag[m] ** 2).mean())
        rms[i] = np.sqrt((seg[n_fft // 4:3 * n_fft // 4] ** 2).mean())
        lm = np.log1p(mag * 10)
        if prev is not None:
            d = np.maximum(lm - prev, 0)
            flo[i] = d[lo_m].sum(); fhi[i] = d[hi_m].sum()
        prev = lm
    feat = {k: _follow(_norm(v)) for k, v in E.items()}
    feat['rms'] = _follow(_norm(rms))
    for name, f in (('lowOnset', flo), ('hat', fhi)):
        f = np.maximum(f - ss.medfilt(f, 9), 0)
        feat[name] = _follow(np.clip(_norm(f, 99), 0, 1), att=1.0, rel=0.25)
    feat['fps'] = np.array(fps); feat['nframes'] = np.array(nframes)
    if cache:
        np.savez(cache, **feat)
    return feat


def wave_rows(mono, sr, t, peak):
    """512-sample waveform window and 512-bin log spectrum at time t (for the uWave texture)."""
    c = int(t * sr)
    seg = mono[max(c - 512, 0): c + 512]
    seg = np.pad(seg, (0, 1024 - len(seg)))
    wv = np.clip(seg[::2] / (peak + 1e-9), -1.2, 1.2)
    sp = np.abs(np.fft.rfft(np.pad(seg, (0, 3072)) * np.hanning(4096)))
    fr = np.fft.rfftfreq(4096, 1 / sr)
    s = np.interp(np.geomspace(30, 16000, 512), fr, sp)
    s = np.clip((20 * np.log10(s + 1e-6) + 20) / 60, 0, 1)
    return np.stack([wv, s]).astype(np.float32)
