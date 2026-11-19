# Production paging integration — acceptance contract (2026-10-05)

The accepted prototype is the design baseline. Opening a book is focused; its
top hit zone opens a covering banner and icon toolbar. Dismissal consumes its
click. Blank left/right areas turn; prose, punctuation, selections, dialogs,
dragging and controls never turn accidentally. Showing tools never repaginates.

## Failure inventory, recorded before implementation

- Source loss, duplication, wrong order, UTF-16 anchor drift on single/double
  spreads, resize, font/density changes, progress seeks, reopen or chapter switch.
- Fixed-height overflow cuts text; long code/grammar needs local scrolling.
- Page textures capture the wrong side, stale font/theme, highlights or book;
  texture preparation blocks the click; GPU context/resource growth leaks memory.
- Shader/context/raster failure leaves a blank or frozen page; reduced motion
  still animates; background pagination steals frames from animation.
- Tools overlay shifts page geometry, passes dismissal through to lookup/turn,
  traps keyboard focus, or remains mounted on a different route.
- Word-card outside pointerdown closes before the click guard, causing a turn.
- Text selection, paragraph gaps, slider release and trackpad gestures conflict.
- Legacy utilities disappear during toolbar consolidation; disabled plugins
  leave orphan actions; closing notes loses its queued save.
- Translation source alignment, grammar slots, bookmark markers and playback
  break on the second page or a source block that spans both leaves.
- Late pagination/AI responses repaint another page after navigation/cancel.
- Fullscreen/responsive layouts show two cramped pages or fail to reflow height.
- Progress drag previews jump prematurely, mouse release does not seek, or return
  remembers a display page number rather than the original source location.
- Acceptance changes the user's notes, AI settings, or transmits their book.

## Engineering budget and gates

Use one reusable WebGL context/program/mesh per reader and a bounded page-texture
cache. Warm at most current and adjacent spreads. Pause background pagination
during animation. Benchmark prototype and implementation on the same local
browser/viewport without screenshot capture during measurement. Record pointer
to first frame, frame intervals, cache use and fallback; do not equate callback
rate with hardware scanout or report an unmeasured improvement. Investigate two
consecutive no-progress attempts before changing the hypothesis.

Run final E2E only after integration. Retain first failures, screenshots, frame
metrics, exact source-anchor evidence, reproducible steps and source hashes.
Use an isolated database and a localhost mock AI provider for mutations/AI;
the user's existing book is used only for local display/performance validation.

## Consolidated entrances

Bottom icons: directory, notes, progress, appearance, typography, more.
Top banner: bookshelf, title, reading save state, fullscreen.
More: assistance density, bookmarks, selected translation, speech, search,
reading traces, finish, archive, AI/speech settings, preferences, feature manager.
Selection actions stay beside the selected text; grammar stays inline and
translation stays in its dedicated right pane.
