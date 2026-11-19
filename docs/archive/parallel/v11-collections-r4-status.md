# V1.1 collections dialog / R4 handoff

2026-10-11. Scope: `web/collections-dialogs.js`, necessary `web/collections-store.js`, and this handoff. Parent owns reader-chrome capture handling and real browser walkthroughs; Epicurus owns backend R1–R3. No browser operations, production database/config writes, service restarts, commits, pushes, issues, new unit tests or full E2E by this contributor.

## Failure classes recorded before repair / isolated checks

- R4: after another window expands an excerpt while reusing its ID, retry must compare immutable original source identity, content version, every ordered range segment and raw quote. Latest revision alone is insufficient. A mismatch must not issue a meaning PATCH against the union.
- A changed source/version/range must show both original and current references, preserve the original draft, and keep it recoverable after closing and reopening the expanded record. Editing or saving the new range must not delete the original-range draft. Legacy drafts must remain accessible.
- A same-range revision conflict may still be explicitly resolved. Another merge after the comparison is displayed must be rejected by the server revision guard; retry must recheck the original range again. Failed/aborted reads, missing records, duplicate clicks, scope disposal and local-storage quota failures must not claim a save.
- Dialog close, blank content, input, Escape, backdrop, and a detail action that opens another dialog must not bubble into reader dismissal/page turning. Removed dialog nodes must retain their event boundary for the in-flight event path. Document capture still requires the parent's separate early modal guard.
- PDF U+FFFC must be displayed as `〔原式〕` in context/reference text only. Source snapshots, anchors, raw quote identity, API bodies and exports must remain unchanged.
- Syntax, module imports and formatting checks can detect source integration defects only. They cannot establish browser event ordering, actual multi-window mutation behavior or macOS acceptance.

## Status

Source repair complete; real browser/multi-window/macOS acceptance remains with parent. The original R4 finding remains in `docs/parallel/v11-records-integration-review.md`; this handoff does not rewrite that first-failure record.

## Changes and integration

- `web/collections-dialogs.js`: `meaningRangeIdentity()` captures a string identity when the editor opens: UID/kind, canonical source identity, content version, root anchor and all ordered segment coordinates/quotes, plus raw top-level quote. Source object key order is normalized; segment order and raw UTF-16 text are not. Missing source/version/quote fails closed. Every meaning PATCH also checks the editor's current item against this original identity.
- Retry scans the original document's paginated real collection list by original ID without the former quote-prefix filter. Only an exact original-range match can expose the ordinary comparison's “用我的输入保存 / 使用当前保存” actions and replace `item.revision`. A mismatch retains the original editor, displays the changed quote and a range-change reason, preserves the draft and issues no retry PATCH. It never writes a subrange or the union on the user's behalf. A merge occurring after a same-range comparison is displayed still encounters the existing server `expected_revision` guard.
- Drafts use `collection-meaning:<uid-or-id>:<draft-uuid>` keys through the existing `local` helper. A restored matching draft retains its key; legacy unsuffixed keys remain readable. New-range editing/saving removes only its own active draft, leaving old-range drafts intact. Reopening the surviving collection shows other drafts with original quotes and read-only, selectable text; they are never automatically inserted into the current meaning. Existing explicitly scoped collection cleanup covers these keys. Storage failure asks the user to copy the input. Explicit “保留未保存输入，稍后继续” does not try the blocked save again during disposal.
- `web/collections-store.js`: `contextText()` applies the existing `sourceExcerpt()` to its display string. Detail, source preview, merged subrange, conflict, draft and selected-reference displays also use that projection. Raw snapshots, stored draft identity, API bodies, source offsets and downloaded exports retain U+FFFC; the UI shows `〔原式〕`. No source-selection or PDF engine changes.
- Dialog event isolation from the preceding repair stays in `collectionDialog()`: bubble-phase pointer/mouse/touch/wheel/keyboard boundaries live on the dialog node, outside its abort scope, so closing/removing it cannot remove the boundary during an in-flight event. Native input/focus/scroll defaults are preserved. Close/cancel and actual outside-rectangle backdrop dismissal remain local. Child action handlers can open another dialog without their click reaching the reader.

No new parent function contract or backend API is required. Ship the two changed frontend modules. The parent's separate reader-chrome document-capture fix is still necessary: a dialog bubble handler cannot stop capture that already ran. Readback found the parent's click `modal() || target.closest("dialog")` guard before panel dismissal and its keydown modal guard before Escape handling. This contributor did not edit reader-chrome, backend R1–R3, list/word UI or source-selection.

## Actual verification

R4 failure classes above were written before its implementation/checks. These commands completed successfully from the repository root:

```sh
node --check web/collections-dialogs.js
node --check web/collections-store.js
./node_modules/.bin/prettier --check web/collections-dialogs.js web/collections-store.js
node --input-type=module -e 'await import("./web/collections-dialogs.js"); console.log("collections dialogs/store module graph: import OK (no DOM/API calls)")'
shasum -a 256 web/collections-dialogs.js web/collections-store.js
```

Syntax checks returned no diagnostics. Prettier: `All matched files use Prettier code style!`. Import: `collections dialogs/store module graph: import OK (no DOM/API calls)`. No isolated behavioral harness, mock, unit test, browser operation, real API call or database write was executed. No check failed. Static readback followed the mismatch return before either retry action and confirmed raw identities never use `sourceExcerpt`.

```text
d683ada73b76f82e91af994278ec9d8fd37b99ccb2d10cbb75cb329d940a825d  web/collections-dialogs.js
3d8075b436d15ad75532ffd8edeb7a4825f019ceb739681fbbd1cf5675323280  web/collections-store.js
```

## Parent replay (not executed by this contributor)

Use the parent's candidate at 18772 and real collection operations in its authorized acceptance library. Preserve the original report/18772 dialog failure separately; record the candidate file hashes, screenshots, actual request/response sequence and first new failure. Do not treat the static checks above as these runtime results.

1. **R4 same-ID expansion:** A opens a real short excerpt's detail without typing. B saves an intersecting longer excerpt, expanding the same surviving ID. Record the original and union UID/ID, source identity, anchor, quote and revisions. A types a distinct original-range meaning; retain its first 409 response. A clicks “重新核对版本”. Expect the old quote/input to remain, the changed union quote to appear, and no “用我的输入保存” action or new PATCH. Confirm the union's top-level meaning and its existing subrange meanings are unchanged by A's retry.
2. **Draft recovery:** A clicks “保留未保存输入，稍后继续”, then reopens the expanded record (refresh once as well). Expect its current meaning in the normal editor and the old quote/draft in “此前未保存的草稿”, selectable but not auto-filled. Write a new meaning expressly for the union, wait for real save, close/reopen: the old-range draft must still be available. Exercise an existing legacy unsuffixed draft if one is available; do not seed production storage to create one.
3. **Same-range conflict:** A and B open one unchanged range; B saves a different personal meaning. A types, receives 409, then retries. The comparison must show the exact matching quote. “用我的输入保存” explicitly saves with the fetched revision; a separate run of “使用当前保存” discards only A's active draft. No other-range draft disappears.
4. **Race after comparison:** During step 3, pause A with the comparison open, then B expands that excerpt. A chooses “用我的输入保存”. Its now-stale revision must produce another 409; another retry must show the range-change block, with no automatic rebind to the union. For cross-block records also exercise a change in a later segment; for a real revised source, ensure version/source changes cannot be accepted solely because the visible quote matches.
5. **Modal chain:** From the open reading collections panel, open detail; click inside the input, select text, click modal blank content, use keyboard arrows and scroll. Close using ×, Escape and outside backdrop in separate runs. Reopen detail → “回原文” → close preview → close detail. Only the intended top modal should close; the lower panel and reading position must remain. Continue reading is tested separately as an explicit navigation action. Repeat the nested same-range retry comparison close path.
6. **PDF display only:** Use an actual saved PDF excerpt whose source quote/context contains U+FFFC. Check detail/subrange references, source snapshot/current context, and conflict/draft reference displays: `〔原式〕` is visible, with no bare object character. Compare the real API/export raw quote/context/anchor before and after viewing: original U+FFFC and offsets remain unchanged. Opening/closing preview must not change resume position or call a model.

Remaining limitation is explicit: the frozen API has no original-subrange meaning-edit operation. After a changed-range conflict, this repair retains a recoverable draft and blocks reassignment; it does not claim the draft was saved to the original subrange. Actual first-failure/replay evidence, final Web/macOS builds and full walkthrough remain parent-owned.
