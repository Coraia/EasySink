# Local PDF.js distribution

Pinned version: **6.4.299**, official Mozilla modern-browser prebuilt distribution.

- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Download: https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip
- Official setup: https://mozilla.github.io/pdf.js/getting_started/
- License: Apache-2.0, unmodified upstream `pdfjs-6.4.299/LICENSE`.

The library, worker, source maps, CMaps, standard fonts, ICC profiles and Wasm decoders are local copies from the same release. The full upstream viewer and sample document are not used. `app.js` configures each resource URL under this directory; it does not load a runtime CDN or external document service. Original PDF page rendering remains a separate view from conversion/OCR.

Archive and file SHA-256 evidence are recorded in `../outputs/2026-10-08-ui-cli-01/`. Only CLI resource verification has been performed by the UI session; browser compatibility and actual display are subject to the walkthrough session.
