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

The app includes [Mediabunny](https://github.com/Vanilagy/mediabunny) by Vanilagy, unmodified, to write MP4 files from the **Video** view. It's licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/); its source is available from its repository and from the `mediabunny` package on npm.
