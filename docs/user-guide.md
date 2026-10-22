# RE:BORN user guide

RE:BORN is a desktop music workstation for acid lines, drum machines, sampled beats, and full arrangements. This guide covers the main workflows. Press **F1** in the app for the searchable guide and the full shortcut map.

## Install

On Windows:

1. Download [`RE-BORN-Setup.exe`](https://github.com/dawid-ai/reborn/releases/latest/download/RE-BORN-Setup.exe), the latest release. Older versions are on the [releases page](https://github.com/dawid-ai/reborn/releases).
2. Run it. If Windows SmartScreen warns about an unsigned build, click **More info** > **Run anyway**.
3. Start **RE-BORN** from the Start menu.

On Linux:

1. Download [`RE-BORN-x86_64.AppImage`](https://github.com/dawid-ai/reborn/releases/latest/download/RE-BORN-x86_64.AppImage).
2. Make it executable with `chmod +x RE-BORN-x86_64.AppImage`, then run it. If it says AppImages require FUSE, install FUSE 2: `sudo pacman -S fuse2` on Arch, `sudo apt install libfuse2t64` (or `libfuse2`) on Ubuntu.
3. Keep the AppImage where it is: updates replace that file.

Installed builds, and the AppImage on Linux, check GitHub Releases for updates on launch. When a newer version exists, a prompt shows its notes: click **Update now** to download it, then **Restart now** to install it, or **Later** to install it the next time you quit. To check now, click **Help** > **Check for Updates**.

## Make a first beat

1. Press `Space`. The starter project plays.
2. Click the **Acid line** clip. The dock under the arrangement shows its steps; click a step to change it.
3. To start over from a different style, open the **Projects** browser and pick a template: **Boom bap**, **Acid house**, **Starter rack**, or **Blank**. You can also run **New project from template** in the command palette (`Ctrl+K`) or use **File** > **New from Template**.

The checklist in the status bar tracks the first six things to try.

## Views

| Key | View | Use it to |
|---|---|---|
| `1` | **Arrange** | Place clips on tracks, add sections, insert or delete time. |
| `2` | **Build** | Launch scenes (one pattern per track) live. Arm record (`R`) to write launches into the arrangement. |
| `3` | **Mix** | Set levels, sends, and returns; trace any channel to the master; analyze the mix. |
| `4` | **Perform** | Play macros, the crossfader, and decks with large targets. With record armed, moves become automation. |
| `5` | **Video** | Storyboard a music video cut to the song's drum hits, risers, and impacts, preview it live, and export an MP4. |

The dock always shows the editor for the current selection. The inspector on the right shows every setting of the selected track, clip, or step.

## Edit patterns and clips

- Double-click an empty lane to create a clip.
- `Ctrl+D` duplicates a clip as a linked repeat. Editing one copy edits both; **Make unique** in the inspector separates them.
- `Ctrl+C` copies the selected clip and `Ctrl+X` cuts it. `Ctrl+V` pastes it on the selected track (or the track it came from) at the playhead, then moves the playhead to the end of the copy, so pressing `Ctrl+V` again lays copies end to end. A pasted pattern clip is a linked repeat, like `Ctrl+D`.
- Right-click a clip for **Copy**, **Cut**, **Duplicate**, **Loop**, **Split at playhead**, and **Delete**. Right-click an empty part of a lane to paste at that bar.
- An audio clip plays its sound once. To repeat a short sound across a longer clip, select the clip and turn on **Loop** in the inspector, then choose how often it repeats (**1 beat**, **1 bar**, and so on) and drag the clip's right edge. Looping clips show a loop icon, and their waveform shows each repeat.
- A note step can play a chord. Select the step and choose a chord in the inspector (**Major**, **Minor 7th**, **Sus 4**, and others); the piano roll shows the chord's other notes lighter. Chords work on Wave Synth and Acid Synth, and each voice is turned down so a chord sits at about the level of a single note.
- `Ctrl+E` splits the selected clip at the playhead. `Enter` plays from the start of the selected clip or section.
- The dock sets each pattern's length, step size, and swing. **Song** swing follows the project; any other value overrides it for that pattern. **Quantize** pulls the pattern's microtiming 50% or 100% toward the grid.
- Hold `Alt` while you turn a knob with a step selected to lock that value to the step.
- With record armed and the transport running, every knob, slider, and macro move is written as automation.
- The **Macros** group in the track inspector chooses which parameters each of the eight macros drives.
- `Delete` clears the selected clip, step, slice marker, or section marker. Every edit is undoable with `Ctrl+Z`.

## Sample and chop

1. Drag an audio file (or a starter sample from the **Samples** browser) onto a Sampler lane.
2. The chop editor finds transients and suggests slices. Adjust them, or choose equal, beat, or bar slicing.
3. Play slices from the pad grid with the mouse, the right-hand keys on your keyboard, or MIDI pads.
4. With record armed and the transport running, your pad performance is written into the clip.

To borrow a break's feel, choose a pattern next to **Apply groove** in the chop editor and click it. RE:BORN measures how the sample's hits sit against the grid and moves the pattern's steps the same way.

To split a recording into drums, bass, other, and vocals, select its audio clip (or a Deck, or a Sampler's source) and click **Separate stems** in the inspector. Each stem lands on a new audio track lined up with the clip, as one undo step; the original stays as it is, so mute it to hear the stems alone. Separation uses Ismail with its stem separation add-on (see [Generate sounds with Ismail](#generate-sounds-with-ismail)) and takes about half a minute per minute of audio on a typical CPU.

Audio tracks hold whole recordings with non-destructive gain, offsets, and fades. To print a track, group, or return, select it and click **Print bars … to audio** in the inspector; for the master, run **Print the master** from the palette. The print covers the loop range (or the whole song) and lands on a new audio track, at the same level, as one undo step.

## Generate sounds with Ismail

[Ismail](https://github.com/newsbubbles/ismail), by Nate Codes (newsbubbles), is an open-source audio toolkit with synths, drum machines, modeled instruments, and analysis, released under the MIT license. The desktop app can install it for you. Stem separation uses [Demucs](https://github.com/adefossez/demucs) by Meta. See [third-party notices](../THIRD_PARTY_NOTICES.md).

1. Open the **Generate** tab in the browser and click **Install Ismail**. It needs Python 3.10 or later and about 650 MB of disk space, and installs into RE:BORN's own folder.
2. Describe the sound in **Describe it**, for example "dark rolling acid bassline, one bar, in A minor", and click **Write and generate**. The agent you set up under **Agent** picks the instrument and writes the notes into the fields, then generates the sound. It takes 5 to 30 seconds, depending on the provider.
3. To adjust the result, edit the instrument or notes and click **Generate**. To write notes by hand, pick a pattern from **Starters** or write them: start beat, pitch, length in beats, and velocity, one per line or separated by `;`. For example, `0 C2 0.5 110; 0.5 C3 0.5` plays two notes, and `0 C3,E3,G3 2` plays a chord.

With a Sampler selected, the sound loads into it and is chopped; with an Audio track selected, it lands at the playhead; otherwise it gets a new audio track. On the timeline, a generated sound loops at the shortest length that holds it (a short hit repeats every beat, a one-bar riff every bar), so dragging the clip's right edge repeats it. **Max tail** lets the last note ring for up to that many seconds; Ismail trims trailing silence, so a short sound stays short.

Ismail describes each sound (envelope, pitch, harmonics, brightness) under the **Generate** button. You can also ask in the **Agent** panel, for example "make a four-on-the-floor kick with Ismail". To split recordings into stems, click **Add stem separation** in the same tab; it adds PyTorch and Demucs, about 700 MB more.

## Mix and diagnose

- New projects play at about −14 LUFS, the level streaming services use, so they sound as loud as other music. Older projects keep their level. To make one louder, select **Master** in the mixer, choose a target such as **−14 LUFS (streaming)**, and click **Match**. RE:BORN measures the song and sets **Loudness**, which pushes the mix into a limiter without clipping. Playback and export use the same setting.

- Each track has an insert EQ, filter, and drive, then a fader, pan, and sends to the shared returns.
- Select a return (for example **Tape Delay**) to see which tracks feed it. **Why can I hear echo?** in the palette does this for you.
- **Analyze** measures loudness, peaks, band balance, stereo correlation, and tails per section, and lists warnings such as clipping or sub buildup. Warnings describe evidence; nothing changes until you act.
- **Deep analysis** and **Compare with reference…** run in the Python sidecar. With Ismail installed, they add Ismail's reports: sections and key, chords per bar, and for a reference, bar-by-bar harmony and rhythm scores, timing, tempo, and key.
- **FX Safe Bypass** mutes every return at once, which helps you check a dry mix.

## Play with a controller

- MIDI notes play the selected instrument. On drum machines and samplers, note 36 plays the first voice or pad.
- To map knobs and buttons, click **MIDI** in the transport (or run **MIDI learn** from the palette). Click a knob, slider, macro, or **Play**, **Stop**, or **Record**, then move a control on your device. Repeat for more controls and click **Done**.
- Mappings are saved per device. Macro mappings follow the selected track, so one row of knobs plays whichever instrument you select.
- Computer keys play instruments too: `A`–`K` for notes, `Z` and `X` for octaves, and the right-hand key grid for pads. Turn this off in the dock or the palette.

## Work with an agent

Click **Agent** in the transport. The panel has two agents, each with its own conversation:

- **Composer** works on the music: patterns, sounds, the mix, and the arrangement.
- **Director** makes the music video in the **Video** view. It never changes the music. See [Make a music video](#make-a-music-video).

Choose a provider:

- **Claude CLI** uses your Claude Code login.
- **Claude API** uses an Anthropic API key, stored in the OS credential store (Windows Credential Manager, or the Secret Service keyring such as GNOME Keyring or KWallet on Linux).
- **Local or compatible** uses Ollama, LM Studio, or any OpenAI-compatible server.

Agent edits arrive as proposals. Preview a proposal to hear it, then apply all of it, part of it, or none. To let the agent edit directly, turn on direct edits in the agent settings; each edit is still one undo step. Measurements are shared with the provider only when you turn that on.

The agent can work on one part or a whole song. Ask "make a 16-bar acid house track at 126 BPM with an intro, a main section, and an outro", and it sets the tempo, adds tracks, writes patterns, makes sounds with Ismail, and marks the sections, all as one proposal you can accept change by change. A request like that takes one to two minutes. While it works, the panel lists each step (for example **Reading the project** or **Generating Chord Stab with Ismail**) with a running timer. To stop it, click the stop button next to the message box.

To start a new conversation, click **Clear conversation** (the speech bubble with an X) at the top of the panel. The agent forgets the earlier messages; the project stays as it is.

The **Generate** tab and the **Agent** panel do different jobs. **Generate** makes one sound: you describe it or write the notes, and it lands on a track. The agent works on the whole project: it reads what's there, changes patterns, the mix, and the arrangement, and uses Ismail when it needs a sound.

With the Claude CLI provider, the agent reaches only RE:BORN's own tools. It can't run commands, read your files, or use other services you've connected to Claude Code.

Other agents and scripts can drive RE:BORN too. See [CLI and MCP](cli-and-mcp.md).

## Make a music video

The **Video** view (`5`) turns the song into a beat-synced music video. Visuals are cut to the hits the drum patterns actually play, with swing and microtiming, so they land exactly with the music.

1. Click **Create storyboard**. You get one scene per section, chosen by the section's name: intros drift, builds dive and strobe into a whiteout, drops hit hard and dark, switch sections strobe on the drums, and bridges turn into kaleidoscopes.
2. Press Space. The preview follows the transport, and the lanes below show sections, scenes, text, and the kick, snare, and hat hits that drive the cuts.
3. Click a scene to edit it in the inspector: its look, the look's parameters, up to three layers, cut events, camera travel, and post effects such as trails, bloom, strobe, and whiteout.
4. Click **Analyze mix** so bass, sub, and hi-hat energy can drive motion too. Drum hits work without it. After you change the music, the view tells you the analysis is out of date; nothing re-renders on its own.
5. Click **Export draft** for a quick half-size check, or **Export MP4** for the full-size video with the mix as its audio.

Every field takes a number or an expression evaluated each frame, for example `0.004+0.006*kick` or `t*.15`. **Expressions** at the bottom of the inspector lists what you can use: song and scene time, drum pulses, band envelopes, riser progress, and time to the next impact. Clips with "riser" in their name drive `rise` and `rstrobe`; clips with "impact" in their name fire a flash, shake, and color split.

Scenes and text are timed to section markers, so they follow along when you change the tempo or move a section. A scene whose section was deleted is marked in red.

- **+** in the **Scenes** lane adds a scene at the playhead. Double-click a scene to jump to it.
- **T** in the **Text** lane adds text at the playhead. Text styles include a slam on the drop, words that change on each kick or snare, a typewriter, a flicker on the hats, and a ticker. Text gets a color split that follows the kick; **RGB split** in the inspector scales it, and 0 turns it off.
- **Vertical copy** duplicates the storyboard at 1080×1920 for Shorts, Reels, and TikTok and switches to the copy. On a vertical storyboard the button reads **Landscape copy**. The first menu in the bar switches storyboards, and **Delete storyboard** at the bottom of the inspector removes one.
- Storyboards are saved in the project, undo like any other edit, and can be edited from the CLI and MCP with the `video.*` commands.

### Stages, comments, and approval

A storyboard moves through five stages, shown above the preview: **Brief**, **Treatment**, **Look-dev**, **Draft**, and **Final**. The current stage is highlighted, and a line next to it says what the stage is for. Fill in the brief in the inspector (what the video is for, mood, words to show, footage), then click **Approve Brief**, and approve each later stage when you're happy with it. **Go back…** reopens an earlier stage.

When the Director asks for approval, its request appears under the stage steps: a summary (**Read all** shows the whole text), the stills it wants you to check, and the **Approve** button. To ask for changes instead, leave a comment, then tell the Director to continue.

Leave comments on the storyboard, a scene, a text item, or a still at any time. Open comments block approval until they're answered; **Approve anyway** overrides that. **Render stills** renders a still at each scene, impact, and text moment, plus an overview: one image with all of them, listed under **Stills overview** in the inspector. Click a still in the **Stills** lane, or an overview, to see it large and comment on it.

### The Director

Switch the **Agent** panel to **Director** and describe the video you want. The Director reads the brief, the song's sections, drum hits, and band energy, and works stage by stage: it sets up scenes, checks them with stills, answers your comments, and asks for your approval before moving on. Its storyboard edits apply directly, each as one undo step. It never approves a stage or a footage clip itself, unless you tick the stages it may approve in the storyboard settings.

### Library

**Looks, library, footage** opens a drawer next to the preview:

- **Looks** lists every look with its preview; **Use for scene** switches the selected scene to it.
- **Library** holds presets (one scene's look settings), templates (a whole storyboard by section role), and saved footage. Built-in presets and a template ship with the app; save your own from the selected scene or the storyboard. Applying a preset copies its settings and pins its version, so later changes to the library never alter a saved video; the scene offers **Update to latest** when there's a newer version. Items the Director suggests wait under **Suggested** until you keep or dismiss them.

### Footage

Turn on **Use stock footage** in the storyboard settings to search Pexels, Pixabay, Wikimedia Commons, and the Internet Archive from the **Footage** tab. Pexels and Pixabay need a free API key: get one at [pexels.com/api](https://www.pexels.com/api/) and from the [Pixabay API documentation](https://pixabay.com/api/docs/) after you sign in, then paste it under **API keys** in the storyboard's **Footage** settings or the **Footage** tab. RE:BORN keeps the keys in the OS credential store.

- Only free-to-use licences (CC0, public domain, Pexels, Pixabay) are allowed unless you widen the policy. CC BY needs credits; CC BY-SA may require releasing the video under the same licence, and the export warns when a video uses it.
- Keyword search is literal, so every clip waits for your review. Nothing downloads until you approve a clip, and downloads stay within the clip and megabyte limits in the brief.
- Pick a footage look (**Footage Grade** or **Footage Kaleido**) for a scene and tick its clips in the inspector. Each cut moves to the next clip. **Skip** jumps past title cards at the start of a clip.

**Export MP4** saves a description file next to the video, with chapters from your section names and credits for the footage. The same text is under **Description** in the storyboard settings. The export range can be the whole song, the loop range, or the selected scene.

## Save, share, and export

RE:BORN keeps your unsaved changes as you work. After a crash, the next launch restores them. If you start or open another project without saving, the unsaved state of the one you left is kept: choose **File** > **Recover Unsaved Work** to bring it back. The last 20 projects with unsaved changes are kept for 30 days; saving a project clears its copy.

- `Ctrl+S` saves the project as a `.reborn` folder with its audio. Unchanged audio files are never rewritten.
- **File** > **Pack Project** writes a single `.rebornpack` file to share.
- Projects exported from the earlier RE:BORN web edition (`.json`) open directly; the import report lists anything that changed.
- **Export** renders the song, a section, the loop, or stems as 16- or 24-bit WAV at 44.1 or 48 kHz. An optional loudness target (−16, −14, or −9 LUFS) applies one gain change; it never limits, so if the master ceiling would be crossed it stops there and tells you.
- If the app closes unexpectedly, the next launch offers to recover your unsaved work.

## Audio device

With nothing selected, the inspector shows the project and the **Audio device** settings: the device sample rate and latency. If playback crackles on a busy project, choose **Medium** or **Safe** latency.

## Accessibility

- `F6` moves focus between the browser, workspace, dock, and inspector.
- The palette changes density (compact, normal, large) and switches to high contrast.
- Shortcuts are remappable in **Help** (`F1`).
