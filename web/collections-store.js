import { api, Scope, toast } from "./core.js";
import { sourceExcerpt } from "./source-selection.js";

// Read work belongs to its view; an explicit write is allowed to finish after
// that view closes. Aborting a response would not undo a committed mutation.
export function childScope(...parents) {
  const scope = new Scope();
  for (const parent of parents.filter(Boolean)) {
    const signal = parent.signal || parent;
    if (signal.aborted) scope.dispose();
    else
      signal.addEventListener("abort", () => scope.dispose(), {
        once: true,
        signal: scope.signal,
      });
  }
  return scope;
}

export function createCollectionsStore() {
  const scope = new Scope(),
    events = new EventTarget(),
    pending = new Set(),
    editors = new Set();
  let failures = 0;
  const changed = (detail) =>
    events.dispatchEvent(new CustomEvent("change", { detail }));
  const read = (path = "", owner = scope) =>
    api(`/collections${path}`, { signal: owner.signal });
  const write = (path, body, method = "POST") => {
    const keepalive =
      !["/import", "/cleanup"].includes(path) &&
      (!body ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength < 60000);
    const request = api(`/collections${path}`, { method, body, keepalive });
    pending.add(request);
    request.then(
      (result) => {
        pending.delete(request);
        changed({ path, result });
      },
      () => {
        pending.delete(request);
        failures++;
      },
    );
    return request;
  };
  const flush = async () => {
    const before = failures;
    const results = await Promise.allSettled(
      [...editors].map((editor) => editor.flush()),
    );
    while (pending.size) await Promise.allSettled([...pending]);
    return (
      failures === before &&
      results.every((result) => result.status === "fulfilled")
    );
  };
  scope.on(window, "reader-before-close", (event) =>
    event.detail.waitUntil(flush()),
  );
  scope.on(window, "beforeunload", (event) => {
    if (![...editors].some((editor) => editor.dirty()) && !pending.size) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const undo = (result, message) =>
    toast(
      message,
      result.undo_token
        ? {
            label: "撤销",
            run: async () => {
              await write("/undo", { token: result.undo_token });
              toast("已恢复操作前的状态");
            },
          }
        : undefined,
    );
  return {
    scope,
    events,
    editors,
    read,
    write,
    flush,
    undo,
    remove: (item) =>
      write(
        `/${encodeURIComponent(item.id)}?revision=${encodeURIComponent(item.revision)}`,
        undefined,
        "DELETE",
      ),
    dispose() {
      void flush();
      scope.dispose();
    },
  };
}

export const collectionSource = (item) =>
  [item.book_title, item.title]
    .filter((value, i, all) => value && all.indexOf(value) === i)
    .join(" · ") || "保存的来源";
export const contextText = (context) =>
  sourceExcerpt(
    typeof context === "string"
      ? context
      : Array.isArray(context)
        ? context
            .map((part) =>
              typeof part === "string" ? part : part.text || part.quote || "",
            )
            .filter(Boolean)
            .join("\n\n")
        : context?.text || context?.quote || "",
  );
export const explanationText = (explanation) =>
  typeof explanation === "string"
    ? explanation
    : explanation?.text ||
      [explanation?.payload?.meaning, explanation?.payload?.explanation]
        .filter(Boolean)
        .join("\n");
