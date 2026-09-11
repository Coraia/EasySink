import { $, $$ } from "../core.js";
export function install(ctx) {
  return ctx.hook("read", (r) =>
    r.tool("search", "搜索", () =>
      r.panel(
        "search",
        "在这一篇中查找",
        '<label for="find-text">关键词或短语</label><input type="search" id="find-text" placeholder="输入英文…"><div class="row gap"><button id="find-prev" aria-label="上一个搜索结果">↑</button><span class="meta" id="find-count">输入后查找</span><button id="find-next" aria-label="下一个搜索结果">↓</button></div>',
        (el, scope) => {
          let hits = [],
            current = -1,
            timer;
          const jump = (step) => {
            if (!hits.length) return;
            current = (current + step + hits.length) % hits.length;
            const hit = hits[current];
            hit.scrollIntoView({ block: "center", behavior: "instant" });
            $("#find-count", el).textContent =
              `${current + 1} / ${hits.length} 处`;
          };
          const search = () => {
            r.search = $("#find-text", el).value.trim().slice(0, 120);
            r.draw();
            hits = $$(".search-hit", $("#article"));
            current = -1;
            $("#find-count", el).textContent = hits.length
              ? `${hits.length} 处`
              : "没有找到匹配";
            if (hits.length) jump(1);
          };
          scope.on($("#find-text", el), "input", () => {
            clearTimeout(timer);
            timer = setTimeout(search, 250);
          });
          scope.on($("#find-text", el), "keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              jump(ev.shiftKey ? -1 : 1);
            }
          });
          scope.on($("#find-prev", el), "click", () => jump(-1));
          scope.on($("#find-next", el), "click", () => jump(1));
          scope.cleanup(() => {
            clearTimeout(timer);
            if (!r.scope.signal.aborted) {
              const a = r.position();
              r.search = "";
              r.draw();
              r.restore(a);
            }
          });
          $("#find-text", el).focus();
        },
      ),
    ),
  );
}
