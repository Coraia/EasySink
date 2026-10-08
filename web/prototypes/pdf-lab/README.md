# PDF lab UI

This is the isolated PDF experiment UI for the shared T01 integration. It does not replace the production reader or establish conversion quality/production acceptance.

## Open

From the repository root, the backend-owned launcher is:

```sh
python3 scripts/pdf_lab_server.py start
```

Open `http://127.0.0.1:18866/static/prototypes/pdf-lab/index.html`. The lab service uses its own data directory. The UI session did not start/stop the service or change production port 8766. The existing backend was read back through HTTP during resource verification.

## Implemented UI

- Persistent server bookshelf; multipart import with a closable receipt panel. Closing the panel does not send a task cancellation. Response failure asks the reader to check the shelf before any new import.
- Server-reported engine availability and supported task actions. Actual complete/partial/error/model states remain separate from quality review.
- Reading edition in focus mode, native text selection, bounded current source page ±1 loading, at most six nearby page results, font controls and source page navigation. Source pages are explicitly labeled, without invented reading-page numbers or chapters.
- Local PDF.js original page rendering, actual DPR, one Canvas at a time, fit/zoom/rotation, and source-region highlighting under verified geometry. Canvas render completion and viewport visibility are separate events.
- Same-product block/character anchors for source round trips and font changes. A different conversion task without a reliable mapping produces an explicit unavailable state. The hidden reading DOM survives original-view inspection.
- Polling is serial; route/render tokens discard old results. Selection and pointer interaction defer current content replacement. BFCache return re-establishes the route subscription.
- Assets use only server-provided `asset_url` under the current book's same-origin API path. Missing structures/resources show explicit unavailable text; image fallback does not count as recognition success.

PDF.js is pinned to **6.4.299**, with its unmodified Apache-2.0 license and local worker, CMaps, fonts, ICC and Wasm resources. See `vendor/README.md` for provenance. There is no runtime CDN.

## Walkthrough handoff

The walkthrough session owns browser operation and its evidence. Repeat with a fresh book/no resume entry as well as a saved position:

1. Import → close receipt without opening → refresh shelf → reopen the same book. Readback should retain one book; repeat the same file and verify reuse. A CLI-prepared book is a separate preparation claim from successful browser file selection.
2. Open digital content → select text → change font → source icon/selection source → verify the highlighted source → zoom 125% → rotate 90° → verify that highlight intersects the actual scroll viewport → return to the same character/block position.
3. Jump beyond source page 50 in a suitable long sample. The request must name the current page and neighboring range; loaded, empty and failed ranges must have different UI states.
4. Switch views/pages during first loading; quickly switch books; keep text selected during a progressive result update. Old responses must not replace the current route or selection.
5. Reopen/refresh and use browser back with BFCache where supported; missing engines/resources, rejected ranges and task failure must remain honest.

These are reproducible manual steps, not claimed passes. The original first UI failure and the zoom/rotation failure belong to `outputs/pdf-walkthrough-20261008-0844/pdf-integration/`; see `docs/parallel/pdf-walkthrough-status.md` for the actual evidence boundary.

## Measurement artifact

Conversion details → “显示测量记录” → “导出本页测量 JSON” saves browser/viewport/DPR, source digest/IDs, task timing and events without source text. The browser also exposes `window.pdfLabEvidence.snapshot()` and dispatches `pdf-lab:metric` events. Key events:

- `import_requested`, `import_registered`, `import_failed_or_unknown`
- `original_requested`, `original_canvas_rendered`, `original_visible`, `original_failed`
- `source_region_rendered`, `source_geometry_unverified`
- `reading_text_visible` (actual text block intersects the viewport), `reading_fallback_dom_present` (DOM only), `reading_asset_visible` (loaded image intersects the viewport), `reading_asset_failed`
- `conversion_end_observed` (server task ending observed, quality_verified=false)

The UI retains at most 2,000 events and reports dropped count. This export supplements screenshots and independent server/conversion logs; DOM or task completion cannot replace quality or device acceptance.

CLI artifacts are in `outputs/2026-10-08-ui-cli-01/`: the original official archive, vendor SHA-256 manifest, initial checks and final checks. No unit tests/new E2E suite were written or run.

## Deferred

Formal learning tools, notes/bookmarks, paid enhancement, lifecycle/storage operations, complete version migration, real page curl/trackpad behavior, structured formula/table rendering, OCR candidate comparison and user prototype acceptance are outside this UI contribution. The right side of the reading layout is reserved for future selected translation; no simulated result is shown there.
