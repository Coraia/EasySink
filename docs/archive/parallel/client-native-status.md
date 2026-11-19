# Client native gesture integration — ticket #37

## New unrelated shutdown fix — note mutations

2026-10-09, separate assignment. Only `web/plugins/notes-store.js` and this
section are owned for this fix; the frozen Swift and native JS remain untouched.

Failure modes recorded before code:

- `remove()` marks entries deleted synchronously, then awaits their existing
  save chains before DELETE. `flush()` currently excludes those entries and can
  finish while removal is still waiting, allowing shutdown before DELETE occurs.
- An already-issued DELETE or undo POST can remain pending without a non-deleted
  entry. Looking only at entry save chains misses these mutations entirely.
- Discard also waits for a save before removing the draft. Shutdown must await
  its full mutation, not just the saved-note collection.
- A single snapshot can miss another mutation started while flush is waiting.
  Drain the shared in-flight mutation set until empty.
- A rejected delete/undo must still reject to its UI caller, restore deleted
  flags as before where applicable, and prevent the concurrent flush from
  reporting success. Wait for other pending mutations even after a rejection.
- A successful delete is terminal. Flush must not re-save tombstoned entries or
  recreate removed notes; preserve existing UI notifications and error handling.
- Promise cleanup must not create an unhandled rejected `finally()` branch.

Plan: track original save/remove/undo/discard promises independently of entry
visibility; flush queues live saves, drains all tracked mutations, and returns
false on concurrent mutation rejection or remaining live failed entries. Main
owns targeted UI verification. No unit tests will be added.

Implemented: save chains and full remove/undo/discard operations now enter a
shared in-flight set. Flush drains it with `Promise.allSettled` until empty and
checks both concurrent mutation failures and current live entry save failures.
Removal still marks entries deleted synchronously, waits for saves, and performs
the same DELETE/cleanup; rejection still restores its flags and reaches the UI
caller. Undo and notifications retain their original behavior. Successfully
deleted entries are never queued again by flush.

Validation: `node --check web/plugins/notes-store.js` and owned-file
`git diff --check` passed. No unit tests or UI walkthrough were run in this
assignment. Main's targeted UI checks should delay save then delete, delay DELETE
itself, and delay/fail undo while quitting; verify shutdown waits, errors still
surface, and successful deletion remains deleted after reopening. The prior
native source freeze is unchanged.

2026-10-09. Source frozen for the bundle build. Integration implemented; physical
Mac trackpad and visual/performance acceptance remain pending.

## Ownership and host contract

Owned files: `desktop/NativeTrackpad.swift`, `web/reading-native-trackpad.js`,
`web/reading-trackpad.js`, and this status file. Preserve the pre-existing dirty
range-handoff changes in the native JS adapter. No renderer changes, commits,
pushes, issue updates, or unit tests.

Host API (main actor): retain `let trackpad = NativeTrackpad()`, call
`trackpad.attach(to: webView, origin: runtimeURL)` **before loading** the owned
loopback app URL, and call `trackpad.detach()` on window teardown. Attach installs
a main-frame document-start capability script. The supplied URL pins scheme,
host, port and app pathname (hash routes may change). Main owns `desktop/App.swift`
and its separate route-restoration script; detach must preserve that script.
The browser plugin must install immediately when
`window.wiseReaderDesktop?.nativeTrackpad === true`, before any API discovery.
The ordinary browser WebSocket discovery/reconnection path remains available.
The capability object is extensible: the lifecycle owner may set
`window.wiseReaderDesktop.prepareToClose`. Detach only sets `nativeTrackpad` false
and preserves other lifecycle properties.

## Failure modes recorded before implementation

- Attach after load misses capability discovery; duplicate attach/listeners cause
  double turns; detach leaves monitors or injected hooks alive; removing all user
  scripts loses the host's route restoration. Reattach must be idempotent.
- Another window/app, sheet, unrelated URL, same-origin non-app document or child
  frame gains input capability. Bind native delivery and injected code to the
  exact owned loopback app; reject foreign navigation and stale deliveries.
- Native point coordinates use bottom-left points while DOM uses top-left CSS
  viewport pixels; Retina, page zoom or pinch magnification misroutes hit tests.
  Convert view coordinates, account for page zoom and visual viewport scaling;
  preserve the PhaseMonitor negative scrollingDeltaX/Y convention.
- Pointer history is stale at first scroll; use each native event's coordinates
  with DOM hit testing. Notes, focused inputs, selection, word cards, tools,
  dialogs, modifiers, mouse buttons and outside-stage scroll must not turn pages.
- Async native delivery races DOM wheel delivery; never swallow unrelated native
  scroll. The existing DOM wheel listener owns only eligible horizontal input.
- A quiet contact interval is mistaken for release; zero-delta ended/cancelled
  is dropped; momentum creates extra movement; rejection resumes a half gesture.
  Forward real phases unchanged, require a new began after interruption, and use
  the existing controller's explicit release/cancel path without contact timers.
- Blur, hidden page, navigation, zoom or detach strands a grabbed paper. Cancel
  explicitly; do not let later momentum or changed-only input restart it.
- Desktop accidentally opens the browser bridge, retries forever or subscribes
  twice. Choose one transport at install and preserve browser recovery.
- DOM-dispatched `source: 'macOS-NSEvent'` is misreported as physical evidence.
  Count DOM transport separately; native monitor records and human observation
  are still required. Source strings and synthetic phases prove no hardware use.
- Swift compiles only against assumed APIs or JS fails to parse. Compile with the
  installed Apple SDK and check both JS modules; retain first diagnostics here.
- Reused paper rendering can still regress in WKWebView. Compile/fixture checks
  cannot satisfy clear text, measured frame/settle performance or human feel.

## Verification boundary

Validate Swift compilation and JS syntax first. Use targeted real-engine
walkthroughs if the host is available; no new unit tests or full development E2E
suite. Final host/bundle integration, fixed EPUB single/double-page walkthrough,
real trackpad phases, pause/reverse/continuous/alternating turns, P50/P95/max,
first failure and user acceptance remain explicit gates. Stop repeated validation
attempts after two no-progress failures and report the external blocker.

### First validation result

Both JS modules pass `node --check`; `git diff --check` passes. First Swift 6
strict compile found `sending 'note' risks causing data races` at the notification
callback's main-actor boundary. The fix extracts the actor-bound `NSWindow` before
entering `MainActor.assumeIsolated`, instead of capturing the untyped Notification.
This first diagnostic is retained. The rerun compiled and linked successfully
with Swift 6 and warnings treated as errors.

## Frozen delivery

`NativeTrackpad()` is an `@MainActor` object with
`attach(to: WKWebView, origin: URL)` and `detach()`. Attach installs one local
NSEvent monitor and a main-frame, exact-origin/app-path document-start script.
Reattach replaces the old monitor/hook. Detach preserves other user scripts and
the extensible desktop object's `prepareToClose` lifecycle hook. The monitor
always returns the original event; it requests no global event permissions.

The desktop install gate now runs before the discovery fetch. DOM events use
the existing paper controller and gesture policy. Stationary/no-event contact
has no release timer; ended, cancelled and momentum transitions drive the
existing release logic. Native window/modifier gates and DOM point/input/tool/
selection gates reject unrelated input. After interruption, a fresh began is
required. The pre-existing range-handoff changes remain intact.

Native `recentEvents` (bounded to 256 records), `deliveryError`, and `isAttached`
are available to the host for diagnostics. Native records themselves can contain
programmatically generated NSEvents. The DOM counter `domEvents` is separate
from `physicalEvents`, and DOM `source: 'macOS-NSEvent'` never increments the
latter. DOM records are bounded and published at controller transitions, avoiding
serialization of the entire history on every changed event.

Source SHA-256 at freeze:

```text
276602caa4674fdab4c155531b53f4a927c2401c6545e62adf7ab79ecb928649  desktop/NativeTrackpad.swift
291c29f26fdcb960eebc6d2e4161bf0c25f33253c7cbd5d72c21fce312e70173  web/reading-native-trackpad.js
461020b6b7d5e7d9504841921a84e1cab2df560d47bc44977afa626f3463933a  web/reading-trackpad.js
```

## Completed bounded checks

Environment: macOS 26.6.2 (25G83), arm64, Apple Swift 6.4. Source snapshots and
hash manifest are in `/tmp/wise-reader-native-20261009-webkit/`.

```sh
xcrun swiftc -swift-version 6 -warnings-as-errors -parse-as-library -emit-library desktop/NativeTrackpad.swift -o /tmp/libWiseReaderNativeTrackpad.dylib
xcrun swiftc -warnings-as-errors desktop/App.swift desktop/NativeTrackpad.swift -o /tmp/WiseReaderNativeIntegrationCheck
node --check web/reading-native-trackpad.js
node --check web/reading-trackpad.js
```

All passed. Host compilation used main's shared `App.swift` without editing it.
Final JS syntax and owned-file whitespace checks also passed after logging was
bounded. No unit tests, full suite, commits, pushes or issue writes were made.

Existing browser regression command:

```sh
WR_E2E_EVIDENCE=/tmp/wise-reader-native-20261009-browser-check npx playwright test tests/browser/reader-native.spec.js --grep 'contact holds|tools, notes'
```

Three passed in 11.2 s: single/double hold, reverse, end, rapid/alternating order;
tools, selection, zoom, Escape and disconnection. This uses generated WebSocket
phases and Chromium, not physical input or installed-client acceptance. Evidence:
`/tmp/wise-reader-native-20261009-browser-check/results.json`, `results/`,
and `report/index.html`. The full suite was not run.

The additional temporary WKWebView walkthrough loaded the actual app modules
against `scripts/test_server.py`'s disposable database with the production Swift
bridge. It exercised the document-start hook by invoking that hook with generated
payloads, **not by sending a physical or synthetic native scroll**. First run:

- Desktop installed immediately with zero native discovery fetches; lifecycle
  `prepareToClose` remained writable and installed.
- One-second hold, reverse cancellation, explicit release and ignored momentum
  passed. DOM count was 8, physical count 0; native monitor records were 0.
- Programmatic point hit tests worked at pageZoom 1.25/1.5 and magnification 1.3.
  WebKit reported widths 880/733/846 for the 1100-point view, respectively. This
  checks the injected coordinate path, not actual NSEvent point calibration.
- Detach disabled input while preserving lifecycle and another user script;
  reattach restored one hook. Navigating from 127.0.0.1 to localhost did not gain
  the capability or hook.

First-run artifacts, preserved before any follow-up:

- `/tmp/wise-reader-native-20261009-webkit/first-walkthrough.json`
- `/tmp/wise-reader-native-20261009-webkit/first-run.log`
- `/tmp/wise-reader-native-20261009-webkit/first-held-page.png`
- `/tmp/wise-reader-native-20261009-webkit/Walkthrough.swift` (reproduction driver;
  later adds a 45-second hold for attempted visual inspection).

To reproduce, start a **fresh** `.venv/bin/python scripts/test_server.py`, enable
non-auth plugins and disable AI using the existing `reader-helpers.js` setup,
then POST a disposable `/api/documents` document with 60 paragraphs of repeated
English prose. Save its response as `document.json` in the evidence directory.
Compile the driver with the frozen bridge and run it:

```sh
xcrun swiftc /tmp/wise-reader-native-20261009-webkit/NativeTrackpad.swift /tmp/wise-reader-native-20261009-webkit/Walkthrough.swift -o /tmp/wise-reader-native-20261009-webkit/Walkthrough
/tmp/wise-reader-native-20261009-webkit/Walkthrough
```

The first run used document 1 at `http://127.0.0.1:18767/#/read/1`; source text
and response are in `document.json`. The temporary service was stopped after
checks; the normal user service/database was not used.

## Open evidence and handoff to main

**Visual gate remains open.** `first-held-page.png`, captured by WKWebView's
snapshot API, visibly contains large black regions and inconsistent text scale.
The transport assertions passing do not override this image. It is not yet
established whether the defect is in snapshot capture or live rendering; no
renderer file was changed. Native UI inspection could not resolve the unbundled
temporary executable through the available app inventory, so no live-screen
claim is made. Main should inspect the built candidate's held page.

Raw first-run WebKit metrics retain the whole sequence: the turn following the
one-second hold reports P95 frame interval 1181 ms, and the next one-step
generated turn reports 40 ms. Release durations were 112/124 ms, with
input-to-landing 144/160 ms. These sparse generated sequences are not a continuous
input benchmark and do not establish the <34 ms frame gate. No tail was removed.

The follow-up visual probe failed its `stationary hold` assertion and is retained
in `walkthrough.json`/`visual-run.log`. Its record shows tracking on page **1**;
the driver incorrectly still required page **0** after the first run had saved
progress in the same disposable database. This is a reproduction-precondition
failure, not evidence of a physical hold failure. No extra matrix/rerun was made
after main requested the freeze. A fresh database is required for reproduction.

Main can now build the frozen source. Installed bundle behavior, live visual
quality, actual event coordinates/window gating, human contact/handfeel and
representative full-sequence performance remain pending. JS dispatch, the native
source label, compile success and generated-phase checks do not satisfy those
gates.

## Apple primary references

- [Monitoring Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html):
  local monitors run on the main thread, observe this app, can return the original
  event, and must be removed during lifecycle teardown.
- [Handling Trackpad Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingTouchEvents/HandlingTouchEvents.html):
  scroll phase and momentum phase are distinct; preserve ended/cancelled and do
  not infer raw finger contact from arbitrary gesture touch queries.
- [WKUserScript](https://developer.apple.com/documentation/webkit/wkuserscript)
  and [pageZoom](https://developer.apple.com/documentation/webkit/wkwebview/pagezoom):
  inject before app modules execute; page zoom scales content relative to bounds.
- [WKWebView magnification](https://developer.apple.com/documentation/webkit/wkwebview/magnification):
  pinch scaling is separate from the page zoom factor.
