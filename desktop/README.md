# macOS client

The macOS desktop shell wraps the local Web reader in AppKit/WKWebView and bundles a standalone Python runtime. It is not a signed or notarized release build.

## Build

On an Apple Silicon Mac with Xcode Command Line Tools and `uv`:

```sh
python3 scripts/desktop/build.py --flavor production --archive
# Reuse the prepared runtime and dictionary after source changes:
python3 scripts/desktop/build.py --flavor production --refresh-app --archive
```

The builder requires a `uv`-managed standalone CPython 3.12 runtime (`arm64`), Xcode CLT (`swiftc`), the pinned PDF.js bundle (`web/vendor/pdfjs-6.4.299`), and local dictionary files under `data/`. Output is written to `dist/EasySink.app` (and `dist/EasySink.zip` with `--archive`).

### Build-flavor and data-root isolation

Each build compiles in one of three fixed identities that cannot be overridden via CLI arguments:

| Flavor | Bundle ID | Product | Fixed data directory |
| --- | --- | --- | --- |
| `production` | `com.coraia.wisereader.candidate` | EasySink | `EasySink Candidate` |
| `preview` | `com.coraia.wisereader.preview` | EasySink Preview | `EasySink Paragraph Preview Data 002` |
| `diagnostic` | `com.coraia.wisereader.diagnostic` | EasySink Diagnostic | `EasySink Diagnostic Data 001` |

Both native Swift startup (`desktop/LaunchPolicy.swift`) and Python backend startup (`scripts/desktop/launch_policy.py`) verify that the compiled flavor, `Info.plist`, packaged `desktop-build-flavor.json`, and canonical `~/Library/Application Support/<Fixed Data Directory>` match, reject symlinked or protected roots in diagnostic builds, and enforce single-instance locks (`NativeInstanceLock` and `desktop.lock`). Refresh builds (`--refresh-app`) refuse to change an existing bundle's flavor.

## Run and data

Copy the generated application bundle to a user-owned Applications directory and open it normally. Candidate data lives in `~/Library/Application Support/EasySink Candidate`, isolated from the local dev Web reader database.

- Closing the window keeps the app process alive; quitting drains pending reading saves and terminates the owned backend process.
- The backend binds a loopback port and authenticates every request with a per-launch cookie token.
- External links open in the default browser; the WebKit bridge is restricted to the app's own origin.
- After system wake, the host verifies the live session health without reloading the reading page or discarding unsaved state.

## Optional local recognition

Basic reading, dictionary lookup, and digital PDF parsing do not require OCR models. Local OCR runtimes remain outside the app bundle (`DESKTOP_DATA/ocr/mineru/runtime.json` or selected via **Window → 连接本机识别资源…**).

For deployment/acceptance operators, the equivalent CLI commands are:

```sh
candidate_app="$HOME/Applications/EasySink.app"
candidate_data="$HOME/Library/Application Support/EasySink Candidate"
"$candidate_app/Contents/Resources/python/bin/python3" -I -B \
  "$candidate_app/Contents/Resources/app/scripts/desktop/runtime.py" \
  --data-dir "$candidate_data" --register /absolute/managed/mineru/runtime.json
```

To stage a standalone OCR runtime copy using the bundled Python:

```sh
"$candidate_app/Contents/Resources/python/bin/python3" -I -B \
  "$candidate_app/Contents/Resources/app/scripts/desktop/prepare_ocr.py" \
  --venv /absolute/prepared/source/venv \
  --models /absolute/prepared/source/MinerU-4_models_onnx \
  --destination "$candidate_data/ocr/mineru-4.0.11-standalone" \
  --data-dir "$candidate_data"
```

**Window → 保存体验记录…** exports rendering and input diagnostics without book text or provider credentials.
