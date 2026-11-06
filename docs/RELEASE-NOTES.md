# Release notes

## 1.0.0 — first public build

Clipwright Studio 1.0.0 turns long recordings into finished short-form clips
without leaving the machine.

**Editor.** Multitrack timeline (video, overlay, audio, text and captions),
frame-accurate trims, split, ripple delete, insert and overwrite edits, snapping
to clip edges, the playhead and markers, clip groups, keyframed transform and
opacity, and on-canvas transform handles.

**Captions.** Word-level transcript with ten built-in styles, karaoke and
spoken-word emphasis at any speed, plus SRT/VTT import and export.

**AI workspace.** Moment scoring runs offline with no key: it reads the
transcript's own signals (hook language, pacing, question/answer shape, payoff)
and ranks candidates with a visible reason for each score. If you connect a
provider, the same workspace will use it for richer analysis and vision.

**Export.** Deterministic compositor → qtrle intermediate → H.264/AAC MP4
(`yuv420p`, `+faststart`), NVENC when the GPU supports it, and a validation pass
that probes the finished file and reports real problems instead of a green tick.

**Packaging.** Projects export to a single `.clipwright` file — a zip containing
the manifest, managed media, transcript and moments — and re-import on another
machine with a fresh project id. Double-click `.clipwright` files to open them.

**Privacy.** No accounts, no telemetry. API keys are encrypted with the OS
keystore. ffmpeg and whisper.cpp are bundled so nothing else needs installing.

### Installing

Download either artifact from the release page:

| file | notes |
|---|---|
| `Clipwright Studio-Setup-1.0.0-x64.exe` | per-user install, no admin prompt, registers `.clipwright` files |
| `Clipwright Studio-Portable-1.0.0-x64.exe` | single file, no install |

Verify the SHA-256 in `checksums.txt` before running.

This build is **unsigned unless the release says otherwise**, so Windows
SmartScreen will warn on first launch. That warning is expected for an unsigned
installer; the hash check is what actually protects the download.

Your workspace lives in `Documents\Clipwright Studio` and is never deleted by an
uninstall or an upgrade.

### Known limitations

- Windows x64 only.
- Offline transcription needs a model you download once (Settings ▸ Local
  models); without it the app says so rather than failing quietly.
- Unsigned builds trigger SmartScreen (see above).
