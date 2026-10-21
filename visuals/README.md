# RE:BORN Visuals: music videos from RE:BORN projects

This folder is a small library and renderer for beat-synced music videos. It reads a RE:BORN project and its WAV export.

- `looks/`: one GLSL file per visual. Each file has a header with its name, the sections it suits, a description and its parameters. `catalog.md` and `catalog.png` show a preview of each look.
- `post/`: feedback trails and the final post stack (chromatic aberration, bloom, strobe, whiteout, impact flash, text layer, grain).
- `mvkit/`: the Python side:
  - `reborn_cues.py` reads a `.reborn` project and writes exact cue times (port of `audio-engine/src/studio/schedule.ts`).
  - `analyze.py` turns the WAV into per-frame band envelopes.
  - `footage.py` searches for stock footage, downloads it and normalises it.
  - `engine.py` renders a storyboard to MP4 or stills.
  - `catalog.py` generates the look previews.
- `storyboards/`: one JSON file per video. `psych-drop.json` rebuilds the first fractal video. `psych-drop-footage-demo.json` is the stock-footage and kinetic-type demo.
- `fonts/`: the app's own OFL fonts converted to TTF, used for text.
- `footage-cache/`: downloaded clips plus `CREDITS.md`. This folder is git-ignored.

## What to give Claude for a new song

Give the project folder (`Song.reborn/`) and the WAV export. You don't need to describe bars, tempo or a cue sheet.

| Source | What it gives |
|---|---|
| `project.json` | Tempo, meter and swing. Section names and bar ranges. Every drum hit per lane, with swing, micro-timing, ratchets and probability, timed the way the engine plays it. Acid and other notes. Every clip, so you know when the riser, impact, Reese B or pad play. Automation, such as filter sweeps. Muted tracks are excluded. |
| WAV export | The real sound: band energies, waveform and spectrum. This drives continuous motion such as bass wobble, hat sparkle and the oscilloscope. |
| A sentence or two from you | Mood, colours, what to show (footage keywords), any text or titles, and which look goes where. A rough storyboard is welcome, but it's optional. |

The first video used a hand-written cue sheet and a 150 BPM grid. The project file has the exact syncopated kick and snare patterns, so visuals now hit on the real drums. For example, the Drop A kicks fall on 16ths 0, 10, 16, 22, 26 and 29, not just "beat 1 and 3".

## Quick start

```bash
cd visuals
pip install -r requirements.txt          # numpy scipy moderngl pillow fonttools; ffmpeg must be on PATH

# 1. what's in the song
python -m mvkit.reborn_cues "../../../../Music/RE-BORN Exports/Psych Drop.reborn" -o cues.json

# 2. footage (only for storyboards that use it)
python -m mvkit.footage search "lightning storm"            # list candidates with licence + page
python -m mvkit.footage fetch storyboards/psych-drop-footage-demo.json

# 3. look at a few frames, then render
python -m mvkit.engine storyboards/psych-drop.json --size 960x540 --stills "Drop 1+1beats,Drop 2,Psych bridge"
python -m mvkit.engine storyboards/psych-drop.json -o renders/psych-drop.mp4
```

The engine uses the GPU when it runs on Windows or macOS. It falls back to headless EGL software rendering on a Linux server, where 1080p renders at about 2 frames per second.

## Storyboard format

```jsonc
{
  "audio": "path/to/song.wav",                 // relative to the storyboard file
  "project": "path/to/Song.reborn",            // optional; enables exact cues + section names
  "fps": 30,
  "range": ["Build 1", "Fast switch@end"],     // optional: render only part of the song
  "fade": "min(1,t/6.4)",                      // master fade expression
  "impacts": ["Drop 3+8bars"],                 // extra flash/shake hits (clips named *Impact* are found automatically)
  "impact": {"flash": 1.2, "ca": 0.02, "shake": 0.02},
  "pulses": {"kick": {"lanes": ["/kick"], "decay": 7}},   // which drum lanes drive kick / snare / hat pulses
  "footage": {"lava": {"query": "lava volcano", "source": "wikimedia", "title": "<exact file>", "start": 2, "skip": 0}},
  "scenes": [
    {"from": "Drop 1", "to": "Drop 1+8bars",   // seconds, "bar:16", "Section", "Section@end", "Section+2bars|beats|s"
     "look": "vein-tunnel",
     "params": {"thickLo": 22, "colB": [0.85, 0.05, 0.18], "punch": "0.05+0.05*rise"},
     "layers": [{"look": "shock-ring", "amount": 0.6, "params": {}}],      // up to 3 additive layers
     "travel": {"base": 0.55, "kick": 1.8, "snare": 1.1, "bass": 0.6},    // camera speed for tunnel looks
     "cutOn": ["kick", "snare"],               // events that advance strobe-deck / footage clips
     "clips": ["lava"], "clipOrder": "cycle|shuffle", "clipStart": "random|<seconds>", "clipSpeed": 1,
     "xfade": 0,                               // seconds of crossfade from the previous scene (0 = hard cut)
     "post": {"ca": 0.004, "bloom": 0.5, "fb": 0.2, "fbZoom": 1.02, "fbRot": 0, "fbHue": 0,
              "grain": 0.05, "vig": 1.2, "strobe": "rstrobe", "white": 0, "shake": "0.006*kick"}}
  ],
  "text": [
    {"at": "Drop 1", "until": "Drop 1+2bars", "text": "PSYCH\nDROP", "style": "slam",
     "font": "BigShoulders-Black", "size": 330, "pos": [0.5, 0.5], "blend": "difference", "glitch": 0.06}
  ]
}
```

Expression variables are evaluated every frame, in plain Python syntax:

- Time: `t`, `L` (seconds into the scene), `x` (0 to 1 progress through the scene), `len`, `beat`, `bar`, `BEAT`, `BAR`.
- Drum pulses: `kick`, `snare`, `hat` (0 to 1, decaying after each hit), plus `kt` and `st`, the seconds since the last kick or snare.
- Audio envelopes: `sub`, `bass`, `mid`, `harsh`, `air`, `rms`, `hatEnv`.
- Builds and impacts: `rise` (riser progress), `rstrobe` (a strobe that speeds up through the riser), `toImpact`, `sinceImpact`, `cut`, `cutT`.
- Functions: `sin cos exp log sqrt abs min max floor fract clamp smooth mix step pow`.

Text styles:

- `hold`: static text.
- `slam`: punches in at large scale, with an RGB-split burst.
- `type`: typewriter, one character per 16th note.
- `words`: the next word on each event. Set the events with `on`: `beat`, `bar`, `kick`, `snare`, or a list of these. Separate words with `|`.
- `flicker`: flickers with the hats.
- `scroll`: a ticker.

Text options: `font`, `size` (in px at 1080p), `pos`, `color`, `tracking`, `stroke`, `leading`, `fadeIn`, `fadeOut`, `pulse`, `ca`, `caKick`, `glitch`, and `blend: difference`, which makes the text invert whatever is under it.

## Adding a look

1. Copy a file in `looks/`. Change `// @look`, `// @title`, `// @fits`, `// @mood` and `// @desc`, and add one `// @param name default description` line per knob.
2. Write `vec3 look(vec2 uv)`. `uv` runs from -aspect to aspect horizontally and from -1 to 1 vertically. Read each parameter as `P_name`, and read the shared uniforms listed at the top of `_common.glsl`.
3. Prefix any helper functions with the look's initials, for example `vt_veins`, so they don't clash with other looks.
4. Run `python -m mvkit.catalog --audio ... --project ...` to render its preview and add it to `catalog.md`.

The looks only use GLSL that also compiles as WebGL2 (`#version 300 es`). That means the same files can run live inside the Electron app later.

## Footage

- **pexels** and **pixabay** have modern HD footage with good keyword relevance. They need free API keys in `.keys.json` (`{"pexels": "...", "pixabay": "..."}`, git-ignored) or in the `PEXELS_API_KEY` / `PIXABAY_API_KEY` environment variables.
- **wikimedia** (Commons) needs no key and has lots of HD clips. Many are CC BY or CC BY-SA, so attribution is required: put `footage-cache/CREDITS.md` in the video description.
- **archive** (Internet Archive) only returns public-domain items. It's mostly vintage SD film (Prelinger, NASA, newsreels), which is good for a VHS or found-footage look. Pass `minWidth: 480` to allow SD clips.
- **Always review candidates before using them.** Keyword search is literal. "old man walking" on Commons returned police body-cam videos. Pin the exact file with `title` once you've chosen one.
- Wikimedia rate-limits bursts and shared cloud IPs. Fetching from your own machine works better. Downloads that come back as an HTML error page are retried, and clips that fail are skipped.
- Use `skip` to jump past title cards at the start of a clip. Use `zoom` 1.15 to 1.2 on `footage-grade` to crop corner watermarks.

## Workflow (the recipe used for Psych Drop)

1. Run `reborn_cues` and read the cue sheet: sections, impacts, risers, drum patterns per section, and which tracks enter or change. Note the bass sample swap at Drop 3 bar 85.
2. Choose one look per section. Builds zoom or accelerate into a whiteout, and drops hard-cut on the impact. Breakdowns use strobe cuts. Bridges use kaleidoscopes with feedback trails. Give a mid-drop sample change its own new look.
3. Write the storyboard. Render about 12 stills at 960x540 with `--stills`, about 1 minute of work, and look at them as a contact sheet. Fix anything off-centre, washed out or too bright before doing the full render. Bright full-frame colour in heavy drops reads as "light", so keep drops mostly black with bright accents.
4. Render the full video in the background. Encode at a capped bitrate (`-maxrate 14M`). An uncapped high-quality encode of film grain and fractals produced almost 1 GB.
5. Spot-check frames from the encoded file at the impacts.

## Bringing it into RE:BORN

The parts are already split the way the app would need them:

- **Timing:** `reborn_cues.py` mirrors `sourceEvents()`. In the app, call the real scheduler instead.
- **Analysis:** `packages/analysis` already computes bands and onsets.
- **Rendering:** the GLSL looks run in a WebGL2 canvas in the studio. That gives a real-time preview locked to the transport.
- **Export:** render offline frame by frame, then use WebCodecs `VideoEncoder` plus an MP4 muxer. Mux in the existing offline audio render.
- **Storyboard:** add the storyboard as a project field (`project.visuals`), so a video is saved, undone and versioned with the song. Scenes would reference section IDs instead of names.
