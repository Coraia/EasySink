# macOS candidate

This is the first native-client slice of #36, with integration groundwork for #37
and #38. It reuses the Web reader in AppKit/WKWebView. It is not a signed,
notarized release or full V1 acceptance.

## Build

On an Apple Silicon Mac with Xcode command-line tools and `uv`:

```sh
python3 scripts/desktop/build.py --dependency-lock scripts/desktop/dependencies.lock --archive
# Reuse the prepared runtime and dictionary for subsequent frozen source changes:
python3 scripts/desktop/build.py --refresh-app --dependency-lock scripts/desktop/dependencies.lock --archive
```

The builder requires an existing uv-managed standalone CPython 3.12 and the
project's fetched dictionary resources. Build output is `dist/Wise Reader.app`
and, with `--archive`, `dist/Wise Reader.zip`. Preserve the generated dependency
lock, manifest, source hashes and ZIP digest with a delivery. Pass
`--dependency-lock dist/desktop-dependencies.lock` to repeat the resolved wheels.
Installed users need neither the repository nor Python, Swift, uv, or a running
development server. That was exercised with the relocated bundle on the
development machine; clean-machine installation remains unverified.

Build only after the main agent's source freeze. All production Python modules
and Web assets, including untracked formula/enhancement files, are included.
The two PDF/formula worker scripts and optional-runtime preparation helpers are
explicit resources. The builder rejects changed inputs during the build and
records per-source hashes. A refresh compares the canonical dependency lock and
installs newly required wheels (including the light `psutil` supervisor); it
does not silently reuse an outdated dependency set. An aborted build is not a
delivery even if an intermediate app/ZIP remains in its output directory.

## Run and data

Copy the generated application into a user-owned Applications folder and open
it normally. Candidate data lives in `~/Library/Application Support/EasySink
Candidate`, separately from the Web reader's personal library. No automatic
data or credential migration occurs. Closing the window keeps the process;
quitting drains reading saves and terminates its owned backend. Reopening a
window restores the current session. Interrupted PDF jobs remain paused until
the user resumes them.

The service binds its own loopback port and authenticates every request. It
does not attach to or kill a service on an occupied port. Versioned reading
preferences/drafts are scoped to a library identity independently of the port.
Remote navigation opens in the default browser; native bridges remain limited
to the app's own origin.

After system wake, the host checks its authenticated owned session without
reloading the reading page, selection or draft. An unavailable service exposes
Reconnect; it does not automatically resume conversion or paid requests.
Reconnect reinstates the session cookie before loading. These changes are
typechecked; actual sleep/wake and native UI acceptance remain pending.

## Optional local recognition

Basic reading, dictionary and digital PDF parsing do not need OCR. Models stay
outside the app. `desktop-mineru.json` in the candidate data directory stores
only the explicitly selected runtime manifest; it is separate from all text,
speech and enhancement AI settings. Inherited shell runtime overrides are
ignored. With no registration, the controlled default is
`DATA/ocr/mineru/runtime.json`, never the source checkout or read-only app.

Window → Connect Local Recognition Resources (连接本机识别资源…) selects a
prepared `runtime.json`, checks its pinned identity and installed file stats,
and takes effect after normal quit/reopen. No model is loaded or downloaded.
The manifest stays in its original location so all clients share the same
inference lock. A changed/missing runtime remains unavailable; existing books
and cached formula results remain readable. Keep that external directory.

For deployment/acceptance operators, the equivalent registration command is:

```sh
candidate_app="$HOME/Applications/Wise Reader.app"
candidate_data="$HOME/Library/Application Support/EasySink Candidate"
"$candidate_app/Contents/Resources/python/bin/python3" -I -B \
  "$candidate_app/Contents/Resources/app/scripts/desktop/runtime.py" \
  --data-dir "$candidate_data" --register /absolute/managed/mineru/runtime.json
```

Registering a developer venv does not make it portable. The current source
MinerU venv depends on Homebrew Python. A separately scheduled preparation
operation can copy supplied Python 3.12 model packages and models into a **new**
managed directory and use a copy of the app's standalone Python instead:

```sh
"$candidate_app/Contents/Resources/python/bin/python3" -I -B \
  "$candidate_app/Contents/Resources/app/scripts/desktop/prepare_ocr.py" \
  --venv /absolute/prepared/source/venv \
  --models /absolute/prepared/source/MinerU-4_models_onnx \
  --destination "$candidate_data/ocr/mineru-4.0.11-standalone" \
  --data-dir "$candidate_data"
```

This is an explicit multi-GB local copy/hash operation, not a startup task.
It needs supplied runtime material but no package resolver, model download,
Homebrew, Xcode or model inference. It uses copy-on-write when available,
rebases the venv to its managed Python, rejects escaping symlinks/non-system
absolute library loads, removes upstream build-only RPATHs on copies, and
renews their ad-hoc signatures with macOS codesign. It registers only after
actual ORT/PDFium imports and complete fingerprints succeed. Failure preserves
the previous registration and the new directory for diagnosis; choose a new
destination on retry. A complete prepared installation must remain at its
registered path. Resource installation is not OCR quality or notarization proof.

The separately authorized preparation was executed on 2026-10-10 with
`--no-register`, preserving the installed pointer. It includes a fallback copy
of supplied psutil 7.2.2 when the bootstrap app predates that dependency. The
managed runtime is physically ready at
`outputs/v1-final-closeout-20261010/desktop/standalone-ocr-20261010/runtime/`.
Restricted imports and one real CPU source-first page/formula request completed;
the formula request returned a visibly incorrect transcription of its tiny crop.
Runtime execution is verified; formula quality and clean-machine installation
are not accepted. Exact hashes, costs, preserved failures and activation steps
are in the adjacent `REPORT.md`. No installed library was activated.

Window → Save Experience Record exports rendering/input diagnostics without
book text or provider credentials. Raw generated events are not evidence of a
human touching or releasing a trackpad.

## Current limits

- Existing compressed package about 298 MB; unpacked about 1.06 GB, including about
  949 MB of required dictionary resources. This is a measured prototype cost,
  not a lightweight-distribution budget pass.
- Digital PDF dependencies are bundled. Optional OCR models are not; readiness
  must remain truthful. The public-paper conversion retained substantial image
  fallback and does not establish academic-text quality acceptance.
- Real human touchpad feel, mid-turn WebKit visual quality, clean-machine
  installation, sleep/wake and full PDF quality/performance gates are pending.

2026-10-10 desktop evidence and handoff:
`outputs/v1-final-closeout-20261010/desktop/REPORT.md`. After main's source freeze,
the fresh `final-build --archive` succeeded and the exact ZIP was extracted to
a new location. Its complete inventory, restricted-PATH imports (including new
formula/enhancement modules), private HTTP lifecycle and independent enhancement
configuration passed. See `FINAL-BUILD-REPORT.md` in that evidence directory for
the manifest, hashes, first harness failure and installation steps. Installation,
native operation and system sleep remain for main. The follow-up
prepared runtime is **2,086,110,691 bytes**, including its own standalone Python,
model packages, 858 MB of models and registration/integrity material. The actual
runtime smoke check does not accept native UI behavior or OCR accuracy.

Evidence and exact boundaries: `docs/parallel/client-host-status.md`,
`client-runtime-status.md`, `client-native-status.md`, and
`client-pdf-lifecycle-status.md` in the same documentation folder. Local raw
walkthrough artifacts live under `outputs/v1-implementation-20261009/`.
