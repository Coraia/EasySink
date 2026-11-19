# macOS diagnostic build isolation — 2026-10-23

## Purpose

This change prevents a diagnostic executable that is relaunched without its
original command-line arguments from falling back to the protected Formal or
Preview library. It follows two unintended Formal launches caused by using the
same bundle identity for production and diagnostic App copies.

This is source/fake-root validation only. No real EasySink App was launched,
no App was built, and no Formal or Preview database was opened.

## Fixed build identities

| Flavor | Bundle ID | Product name | Fixed data directory | Root ID |
| --- | --- | --- | --- | --- |
| production | `com.coraia.wisereader.candidate` | EasySink | `EasySink Candidate` | `easysink-formal-candidate` |
| preview | `com.coraia.wisereader.preview` | EasySink Preview | `EasySink Paragraph Preview Data 002` | `easysink-preview-002` |
| diagnostic | `com.coraia.wisereader.diagnostic` | EasySink Diagnostic | `EasySink Diagnostic Data 001` | `easysink-diagnostic-001` |

`scripts/desktop/build.py --flavor` selects matching Swift compile flags,
Info.plist fields, product/bundle name and a packaged
`desktop-build-flavor.json`. A refresh refuses to infer or change an existing
output's flavor.

## Fail-closed sequence

1. Native code compares the compile-time profile with the actual bundle ID and
   the packaged Info.plist flavor before constructing `NSApplication`.
2. Runtime data-root or flavor overrides are rejected for all builds.
3. Production and Preview retain their separate normal no-argument GUI roots.
4. Diagnostic no-argument, argument-stripped, reopen and LaunchServices-style
   launches always resolve to the compile-time diagnostic root.
5. Diagnostic root must already exist, be canonical, current-user-owned and
   mode `0700`. Its mode-`0600` non-symlink marker must match schema 2, role,
   root ID and diagnostic bundle ID.
6. A native `O_NOFOLLOW`/`flock` lock is acquired before `NSApplication`,
   ReadingStorage, logs or backend startup. Duplicate instances fail with no
   database open. The lock file must be current-user-owned and private.
7. Backend independently reads the packaged build manifest and Info.plist,
   compares flavor/bundle/root identity, and repeats fixed-root and marker
   validation before mkdir, lock, isolation or application imports.
8. UI automation receives only a pre-existing PID. `ui_target.py` verifies PID,
   executable path/hash, process start time and bundle ID and never launches or
   activates an App.

## Source and fake-root verification

- Python fixed-root/backend/UI-target suite: PASS, 6 tests.
- Existing tokenizer suite: PASS, 6 tests.
- Combined targeted pytest run: PASS, 12 tests.
- Swift fixed-root/duplicate-instance suite compiled and passed separately for
  production, Preview and diagnostic flags.
- Full `desktop/*.swift` typecheck: PASS for all three build flags.
- Collections smoke: PASS, 94 API checks.
- Tiny resource policy: PASS, 11/11.
- Python syntax compilation and `git diff --check`: PASS.

Covered cases include no arguments, stripped/override arguments,
LaunchServices-equivalent repeat resolution, duplicate instance lock, bundle
and flavor mismatch, missing/old/wrong marker, root and marker permissions,
root and marker symlinks, protected-root rejection, backend identity forgery,
Info.plist/manifest mismatch, missing/PID-mismatch/path/hash/bundle UI targets,
and unchanged fake Formal/Preview trees.

## Protected-data boundary

Formal and Preview were checked only through all-file metadata records; no
SQLite API was used.

- Formal before/after digest:
  `ba85d99feb34d74f53deb764e579ca37fe9d239d2d1afce03ccca488e01bf442`
- Preview before/after digest:
  `c48b10cfad2d241dcbc5dd6abbbc6340e592f369a7d6def486afaef39612e0bb`
- Post-test `lsof +D`: no handle in either tree.
- `WiseReader`, EasySink backend and recorded ports 49181/63671: inactive.

## Not run

- App build/signing and bundle-level integration: NOT RUN.
- Finder/LaunchServices invocation of a real App: NOT RUN.
- Any Formal or Preview App launch/database access: NOT RUN.
- Performance, physical trackpad and strict 65 ms work: NOT RUN.
- Push, merge, PR or release: NOT PERFORMED.
