# V1 client runtime slice

Owner: packaging/backend only. Main owns `desktop/`; native agent owns trackpad integration. No commit, push, issue writes, baseline edits, or unit tests.

## Agreed build and launch interface (2026-10-09)

Build: `python3 scripts/desktop/build.py`. Compile all `desktop/*.swift` with `App.swift` providing `@main`; emit `dist/Wise Reader.app` plus dependency lock, source/file SHA-256 manifest and costs. Existing uv-managed CPython 3.12.12 arm64 reused without a runtime download; final relocated process/import/PDF walkthrough passed below. Build requires Swift toolchain and uv; installed launch requires neither.

Layout:

```
Contents/MacOS/WiseReader
Contents/Resources/python/bin/python3
Contents/Resources/app/src/
Contents/Resources/app/web/
Contents/Resources/app/data/{stardict.db,lemma.en.txt}
Contents/Resources/app/scripts/pdf_lab_convert.py
Contents/Resources/app/scripts/desktop/backend.py
```

Host launches bundled `python3 -I backend.py --data-dir DIR --ready-file FILE --token NONCE`, with a kept-open stdin Pipe. Default data-directory policy belongs to host: Application Support/EasySink Candidate; `--data-dir` override enables isolated acceptance. Backend locks the supplied data dir, binds loopback itself (saved preferred port, fallback to port 0 when occupied), validates all requests using HttpOnly SameSite=Strict `wr_desktop_<port>` cookie, exact Host and same-origin checks. No unauthenticated health or token URL. Host waits for atomic 0600 ready JSON `{url,token,pid,cookie_name}`, checks nonce and its own Process identity, installs the cookie using WKHTTPCookieStore, verifies authenticated `/health`, then loads url. Host manages only its Process. Backend observes stdin EOF and SIGTERM for graceful uvicorn lifespan shutdown. Port changes are recorded in the isolated data dir for localStorage continuity diagnosis.

## Failure modes recorded before implementation

- Standalone Python links to its original installation or Homebrew, uses symlinks escaping bundle, needs missing dylibs, or carries incompatible extension wheels. Verify Mach-O dependencies and actual relocated imports/startup under restricted environment.
- Bundle accidentally includes `.env`, credentials, personal database, caches, evidence, models, prototypes, or editable dependency pointers. Copy explicit source/resource allowlist and only wheel-installed runtime dependencies; hash and inventory everything shipped.
- Read-only application resources receive SQLite journals, Python bytecode, model downloads, speech files or temporary conversions. Route mutable paths under data dir; readonly URI dictionary; disable bytecode and inherited settings; verify resource hashes after use.
- Readiness is published before ASGI lifespan or HTTP health; stale ready file or nonce points to unrelated process. Publish after real authenticated health, atomically at mode 0600; duplicate lock failure must not touch an owner's readiness.
- Saved port is held by another app; second launch concurrently opens one database. Bind before serving; on occupied saved port choose new port without contacting incumbent; flock data dir for process lifetime and record port switch.
- Cross-site fetch, form POST, null Origin, forged Host or unauthenticated request mutates/reads local data. Require session cookie on every route, exact loopback authority, reject foreign Origin and cross-site Fetch Metadata, including requests carrying a valid cookie.
- Native crash leaves server/conversion alive; SIGTERM bypasses cleanup; active worker remains paused or orphaned. Monitor stdin EOF and exercise real process teardown, inspect worker ownership/termination read-only; request main coordination for worker.py changes.
- Digitized PDF imports but light dependencies are absent, conversion process resolves repo venv, or reading text is never produced. Exercise actual bundled digitized-PDF conversion and retain first failure. OCR/model installation is separate and never an accuracy pass.
- Build/HTTP success is mistaken for native WebView acceptance, no-dev clean-machine proof, real gesture evidence or notarized release. This slice reports packaging/backend evidence only; main completes native UI walkthrough.

## Coordination

Main/sidecar supplied worker process-group teardown and controlled environment forwarding in `pdf_lab/worker.py` and validator cleanup in `pdf/uploads.py`; this slice made no worker/upload edits. Final relocated conversion uses bundled `sys.executable`, and both SIGTERM and stdin EOF terminate actual converter descendants. Host should retain stdin writer until quit and allow at least seven seconds for worker escalation. Text-AI shutdown under an in-flight external request remains outside these zero-credential checks.

Port conflict preserves backend data and records old/new ports in `desktop-port-changes.jsonl`, but the new origin has separate WKWebView localStorage. Main-owned follow-up: preserve/restore the allowlisted launch preferences independently of origin. This slice does not modify host/web state handling. A source readback also shows `checkReady()` currently injects the cookie and loads the reader directly: the host-owned post-cookie `/health` verification remains a coordination request (backend itself verifies authenticated HTTP before ready publication). Main owns native UI acceptance and copying to the installed candidate; installed copy was not touched here.

## Final delivered build

- `dist/Wise Reader.app` and `dist/Wise Reader.zip`, native arm64 executable, macOS minimum 13, bundle ID `com.coraia.wisereader.candidate`, local-network ATS. Swift `desktop/*.swift` compiled from `dist/desktop-source/` with `-parse-as-library`; those source hashes match the frozen current host/native files at final verification. Ad-hoc native/runtime signatures only; no notarized-release claim.
- ZIP: **297,494,185 bytes**, SHA-256 **2709976ac774c7a6565d7c208fbbbd60801fe1a8206dd69fa4948a4f20746d8b**. Unpacked file bytes: **1,059,602,835**. Required dictionary+lemma: **949,034,342**. Python+27 pinned dependencies: **94,455,286**. Final refresh: **7.82 s** to app/manifest inventory; **30.63 s** including archive. First build: 13.38 s without archive.
- Runtime uses existing standalone CPython **3.12.12**, upstream build **20260211**; no runtime download. `desktop-dependencies.lock` records exact wheel hashes, generated from existing `uv.lock` core versions plus pinned light PDF dependencies. Initial dependency installation prepared six packages; download progress for pdfminer-six (6.3 MiB), cryptography (3.7 MiB) and pypdfium2 (3.4 MiB) is retained in build.log; runtime download remained zero. Dependencies installed from wheels into standalone runtime, without copying either development venv. Python/Pillow build-specific dylib ID/RPATH removed and changed binaries re-signed.
- Only `src`, `web`, two scripts and dictionary/lemma go into app resources. Prototype UI omitted; `web/prototypes/pdf-lab/vendor` retained because production reader imports PDF.js. All resource files/directories made read-only; dictionary uses SQLite readonly immutable URI. APFS clones used for dictionary and one relocated bundle; refreshes reuse dictionary/runtime and update changed relocated files only.
- Optional OCR/model payload bundled: **0 bytes**. `docling` is truthfully unavailable in capability response; OCR download size **not measured/not proposed by this slice** and OCR accuracy **not evaluated**. This is a working digital-PDF candidate, not bundled OCR acceptance.

Build/reproduce from the shared checkout:

```sh
python3 scripts/desktop/build.py --runtime /Users/fish/.local/share/uv/python/cpython-3.12.12-macos-aarch64-none --dependency-lock dist/desktop-dependencies.lock --output /tmp/wise-reader-rebuild --archive
# Later host/web refresh without another Python/dictionary copy:
python3 scripts/desktop/build.py --refresh-app --archive
```

Per-file/source SHA-256 manifest, its digest, input/runtime record and native-load audit are in `dist/desktop-manifest.json`, `dist/desktop-manifest.sha256`, `dist/desktop-build-inputs.json`, `dist/desktop-native-dependencies.json`. Exact delivered copies and builder/backend source snapshots are retained in `outputs/v1-implementation-20261009/client-runtime/` with `-final` names.

## Actual runtime evidence

Final walkthrough: `outputs/v1-implementation-20261009/client-runtime/walkthrough-20261009-173620/`. Reproduction script: `client-runtime/relocated-walkthrough.py`, config: `relocation-final.json`; run `python3 SCRIPT CONFIG`. Every run creates fresh isolated data and preserves raw HTTP results/logs. Backend launched from relocated `Contents/Resources/app` cwd, with only bundled Python and a restricted PATH, with deliberately invalid inherited Python/DB/paid-credential sentinels. Native rendering and a truly clean machine are separate evidence.

- Readiness after actual ASGI startup and authenticated HTTP: **1.019 s** first launch; **0.951 s** persisted reopen. These measure backend readiness, not actionable reader latency. Atomic ready file was 0600 and matched owned PID+nonce.
- Every unauthenticated route tested rejected (health, root, static JS, documents); valid-cookie foreign Origin/null Origin/forged Host/cross-site and same-site requests rejected before mutation. AI text/speech credentials remained absent and disabled despite supplied sentinel environment and data-dir `.env`.
- Duplicate data directory exited **73**, preserving owner's readiness. Separate data directory used a different cookie name and rejected the other cookie. Preferred port reused on restart; occupied preferred port selected another owned listener and recorded switch; probe listener received no connection.
- Fixed bundled sample EPUB imported; document read, actual dictionary lookup, note, bookmark and resume ratio 0.37 survived backend exit/relaunch. CLI/HTTP evidence only; main performs native file chooser/reader verification.
- Fixed three-page synthetic digital PDF genuinely converted with bundled pdfplumber/PDFium, produced reading document and completed 3/3 pages in **1.739 s** upload-to-result. Zero OCR/cloud calls; this is actual engine execution on a synthetic fixture, not real-user PDF quality acceptance.
- Idle EOF exits 0 and removes readiness; SIGTERM exits 0 in **0.184 s**. During real 62-page conversion, observed supervisor/resource tracker/page engine all used relocated bundled Python. EOF stopped their process group in **0.282 s**, retained paused task with **32 completed pages**, cleared PID, and removed readiness. Prior v3 walkthrough separately proved active SIGTERM (0.280 s, paused 38 pages). No process group survived either observation.
- `macho-load-audit-final.json`: **45** Mach-O binaries, zero external non-system load/search paths. `dyld-images-final.json`: **533** actual loaded images, all from relocated bundle or macOS. `final-verification.json`: full delivered file hashes, absence of added files/bytecode, readonly resources, source snapshot agreement and preserved baseline snapshot checks.

## Preserved first failures and limits

- `first-build-failure.txt`: concurrent host edit caused Swift to reject input. Builder now snapshots Swift files and records exact hashes.
- `first-launch-resource-write.json`: Python startup wrote four encodings/sitecustomize pyc files before the Python hook ran. Fixed with read-only resources and verified no new files after final walkthrough.
- `walkthrough-20261009-173039/`: walkthrough script initially expected `reading_doc_id` at top level instead of `pdf.reading_doc_id`; engine had actually completed. Original script/results preserved, corrected harness rerun separately.
- `walkthrough-20261009-173135/`: uvicorn re-raised SIGTERM after lifespan before outer ready-file removal. Backend now owns SIGTERM/SIGINT; final actual process checks pass.
- `build-final-portable.log`: install_name_tool needed its resource directory writable during a rebuild. Builder now temporarily enables that generated directory and restores/read-protects it; successful rerun is `build-final-portable-v2.log`.
- Initial `relocation-audit.json` used otool `-L` and included LC_ID_DYLIB self-identities; definitive audit distinguishes identities from actual load commands. Its preserved output is not an external-dependency finding. The actual residual Pillow build RPATH was removed and final load audit passed.

No new unit tests or full E2E suite, commits, pushes, issue operations, baseline edits, personal data migration, paid requests, or changes outside assigned source ownership. `outputs/` contains reproducible evidence only. Main still owns native UI final acceptance, actual gestures, clean-machine installation and launch-origin preference migration. The user's reported native walkthrough/timings are separate from this slice's measurements.
