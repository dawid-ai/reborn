"""Storyboard renderer: turns a storyboard JSON (+ WAV, + optional RE:BORN project) into an MP4.

    python -m mvkit.engine storyboards/psych-drop.json -o out.mp4 [--start 12.8 --end 64] [--size 1920x1080]
    python -m mvkit.engine storyboards/psych-drop.json --stills 26,80,140 --size 960x540   # PNG stills

See README.md for the storyboard format.
"""
import json, math, os, re, subprocess, sys, time, argparse, random
import numpy as np
from collections import OrderedDict

from . import analyze as an
from .reborn_cues import build_cues, load as load_project

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOOK_DIR = os.path.join(HERE, 'looks')
POST_DIR = os.path.join(HERE, 'post')
FONT_DIR = os.path.join(HERE, 'fonts')
GLSL_HEADER = '#version 330\n'          # WebGL2 port: '#version 300 es\nprecision highp float;\n'


# ----------------------------------------------------------------------------- look library
def parse_look(path):
    src = open(path, encoding='utf-8').read()
    meta = dict(name=os.path.splitext(os.path.basename(path))[0], params=OrderedDict(), code=src, path=path)
    for line in src.splitlines():
        m = re.match(r'//\s*@(\w+)\s+(.*)', line)
        if not m:
            continue
        key, rest = m.group(1), m.group(2).strip()
        if key == 'param':
            parts = rest.split(None, 2)
            default = [float(v) for v in parts[1].split(',')]
            meta['params'][parts[0]] = dict(default=default, desc=parts[2].strip() if len(parts) > 2 else '')
        elif key == 'look':
            meta['name'] = rest
        else:
            meta[key] = rest
    return meta


def load_library():
    lib = OrderedDict()
    for f in sorted(os.listdir(LOOK_DIR)):
        if f.endswith('.glsl') and not f.startswith('_'):
            lk = parse_look(os.path.join(LOOK_DIR, f))
            lib[lk['name']] = lk
    return lib


GLSL_T = {1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4'}


def build_scene_source(looks):
    out = [GLSL_HEADER, 'in vec2 vUv;\nout vec4 frag;\n', open(os.path.join(LOOK_DIR, '_common.glsl')).read()]
    for i, lk in enumerate(looks):
        out.append(f'\n// ===== look {i}: {lk["name"]}')
        for p, d in lk['params'].items():
            out.append(f'uniform {GLSL_T[len(d["default"])]} L{i}_{p};\n#define P_{p} L{i}_{p}')
        out.append(f'#define look look_{i}')
        out.append(lk['code'])
        out.append('#undef look')
        out += [f'#undef P_{p}' for p in lk['params']]
    out.append('uniform int uLook, uLookB, uLay0, uLay1, uLay2;\nuniform float uMix, uLayAmt0, uLayAmt1, uLayAmt2;')
    out.append('vec3 runLook(int id, vec2 uv){')
    for i in range(len(looks)):
        out.append(f'  if(id=={i}) return look_{i}(uv);')
    out.append('  return vec3(0.);\n}')
    out.append('''void main(){
  vec2 uv = (vUv*2.-1.)*vec2(uRes.x/uRes.y,1.);
  vec3 c = runLook(uLook, uv);
  if(uMix>0.) c = mix(c, runLook(uLookB, uv), uMix);
  if(uLay0>=0) c += runLook(uLay0, uv)*uLayAmt0;
  if(uLay1>=0) c += runLook(uLay1, uv)*uLayAmt1;
  if(uLay2>=0) c += runLook(uLay2, uv)*uLayAmt2;
  frag = vec4(max(c,0.),1.);
}''')
    return '\n'.join(out)


# ----------------------------------------------------------------------------- expressions
def _clamp(v, a=0.0, b=1.0): return min(max(v, a), b)
def _smooth(a, b, v):
    x = _clamp((v - a) / (b - a)); return x * x * (3 - 2 * x)

EXPR_FUNCS = dict(sin=math.sin, cos=math.cos, tan=math.tan, exp=math.exp, log=math.log, sqrt=math.sqrt, abs=abs, min=min,
                  max=max, floor=math.floor, pi=math.pi, clamp=_clamp, smooth=_smooth, mix=lambda a, b, k: a + (b - a) * k,
                  fract=lambda v: v - math.floor(v), step=lambda e, v: 1.0 if v >= e else 0.0, pow=pow, round=round)


class Val:
    """A param value: number, vector, or expression string(s) evaluated per frame."""
    def __init__(self, v):
        self.v = v
        if isinstance(v, str):
            self.c = compile(v, v, 'eval')
        elif isinstance(v, list) and any(isinstance(x, str) for x in v):
            self.c = [compile(x, x, 'eval') if isinstance(x, str) else x for x in v]
        else:
            self.c = None

    def __call__(self, ctx):
        if self.c is None:
            return self.v
        if isinstance(self.c, list):
            return [eval(x, EXPR_FUNCS, ctx) if not isinstance(x, (int, float)) else x for x in self.c]
        return eval(self.c, EXPR_FUNCS, ctx)


# ----------------------------------------------------------------------------- hooks (CPU helpers per look)
_GX, _GY = np.meshgrid(np.linspace(-1, 1, 64) * (16 / 9), np.linspace(-1, 1, 36))


def hook_julia(params, ctx, state):
    """Keep a zooming Julia set evenly bright: offset = 15th percentile escape count of the view, smoothed."""
    a = params['cAngle'][0]
    c = 0.7885 * complex(math.cos(a), math.sin(a))
    cen = complex(*params['center'][:2]); zoom = params['zoom'][0]; ra = params['rot'][0]; it = int(params['iters'][0])
    z = cen + complex(math.cos(ra), math.sin(ra)) * (_GX + 1j * _GY) * zoom
    n = np.zeros(z.shape); alive = np.ones(z.shape, bool)
    for _ in range(it):
        z[alive] = z[alive] ** 2 + c
        alive &= np.abs(z) < 32
        n[alive] += 1
        if not alive.any():
            break
    esc = n[~alive]
    o = max(float(np.percentile(esc, 15)) - 4.0, 0.0) if len(esc) > 20 else 0.0
    state['off'] = o if 'off' not in state else state['off'] + (o - state['off']) * 0.25
    if params.get('_autoOff', True):
        params['off'] = [state['off']]


HOOKS = {'julia-drift': hook_julia}


# ----------------------------------------------------------------------------- text
class TextLayer:
    def __init__(self, items, W, H, fps, sec, pulses_at, beat):
        from PIL import ImageFont
        self.items = items; self.W, self.H = W, H; self.sec = sec; self.pulses_at = pulses_at; self.beat = beat
        self.fonts = {}; self.cache = {}
        self.ImageFont = ImageFont

    def font(self, name, size):
        key = (name, size)
        if key not in self.fonts:
            path = name if os.path.exists(name) else None
            for ext in ('.ttf', '.otf'):
                p = os.path.join(FONT_DIR, name + ext)
                if not path and os.path.exists(p):
                    path = p
            self.fonts[key] = self.ImageFont.truetype(path or os.path.join(FONT_DIR, 'BigShoulders-Black.ttf'), size)
        return self.fonts[key]

    def bitmap(self, text, it):
        from PIL import Image, ImageDraw
        s = self.H / 1080
        size = max(8, int(it.get('size', 160) * s))
        key = (text, it.get('font', 'BigShoulders-Black'), size, it.get('tracking', 0), it.get('stroke', 0), str(it.get('color')), str(it.get('strokeColor')))
        if key in self.cache:
            return self.cache[key]
        f = self.font(key[1], size)
        trk = it.get('tracking', 0) * size
        stroke = int(it.get('stroke', 0) * s)
        lines = text.split('\n')
        def lw(line):
            return sum(f.getlength(ch) for ch in line) + trk * max(len(line) - 1, 0)
        asc, desc = f.getmetrics()
        lh = int((asc + desc) * it.get('leading', 1.0))
        w = int(max(lw(l) for l in lines)) + 2 * stroke + 4
        h = lh * len(lines) + 2 * stroke + 4
        img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        col = tuple(int(c * 255) for c in it.get('color', [1, 1, 1])) + (255,)
        scol = tuple(int(c * 255) for c in it.get('strokeColor', [0, 0, 0])) + (255,)
        for li, line in enumerate(lines):
            x = stroke + 2 + (w - 4 - 2 * stroke - lw(line)) * {'left': 0, 'center': .5, 'right': 1}[it.get('align', 'center')]
            for ch in line:
                d.text((x, stroke + 2 + li * lh), ch, font=f, fill=col, stroke_width=stroke, stroke_fill=scol)
                x += f.getlength(ch) + trk
        self.cache[key] = img
        return img

    def frame(self, t, ctx):
        """Return (RGBA PIL image or None, ca, glitch, blend)."""
        from PIL import Image
        active = [it for it in self.items if it['_t0'] <= t < it['_t1']]
        if not active:
            return None, 0, 0, 0
        canvas = Image.new('RGBA', (self.W, self.H), (0, 0, 0, 0))
        ca = glitch = blend = 0.0
        for it in active:
            L = t - it['_t0']; rem = it['_t1'] - t
            style = it.get('style', 'hold')
            text = it['text']; alpha = 1.0; scale = 1.0; dx = dy = 0.0
            if style == 'words':
                words = [w for w in re.split(r'\s*\|\s*|\s+', text) if w] if '|' not in text else [w.strip() for w in text.split('|')]
                on = it.get('on', 'beat')
                allev = sorted(set(round(float(e), 5) for ch in (on if isinstance(on, list) else [on]) for e in self.pulses_at(ch)))
                ev = [e for e in allev if it['_t0'] - 1e-6 <= e < it['_t1']]
                k = sum(1 for e in ev if e <= t + 1e-6) - 1
                if k < 0:
                    continue
                text = words[k % len(words)] if it.get('loop', True) else words[min(k, len(words) - 1)]
                since = t - ev[k]
                scale = 1 + it.get('pop', 0.25) * math.exp(-since * 18)
            elif style == 'type':
                step = it.get('every', self.beat / 4)
                n = int(L / step) + 1
                text = text[:n] + ('_' if n < len(text) and int(L / (self.beat / 2)) % 2 == 0 else '')
            elif style == 'slam':
                scale = 1 + it.get('pop', 0.6) * math.exp(-L * 22)
            elif style == 'flicker':
                alpha = 1.0 if (ctx['hat'] > 0.35 or random.Random(int(t * 30)).random() > 0.35) else 0.15
            elif style == 'scroll':
                dx = (it.get('speed', -0.15)) * L
            fi, fo = it.get('fadeIn', 0), it.get('fadeOut', 0)
            if fi > 0: alpha *= min(1, L / fi)
            if fo > 0: alpha *= min(1, rem / fo)
            if it.get('pulse'):
                scale *= 1 + it['pulse'] * ctx['kick']
            if not text:
                continue
            bm = self.bitmap(text, it)
            if abs(scale - 1) > 0.01:
                bm = bm.resize((max(1, int(bm.width * scale)), max(1, int(bm.height * scale))))
            if alpha < 0.999:
                a = bm.getchannel('A').point(lambda v: int(v * alpha))
                bm = bm.copy(); bm.putalpha(a)
            px, py = it.get('pos', [0.5, 0.5])
            x = int((px + dx) * self.W - bm.width / 2); y = int(py * self.H - bm.height / 2)
            cx0, cy0 = max(0, -x), max(0, -y)
            if cx0 < bm.width and cy0 < bm.height and x < self.W and y < self.H:
                canvas.alpha_composite(bm.crop((cx0, cy0, bm.width, bm.height)), (max(x, 0), max(y, 0)))
            ca = max(ca, it.get('ca', 0.002) + it.get('caKick', 0.01) * ctx['kick'] + (0.02 * math.exp(-L * 10) if style == 'slam' else 0))
            glitch = max(glitch, it.get('glitch', 0) * max(ctx['snare'], math.exp(-L * 8) if style == 'slam' else 0))
            blend = max(blend, 1.0 if it.get('blend') == 'difference' else 0.0)
        return canvas, ca, glitch, blend


# ----------------------------------------------------------------------------- footage
class FootagePlayer:
    def __init__(self, cache_dir, W, H, fps):
        self.dir = cache_dir; self.W, self.H, self.fps = W, H, fps
        self.key = None; self.proc = None; self.last = None
        self.dur = {}

    def duration(self, cid):
        if cid not in self.dur:
            p = os.path.join(self.dir, f'{cid}.mp4')
            r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True)
            self.dur[cid] = float(r.stdout.strip() or 0)
        return self.dur[cid]

    def frame(self, cid, start, speed=1.0):
        key = (cid, round(start, 3), speed)
        if key != self.key:
            if self.proc:
                self.proc.kill(); self.proc.wait()
            p = os.path.join(self.dir, f'{cid}.mp4')
            vf = f'setpts=PTS/{speed},fps={self.fps},scale={self.W}:{self.H}' if speed != 1 else f'scale={self.W}:{self.H}'
            self.proc = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-ss', f'{start:.3f}', '-stream_loop', '-1', '-i', p,
                                          '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL)
            self.key = key
        need = self.W * self.H * 3
        buf = self.proc.stdout.read(need)
        if len(buf) == need:
            self.last = buf
        return self.last or bytes(need)


# ----------------------------------------------------------------------------- storyboard
class Storyboard:
    def __init__(self, path, W=1920, H=1080, audio=None, project=None):
        self.path = path; self.dir = os.path.dirname(os.path.abspath(path))
        sb = json.load(open(path, encoding='utf-8'))
        if audio: sb['audio'] = os.path.abspath(audio)
        if project: sb['project'] = os.path.abspath(project)
        self.sb = sb; self.W, self.H = W, H
        self.fps = sb.get('fps', 30)
        rel = lambda p: p if os.path.isabs(p) else os.path.join(self.dir, p)
        self.audio = rel(sb['audio'])
        self.sr, self.mono = an.load_wav(self.audio)
        self.peak = float(np.percentile(np.abs(self.mono), 99.9))
        self.duration = len(self.mono) / self.sr
        self.nframes = int(math.ceil(self.duration * self.fps))
        cache = os.path.splitext(self.audio)[0] + f'.mvfeat{self.fps}.npz'
        try:
            self.feat = an.analyze(self.audio, self.fps, cache)
        except OSError:
            self.feat = an.analyze(self.audio, self.fps, None)
        self.cues = build_cues(load_project(rel(sb['project']))) if sb.get('project') else None
        self.tempo = self.cues['tempo'] if self.cues else sb.get('tempo', 120)
        self.beat = 60 / self.tempo
        self.barSec = self.cues['barSec'] if self.cues else self.beat * 4
        self.sections = self.cues['sections'] if self.cues else sb.get('sections', [])
        self.lib = load_library()
        self._channels()
        self._scenes()
        self._text()
        self.footage_dir = rel(sb.get('footageDir', 'footage'))

    # time spec -> seconds
    def T(self, spec):
        if isinstance(spec, (int, float)):
            return float(spec)
        s = str(spec)
        m = re.match(r'bar:([\d.]+)$', s)
        if m:
            return float(m.group(1)) * self.barSec
        m = re.match(r'(.+?)(@end)?([+-][\d.]+(?:bars?|beats?|s)?)?$', s)
        name, at_end, off = m.group(1), m.group(2), m.group(3)
        sec = next((x for x in self.sections if x['name'].lower() == name.strip().lower()), None)
        if sec is None:
            raise ValueError(f'unknown time / section: {spec}')
        t = sec['end'] if at_end else sec['start']
        if off:
            mm = re.match(r'([+-][\d.]+)(bars?|beats?|s)?', off)
            v = float(mm.group(1)); u = mm.group(2) or 's'
            t += v * (self.barSec if u.startswith('bar') else self.beat if u.startswith('beat') else 1)
        return t

    def _channels(self):
        """Pulse channels (kick / snare / hat ...) from exact project hits, or a grid fallback."""
        cfg = {'kick': {'lanes': ['/kick'], 'decay': 7}, 'snare': {'lanes': ['/snare', '/clap'], 'decay': 8},
               'hat': {'lanes': ['/closedHat', '/openHat'], 'decay': 20}}
        for k, v in self.sb.get('pulses', {}).items():
            cfg.setdefault(k, {}).update(v)
        self.chan = {}
        for name, c in cfg.items():
            ts = []
            if self.cues:
                for lane, hits in self.cues['hits'].items():
                    if any(lane.endswith(x) or lane == x for x in c['lanes']):
                        ts += [h['t'] for h in hits]
            self.chan[name] = dict(t=np.array(sorted(set(round(x, 5) for x in ts))), decay=c.get('decay', 8))
        n = int(self.duration / self.beat) + 2
        self.chan['beat'] = dict(t=np.arange(n) * self.beat, decay=9)
        self.chan['half'] = dict(t=np.arange(n // 2) * self.beat * 2, decay=6)
        self.chan['bar'] = dict(t=np.arange(int(self.duration / self.barSec) + 2) * self.barSec, decay=4)
        self.chan['2bar'] = dict(t=np.arange(int(self.duration / self.barSec / 2) + 2) * self.barSec * 2, decay=3)
        self.chan['8th'] = dict(t=np.arange(n * 2) * self.beat / 2, decay=14)
        imp = (self.cues['impacts'] if self.cues else []) + [self.T(x) for x in self.sb.get('impacts', [])]
        self.impacts = np.array(sorted(set(imp)))
        self.chan['impact'] = dict(t=self.impacts, decay=4)
        self.risers = [tuple(r) for r in (self.cues['risers'] if self.cues else [])] + [(self.T(a), self.T(b)) for a, b in self.sb.get('risers', [])]

    def events(self, name):
        return self.chan[name]['t'] if name in self.chan else np.array([])

    def pulse(self, name, t):
        c = self.chan.get(name)
        if c is None or len(c['t']) == 0:
            return 0.0, 99.0
        i = np.searchsorted(c['t'], t + 1e-6) - 1
        if i < 0:
            return 0.0, 99.0
        dt = t - c['t'][i]
        return math.exp(-dt * c['decay']), dt

    def _scenes(self):
        sc = self.sb['scenes']
        self.scenes = []
        for i, s in enumerate(sc):
            t0 = self.T(s['from'])
            t1 = self.T(s['to']) if 'to' in s else (self.T(sc[i + 1]['from']) if i + 1 < len(sc) else self.duration + 1)
            look = self.lib[s['look']]
            params = {p: Val(s.get('params', {}).get(p, d['default'] if len(d['default']) > 1 else d['default'][0]))
                      for p, d in look['params'].items()}
            layers = []
            for L in s.get('layers', [])[:3]:
                lk = self.lib[L['look']]
                layers.append(dict(look=L['look'], amount=Val(L.get('amount', 1.0)),
                                   params={p: Val(L.get('params', {}).get(p, d['default'] if len(d['default']) > 1 else d['default'][0]))
                                           for p, d in lk['params'].items()}))
            post = {k: Val(v) for k, v in s.get('post', {}).items()}
            cut_ev = []
            for c in s.get('cutOn', []):
                cut_ev += list(self.events(c)) if isinstance(c, str) else list(np.arange(t0, t1, float(c)))
            cut_ev = np.array(sorted(x for x in set(np.round(cut_ev, 5)) if t0 + 1e-4 < x < t1))
            self.scenes.append(dict(i=i, t0=t0, t1=t1, look=s['look'], params=params, layers=layers, post=post,
                                    travel=s.get('travel', {}), cuts=cut_ev, clips=s.get('clips', []), clipOrder=s.get('clipOrder', 'cycle'),
                                    clipSpeed=s.get('clipSpeed', 1.0), clipStart=s.get('clipStart', 'random'), xfade=s.get('xfade', 0),
                                    name=s.get('name', s['look']), state={}, layer_state=[{} for _ in layers]))
        self.used_looks = list(OrderedDict.fromkeys([s['look'] for s in self.scenes] + [L['look'] for s in self.scenes for L in s['layers']]))
        self.fade = Val(self.sb.get('fade', 1.0))
        # integrate camera travel
        self.push = np.zeros(self.nframes + 2)
        acc = 0.0
        for fi in range(self.nframes + 2):
            t = fi / self.fps
            s = self.scene_at(t)
            tr = s['travel'] if s else {}
            k, _ = self.pulse('kick', t); sn, _ = self.pulse('snare', t)
            acc += (tr.get('base', 0.3) + tr.get('kick', 0) * k + tr.get('snare', 0) * sn + tr.get('bass', 0) * self.f('bass', fi)) / self.fps
            self.push[fi] = acc

    def _text(self):
        self.text_items = []
        for it in self.sb.get('text', []):
            it = dict(it)
            it['_t0'] = self.T(it['at'])
            it['_t1'] = self.T(it['until']) if 'until' in it else it['_t0'] + it.get('dur', 2.0)
            self.text_items.append(it)

    def f(self, k, fi):
        a = self.feat.get(k)
        return float(a[min(fi, len(a) - 1)]) if a is not None else 0.0

    def scene_at(self, t):
        cur = None
        for s in self.scenes:
            if s['t0'] <= t < s['t1']:
                cur = s
        return cur

    def ctx(self, fi, scene):
        t = fi / self.fps
        k, kt = self.pulse('kick', t); sn, st = self.pulse('snare', t); h, _ = self.pulse('hat', t)
        rise = 0.0; rstrobe = 1.0
        for a, b in self.risers:
            if a <= t < b:
                rise = (t - a) / (b - a)
                sub = self.beat if rise < .5 else self.beat / 2 if rise < .75 else self.beat / 4
                rstrobe = (1 - 0.65 * rise) + 0.9 * rise * math.exp(-((t - a) % sub) * 18)
        nxt = self.impacts[self.impacts > t + 1e-6]
        prv = self.impacts[self.impacts <= t + 1e-6]
        c = dict(t=t, beat=t / self.beat, bar=t / self.barSec, kick=k, kt=kt, snare=sn, st=st, hat=h, rise=rise, rstrobe=rstrobe,
                 toImpact=float(nxt[0] - t) if len(nxt) else 99.0, sinceImpact=float(t - prv[-1]) if len(prv) else 99.0,
                 BEAT=self.beat, BAR=self.barSec)
        for b in ('sub', 'bass', 'mid', 'harsh', 'air', 'rms'):
            c[b] = self.f(b, fi)
        c['hatEnv'] = self.f('hat', fi)
        if scene:
            L = t - scene['t0']; ln = scene['t1'] - scene['t0']
            ci = int(np.searchsorted(scene['cuts'], t + 1e-6))
            c.update(L=L, len=ln, x=min(L / ln, 1.0), cut=ci, cutT=(t - scene['cuts'][ci - 1]) if ci > 0 else L)
        return c


# ----------------------------------------------------------------------------- GL renderer
class Renderer:
    def __init__(self, story: Storyboard, W, H, looks=None):
        import moderngl
        self.mgl = moderngl
        self.s = story; self.W, self.H = W, H
        names = looks or story.used_looks
        self.looks = [story.lib[n] for n in names]
        self.index = {lk['name']: i for i, lk in enumerate(self.looks)}
        try:
            ctx = moderngl.create_standalone_context()           # Windows / macOS / Linux with a display: uses the GPU
        except Exception:
            ctx = moderngl.create_standalone_context(backend='egl')   # headless Linux (cloud container)
        self.ctx = ctx
        vs = GLSL_HEADER + 'in vec2 pos; out vec2 vUv; void main(){ vUv = pos*.5+.5; gl_Position = vec4(pos,0,1); }'
        self.scene_src = build_scene_source(self.looks)
        try:
            self.p_scene = ctx.program(vertex_shader=vs, fragment_shader=self.scene_src)
        except Exception as e:
            open('/tmp/scene_failed.glsl', 'w').write(self.scene_src)
            raise
        self.p_fb = ctx.program(vertex_shader=vs, fragment_shader=GLSL_HEADER + open(os.path.join(POST_DIR, 'feedback.glsl')).read())
        self.p_post = ctx.program(vertex_shader=vs, fragment_shader=GLSL_HEADER + open(os.path.join(POST_DIR, 'post.glsl')).read())
        quad = ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype='f4'))
        self.v_scene = ctx.simple_vertex_array(self.p_scene, quad, 'pos')
        self.v_fb = ctx.simple_vertex_array(self.p_fb, quad, 'pos')
        self.v_post = ctx.simple_vertex_array(self.p_post, quad, 'pos')

        def tex(mip=False):
            t = ctx.texture((W, H), 4, dtype='f2'); t.repeat_x = t.repeat_y = False
            t.filter = (moderngl.LINEAR_MIPMAP_LINEAR if mip else moderngl.LINEAR, moderngl.LINEAR)
            return t
        self.t_scene = tex(); self.f_scene = ctx.framebuffer([self.t_scene])
        self.t_fb = [tex(True), tex(True)]; self.f_fb = [ctx.framebuffer([t]) for t in self.t_fb]
        self.out = ctx.framebuffer([ctx.renderbuffer((W, H), 4)])
        self.t_wave = ctx.texture((512, 2), 1, dtype='f4'); self.t_wave.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.t_foot = ctx.texture((W, H), 3); self.t_foot.repeat_x = self.t_foot.repeat_y = False
        self.t_foot.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.t_text = ctx.texture((W, H), 4); self.t_text.repeat_x = self.t_text.repeat_y = False
        for f in self.f_fb:
            f.use(); ctx.clear(0, 0, 0, 1)
        self.cur = 0
        self.footage = FootagePlayer(story.footage_dir, W, H, story.fps)
        self.text = TextLayer(story.text_items, W, H, story.fps, story.sections, story.events, story.beat)
        self.prev_scene = None
        for li in range(3):
            self._set(self.p_scene, f'uLay{li}', -1)

    def _set(self, prog, name, val):
        if name in prog:
            prog[name].value = val

    def _set_params(self, idx, look, values):
        for p, d in look['params'].items():
            v = values.get(p, d['default'])
            if not isinstance(v, (list, tuple)):
                v = [v]
            v = [float(x) for x in v]
            self._set(self.p_scene, f'L{idx}_{p}', v[0] if len(v) == 1 else tuple(v))

    def _resolve(self, params, c):
        out = {}
        for p, val in params.items():
            v = val(c)
            out[p] = v if isinstance(v, list) else [v]
        return out

    def _clip_for(self, scene, c):
        clips = scene['clips']
        if not clips:
            return None
        k = c['cut']
        if scene['clipOrder'] == 'shuffle':
            idx = random.Random(scene['i'] * 1000 + k).randrange(len(clips))
        else:
            idx = k % len(clips)
        cid = clips[idx]
        dur = self.footage.duration(cid)
        skip = float(self.s.sb.get('footage', {}).get(cid, {}).get('skip', 0))   # unusable lead-in (title cards...)
        if scene['clipStart'] == 'random':
            start = random.Random(scene['i'] * 7919 + k).uniform(skip, max(skip, dur - 4.0))
        else:
            start = float(scene['clipStart'])
        cut_t = scene['t0'] if k == 0 else float(scene['cuts'][k - 1])
        # the reader streams forward from `start`; seeking is only done on a cut
        return cid, start, cut_t

    def render(self, fi):
        s = self.s; t = fi / s.fps
        scene = s.scene_at(t)
        c = s.ctx(fi, scene)
        ps = self.p_scene
        # audio textures / uniforms
        self.t_wave.write(an.wave_rows(s.mono, s.sr, t, s.peak).tobytes())
        self.t_wave.use(0); self._set(ps, 'uWave', 0)
        uni = dict(uT=t, uL=c.get('L', 0), uLen=c.get('len', 1), uX=c.get('x', 0), uBeat=c['beat'], uBar=c['bar'],
                   uSub=c['sub'], uBass=c['bass'], uMid=c['mid'], uAir=c['air'], uRms=c['rms'], uHat=c['hatEnv'],
                   uKick=c['kick'], uSnare=c['snare'], uHatP=c['hat'], uKT=c['kt'], uCutT=c.get('cutT', 0), uRise=c['rise'],
                   uPush=float(s.push[fi]), uFootAsp=self.W / self.H)
        for k, v in uni.items():
            self._set(ps, k, float(v))
        self._set(ps, 'uCut', int(c.get('cut', 0)))
        self._set(ps, 'uRes', (float(self.W), float(self.H)))
        # footage
        if scene and scene['clips']:
            cid, start, cut_t = self._clip_for(scene, c)
            self.t_foot.write(self.footage.frame(cid, start, scene['clipSpeed']))
        self.t_foot.use(1); self._set(ps, 'uFootage', 1)
        # looks
        look_id = -1; mix = 0.0; look_b = -1
        if scene:
            vals = self._resolve(scene['params'], c)
            if scene['look'] in HOOKS:
                HOOKS[scene['look']](vals, c, scene['state'])
            look_id = self.index[scene['look']]
            self._set_params(look_id, self.looks[look_id], vals)
            if scene['xfade'] > 0 and c['L'] < scene['xfade'] and scene['i'] > 0:
                prev = s.scenes[scene['i'] - 1]
                if prev['look'] != scene['look']:
                    pc = dict(c); pc.update(L=t - prev['t0'], len=prev['t1'] - prev['t0'], x=1.0)
                    pv = self._resolve(prev['params'], pc)
                    if prev['look'] in HOOKS:
                        HOOKS[prev['look']](pv, pc, prev['state'])
                    look_b = self.index[prev['look']]
                    self._set_params(look_b, self.looks[look_b], pv)
                    mix = 1 - c['L'] / scene['xfade']
            for li in range(3):
                if li < len(scene['layers']):
                    L = scene['layers'][li]
                    lv = self._resolve(L['params'], c)
                    lid = self.index[L['look']]
                    self._set_params(lid, self.looks[lid], lv)
                    self._set(ps, f'uLay{li}', lid); self._set(ps, f'uLayAmt{li}', float(L['amount'](c)))
                else:
                    self._set(ps, f'uLay{li}', -1)
        self._set(ps, 'uLook', look_id); self._set(ps, 'uLookB', look_b); self._set(ps, 'uMix', mix)
        self.f_scene.use()
        self.v_scene.render(self.mgl.TRIANGLE_STRIP)

        # post values
        P = dict(ca=0.002, bloom=0.5, fb=0.0, fbZoom=1.0, fbRot=0.0, fbHue=0.0, grain=0.03, vig=1.0, strobe=1.0, white=0.0, shake=0.0)
        if scene:
            for k, v in scene['post'].items():
                P[k] = float(v(c))
        imp = s.sb.get('impact', {})
        si = c['sinceImpact']
        P['flash'] = imp.get('flash', 1.2) * math.exp(-si * 14)
        P['ca'] += imp.get('ca', 0.02) * math.exp(-si * 4)
        shake = P['shake'] + imp.get('shake', 0.02) * math.exp(-si * 3)
        if scene and c['L'] < 1.0 / s.fps * 1.5 and scene['xfade'] == 0:
            P['fb'] = 0.0                                        # hard cut: no trails from the old scene
        rng = np.random.default_rng(fi)
        sh = rng.normal(0, 1, 2) * shake
        fade = float(s.fade(c))

        nxt = 1 - self.cur
        self.f_fb[nxt].use()
        self.t_scene.use(0); self.t_fb[self.cur].use(1)
        pf = self.p_fb
        for k, v in dict(uScene=0, uPrev=1).items():
            self._set(pf, k, v)
        for k, v in dict(uFb=P['fb'], uFbZoom=P['fbZoom'], uFbRot=P['fbRot'], uFbHue=P['fbHue'], uAsp=self.W / self.H).items():
            self._set(pf, k, float(v))
        self.v_fb.render(self.mgl.TRIANGLE_STRIP)
        self.t_fb[nxt].build_mipmaps()
        self.cur = nxt

        # text
        img, tca, tgl, tbl = self.text.frame(t, c)
        if img is not None:
            self.t_text.write(img.tobytes())
        pp = self.p_post
        self.out.use()
        self.t_fb[self.cur].use(0); self.t_text.use(2)
        self._set(pp, 'uImg', 0); self._set(pp, 'uText', 2)
        for k, v in dict(uCA=P['ca'], uBloom=P['bloom'], uGrain=P['grain'], uFlash=P['flash'], uFade=fade, uStrobe=P['strobe'],
                         uWhite=P['white'], uVig=P['vig'], uT=t, uTextCA=tca, uTextGlitch=tgl, uTextOn=1.0 if img is not None else 0.0,
                         uTextBlend=tbl).items():
            self._set(pp, k, float(v))
        self._set(pp, 'uShake', (float(sh[0]), float(sh[1])))
        self._set(pp, 'uRes', (float(self.W), float(self.H)))
        self.v_post.render(self.mgl.TRIANGLE_STRIP)
        return self.out.read(components=3)

    def still(self, t, path, warm=20):
        from PIL import Image
        f0 = int(round(t * self.s.fps))
        for fi in range(max(0, f0 - warm), f0 + 1):
            data = self.render(fi)
        Image.frombytes('RGB', (self.W, self.H), data).transpose(Image.FLIP_TOP_BOTTOM).save(path)


def render_video(story, out, W, H, start=0.0, end=None, bitrate='14M'):
    r = Renderer(story, W, H)
    f0 = int(round(start * story.fps)); f1 = story.nframes if end is None else int(round(end * story.fps))
    for fi in range(max(0, f0 - 15), f0):
        r.render(fi)
    cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(story.fps), '-i', '-',
           '-ss', f'{f0 / story.fps:.4f}', '-t', f'{(f1 - f0) / story.fps:.4f}', '-i', story.audio,
           '-map', '0:v', '-map', '1:a', '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
           '-maxrate', bitrate, '-bufsize', '30M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', out]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    for fi in range(f0, f1):
        ff.stdin.write(r.render(fi))
        if (fi - f0) % 150 == 0:
            done = fi - f0 + 1; fps = done / (time.time() - t0 + 1e-9)
            print(f'frame {fi}/{f1}  {fps:.2f} fps  eta {(f1 - fi) / max(fps, 1e-3) / 60:.1f} min', flush=True)
    ff.stdin.close(); ff.wait()
    print('done', round(time.time() - t0), 's', out, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('storyboard')
    ap.add_argument('-o', '--out', default=None)
    ap.add_argument('--size', default='1920x1080')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--end', type=float, default=None)
    ap.add_argument('--stills', default='')
    ap.add_argument('--stills-dir', default='stills')
    ap.add_argument('--audio', default=None, help='override the storyboard audio path')
    ap.add_argument('--project', default=None, help='override the RE:BORN project path (.reborn folder or project.json)')
    a = ap.parse_args()
    W, H = map(int, a.size.split('x'))
    st = Storyboard(a.storyboard, W, H, a.audio, a.project)
    if a.stills:
        os.makedirs(a.stills_dir, exist_ok=True)
        r = Renderer(st, W, H)
        for x in a.stills.split(','):
            t = st.T(x) if not re.match(r'^[\d.]+$', x) else float(x)
            p = os.path.join(a.stills_dir, f'{t:07.2f}.png'); r.still(t, p); print(p, flush=True)
        return
    start, end = a.start, a.end
    if 'range' in st.sb and not a.start and a.end is None:          # storyboard can limit itself to part of the song
        start, end = st.T(st.sb['range'][0]), st.T(st.sb['range'][1])
    render_video(st, a.out or os.path.splitext(a.storyboard)[0] + '.mp4', W, H, start, end)


if __name__ == '__main__':
    main()
