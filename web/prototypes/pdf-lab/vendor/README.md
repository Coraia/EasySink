# Local PDF.js distribution

Pinned version: **6.4.299**, official Mozilla modern-browser prebuilt distribution.

- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Download: https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip
- Official setup: https://mozilla.github.io/pdf.js/getting_started/
- License: Apache-2.0, unmodified upstream `pdfjs-6.4.299/LICENSE`.

The library, worker, source maps, CMaps, standard fonts, ICC profiles and Wasm decoders are local copies from the same release. The full upstream viewer and sample document are not used. `app.js` configures each resource URL under this directory; it does not load a runtime CDN or external document service. Original PDF page rendering remains a separate view from conversion/OCR.

`build/` is intentionally ignored because these upstream generated files are not
reviewable application source. Restore the two runtime files on a fresh machine
with:

```sh
python3 scripts/fetch_pdfjs.py
```

`SOURCE.json` pins the official archive URL, archive size/SHA-256, the two
extracted file size/SHA-256 values and the tracked license. The fetcher refuses
to overwrite a mismatched existing resource. The desktop builder verifies the
same manifest and fails closed when either resource is missing or changed.

Historical archive/resource evidence is also described in
`../outputs/2026-10-08-ui-cli-01/`. CLI verification never substitutes for an
actual in-App original-PDF walkthrough.
