# Release notes

## 1.0.6 — editing correctness

A pass over the editor's own math and state, not over features. Every item below
was a case where the app accepted an instruction and then did something subtly
different.

**Clip timing.** Durations are validated in one place. A typed duration, an
imported value or a programmatic patch can no longer produce a clip with a
negative, zero or non-numeric length — the kind of clip that exists in the
project but can never be drawn. The minimum clip length was 80 ms, shorter than
one frame; trims and splits now use a frame-aware floor and a manual retime has
its own, coarser floor so you cannot type a clip away.

**Undo.** A drag is one undo step. Move, trim, retime and on-canvas transforms
each recorded either one entry per pointer frame (undo flooded) or none at all
(undo skipped past the edit); a click that moved nothing recorded nothing. Undo
of a transform used to restore the state the drag had just created, i.e. do
nothing. Inspector edits — timing, style, volume — are now undoable; they
previously shared a code path that deliberately skipped history.

**Editing ranges.** Overwrite means trim, never delete. Two functions named
"overwrite" behaved in opposite ways: one cut media, the other destroyed whole
clips. An empty or inverted range is a no-op instead of duplicating a clip. An
insert edit no longer lays the new clip on top of one that straddles the
insertion point. Splitting or cutting an animated clip re-anchors its keyframes
at the cut with the sampled value, so the motion continues instead of jumping or
replaying.

**Tracks.** Mute, solo, lock and the eye toggle are enforced by one predicate
used by the preview, the exporter and the audio mix — they used to be three
copies that disagreed, most visibly about captions. Locking a track now also
blocks delete, ripple delete and split, not just dragging. A hidden or
solo-excluded track dims in the timeline so it is obvious why its media is not
in the frame.

**Removing a track** no longer leaves the selection pointing at deleted clips
(which made the Inspector show a ghost and turned the next Delete into a no-op).

**Captions.** Generating captions puts them on the caption track you have
selected and creates one if the project has none; it used to always use the
first caption track and replace every caption clip in the project. Clip
generation no longer crashes on a project without a caption or video track.

**Transcription.** A whisper model is checked before the runtime is started:
missing, empty, truncated, and "this is a faster-whisper model.bin, not a ggml
model" now each have their own message instead of an opaque non-zero exit. The
same goes for a binary that is present but not executable.

**Preview and export match.** Curved transitions (`fadeToBlack`,
`fadeFromBlack`, `dissolve`) were rendered with a linear fade on export while the
monitor showed the curve. The export now emits the preview's own curve; the
alpha values are compared against real ffmpeg output in the test suite.

**Performance.** Scrubbing coalesces to one update per animation frame, video
elements take one seek at a time instead of being restarted on every frame,
waveforms are fetched once per asset (and in parallel) instead of re-requesting
every asset on every load, and the playhead no longer writes to the store when
it has not moved. Autosave no longer resets its timer on every keystroke — which
meant a busy session might never save — and it skips writes during a drag.

### Installing

Download either artifact from the release page:

| file | notes |
|---|---|
| `Clipwright Studio-Setup-1.0.6-x64.exe` | per-user install, no admin prompt, registers `.clipwright` files |
| `Clipwright Studio-Portable-1.0.6-x64.exe` | single file, no install |

Verify the SHA-256 in `checksums.txt` before running.

This build is **unsigned**, so Windows SmartScreen will warn on first launch.
That warning is expected for an unsigned installer; the hash check is what
actually protects the download.

Your workspace lives in `Documents\Clipwright Studio` and is never deleted by an
uninstall or an upgrade.

### Known limitations

- Windows x64 only.
- Offline transcription needs a model you download once (Settings ▸ Local
  models); without it the app says so rather than failing quietly.
- Unsigned builds trigger SmartScreen (see above).
- The bundled-model digests are not pinned to publisher hashes yet (none are
  published upstream), so the model download is verified by size and by the ggml
  container check, not by a known-good SHA-256.

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
