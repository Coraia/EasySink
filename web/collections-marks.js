import { anchorSegments } from "./source-selection.js";
import { sourceRuns } from "./selection-range.js";

const unmark = (root) => {
  for (const mark of root.querySelectorAll("span.collections-mark")) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  }
};

// DOM ranges are UTF-16. Wrappers contain source characters only and add no
// width/line-height, so native selection and PDF inline offsets stay intact.
// Inline decoration survives PageCurlRenderer's detached-page serialization.
export function createMarkPainter(reader) {
  let byBlock = new Map(),
    revision = 0;
  const painted = new WeakMap();
  const set = (items) => {
    byBlock = new Map();
    for (const item of items) {
      if (item.anchor?.kind === "image") continue;
      for (const part of anchorSegments(item.anchor)) {
        if (!byBlock.has(part.block_id)) byBlock.set(part.block_id, []);
        byBlock
          .get(part.block_id)
          .push({ ...part, version: item.anchor.version, kind: item.kind });
      }
    }
    revision++;
  };
  const paint = (root = document.querySelector("#article")) => {
    if (!root || reader.scope.signal.aborted) return;
    // Only supplied visible/capture fragments, never a chapter text walk.
    for (const block of root.querySelectorAll(
      "[data-block]:not([data-pdf-object])",
    )) {
      const stamp = `${revision}:${reader.doc.version}`;
      if (painted.get(block) === stamp) continue;
      unmark(block);
      const parts = (byBlock.get(block.dataset.block) || []).filter(
        (part) =>
          part.version === reader.doc.version &&
          part.start < +block.dataset.end &&
          part.end > +block.dataset.start,
      );
      if (parts.length) {
        // sourceRuns includes the block's descendants; use the parent only as
        // a traversal container and restrict to this exact block.
        const runs = [...sourceRuns(block.parentNode)].filter(
          (run) => run.block === block,
        );
        for (const { node, start, end } of runs) {
          const hits = parts.filter(
            (part) => part.start < end && part.end > start,
          );
          if (!hits.length) continue;
          const cuts = [
            ...new Set([
              start,
              end,
              ...hits.flatMap((part) => [
                Math.max(start, part.start),
                Math.min(end, part.end),
              ]),
            ]),
          ].sort((a, b) => a - b);
          const fragment = document.createDocumentFragment();
          for (let i = 0; i < cuts.length - 1; i++) {
            const a = cuts[i],
              z = cuts[i + 1],
              active = hits.filter((part) => part.start < z && part.end > a);
            const text = node.data.slice(a - start, z - start);
            if (!active.length) {
              fragment.append(text);
              continue;
            }
            const span = document.createElement("span");
            const excerpt = active.some((part) => part.kind === "excerpt");
            span.className = `collections-mark collections-mark-${excerpt ? "excerpt" : "word"}`;
            span.style.textDecoration = `underline ${excerpt ? "solid #a88044" : "dotted #6f8d69"} 1.5px`;
            span.style.textUnderlineOffset = "0.22em";
            span.textContent = text;
            fragment.append(span);
          }
          node.replaceWith(fragment);
        }
      }
      painted.set(block, stamp);
    }
  };
  return {
    set,
    paint,
    clear(root = document.querySelector("#article")) {
      if (root) unmark(root);
    },
  };
}

// Preserve the original server-provided fragments when the host applies this
// more than once. Feedback never edits source text or legacy global verdicts.
export function createAnnotationOverlay(reader) {
  const originals = new WeakMap();
  let byBlock = new Map(), meaningsByBlock = new Map();
  return {
    set(feedback, adopted = []) {
      byBlock = new Map();
      meaningsByBlock = new Map();
      for (const value of adopted) {
        const parts = anchorSegments(value.anchor);
        // A sentence/paragraph explanation must not become a word's gloss.
        if (parts.length !== 1 || value.anchor.quote.length > 96 || /[\r\n]/.test(value.anchor.quote)) continue;
        const part = parts[0];
        if (!meaningsByBlock.has(part.block_id)) meaningsByBlock.set(part.block_id, []);
        meaningsByBlock.get(part.block_id).push({ ...value, ...part, version: value.anchor.version });
      }
      for (const state of feedback) {
        for (const part of anchorSegments(state.anchor)) {
          if (!byBlock.has(part.block_id)) byBlock.set(part.block_id, []);
          byBlock
            .get(part.block_id)
            .push({ ...state, ...part, version: state.anchor.version });
        }
      }
    },
    apply(blocks = reader.doc.blocks) {
      return blocks.map((input) => {
        const block = originals.get(input) || input,
          states = (byBlock.get(block.id) || []).filter(
            (state) => state.version === reader.doc.version,
          );
        const meanings = (meaningsByBlock.get(block.id) || []).filter(value =>
          value.version === reader.doc.version && block.text.slice(value.start, value.end) === value.quote);
        if (!states.length && !meanings.length) return block;
        if (
          block.asset_url &&
          ["image", "image_fallback", "formula", "table"].includes(block.type)
        )
          return block;
        let offset = 0;
        const fragments = (
          block.fragments || [{ type: "plain", text: block.text }]
        ).map((fragment) => {
          const start = offset;
          offset += fragment.text.length;
          const adopted = meanings.find(value => value.start === start && value.end === offset);
          return { ...fragment, ...(adopted && fragment.type !== "plain" ? {
            note: adopted.explanation.payload.meaning,
            detail: adopted.explanation.payload.explanation || "",
            source: "context-adopted",
          } : {}), start, end: offset };
        });
        // Refuse to decorate inconsistent fragment text; never repair offsets
        // by searching for repeated words elsewhere in the block.
        if (fragments.map((fragment) => fragment.text).join("") !== block.text)
          return block;
        const active = states.filter(
          (state) =>
            state.start >= 0 &&
            state.end <= block.text.length &&
            state.end > state.start &&
            (state.understood === true || (state.retained && state.note)),
        );
        // A gloss belongs to the complete annotated expression. A retained
        // member/partial word (or contextual suppression) cannot leave that
        // expression's gloss attached to its remaining half, nor duplicate it.
        for (let i = 0; i < fragments.length; i++) {
          const fragment = fragments[i];
          if (
            fragment.type !== "plain" &&
            active.some(
              (state) =>
                state.start < fragment.end && state.end > fragment.start,
            )
          )
            fragments[i] = {
              type: "plain",
              text: fragment.text,
              start: fragment.start,
              end: fragment.end,
            };
        }
        const cuts = [
          ...new Set([
            0,
            block.text.length,
            ...fragments.flatMap((f) => [f.start, f.end]),
            ...active.flatMap((s) => [s.start, s.end]),
          ]),
        ].sort((a, b) => a - b);
        const next = [];
        for (let i = 0; i < cuts.length - 1; i++) {
          const start = cuts[i],
            end = cuts[i + 1],
            base = fragments.find((f) => f.start <= start && f.end >= end);
          const hits = active.filter(
            (state) => state.start <= start && state.end >= end,
          );
          const retained = hits
            .filter((state) => state.retained && state.note)
            .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
          const understood = hits.some((state) => state.understood === true);
          const adopted = retained && meanings.find(value => value.start === retained.start && value.end === retained.end);
          let fragment = { ...base, text: block.text.slice(start, end) };
          if (retained)
            fragment = {
              ...fragment,
              type: "annotation",
              note: adopted?.explanation.payload.meaning || retained.note,
              detail: adopted?.explanation.payload.explanation || retained.detail || "在这里保留的注释",
              target:
                retained.target ||
                block.text.slice(retained.start, retained.end),
              kind: "retained",
              source: "context-retained",
              collectionsFeedbackId: retained.id,
            };
          else if (understood)
            fragment = { type: "plain", text: fragment.text };
          delete fragment.start;
          delete fragment.end;
          // Rejoin retained spans split by an old automatic annotation so the
          // gloss occurs once for the retained expression.
          const last = next.at(-1);
          if (
            last &&
            ((fragment.collectionsFeedbackId &&
              last.collectionsFeedbackId === fragment.collectionsFeedbackId) ||
              (fragment.type === "plain" && last.type === "plain"))
          )
            last.text += fragment.text;
          else next.push(fragment);
        }
        const derived = { ...block, fragments: next };
        originals.set(derived, block);
        return derived;
      });
    },
  };
}
