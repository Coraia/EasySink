# macOS candidate

This is the first native-client slice of #36, with integration groundwork for #37
and #38. It reuses the Web reader in AppKit/WKWebView. It is not a signed,
notarized release or full V1 acceptance.

## Build

On an Apple Silicon Mac with Xcode command-line tools and `uv`:

```sh
python3 scripts/desktop/build.py --dependency-lock scripts/desktop/dependencies.lock --archive
# Reuse the prepared runtime and dictionary for subsequent source changes:
python3 scripts/desktop/build.py --refresh-app --archive
```

The builder requires an existing uv-managed standalone CPython 3.12 and the
project's fetched dictionary resources. Build output is `dist/Wise Reader.app`
and, with `--archive`, `dist/Wise Reader.zip`. Preserve the generated dependency
lock, manifest, source hashes and ZIP digest with a delivery. Pass
`--dependency-lock dist/desktop-dependencies.lock` to repeat the resolved wheels.
Installed users need neither the repository nor Python, Swift, uv, or a running
development server. That was exercised with the relocated bundle on the
development machine; clean-machine installation remains unverified.

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

Window → Save Experience Record exports rendering/input diagnostics without
book text or provider credentials. Raw generated events are not evidence of a
human touching or releasing a trackpad.

## Current limits

- Compressed package about 297 MB; unpacked about 1.06 GB, including about
  949 MB of required dictionary resources. This is a measured prototype cost,
  not a lightweight-distribution budget pass.
- Digital PDF dependencies are bundled. Optional OCR models are not; readiness
  must remain truthful. The public-paper conversion retained substantial image
  fallback and does not establish academic-text quality acceptance.
- Real human touchpad feel, mid-turn WebKit visual quality, clean-machine
  installation, sleep/wake and full PDF quality/performance gates are pending.

Evidence and exact boundaries: `docs/parallel/client-host-status.md`,
`client-runtime-status.md`, `client-native-status.md`, and
`client-pdf-lifecycle-status.md` in the same documentation folder. Local raw
walkthrough artifacts live under `outputs/v1-implementation-20261009/`.
