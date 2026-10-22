# Updates

Releases of the RE:BORN desktop app, newest first. The release workflow publishes each entry as the GitHub release notes, and the app shows them when it offers the update.

## v2.2.1 — 2026-10-22

- Fixed: a long request from the Director pushed the video preview, the **Looks, library, footage** drawer, the approve button, and the export buttons off the screen.
- The Director's request now shows under the stage steps with its full text (**Read all**), the stills to check, and an **Approve** button named after the stage.
- A line next to the stage steps says what the current stage is for, and **Go back…** reopens an earlier stage.
- **Vertical copy** no longer stacks "vertical" onto copy names, a vertical storyboard offers **Landscape copy**, and **Delete storyboard** at the bottom of the inspector removes one.
- The footage API keys and **Search footage** are also in the storyboard's **Footage** settings.
- Contact sheets are now called stills overviews; click one in the inspector to see it large.
- Footage scenes with no clips say so instead of showing black without explanation.
- Text has an **RGB split** setting; 0 turns off the color split that follows the kick.

## v2.2.0 — 2026-10-22

- **New:** the **Video** view (5) makes a music video for your song. Scenes start from your sections, cuts land on the drum hits your patterns play, and the preview follows playback. Export an MP4 with the mix as its audio, plus a description with chapters.
- **New:** the **Director**, a second agent in the **Agent** panel. It plans and builds the video stage by stage, checks it with stills, answers your comments, and waits for your approval. It never changes the music. The **Composer** and the Director can work at the same time.
- **New:** stages with approval, comments on scenes and stills, contact sheets, a library of looks, presets, and templates, and stock footage from Pexels, Pixabay, Wikimedia Commons, and the Internet Archive that downloads only after you approve each clip.
- Projects from the earlier web edition still open; the app now uses only the RE:BORN name.

## v2.1.0 — 2026-10-21

- **New:** **Clear conversation** at the top of the **Agent** panel starts a new conversation. The agent forgets the earlier messages; your project stays as it is.
- RE:BORN has its own repository, [dawid-ai/reborn](https://github.com/dawid-ai/reborn). Downloads, release notes, and updates come from there.

## v2.0.0 — 2026-10-20

- **The RE:BORN desktop studio.** Arrange, Build, Mix, and Perform views with Acid, Wave, drum machine, sampler, and audio tracks, a mixer with returns and groups, and WAV and stem export.
- **Project folders.** Save, pack, and reopen projects, with per-project autosave and **File** > **Recover Unsaved Work**.
- **Agent and CLI.** An agent that proposes edits you apply or reject, the `reborn` command-line tool, and an MCP server for Claude Code.
- **Ismail.** Optional deep analysis, sound generation, and stem separation.
- **Updates.** The app checks for new releases at launch and asks before it downloads one. **Help** > **Check for Updates** checks on demand.
- **Fixed:** you can type a new tempo or swing value; the field no longer snaps back while you type.
- **Fixed:** the metronome clicks after a restart when it was left on.
- **Fixed:** a muted track with a long name can be unmuted. Mute and solo are now icons.
- **Fixed:** Ismail progress pills clear when generation or separation ends.
- **New:** right-click a track header to rename, mute, solo, or remove it.
