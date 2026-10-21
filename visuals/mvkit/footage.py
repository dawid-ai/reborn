"""Find, download and normalise stock footage by keywords.

Sources (in this order for source="any"):
  pexels    – modern HD, free licence, needs PEXELS_API_KEY  (https://www.pexels.com/api/)
  pixabay   – modern HD, free licence, needs PIXABAY_API_KEY (https://pixabay.com/api/docs/)
  wikimedia – Wikimedia Commons, CC0 / CC BY / CC BY-SA / public domain (attribution may be required)
  archive   – Internet Archive, public-domain / CC items (lots of vintage film: Prelinger, NASA, newsreels)

Keys are read from the environment or from visuals/.keys.json ({"pexels": "...", "pixabay": "..."}),
which is git-ignored.

CLI:
  python -m mvkit.footage search "old man walking into the sunset" [--source any] [-n 8]
  python -m mvkit.footage fetch storyboard.json          # downloads every clip the storyboard names
"""
import json, os, re, subprocess, sys, argparse, urllib.parse, hashlib, time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = 'REBORN-visuals/0.2 (personal music video tool)'
ALLOWED = re.compile(r'(cc0|public ?domain|pd|cc[ -]by(?![- ]?nc)(?![- ]?nd)|cc[ -]by[- ]sa|pexels|pixabay|publicdomain|creativecommons\.org/licenses/by/|creativecommons\.org/licenses/by-sa/|creativecommons\.org/publicdomain)', re.I)
BLOCKED = re.compile(r'(-nc|-nd|noncommercial|noderiv|by-nc|by-nd)', re.I)


def keys():
    k = {}
    p = os.path.join(HERE, '.keys.json')
    if os.path.exists(p):
        k.update(json.load(open(p)))
    for name in ('pexels', 'pixabay'):
        v = os.environ.get(f'{name.upper()}_API_KEY')
        if v:
            k[name] = v
    return k


def _get(url, headers=None, tries=4):
    cmd = ['curl', '-sS', '-L', '--max-time', '40', '-A', UA]
    for h, v in (headers or {}).items():
        cmd += ['-H', f'{h}: {v}']
    for i in range(tries):
        r = subprocess.run(cmd + [url], capture_output=True)
        if r.returncode == 0 and r.stdout and not r.stdout.startswith(b'You are making too many'):
            return r.stdout
        time.sleep(5 * (i + 1) ** 2)    # Wikimedia rate-limits bursts; back off
    raise RuntimeError(f'GET failed: {url}: {r.stderr[:200]}')


def _strip_html(s):
    return re.sub(r'<[^>]+>', '', s or '').strip()


def search_pexels(q, n=10):
    k = keys().get('pexels')
    if not k:
        return []
    d = json.loads(_get('https://api.pexels.com/videos/search?' + urllib.parse.urlencode(
        {'query': q, 'per_page': n, 'orientation': 'landscape'}), {'Authorization': k}))
    out = []
    for v in d.get('videos', []):
        files = sorted([f for f in v['video_files'] if f.get('width') and f['width'] <= 1920 and f.get('file_type') == 'video/mp4'],
                       key=lambda f: -f['width'])
        if files:
            out.append(dict(source='pexels', id=str(v['id']), title=v.get('url', '').rstrip('/').split('/')[-1],
                            url=files[0]['link'], width=files[0]['width'], height=files[0]['height'], duration=v['duration'],
                            license='Pexels License', author=v['user']['name'], page=v['url']))
    return out


def search_pixabay(q, n=10):
    k = keys().get('pixabay')
    if not k:
        return []
    d = json.loads(_get('https://pixabay.com/api/videos/?' + urllib.parse.urlencode({'key': k, 'q': q, 'per_page': max(3, n)})))
    out = []
    for v in d.get('hits', []):
        f = v['videos'].get('large') or v['videos'].get('medium')
        if f and f.get('url'):
            out.append(dict(source='pixabay', id=str(v['id']), title=v.get('tags', ''), url=f['url'], width=f['width'], height=f['height'],
                            duration=v['duration'], license='Pixabay Content License', author=v.get('user', ''), page=v['pageURL']))
    return out


def search_wikimedia(q, n=10):
    d = json.loads(_get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'generator': 'search', 'gsrsearch': f'{q} filetype:video', 'gsrnamespace': 6, 'gsrlimit': n,
        'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata', 'iiurlwidth': 320,
        'iiextmetadatafilter': 'LicenseShortName|Artist|ObjectName', 'format': 'json'})))
    out = []
    pages = sorted(d.get('query', {}).get('pages', {}).values(), key=lambda p: p.get('index', 0))
    for p in pages:
        ii = p['imageinfo'][0]; m = ii.get('extmetadata', {})
        lic = m.get('LicenseShortName', {}).get('value', '')
        out.append(dict(source='wikimedia', id=p['title'][5:], title=p['title'][5:], url=ii['url'], width=ii.get('width', 0),
                        height=ii.get('height', 0), duration=ii.get('duration', 0), license=lic,
                        author=_strip_html(m.get('Artist', {}).get('value', '')), page=ii.get('descriptionurl', ''),
                        thumb=ii.get('thumburl', '')))
    return out


def wikimedia_file(title):
    """Exact Commons file (pinned in a storyboard) without a search call."""
    d = json.loads(_get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'titles': 'File:' + title, 'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata',
        'iiextmetadatafilter': 'LicenseShortName|Artist|ObjectName', 'format': 'json'})))
    for p in d.get('query', {}).get('pages', {}).values():
        if 'imageinfo' not in p:
            continue
        ii = p['imageinfo'][0]; m = ii.get('extmetadata', {})
        return dict(source='wikimedia', id=title, title=title, url=ii['url'], width=ii.get('width', 0), height=ii.get('height', 0),
                    duration=ii.get('duration', 0), license=m.get('LicenseShortName', {}).get('value', ''),
                    author=_strip_html(m.get('Artist', {}).get('value', '')), page=ii.get('descriptionurl', ''))
    return None


def search_archive(q, n=10):
    docs = []
    # archive.org's search backend rejects OR-groups of wildcards, so run simple queries one by one
    for query in (f'title:({q}) AND mediatype:movies AND licenseurl:*publicdomain*',
                  f'({q}) AND mediatype:movies AND licenseurl:*publicdomain*'):
        d = json.loads(_get('https://archive.org/advancedsearch.php?' + urllib.parse.urlencode(
            {'q': query, 'fl[]': ['identifier', 'title', 'licenseurl', 'creator'], 'rows': n, 'output': 'json', 'sort[]': 'downloads desc'}, doseq=True)))
        docs += [x for x in d.get('response', {}).get('docs', []) if x['identifier'] not in {y['identifier'] for y in docs}]
        if len(docs) >= n:
            break
    out = []
    for doc in docs[:n]:
        try:
            md = json.loads(_get(f"https://archive.org/metadata/{doc['identifier']}"))
        except Exception:
            continue
        vids = [f for f in md.get('files', []) if f['name'].lower().endswith(('.mp4', '.mov', '.webm', '.ogv', '.mpeg', '.mpg'))]
        def w(f):
            try: return int(f.get('width') or 0)
            except ValueError: return 0
        vids = sorted(vids, key=lambda f: (min(w(f), 1920), -abs(w(f) - 1920)), reverse=True)
        if not vids:
            continue
        f = vids[0]
        try: dur = float(f.get('length') or 0)
        except ValueError: dur = 0
        out.append(dict(source='archive', id=doc['identifier'], title=doc.get('title', ''),
                        url=f"https://archive.org/download/{doc['identifier']}/{urllib.parse.quote(f['name'])}",
                        width=w(f), height=int(f.get('height') or 0) if str(f.get('height', '')).isdigit() else 0, duration=dur,
                        license=doc.get('licenseurl', ''), author=doc.get('creator', '') if isinstance(doc.get('creator'), str) else ', '.join(doc.get('creator', [])),
                        page=f"https://archive.org/details/{doc['identifier']}"))
    return out


PROVIDERS = {'pexels': search_pexels, 'pixabay': search_pixabay, 'wikimedia': search_wikimedia, 'archive': search_archive}


def usable(c, min_w=960):
    lic = c.get('license', '')
    if c['source'] in ('pexels', 'pixabay'):
        ok = True
    else:
        ok = bool(ALLOWED.search(lic)) and not BLOCKED.search(lic)
    dur = c.get('duration') or 0
    return ok and (c.get('width') or 0) >= min_w and (dur == 0 or dur >= 3)


def search(q, source='any', n=8, min_w=960):
    order = ['pexels', 'pixabay', 'wikimedia', 'archive'] if source == 'any' else source.split(',')
    found = []
    for s in order:
        try:
            found += [c for c in PROVIDERS[s](q, n) if usable(c, min_w)]
        except Exception as e:
            print(f'  [{s}] {e}', file=sys.stderr)
    # prefer landscape HD, then reasonable length
    def score(c):
        w, h = c.get('width') or 0, c.get('height') or 1
        land = 1 if w >= h * 1.3 else 0
        return (land, min(w, 1920), -abs((c.get('duration') or 20) - 20))
    return sorted(found, key=score, reverse=True)


def normalise(src, dst, start=0.0, dur=20.0, w=1920, h=1080, fps=30):
    vf = f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps},format=yuv420p'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', str(start), '-i', src, '-t', str(dur), '-vf', vf, '-an',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-g', '15', dst], check=True)


def fetch_clip(cid, spec, cache_dir):
    """spec: {"query": "...", "source": "any", "pick": 0, "start": 0, "dur": 20} or {"file": "local.mp4"}"""
    os.makedirs(cache_dir, exist_ok=True)
    out = os.path.join(cache_dir, f'{cid}.mp4')
    meta_p = os.path.join(cache_dir, f'{cid}.json')
    if os.path.exists(out) and os.path.exists(meta_p):
        return json.load(open(meta_p))
    if spec.get('file'):
        normalise(spec['file'], out, spec.get('start', 0), spec.get('dur', 20))
        meta = dict(id=cid, source='local', title=os.path.basename(spec['file']), license='own', author='', page='')
    else:
        pinned = wikimedia_file(spec['title']) if spec.get('title') and spec.get('source') == 'wikimedia' else None
        cands = [pinned] if pinned else search(spec['query'], spec.get('source', 'any'), spec.get('n', 8), spec.get('minWidth', 960))
        if spec.get('title'):
            cands = [c for c in cands if c['title'] == spec['title']] or cands
        if spec.get('require'):
            cands = [c for c in cands if all(w.lower() in (c['title'] + ' ' + c.get('page', '')).lower() for w in spec['require'])] or cands
        if not cands:
            raise RuntimeError(f'no usable footage for "{spec["query"]}"')
        c = cands[min(spec.get('pick', 0), len(cands) - 1)]
        import tempfile
        raw = os.path.join(tempfile.gettempdir(), f'mvkit-{cid}.download')
        for attempt in range(5):
            subprocess.run(['curl', '-sS', '-L', '--max-time', '600', '-A', UA, '-o', raw, c['url']], check=True)
            with open(raw, 'rb') as fh:
                head = fh.read(64)
            if not head.lstrip().lower().startswith((b'<!doctype', b'<html')):
                break
            time.sleep(15 * (attempt + 1))      # got an HTML error page (rate limit) instead of video
        else:
            raise RuntimeError(f'download kept failing (rate limited?): {c["url"]}')
        start = spec.get('start', min(2.0, (c.get('duration') or 0) * 0.1))
        normalise(raw, out, start, spec.get('dur', 20))
        try:
            os.remove(raw)
        except OSError:
            pass
        meta = dict(id=cid, query=spec['query'], **{k: c[k] for k in ('source', 'title', 'license', 'author', 'page', 'url')})
    json.dump(meta, open(meta_p, 'w'), indent=1)
    return meta


def write_credits(metas, path):
    lines = ['# Footage credits', '']
    for m in metas:
        if m['source'] == 'local':
            continue
        lines.append(f"- **{m['title']}** — {m.get('author') or 'unknown author'}, {m['license']} ({m['source']}): {m['page']}")
    open(path, 'w').write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd')
    s = sub.add_parser('search'); s.add_argument('query'); s.add_argument('--source', default='any'); s.add_argument('-n', type=int, default=8); s.add_argument('--min-width', type=int, default=960)
    f = sub.add_parser('fetch'); f.add_argument('storyboard'); f.add_argument('--cache', default=None)
    a = ap.parse_args()
    if a.cmd == 'search':
        for i, c in enumerate(search(a.query, a.source, a.n, a.min_width)):
            print(f"{i}: [{c['source']}] {c['title'][:60]} {c['width']}x{c['height']} {c.get('duration', 0):.0f}s {c['license']} — {c['page']}")
    elif a.cmd == 'fetch':
        sb = json.load(open(a.storyboard))
        cache = a.cache or os.path.join(os.path.dirname(os.path.abspath(a.storyboard)), sb.get('footageDir', 'footage'))
        metas = []
        for cid, spec in sb.get('footage', {}).items():
            print('fetch', cid, spec.get('query') or spec.get('file'), flush=True)
            try:
                metas.append(fetch_clip(cid, spec, cache))
            except Exception as e:
                print(f'  !! {cid} failed: {e}', flush=True)
            time.sleep(1)
        write_credits(metas, os.path.join(cache, 'CREDITS.md'))


if __name__ == '__main__':
    main()
