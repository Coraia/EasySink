import { e } from "./core.js";

// Shared by plugin-updated controls, so a playback/save refresh keeps its icon.
const paths = {
  lookup: '<path d="M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  pin: '<path d="m8 3 8 0-1 7 3 4H6l3-4zM12 14v7"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  sound: '<path d="m4 9 4 0 5-4v14l-5-4H4zM17 8c2 2 2 6 0 8M20 5c4 4 4 10 0 14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  highlight: '<path d="m5 14 9-9 5 5-9 9H5zM12 7l5 5M3 22h18"/>',
  notes: '<path d="M5 4h9M5 4v16h15v-9M11 14l1-5 7-7 3 3-7 7z"/>',
  translation: '<path d="M3 5h12M9 2v3M6 5c0 6 6 9 9 10M13 5c0 6-6 9-10 10M14 21l4-11 4 11M15.5 17h5"/>',
  grammar: '<rect x="8" y="3" width="8" height="5" rx="1"/><path d="M12 8v5M4 13h16M4 13v3M20 13v3"/><rect x="1" y="16" width="6" height="5" rx="1"/><rect x="17" y="16" width="6" height="5" rx="1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  source: '<path d="M4 3h16v18H4zM8 7h8M8 11h8M8 15h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4"/>',
  reset: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
  explain: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
};
export const actionIcon = id => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[id] || paths.more}</svg>`;
const renderedActions = new WeakMap();
export function setReadingAction(button, icon, label, accessible = label) {
  if (!button) return;
  const previous=renderedActions.get(button);
  if(!previous || previous.icon!==icon || previous.label!==label ||
      previous.svg!==button.firstElementChild || previous.caption!==button.lastElementChild ||
      previous.caption.textContent!==label) {
    button.innerHTML = `${actionIcon(icon)}<span class="reading-action-label">${e(label)}</span>`;
    renderedActions.set(button,{icon,label,svg:button.firstElementChild,caption:button.lastElementChild});
  }
  if(button.getAttribute("aria-label")!==accessible) button.setAttribute("aria-label", accessible);
  if(button.title!==accessible) button.title = accessible;
}
