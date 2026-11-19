# Local source-preservation commit manifest — 2026-10-23

## Scope and ancestry

- Branch: `codex/source012-portable-20261023`
- Commit parent before preservation: `0ad22117330609646bcd00847bf7aef77b40b35d`
- Fixed upstream baseline: `74226309ebd1211bdbeeace4323049c2c175f742`
- The pending tree had 84 changed/untracked files before this manifest was added.
- The changes are preserved in one commit because the pre-product WIP and later product restoration overlap in `desktop/App.swift`, `scripts/desktop/build.py`, and `src/wise_reader/app.py`. Splitting their hunks by reconstruction would risk losing or misattributing existing work.
- This is a local preservation commit only. It is not a release, PR, merge, or performance acceptance.

No Formal/Preview data, private migration package, credentials, NAS content, dictionary, runtime, build output, trace, or diagnostic data belongs in this commit.

## Source receipts

The first 51 paths were captured before the product restoration at `2026-10-23T16:59:51.914868+08:00`:

- local receipt: retained outside Git; workstation path omitted for publication.
- receipt SHA-256: `19fab38044a53976365899fda9c6143222c261a5e5e3bb3cd23797c647328e63`
- tracked patch SHA-256: `beeb04d1786e386437a3f92e84388aea82d3e30fff7bcf3ff134f01f8e23f75c`
- 48 of those paths still matched their recorded hashes before this commit.
- Three paths changed later as part of the product restoration: `desktop/App.swift`, `scripts/desktop/build.py`, and `src/wise_reader/app.py`. Their pre-product bytes remain recoverable from the receipt/patch above.

### Pre-product WIP: startup and resource governance

Source: recorded 51-path pre-product snapshot. Verification: source/fake-root tests listed below; no real App or real library was opened.

- `desktop/App.swift`
- `desktop/LaunchPolicy.swift`
- `scripts/desktop/backend.py`
- `scripts/desktop/build.py`
- `scripts/desktop/launch_policy.py`
- `scripts/desktop/RESOURCE_POLICY.md`
- `scripts/desktop/check_resource_policy.py`
- `scripts/desktop/resource_policy.py`
- `tests/desktop_launch_policy.swift`
- `tests/test_desktop_launch_policy.py`

### Pre-product WIP: portable migration, collections, PDF and learning compatibility

Source: recorded 51-path pre-product snapshot. Verification: 6 tokenizer tests, 94 API checks and targeted source tests; full GUI acceptance not claimed.

- `scripts/fetch_lexicon.py`
- `src/wise_reader/app.py`
- `src/wise_reader/collections.py`
- `src/wise_reader/collections_smoke.py`
- `src/wise_reader/collections_transfer.py`
- `src/wise_reader/engine.py`
- `src/wise_reader/l2.py`
- `src/wise_reader/pdf/paragraph_groups.py`
- `src/wise_reader/pdf/representation.py`
- `src/wise_reader/plugins/collections.py`
- `src/wise_reader/reading_learning.py`
- `src/wise_reader/store.py`
- `src/wise_reader/url_commit.py`
- `src/wise_reader/usage_feedback.py`
- `tests/fixtures/handoff_synthetic.md`

### Pre-product WIP: reader UI, annotation and performance draft

Source: recorded 51-path pre-product snapshot. Verification status: **included-unverified** for native performance. Build29 warm release-active JS intervals passed the bounded automated sample, but the first observed settle interval failed at 43 ms and the diagnostic reproduction localized 51 ms to rAF request-to-callback delivery. Strict 65 ms input, physical trackpad and true-cold acceptance are NOT RUN. No performance acceptance is implied by this commit.

- `web/annotation-ink.js`
- `web/annotation-layout.js`
- `web/annotation-reflow.js`
- `web/assist-popup.js`
- `web/collections-word.js`
- `web/collections.css`
- `web/dictionary-card.js`
- `web/page-curl-renderer.js`
- `web/pagination.js`
- `web/pdf-paragraph-groups.js`
- `web/plugins/collections.js`
- `web/plugins/notes.js`
- `web/plugins/progress.js`
- `web/plugins/translate.js`
- `web/plugins/tts.js`
- `web/plugins/typography.js`
- `web/reader-chrome.js`
- `web/reader.js`
- `web/reading-action-icons.js`
- `web/reading-evidence.js`
- `web/reading-interactions.js`
- `web/reading-learning.js`
- `web/reading-native-trackpad.js`
- `web/reading-wheel.js`
- `web/selection-range.js`
- `web/style.css`

## Product-restoration layer after the 51-path receipt

These 33 files were added or changed after the pre-product receipt to restore the product structure packaged and exercised as Build29. The prior targeted regression reported G1/S1/S2/M1/B1/A1/A2/T1 passing for that frozen bundle. Those results are historical evidence, not a claim that every current feature has full release acceptance.

### Native storage and packaged identity

- `desktop/Assets/EasySink.icns`
- `desktop/ReadingStorage.swift`

### Brand and application shell

- `web/app.js`
- `web/index.html`
- `web/brand.css`
- `web/manifest.webmanifest`
- `web/assets/brand/apple-touch-icon.png`
- `web/assets/brand/easysink-app.svg`
- `web/assets/brand/easysink-icon.svg`
- `web/assets/brand/easysink-mark.svg`
- `web/assets/brand/favicon-32.png`
- `web/assets/brand/icon-192.png`
- `web/assets/brand/icon-512.png`
- `web/assets/brand/icon-maskable-512.png`
- `web/assets/brand/macos-icon-1024.png`
- `web/plugins/importer.js`
- `web/plugins/library.js`

### Reading spaces and picturebook product structure

- `src/wise_reader/picturebook.py`
- `src/wise_reader/picturebook_edition.py`
- `web/picturebook-assistance.js`
- `web/picturebook-cast-catalog.js`
- `web/picturebook-cast-chapter.js`
- `web/picturebook-cast-scene.js`
- `web/picturebook-continuity.js`
- `web/picturebook-fox-chapter.js`
- `web/picturebook-fox-reading.css`
- `web/picturebook-fox-reading.js`
- `web/picturebook-learning-notes.js`
- `web/picturebook-rose-chapter.js`
- `web/picturebook-rose-scene.js`
- `web/picturebook.js`
- `web/reading-spaces.css`
- `web/reading-spaces.js`

## Pre-commit verification performed on the current tree

- `uv run --frozen pytest tests/test_tokenize.py -q`: PASS, 6 tests.
- `uv run --frozen python -m wise_reader.collections_smoke`: PASS, 94 API checks.
- `uv run --frozen pytest tests/test_desktop_launch_policy.py -q`: PASS, 5 tests.
- Swift LaunchPolicy executable test: PASS.
- `xcrun swiftc -typecheck -parse-as-library desktop/*.swift`: PASS.
- Tiny resource-policy checks: PASS, 11/11. The first shell wrapper used zsh's reserved `status` variable after the checker had already reported success; it was repeated with `rc` and exited 0.
- `git diff --check`: PASS.
- Pending-file sensitive-path/credential scan: no private package, private-key or API-secret material found; a workstation receipt path was later removed in the publication copy. Occurrences of `token` are application/session/undo token identifiers, not credentials.
- Formal all-file metadata digest before/after tests: unchanged at `ba85d99feb34d74f53deb764e579ca37fe9d239d2d1afce03ccca488e01bf442`.
- Preview all-file metadata digest before/after tests: unchanged at `c48b10cfad2d241dcbc5dd6abbbc6340e592f369a7d6def486afaef39612e0bb`.
- Formal and Preview open-handle checks after tests: none.

## Explicitly not claimed

- Native performance acceptance: NO-GO/INCOMPLETE; performance draft is included-unverified.
- Strict 65 ms operation, physical trackpad, true cold startup and human-perceived smoothness: NOT RUN.
- Full GUI/manual library acceptance: NOT RUN.
- Formal/Preview App startup or database validation during this preservation: forbidden and NOT RUN.
- Release, push, merge, PR update or publication: NOT PERFORMED.
