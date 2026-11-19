# V1.1 collections UI handoff

Status: assigned UI implementation handed off on 2026-10-11. Parent has started the actual browser walkthrough on port 18772 and takes over subsequent small UI repairs. This contributor edited only the seven new frontend files below and this handoff. No commits/push/issues, production data/config writes, service restarts, new unit tests, mocks, seeded production records, full E2E runs or real-model calls.

## Changed files and delivered behavior

- `web/plugins/collections.js`: plugin lifecycle, prepare-reading/read/word/home hooks, global route, selection action `collections-highlight`, per-book tool, controller and bounded neighboring-packet invalidation after record mutations.
- `web/collections-store.js`: production collection API calls, view-scoped cancellable reads, explicit writes allowed to finish after view disposal, desktop-close flush and version-protected server undo.
- `web/collections-marks.js`: exact visible UTF-16 source spans (including punctuation/partial words/cross-block ranges), independent word/excerpt decorations, detached paper capture support, immutable contextual annotation overlay.
- `web/collections-word.js`: independent 收藏词语 / 已懂这里 / 保留注释; hide old global verdict controls while enabled; dictionary/assist record event support; saved explanation preview/adoption entry. Reuses parent dictionary rendering when present. Final requested ordering fix uses `.dictionary-candidates || .meaning || h3` as the insertion anchor, so definitions precede record actions, including late dictionary insertion.
- `web/collections-list.js`: current book/article and global paginated lists, type/query/book filters, explicitly labeled grouping of loaded word occurrences, selection, detail/source/ordinary-delete actions; real resurface GET/next/snooze/hide/show without generated content or provider requests.
- `web/collections-dialogs.js`: source snapshot preview, source recheck before explicit continue, current-context disclosure for historical but reliably resolved sources, missing-source reasons; debounced revision-guarded personal meanings with recovery drafts, conflict comparison, explanation adoption/history and merged subrange histories; real JSON/Markdown download/import and separately selected, explicitly scoped permanent cleanup.
- `web/collections.css`: approved paper/green/ochre visual treatment, scoped list/card/modal/word controls, responsive layouts. Persisted excerpt underlines stay visually distinct from temporary selection; mark spans also carry inline decoration for detached serialization.

Ordinary deletion uses the backend token and preserves independent notes. Cleanup selects record classes explicitly; global scope is export-only, and cleanup is restricted to one book or selected collection IDs. Restore submits the real exported structure; all origin matching and duplicate detection remain on the production backend. There is no automatic model call in this plugin.

## Failure classes (recorded before any isolated check)

- Invalid UTF-16 ranges, partial words, cross-block/page ranges, changed source versions, image objects or unavailable sources must never mark/jump to guessed text.
- Repeated save, intersecting union, bridge union, whole-record delete, undo conflicts and late GET responses must not resurrect deleted records or erase independent word records/notes/subrange explanations.
- Word-card state must keep save, understood and retained separate; contextual retained annotations override contextual understood while legacy feedback remains intact elsewhere.
- Off-page text, pagination, native selection, texture capture, PDF inline objects and plugin disposal must preserve source coordinates and existing interactions; no whole-book redraw or fetch per turn.
- Slow/offline/failed requests, route exit, disposed scopes, duplicate clicks, concurrent personal-meaning edits and revision conflicts must remain visible and must not silently overwrite or retry mutations/paid requests.
- Source preview must not write resume position or open another book; missing/historical identity must disable continue until the source API explicitly confirms availability.
- Paged lists/grouping must retain every loaded occurrence and expose remaining results. Export/import/cleanup must name exact scope and independently select record classes.
- Resurfacing must consume only the production endpoint, remain outside reading, refresh on deletion, and never fabricate empty-state records.
- All remote text must be escaped/textContent. Dialog focus/Escape/backdrop, small viewport, keyboard controls, file size and download errors need final browser acceptance.

## Exact integration contract

- Default-enabled catalog id `collections`; global route `collections`; nav “词句收藏”; reader tool id `collections`. The plugin dynamically links its own stylesheet. Parent owns catalog, sidebar/dock placement and packaging all new modules/CSS.
- `await ctx.run('prepare-reading', reader)` **before the first draw/indexSource**, both for normal Reader and lightweight prepareRange readers. The hook creates the controller and loads only `/api/collections/state/{doc_id}`. When `reader.collectionsSeed` exists, it uses that exact raw payload with no repeat request. Successful reads update the same property. Pass the target prepared reader's seed through handoff; do not share it with a different source document.
- Preparation binds no DOM listeners or tools and needs only `reader.doc` plus `reader.scope.signal`. `read` reuses the controller and binds the UI. The prepare stage does not request a reflow; the first draw applies the overlay. A compatibility host that omits prepare gets one initial `annotations-change` event after loading feedback.
- `reader.collectionsController.applyAnnotations(baseblocks = reader.doc.blocks) -> blocks` is synchronous and does not mutate base blocks/fragments. Parent applies it to original `sourceBlocks` before indexSource/measurement. Historical feedback is ignored when document versions differ. Contextual understood suppresses the affected automatic annotation; contextual retained wins. If an explicit member/partial-word range intersects an automatic phrase, **the whole intersecting automatic phrase falls back to plain before inserting the exact retained span**; neighboring unrelated annotations stay unchanged. This avoids copying a full phrase gloss onto leftover fragments.
- `reader.collectionsController.paint(root = document.querySelector('#article')) -> void` synchronously wraps only source characters in the supplied live/capture fragments, with no fetch or layout/reflow. Parent must call it in `pagination.render()` immediately after assigning `#article.innerHTML` and before `renderSelection()` for the very first live page (prepare has no draw listener). Also call `source.r.collectionsController?.paint(page)` in `PageCurlRenderer.prepare` after detached leafMarkup creation and before serialization. The read hook additionally paints on subsequent `reader.on('draw')`.
- `reader.collectionsController.reload() -> Promise<void>` loads current-doc state, sets `.loaded`, `.error`, `.state = {items,feedback}`, updates `.collectionsSeed`, and does not throw optional-load failures into body rendering. Controls expose a retry if state could not load. `.ready` is the initial preparation promise.
- After a mounted controller's feedback changes, `reader.emit('annotations-change', {initial, feedback})` requests one current-document reflow from original sourceBlocks. Ordinary highlight/word collection changes only repaint/invalidate textures. `collections-change` carries `{state}` or `{state,error}`. Changes that can remove a warmed neighbor's marks clear only existing bounded `pages.clearRanges()` packets and call `warmRanges()`; they never fetch/redraw a whole book.
- `word` hook payload remains `{reader,pop,item,anchor,scope}` after pop creation. `item.dictionary` is reused for saved dictionary explanations. Assist integration consumes `pop.contextRecord` and `context-record` / `dictionary-record` events (payload includes `pop`). Only an explicit preview/adopt action submits `adopt_assist_id`. No calls are made to the global `/api/feedback` endpoint.
- Home insertion: after existing shelf draw, call `view.mountCollectionsResurface?.()`; alternatively provide `view.afterRender(fn)` registration. It inserts one section after `#article-grid`, without rebuilding shelf cards or initiating recommendation work during reading.
- Plugin disposal removes UI/hooks/marks and restores the base annotation view. It never deletes persisted collections/feedback. Pending explicit writes may finish. Personal-meaning drafts are stored through the existing `local` helper under `collection-meaning:<uid>` and are removed after save or matching confirmed collections cleanup; retries compare the current revision rather than silently overwriting.

Readback during this contribution found parent prepare/overlay, handoff seed, detached capture, word/dictionary and shelf-after-render hooks present. **The initial live-page paint call was still outstanding at last readback and has been explicitly communicated.** Parent owns its final wiring and acceptance.

## Verification

Failure classes above were documented before the first isolated check. Actual checks were syntax/import/formatting only; no browser/API fixture, provider, user database or device was invoked by this contributor. No syntax/import failure occurred. Static review found and repaired the automatic-phrase/member-gloss defect, duplicate parent/plugin dictionary rendering, detached modal lifetime, stale-version decoration, personal-meaning conflict recovery and warmed-neighbor stale seeds. These are source-level findings and repairs, not runtime pass claims.

Reproduce from repository root:

```sh
for file in web/plugins/collections.js web/collections-*.js; do node --check "$file" || exit 1; done
node --input-type=module -e 'await import("./web/plugins/collections.js"); console.log("collections module graph: import OK (install not invoked; no DOM/API calls)")'
./node_modules/.bin/prettier --check web/plugins/collections.js web/collections-*.js web/collections.css
shasum -a 256 web/plugins/collections.js web/collections-*.js web/collections.css
```

Actual output: all `node --check` processes exited 0; module graph import exited 0 with the message above; Prettier reported `All matched files use Prettier code style!`. After the final word-card insertion-order request, that file was formatted and its `node --check` was rerun successfully.

Handoff SHA-256 (before parent follow-up edits):

```text
cd35b33b2e2e943b27c4fa39a31c235e699d2e3e9ad23a8c6888c099722d7848  web/plugins/collections.js
1a753acecf38641b7f777c134017154afc2f7fd5091bdc094409a2f9fac25b86  web/collections-dialogs.js
6cbf82e910756db185002424d45367f8598941f2fc569439ce100ea86fad6bc0  web/collections-list.js
0cf369f7b8bbe6a1badf297d9bef1123622cb1564107c855c76cfbb9b99b4b47  web/collections-marks.js
1e55ad9948faa5a2f80759df5819582131a9650e070b01aeddea969d3a3fa2fd  web/collections-store.js
78a310614f0757f1cfe90c9d40d223f42ea477dddd2460c12a636348672b3387  web/collections-word.js
47dc7d3a23536e204eda8bdd4b18d2a8479c0e41e06a67e759b7086fb609b0c8  web/collections.css
```

## Parent acceptance still required

- Actual browser partial-word/cross-block selection, overlap and bridge unions, same-range whole deletion, undo and revision conflicts; verify the returned union immediately changes the menu to 删除划线 and independent word records/notes survive.
- Existing phrase + retained member/partial word, understood + retained together, density changes, refresh/reopen, plugin off/on, changed OCR version, first page and warmed chapter/range handoff. Check both live underline and the actual moving paper texture at normal DPI.
- Book/global filtering and loaded-occurrence grouping; autosave, failed save recovery, explanation preview/adoption/history and merged subranges against the real backend. Two open editors must fail safely on revision conflicts.
- Source preview Escape/backdrop/close preserves entry and all resume positions; only explicit continue changes reading position. Missing/recycled/ambiguous and reliably relocated historical sources must behave honestly.
- Real downloads, JSON restore/deduplication/unresolved source, selected/book cleanup for each independent type, resurface stability/next/snooze/hide/show and removed-record disappearance. No provider calls caused by any collection action.
- Scope abort/disposal during slow requests, actual macOS WebView layout/input/download behavior, existing-operation regression, and same-environment performance. Parent retains the first real failure and any fix/re-walkthrough evidence.

No runtime/model/device acceptance is claimed here. The contributor's assigned implementation is ready for parent integration and final walkthrough repairs.
