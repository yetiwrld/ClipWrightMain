# Verification report

What was actually tested, what was not, and why. Written so a reader can decide
how much to trust each claim instead of taking a green checkmark at face value.

Commit: see `git log -1`. Environment: Linux x64 sandbox, Node 20, no Electron
runtime available (npm postinstall for the Electron binary is blocked by the TLS
policy here), no GitHub/npm network beyond the registry, no `root` for `apt`.
That single constraint is why packaging and the ffmpeg-dependent tests run in CI
rather than locally.

## 0. Latest status — a real Windows build was produced

GitHub Actions run [42215783621](https://github.com/yetiwrld/ClipWrightMain/actions/runs/42215783621)
on `windows-latest` completed every step, and the artifacts were published as the
pre-release `build-c585d1f` (rebuilt as `build-61bdda7` with cleaner file names):

| step | result |
|---|---|
| typecheck (main + renderer) | pass |
| vitest, including the 9 ffmpeg render tests | 115/115 pass (93 here + render/export tests on CI) |
| electron-builder (NSIS per-user + portable) | pass — 139.9 MB setup, 139.6 MB portable |
| asar contents (`out/main`, `out/preload`, `out/renderer`, `node_modules/fflate`) | pass |
| bundled `ffmpeg.exe` / `ffprobe.exe` run and report a version | pass |
| bundled fonts present | pass |
| **packaged exe boots** (`CLIPWRIGHT_SMOKE=1`, waits for `did-finish-load`) | pass |
| **real export through the compositor with the bundled ffmpeg** | pass — 1920×1080 h264/yuv420p + aac 48 kHz, 2.00 s |
| SHA-256 `checksums.txt` published with the assets | pass |

So the installer is no longer "configured but unverified": it was built, the
packaged application was started, and it encoded a video with the ffmpeg that
ships inside it.

## 1. Automated tests — 115 passed (106 here, 9 render tests on CI)

`npm test` (vitest, single fork, node environment).

| suite | tests | covers |
|---|---|---|
| `tests/editor.test.ts` | 22 | timeline engine and shared editing logic |
| `tests/ui.test.tsx` | 16 | renderer boot, onboarding, editor components (jsdom) |
| `tests/packages.test.ts` | 4 | `.clipwright` export/import round-trip |
| `tests/open-package.test.ts` | 3 | file-association argument parsing |
| `tests/logs.test.ts` | 3 | log tail reading (line window, empty file, live writes) |
| `tests/render.test.ts` | 9 | real ffmpeg encodes; run in CI, and locally against ffmpeg 9.0.2 |

Specific invariants asserted (not smoke tests):

- `splitClip` keeps the source mapping: `part2.sourceIn = sourceIn + part1.duration`.
- `trimClip` start clamps to `max(0, clip.start - clip.sourceIn)`; it cannot invent
  source material that does not exist.
- `insertClip` shifts every clip starting at or after the insert point;
  `overwriteClip` splits covered clips into head and tail instead of deleting them.
- `snapTime` snaps to clip edges, the playhead and markers within the threshold,
  and stays off when snapping is disabled.
- `buildScene` orders layers video → … → caption, derives a 1080×1920 canvas from
  a 9:16 aspect, and applies transition alpha only inside the transition handles
  (the layer is kept with opacity 0 rather than dropped, so timing stays stable).
- SRT and VTT round-trip through parse → serialise → parse without drift.
- Moment scoring is deterministic: identical input produces identical scores.
- The audio graph produces the expected filter chain for gain, fades, pan and
  ducking.
- Package export writes a real zip containing `project.json` and `media/…`, the
  manifest contains no absolute paths from the exporting machine, and import
  copies media into a *new* project id. Importing a package without media marks
  the assets missing rather than pointing at files that are not there. Corrupt
  and missing files throw a specific error.
- The renderer boots without a bridge crash, asks for capabilities and workspace
  info, mounts the onboarding flow on first run, opens the import wizard from a
  native menu command, and splits + undoes through the real store.

Two tests were corrected during authoring because the *expectation* was wrong,
not the code: trim-start clamping and insert-shift semantics. Both are recorded
above as the behaviour the editor actually guarantees.

## 2. Type checking

```
tsc --noEmit -p tsconfig.node.json   # main + preload + shared + tests
tsc --noEmit -p tsconfig.web.json    # renderer
```

Both clean at the current commit. Note `tsconfig.web.json` exits `0` even when it
prints errors, so the output was read, not the exit code.

## 3. Build

`npx electron-vite build` succeeds:

```
out/main/index.js        666.72 kB
out/preload/index.js      10.17 kB
out/renderer/index.html    0.72 kB
out/renderer/assets/index-*.js    1.10 MB
out/renderer/assets/index-*.css   61.04 kB
out/renderer/assets/icon-64-*.png  6.82 kB
```

The main bundle is large because the compositor, filters and AI prompt code live
in one process bundle; that is a deliberate trade (one file to load, no dynamic
chunk paths inside asar).

## 4. Packaging — configured, executed in CI

`electron-builder.config.cjs` produces an NSIS installer (per-user, no elevation)
and a portable exe. Targets and artifact names were validated by loading the
config through Node; `electron-builder` itself cannot run here because it
downloads the Electron distribution, which the sandbox network blocks.

What that means honestly: **the installer has not been built or launched in this
environment.** `.github/workflows/release.yml` does exactly that on
`windows-latest`, in stages that fail loudly:

1. `verify` — `npm ci`, install ffmpeg, typecheck, full test suite.
2. `build` — fetch binaries, generate icons, build, package, then *inspect the
   result*: `asar list` must show `out\main\index.js`, and the bundled
   `ffmpeg.exe`/`ffprobe.exe` must run with `-version` from the unpacked app.
3. Write `checksums.txt` (SHA-256 per artifact).
4. `verify-artifacts` — re-download the artifact, confirm both exes exist and are
   > 50 MB, recompute the hashes and compare, and check the installer is a valid
   PE header.
5. On a `v*` tag: create the GitHub Release with the installer, portable build,
   `checksums.txt` and `latest.yml` — the updater refuses an installer without a
   published checksum, by design.

Bundled resources (unpacked, executable from disk): `resources/ffmpeg`,
`resources/bin`, `resources/fonts`, `LICENSES`. `fflate` is the only runtime
dependency inside `node_modules`; everything else is compiled into `out/`.

`scripts/fetch-binaries.mjs` downloads ffmpeg from gyan.dev (SHA-256 printed and
pinnable through `FFMPEG_SHA256`) and whisper.cpp from GitHub Releases, records
`resources/ffmpeg/BUILD.txt` + `resources/binaries.json`, and **fails** if
ffmpeg/ffprobe are missing — an app that cannot import or export is not a
shippable build. whisper.cpp is treated as optional: if the download fails the
build continues, and the app reports offline transcription as unavailable at
runtime instead of lying about it.

## 5. Known limitations (and what they mean for the user)

- **The binary has not been executed in this Linux sandbox.** It has been
  executed on `windows-latest` (see section 0); what remains unverified is a
  human clicking through the UI, and the NSIS installer itself (the *unpacked*
  app was launched, not the installer's silent-run flow). First launch happens on the
  CI runner / the user's machine. The workflow asserts the shapes that can be
  checked without a GUI.
- **Render tests need ffmpeg.** They are skipped locally and executed in CI. They
  cover the real encoder path: segment cuts, argb intermediate, concat, audio
  muxing and the validation probe.
- **ffprobe is optional at runtime.** When only `ffmpeg` is present, `probe.ts`
  parses the `ffmpeg -i` banner for duration/resolution/streams.
- **Offline transcription needs both** `whisper-cli` and a ggml model. Missing
  either one shows as unavailable; there is no silent fallback to "it works".
- **An unsigned build triggers SmartScreen.** The release notes state this
  explicitly and the checksums are published, rather than implying the warnings
  are a bug.
- **The updater will not install unverified bytes.** It requires a published
  SHA-256 for the installer and refuses otherwise. That is intentional.
- Electron itself could not be launched in this sandbox, so window behaviour
  (title bar overlay, protocol privileges, file dialogs) is verified by code
  review and by the jsdom component tests, not by clicking through it.

## 6. Packaging checklist for a release

1. Bump `version` in `package.json`.
2. `npm run verify` locally.
3. `git tag v1.0.0 && git push origin v1.0.0` — CI builds, verifies and
   publishes.
4. Confirm on the release page: installer, portable exe, `checksums.txt`,
   `latest.yml`; and that the release body says whether the build is signed.
5. Install on a clean Windows machine, import a video, export, and check that
   Settings ▸ Processing reports the bundled ffmpeg as detected.
