"""Turn a RE:BORN project (.reborn folder or project.json) into a timed cue sheet.

Mirrors packages/audio-engine/src/studio/schedule.ts (sourceEvents + swungPosition + chance)
so drum hits and notes land exactly where the engine plays them.

    python -m mvkit.reborn_cues "Psych Drop.reborn" -o cues.json
"""
import json, math, sys, argparse, os


def _imul(a, b):
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def chance(seed: str) -> float:
    """Port of schedule.ts chance(): deterministic 0..1 hash (FNV-1a + murmur finaliser)."""
    h = 2166136261
    b = seed.encode('utf-16-le')
    for i in range(0, len(b), 2):  # JS charCodeAt = UTF-16 code units
        h ^= b[i] | (b[i + 1] << 8)
        h = _imul(h, 16777619)
    h ^= h >> 13
    h = _imul(h, 0x5bd1e995)
    h ^= h >> 15
    return (h & 0xFFFFFFFF) / 4294967296


def swung(step_in_bar, division, swing):
    sb = 1 / division
    return step_in_bar * sb + (swing * sb if step_in_bar % 2 == 1 else 0)


def load(path):
    if os.path.isdir(path):
        path = os.path.join(path, 'project.json')
    d = json.load(open(path, encoding='utf-8'))
    return d.get('studio', d)


def pattern_events(project, clip, pattern):
    """Yield (bar, key, step, lengthBars) for every hit of a pattern clip, like sourceEvents()."""
    division = pattern.get('division') or 16
    swing = pattern['swing'] if pattern.get('swing') is not None else project.get('swing', 0)
    sb = 1 / division
    start, length, offset = clip['start'], clip['length'], clip.get('offset', 0)
    end = start + length
    last_local = math.ceil((length + offset) / sb) + 1
    out = []
    for local in range(0, last_local + 1):
        step = local % pattern['length']
        cycle = local // pattern['length']
        base = start - offset + local // division + swung(local % division, division, swing)

        def emit(hit, key, extra):
            if hit.get('probability', 100) < 100 and chance(f"{clip['id']}:{key}:{cycle}") * 100 >= hit['probability']:
                return
            count = max(1, min(4, round(hit.get('ratchet', 1))))
            sub = sb / count
            for r in range(count):
                bar = base + hit.get('micro', 0) * sb + r * sub
                if bar < start - 1e-9 or bar >= end - 1e-9:
                    continue
                out.append(dict(bar=bar, length=sub, velocity=hit.get('velocity', 100), accent=hit.get('accent', False), **extra))

        if pattern['kind'] == 'notes':
            s = pattern['steps'][step]
            if s and s.get('on'):
                nxt = pattern['steps'][(step + 1) % pattern['length']]
                slide = bool(s.get('slide') and nxt and nxt.get('on'))
                emit(s, str(step), dict(note=s['note'] + clip.get('transpose', 0), slide=slide))
        elif pattern['kind'] == 'drums':
            for voice, lane in pattern['lanes'].items():
                hit = lane[step] if step < len(lane) else None
                if hit and hit.get('on'):
                    emit(hit, f'{voice}:{step}', dict(voice=voice))
        else:
            for hit in pattern.get('hits', []):
                if hit.get('step') == step:
                    emit(hit, f"{hit['pad']}:{step}", dict(voice=hit['pad']))
    return out


def build_cues(project):
    tempo = project['tempo']
    meter = project.get('meter', {'numerator': 4, 'denominator': 4})
    beat = 60 / tempo * 4 / meter['denominator']
    bar_sec = beat * meter['numerator']
    T = lambda bar: round(bar * bar_sec, 6)
    tracks = {t['id']: t for t in project['tracks']}
    solo = any(t['mixer'].get('solo') for t in project['tracks'])
    audible = {tid: (not t['mixer'].get('mute')) and (t['mixer'].get('solo') or not solo) for tid, t in tracks.items()}
    assets = project.get('assets', {})
    cues = dict(
        name=project.get('name'), tempo=tempo, meter=meter, swing=project.get('swing', 0),
        beatSec=beat, barSec=bar_sec, lengthBars=project['length'], end=T(project['length']),
        sections=[dict(name=s['name'], startBar=s['start'], endBar=s['start'] + s['length'],
                       start=T(s['start']), end=T(s['start'] + s['length'])) for s in sorted(project['sections'], key=lambda s: s['start'])],
        tracks=[dict(name=t['name'], kind=t['kind'], audible=audible[t['id']], volume=t['mixer'].get('volume', 0)) for t in project['tracks']],
        hits={}, notes={}, clips=[], automation=[], impacts=[], risers=[],
    )
    for c in project['clips']:
        tr = tracks.get(c['trackId'])
        if tr is None:
            continue
        name = (project['patterns'].get(c['patternId'], {}).get('name') if c.get('patternId')
                else assets.get(c.get('assetId'), {}).get('name'))
        ok = audible[tr['id']] and not c.get('mute')
        cues['clips'].append(dict(track=tr['name'], name=name, startBar=c['start'], endBar=c['start'] + c['length'],
                                  start=T(c['start']), end=T(c['start'] + c['length']),
                                  fadeIn=T(c.get('fadeIn', 0)), fadeOut=T(c.get('fadeOut', 0)), audible=ok))
        low = (name or '').lower()
        if ok and 'impact' in low:
            cues['impacts'].append(T(c['start']))
        if ok and 'riser' in low:
            cues['risers'].append([T(c['start']), T(c['start'] + c['length'])])
        if not ok or not c.get('patternId'):
            continue
        pat = project['patterns'].get(c['patternId'])
        if not pat:
            continue
        for ev in pattern_events(project, c, pat):
            ev['t'] = T(ev['bar'])
            if 'voice' in ev:
                cues['hits'].setdefault(f"{tr['name']}/{ev['voice']}", []).append(
                    dict(t=ev['t'], bar=round(ev['bar'], 6), vel=ev['velocity'], accent=ev['accent']))
            else:
                cues['notes'].setdefault(tr['name'], []).append(
                    dict(t=ev['t'], len=T(ev['length'] * (2 if ev['slide'] else 1)), note=ev['note'], accent=ev['accent'], slide=ev['slide']))
    for k in cues['hits']:
        cues['hits'][k].sort(key=lambda e: e['t'])
    for k in cues['notes']:
        cues['notes'][k].sort(key=lambda e: e['t'])
    cues['impacts'] = sorted(set(cues['impacts']))
    for a in project.get('automation', []):
        tr = tracks.get(a['trackId'])
        cues['automation'].append(dict(track=tr['name'] if tr else None, param=a['param'],
                                       points=[dict(t=T(p['bar']), bar=p['bar'], value=p['value'], curve=p.get('curve')) for p in a['points']]))
    return cues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('project')
    ap.add_argument('-o', '--out', default='cues.json')
    a = ap.parse_args()
    cues = build_cues(load(a.project))
    json.dump(cues, open(a.out, 'w'), indent=1)
    print(f"{cues['name']}: {cues['tempo']} BPM, {len(cues['sections'])} sections, "
          + ', '.join(f'{k}={len(v)}' for k, v in cues['hits'].items()) + f", impacts={cues['impacts']}")


if __name__ == '__main__':
    main()
