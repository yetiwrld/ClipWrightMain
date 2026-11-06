# Clipwright Studio

A native Windows editor for turning long recordings into finished short-form
clips: transcribe, find the moments worth publishing, cut them on a real
multitrack timeline, style captions, and export H.264 MP4s that are verified
before the app says "done".

Everything runs on the machine. ffmpeg and whisper.cpp ship with the installer,
the renderer is plain React in a hardened Electron shell, and the only network
traffic is what you explicitly ask for (an AI provider you configured, a model
download, an update check).

```
Documents\Clipwright Studio\
  Projects\<id>\project.json     timeline document
  Projects\<id>\media\           managed copies of imported media
  Projects\<id>\transcript.json  word-level transcript
  Projects\<id>\moments.json     scored clip candidates
  Exports\                       finished videos + .clipwright packages
  Models\                        ggml models you downloaded
  Logs\clipwright.log            rotating diagnostics log
```

## Highlights

- **Editor** — multitrack timeline (video, overlay, audio, text), frame-accurate
  trim/split/ripple/insert/overwrite, snapping to clips, playhead and markers,
  clip groups, keyframed transform and opacity, on-canvas transform handles.
- **Captions** — word-level transcript, 10 built-in caption styles, karaoke and
  spoken-word emphasis, SRT/VTT import and export.
- **AI workspace** — offline moment scoring that works with no API key, optional
  provider-backed analysis, one-click clip generation into a new project.
- **Export** — deterministic compositor → qtrle intermediate → H.264/AAC
  (`yuv420p`, `+faststart`), NVENC when available, then a real validation pass
  that probes the file and reports problems instead of pretending success.
- **Packaging** — projects export to a single `.clipwright` file (a zip: manifest,
  managed media, transcript, moments) and re-import on another machine.
- **Offline-first** — no accounts, no telemetry, API keys encrypted with the OS
  keystore.

## Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 |
| Runtime | none — Electron 33 and the binaries are bundled |
| Dev | Node.js 20+, npm 10+ |

## Develop

```bash
npm install          # electron's own binary download can be skipped:
                     # ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run dev          # electron-vite dev server + Electron window
npm run verify       # typecheck (main + renderer) then vitest
npm run build        # compile main, preload and renderer into out/
```

Useful scripts:

| script | what it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` for both tsconfig projects (the web one exits 0 even on errors — read the output) |
| `npm test` | vitest: timeline engine, scene graph, captions, scoring, project packages, shell argument parsing, renderer components |
| `npm run icons` | regenerate `build/icon.png`, `build/icon.ico` and the bundled brand PNGs from `ClipWright Icon.png` |
| `npm run fetch:binaries` | download ffmpeg/ffprobe (+ whisper.cpp) into `resources/` |
| `npm run dist:win` | NSIS installer + portable exe into `release/` |
| `npm run dist:dir` | unpacked build (fastest way to smoke-test packaging) |

## Build the installer

```bash
node scripts/fetch-binaries.mjs   # ffmpeg.exe, ffprobe.exe, whisper-cli.exe
npm run dist:win
```

Artifacts land in `release/`:

```
Clipwright Studio-Setup-1.0.0-x64.exe      per-user NSIS installer
Clipwright Studio-Portable-1.0.0-x64.exe   no-install single file
```

The installer is per-user (no UAC prompt), registers `.clipwright` files for the
current user, and never touches your workspace on uninstall.

CI does the same on `windows-latest` — see `.github/workflows/release.yml`. It
typechecks, runs the full test suite (including the ffmpeg render tests, which
need a real encoder), packages, verifies the produced PE files and their SHA-256
sidecar, and publishes a GitHub Release when a `v*` tag is pushed. Signing is
optional: without `CSC_LINK`/`CSC_KEY_PASSWORD` the build is unsigned and the
release notes say so, because SmartScreen will warn.

## Architecture

```
src/
  shared/     types, timeline ops, scene graph, captions, scoring, sanitising
  main/       Electron main: windows, IPC handlers, projects, ffmpeg, AI, updates
  preload/    contextBridge API — the renderer's only door to the system
  renderer/   React 18 + Zustand editor UI
```

Rules the code keeps:

- **`shared/` is the contract.** Main, preload and renderer all compile against
  the same types; the timeline mutations are pure functions returning new
  `Project` objects, so undo/redo is just a stack and the UI cannot corrupt state.
- **The renderer has no Node.** No `fs`, no `child_process`, no dynamic IPC
  channel names — `preload/index.ts` allow-lists every call.
- **Media never uses `file://`.** Files are served through the privileged
  `clipwright-media://` protocol, which keeps paths with spaces and unicode
  working.
- **The compositor is the source of truth.** Preview and export share
  `buildScene` and the same drawing code, so what you see is what is encoded.

## Keyboard

| Action | Keys |
|---|---|
| Play / pause | Space |
| Split at playhead | Ctrl + K |
| Ripple delete | Shift + Delete |
| Zoom in / out | Ctrl + = / Ctrl + - |
| Fit project | Shift + Z |
| Toggle snapping | S |
| Add marker | M |
| Export | Ctrl + E |
| Undo / redo | Ctrl + Z / Ctrl + Shift + Z |

The full list is in Help ▸ Keyboard shortcuts.

## Licensing

Application code is MIT. Bundled third-party components keep their own licences:

- FFmpeg binaries — LGPL 2.1+ (see `LICENSES/ffmpeg-NOTICE.txt`)
- whisper.cpp runtime — MIT (`LICENSES/whisper.cpp-NOTICE.txt`)
- Fonts (Inter, Montserrat, Poppins, Oswald, Anton, Bebas Neue, Playfair Display,
  JetBrains Mono) — SIL Open Font License 1.1 (`LICENSES/fonts-NOTICE.txt`)

Downloaded whisper models stay under the licence of their publisher; they are
not redistributed with the app.

## Verification

`docs/VERIFICATION.md` records what was tested, how, and what could not be
verified in the build environment (with the reason), rather than claiming a
level of confidence the build has not earned.
