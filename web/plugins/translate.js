import { $, e, api, local, toast } from "../core.js";
const pendingSaves = new Map();
export function install(ctx) {
  return ctx.hook("read", (reader) =>
    reader.tool("translate", "对照译文", async () => {
      const id = reader.doc.id;
      await reader.panel(
        "translate",
        "中文对照",
        '<div class="loading">正在读取译文…</div>',
        async (el, scope) => {
          const saved = await api(`/documents/${id}/translation`, {
            signal: scope.signal,
          });
          if (scope.signal.aborted) return;
          const draft = local.get(`translation-draft:${id}`, saved.body);
          let dirty = local.get(`translation-draft:${id}`) !== null;
          let version = 0,
            chain = Promise.resolve(),
            timer;
          el.innerHTML = `<div class="notice">${ctx.profile.l1_available ? "可生成本章译文，任务将在后台执行。" : 'AI 尚未配置。<a href="#/ai">配置文本 AI →</a> 你仍可粘贴译文，自动保存并对照阅读。'}</div><button id="generate-translation" ${ctx.profile.l1_available ? "" : "disabled"}>生成本章译文</button>${reader.doc.chapter && ctx.profile.l1_available ? '<button id="translate-whole" class="gap">翻译整本书</button>' : ""}<label for="translation-body" class="gap">译文 · 可编辑</label><textarea id="translation-body" rows="15" placeholder="粘贴中文译文…">${e(draft)}</textarea><p class="save-state" id="translation-state" role="status">${draft ? "已载入译文" : "输入后自动保存"}</p><a class="text-button" href="#/jobs">查看后台任务 →</a>`;
          const save = () => {
            if (!dirty) return chain;
            clearTimeout(timer);
            timer = null;
            const body = $("#translation-body", el).value,
              rev = version;
            if (!body.trim()) return;
            chain = (pendingSaves.get(id) || chain)
              .catch(() => {})
              .then(() =>
                api(`/documents/${id}/translation`, {
                  method: "PUT",
                  body: { body, lang: "zh", generate: false },
                  keepalive: true,
                }),
              )
              .then(() => {
                if (rev === version) dirty = false;
                if (local.get(`translation-draft:${id}`) === body)
                  local.remove(`translation-draft:${id}`);
                if (!scope.signal.aborted && rev === version)
                  $("#translation-state", el).textContent = "已自动保存 ✓";
              })
              .catch(() => {
                if (!scope.signal.aborted)
                  $("#translation-state", el).textContent =
                    "未同步 · 草稿已保留";
              });
            pendingSaves.set(id, chain);
            return chain;
          };
          scope.on($("#translation-body", el), "input", () => {
            version++;
            dirty = true;
            local.set(
              `translation-draft:${id}`,
              $("#translation-body", el).value,
            );
            $("#translation-state", el).textContent = "保存中…";
            clearTimeout(timer);
            timer = setTimeout(save, 750);
          });
          scope.cleanup(() => {
            if (timer) save();
            clearTimeout(timer);
          });
          scope.on(window, "pagehide", save);
          scope.on(window, "online", save);
          const generate = async (all) => {
            try {
              if (all)
                await api("/translate/books/" + reader.doc.chapter.book_id, {
                  method: "POST",
                });
              else
                await api(`/documents/${id}/translation`, {
                  method: "PUT",
                  body: { generate: true },
                });
              ctx.navigate("#/jobs");
            } catch (err) {
              toast(err.message);
            }
          };
          scope.on($("#generate-translation", el), "click", () =>
            generate(false),
          );
          scope.on($("#translate-whole", el), "click", () => generate(true));
        },
      );
    }),
  );
}
