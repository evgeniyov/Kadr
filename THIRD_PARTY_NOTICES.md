# Third-party notices

Kadr's code uses the [MIT License](LICENSE). Bundled components keep their own licenses and copyright notices. The platform and installer format determine which components a build includes.

## Desktop runtime

| Component | License and upstream source |
| --- | --- |
| Electron 44.11.5 | MIT, copyright Electron contributors and the other holders named in the [Electron license](https://github.com/electron/electron/blob/v44.11.5/LICENSE). The Electron distribution includes `LICENSE`. [Source](https://github.com/electron/electron/tree/v44.11.5) |
| Chromium and Electron's bundled dependencies | Chromium uses a BSD-style license with additional licenses for its bundled code. Each Electron build includes its own `LICENSES.chromium.html` with notices for Chromium, Node.js, V8, and other components. [Chromium source and license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) · [Electron distribution](https://github.com/electron/electron/releases/tag/v44.11.5) |
| jsQR 1.4.0 | Apache-2.0, jsQR contributors. [Source](https://github.com/cozmo/jsQR) · [Exact npm license](https://unpkg.com/jsqr@1.4.0/LICENSE) |
| koffi and the platform-specific `@koromix/koffi-*` packages 3.3.1 | MIT, copyright 2026 Niels Martignène. The Windows build uses `@koromix/koffi-win32-x64`. [Source](https://github.com/Koromix/koffi) · [Exact npm license](https://unpkg.com/koffi@3.3.1/LICENSE.txt) |

## OCR

Tesseract.js 7.0.0 and Tesseract.js Core 7.0.0 use Apache-2.0. The copyright holders are the Tesseract.js and Tesseract contributors. [Tesseract.js source](https://github.com/naptha/tesseract.js/tree/v7.0.0) · [Core source and build scripts](https://github.com/naptha/tesseract.js-core/tree/v7.0.0) · [Apache-2.0 text](docs/licenses/Apache-2.0.txt)

The English and Russian models in `resources/tessdata/` come from Tesseract. The Tesseract.js maintainers package them under `4.0.0_best_int` in `@tesseract.js-data/eng@1.0.0` and `@tesseract.js-data/rus@1.0.0`. The trained data uses Apache-2.0. Credit goes to the Tesseract contributors and the Tesseract.js maintainers. [Model source and license](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE) · [English npm package](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0) · [Russian npm package](https://www.npmjs.com/package/@tesseract.js-data/rus/v/1.0.0) · [Apache-2.0 text](docs/licenses/Apache-2.0.txt)

### Code included in the WebAssembly OCR builds

The source links below identify the revisions pinned by [Tesseract.js Core 7.0.0](https://github.com/naptha/tesseract.js-core/tree/v7.0.0/third_party). The WebAssembly builds include the text recognition engine and image-processing code. Original attribution and license terms are in the linked notices.

| Component | License and notice | Pinned source |
| --- | --- | --- |
| Tesseract OCR | [Apache-2.0](docs/licenses/Apache-2.0.txt), Tesseract contributors | [Core's Tesseract fork](https://github.com/Balearica/tesseract/tree/2a9c1c49c360462733c386d2a44fcd22c4e21411) |
| Leptonica | [BSD-2-Clause](docs/licenses/Tesseract-Leptonica.txt), Leptonica contributors | [Source](https://github.com/DanBloomberg/leptonica/tree/4af068b56a9674da915debea4ed7e1b9885b17e8) |
| libjpeg | [IJG license](docs/licenses/Tesseract-libjpeg.txt). This software is based in part on the work of the Independent JPEG Group. | [Source](https://github.com/LuaDist/libjpeg/tree/6c0fcb8ddee365e7abc4d332662b06900612e923) |
| giflib | [MIT](docs/licenses/Tesseract-giflib.txt), Eric S. Raymond | [Source](https://github.com/mirrorer/giflib/tree/fa37672085ce4b3d62c51627ab3c8cf2dda8009a) |
| libpng | [PNG Reference Library License 2.0 and legacy libpng terms](docs/licenses/Tesseract-libpng.txt), the PNG Reference Library authors | [Source](https://github.com/glennrp/libpng/tree/a37d4836519517bdce6cb9d956092321eca3e73b) |
| LibTIFF | [libtiff license](docs/licenses/Tesseract-libtiff.txt), Sam Leffler and Silicon Graphics | [Source](https://gitlab.com/libtiff/libtiff/-/tree/b51bb157123264e26d34c09cc673d213aea61fc7) |
| libwebp | [BSD-3-Clause](docs/licenses/Tesseract-libwebp.txt) and [additional patent grant](docs/licenses/Tesseract-libwebp-PATENTS.txt), Google Inc. | [Source](https://github.com/webmproject/libwebp/tree/20ef03ee351d4ff03fc5ff3ec4804a879d1b9d5c) |
| OpenLibm | [MIT and component-specific BSD, ISC, Sun and other notices](https://github.com/JuliaMath/openlibm/blob/ae2d91698508701c83cab83714d42a1146dccf85/LICENSE.md) | [Source](https://github.com/JuliaMath/openlibm/tree/ae2d91698508701c83cab83714d42a1146dccf85) |
| zlib | [zlib license](https://github.com/madler/zlib/blob/21767c654d31d2dccdde4330529775c6c5fd5389/README), Jean-loup Gailly and Mark Adler | [Source](https://github.com/madler/zlib/tree/21767c654d31d2dccdde4330529775c6c5fd5389) |
| Emscripten runtime and glue | [MIT or NCSA, with separate terms for bundled system libraries](docs/licenses/Tesseract-Emscripten.txt) | [Emscripten 4.0.15](https://github.com/emscripten-core/emscripten/tree/4.0.15) · [musl notices](https://github.com/emscripten-core/emscripten/blob/4.0.15/system/lib/libc/musl/COPYRIGHT) · [LLVM runtime license](https://llvm.org/LICENSE.txt) |

### Transitive npm dependencies

Kadr replaced `ffmpeg-static` with standalone FFmpeg builds. The table lists the remaining transitive production dependencies. Platform-specific koffi binaries use the same license as koffi. When you distribute copies of these packages with the app, include the license and attribution files from their exact npm tarballs.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| bmp-js | 0.1.0 | MIT | [bmp-js](https://github.com/shaozilee/bmp-js) |
| idb-keyval | 6.3.0 | Apache-2.0 | [idb-keyval](https://github.com/jakearchibald/idb-keyval) |
| is-url | 1.2.4 | MIT | [is-url](https://github.com/segmentio/is-url) |
| node-fetch | 2.7.0 | MIT | [node-fetch](https://github.com/node-fetch/node-fetch/tree/v2.7.0) |
| opencollective-postinstall | 2.0.3 | MIT | [opencollective-postinstall](https://github.com/opencollective/opencollective-postinstall) |
| regenerator-runtime | 0.13.11 | MIT | [regenerator](https://github.com/facebook/regenerator/tree/main/packages/runtime) |
| tr46 | 0.0.3 | MIT | [tr46](https://github.com/jsdom/tr46) |
| wasm-feature-detect | 1.9.0 | Apache-2.0 | [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) |
| webidl-conversions | 3.0.1 | BSD-2-Clause | [webidl-conversions](https://github.com/jsdom/webidl-conversions) |
| whatwg-url | 5.0.0 | MIT | [whatwg-url](https://github.com/jsdom/whatwg-url) |
| zlibjs | 0.3.1 | MIT | [zlib.js](https://github.com/imaya/zlib.js) |

## FFmpeg

Kadr's public packages use free FFmpeg builds configured without `--enable-nonfree`. The licenses, build configuration, and source details are in [`resources/licenses/ffmpeg/`](resources/licenses/ffmpeg/). [FFmpeg source](https://github.com/FFmpeg/FFmpeg) · [FFmpeg licensing](https://ffmpeg.org/legal.html)

## Windows installers

electron-builder uses the WiX Toolset to build the Windows `.msi`. The installer uses standard Windows Installer functions and includes no third-party installer plug-ins. The `.zip` contains only the app files. [electron-builder](https://github.com/electron-userland/electron-builder) · [WiX Toolset](https://github.com/wixtoolset/wix)
