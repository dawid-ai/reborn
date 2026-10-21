# Third-party notices

RE:BORN's desktop app can install the following open-source projects on request. They aren't bundled in the installer; the app downloads them into its own Python environment when you click **Install Ismail** or **Add stem separation** in **Browser** > **Generate**.

## Ismail

[Ismail](https://github.com/newsbubbles/ismail) by Nate Codes (newsbubbles) provides RE:BORN's sound generation, stem separation, and the Ismail reports in deep analysis and reference comparison. The app installs a pinned commit, set in `apps/desktop/src/sidecar.ts`.

```text
MIT License

Copyright (c) 2026 newsbubbles

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Demucs

[Demucs](https://github.com/adefossez/demucs) by Meta performs stem separation. It's installed with Ismail's `separate` extra, together with [PyTorch](https://pytorch.org/) (BSD-3-Clause license). The pretrained model weights download from their published locations the first time you separate.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## Mediabunny

The app includes [Mediabunny](https://github.com/Vanilagy/mediabunny) and its AAC encoder extension, `@mediabunny/aac-encoder`, by Vanilagy, unmodified, to write MP4 files from the **Video** view. Both are licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/); their source is available from the repository and from the `mediabunny` and `@mediabunny/aac-encoder` packages on npm.

## FFmpeg

The AAC encoder extension contains a WebAssembly build of [FFmpeg](https://ffmpeg.org/)'s native AAC encoder from libavcodec, which is licensed under the [GNU Lesser General Public License 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) or later. It runs as a separate module that loads only when the system has no AAC encoder of its own. FFmpeg's source is available from [ffmpeg.org](https://ffmpeg.org/download.html), and the build scripts from the Mediabunny repository.
