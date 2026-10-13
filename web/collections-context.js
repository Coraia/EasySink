import { sameSelection } from "./source-selection.js";

// Old explicitly adopted collections remain readable without a data migration.
// New independent occurrence records take precedence, including after unsaving.
export function adoptedExplanations(state) {
  const entries = [];
  const add = (value) => {
    const explanation = value.explanation;
    if (explanation?.kind !== "context" || !explanation.payload?.meaning?.trim() ||
        !value.anchor || (explanation.anchor && !sameSelection(value.anchor, explanation.anchor))) return;
    const index = entries.findIndex(entry => sameSelection(entry.anchor, value.anchor));
    const entry = { anchor: value.anchor, explanation };
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  };
  for (const item of state.items || []) {
    for (const part of item.subranges || []) add(part);
    add(item);
  }
  for (const feedback of state.feedback || []) add(feedback);
  return entries;
}

export function adoptedAt(state, anchor) {
  return adoptedExplanations(state).find(value => sameSelection(value.anchor, anchor))?.explanation || null;
}
