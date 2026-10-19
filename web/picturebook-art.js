import { $, api } from "./core.js";

const manifestURL = new URL(
  "./assets/picturebook/story-manifest.json",
  import.meta.url,
);
const decoded = new Map();
function preload(url) {
  if (!decoded.has(url)) {
    const picture = new Image();
    picture.src = url;
    const promise = picture.decode().catch((error) => {
      decoded.delete(url);
      throw error;
    });
    decoded.set(url, promise);
  }
  return decoded.get(url);
}
const anchorKey = (value) =>
  `${value.block_id ?? value.block}:${value.start}:${value.quote ?? value.text}`;

export function mountStoryArt({
  root,
  doc,
  scope,
  all,
  demo,
  initialStatus,
  plan,
  onFrame,
}) {
  const states = new Map();
  let current = 0,
    epoch = 0,
    configured = false,
    submitting = false;
  let stopped = false;
  const container = $(".pb-art", root);
  const note = $(".pb-art-note", root);
  const generation = $("#pb-generate", root);
  const label = $("#pb-art-status", root);
  const notice = $("#pb-art-message", root);
  const setting = $("#pb-art-settings", root);
  const updateControls = () => {
    const item = states.get(current);
    const eventNumber = plan ? plan.frames.indexOf(item?.frame) + 1 : 0;
    const start = Math.floor(current / 3) * 3;
    const count = all
      .slice(start, start + 3)
      .filter(
        (_, index) => states.get(start + index)?.state === "ready",
      ).length;
    const unresolved =
      item && ["unknown", "failed", "image-error"].includes(item.state);
    label.textContent =
      item?.state === "ready"
        ? plan
          ? `关键情节 ${eventNumber} / ${plan.frames.length} · 原文 ${current + 1} / ${all.length} 句`
          : `本句专属插画 · ${current + 1} / ${all.length}`
        : item?.state === "generating"
          ? "正在为故事画画…"
          : unresolved
            ? item.message || "这一句的插画暂不可用"
            : "让每句话，拥有自己的画面";
    generation.hidden =
      Boolean(plan) || (demo && count === all.slice(start, start + 3).length);
    generation.disabled = submitting || item?.state === "generating";
    generation.textContent = unresolved
      ? "重新请求当前句插画"
      : count
        ? `补全本幕插画 · ${count}/3`
        : "生成本幕插画";
    if (!unresolved && count === all.slice(start, start + 3).length)
      generation.hidden = true;
    setting.hidden = Boolean(plan) || demo || configured;
    if (!demo && !plan) {
      const disclosure = $(".pb-footer > p", root);
      disclosure.textContent = [...states.values()].some(
        (value) => value.state === "ready",
      )
        ? "情节插画由 AI 生成，故事内容以英文原文为准。"
        : "尚未生成时显示氛围背景，故事内容以英文原文为准。";
    }
    notice.hidden = !unresolved;
    notice.textContent = unresolved
      ? plan
        ? "本机绘本图片未能打开，请刷新或重新打开这一章。"
        : "本次没有自动重试。重新请求可能再次计费。"
      : "";
  };
  async function paint() {
    const token = ++epoch,
      index = current;
    const item = states.get(index);
    updateControls();
    if (plan && item?.frame) {
      onFrame?.(item.frame);
      container.dataset.keyframeId = item.frame.id;
    }
    container.dataset.sentenceIndex = String(index);
    if (item?.state !== "ready") {
      container.dataset.artState = item?.state || "missing";
      container.setAttribute("aria-busy", "false");
      container.setAttribute(
        "aria-label",
        "当前句子尚无可用的情节插画，背景为氛围示意",
      );
      container.replaceChildren();
      delete container.dataset.frameKey;
      note.textContent =
        item?.state === "generating"
          ? "新插画正在生成 · 已完成的画面会保留"
          : "氛围背景 · 当前句子插画尚未就绪";
      return;
    }
    container.dataset.artState = "loading";
    container.setAttribute("aria-busy", "true");
    note.textContent = "正在打开这一句的画面…";
    try {
      await preload(item.url);
      if (stopped || scope.signal.aborted || token !== epoch) return;
      const frameKey = item.art_key
        ? `${item.art_key}:${item.attempt_id}`
        : `${item.url}#${item.cell}`;
      if (
        container.dataset.frameKey === frameKey &&
        container.firstElementChild
      ) {
        container.dataset.artState = "ready";
        container.setAttribute("aria-busy", "false");
        container.setAttribute(
          "aria-label",
          item.description ||
            `对应原文第 ${index + 1} 句的情节插画：${all[index].text}`,
        );
        note.textContent = plan
          ? `关键情节 · ${item.frame.title}`
          : `情节插画 · 第 ${index + 1} / ${all.length} 句`;
        return;
      }
      const frame = document.createElement("div");
      frame.className = "pb-story-frame";
      frame.style.backgroundImage = `url(${JSON.stringify(item.url)})`;
      frame.style.backgroundSize =
        item.cell === undefined ? "cover" : "200% 200%";
      frame.style.backgroundPosition =
        item.cell === undefined
          ? "center"
          : `${(item.cell % 2) * 100}% ${item.cell >= 2 ? 100 : 0}%`;
      if (plan && item.cell !== undefined) {
        // Crop one atlas cell while keeping the illustration's aspect ratio,
        // even when a long original sentence makes the reading paper taller.
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute(
          "viewBox",
          `${(item.cell % 2) * 100} ${item.cell >= 2 ? 100 : 0} 100 100`,
        );
        svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("aria-hidden", "true");
        const picture = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "image",
        );
        picture.setAttribute("width", "200");
        picture.setAttribute("height", "200");
        picture.setAttribute("href", item.url);
        svg.append(picture);
        frame.style.backgroundImage = "none";
        frame.append(svg);
      }
      container.replaceChildren(frame);
      container.dataset.frameKey = frameKey;
      container.dataset.artState = "ready";
      container.setAttribute("aria-busy", "false");
      container.setAttribute(
        "aria-label",
        item.description ||
          `对应原文第 ${index + 1} 句的情节插画：${all[index].text}`,
      );
      note.textContent = plan
        ? `关键情节 · ${item.frame.title}`
        : `情节插画 · 第 ${index + 1} / ${all.length} 句`;
    } catch {
      if (stopped || scope.signal.aborted || token !== epoch) return;
      states.set(index, {
        ...item,
        state: "image-error",
        message: "这一句的插画未能载入，请检查本机服务",
      });
      container.dataset.artState = "image-error";
      container.setAttribute("aria-busy", "false");
      container.replaceChildren();
      delete container.dataset.frameKey;
      note.textContent = "氛围背景 · 本句插画暂不可用";
      updateControls();
    }
  }
  function ingest(items) {
    for (const item of items) {
      const index = all.findIndex(
        (value) => anchorKey(value) === anchorKey(item),
      );
      if (index >= 0) states.set(index, item);
    }
  }
  async function refresh() {
    try {
      const result = await api(`/documents/${doc.id}/illustrations`, {
        signal: scope.signal,
      });
      if (scope.signal.aborted) return;
      configured = result.configured;
      ingest(result.items);
      await paint();
    } catch (error) {
      if (error.name !== "AbortError" && !scope.signal.aborted) {
        label.textContent = "插画状态暂不可用，英文仍可继续阅读";
        setting.hidden = false;
      }
    }
  }
  scope.on(generation, "click", async () => {
    if (submitting) return;
    if (!configured) {
      notice.hidden = false;
      notice.innerHTML =
        '先到 <a href="#/ai">AI 与语音 → 故事插画服务</a> 设置图像模型。';
      return;
    }
    const item = states.get(current);
    const retry =
      item && ["unknown", "failed", "image-error"].includes(item.state);
    const start = Math.floor(current / 3) * 3;
    const selected = retry
      ? [all[current]]
      : all
          .slice(start, start + 3)
          .filter((_, offset) => !states.has(start + offset));
    if (!selected.length) {
      notice.hidden = false;
      notice.textContent =
        "请点选尚未完成的句子查看状态；正在生成的插画会自动保存。";
      return;
    }
    submitting = true;
    updateControls();
    label.textContent = "正在为故事画画，完成后会自动保存…";
    try {
      // A route change does not cancel a potentially chargeable request. The
      // server persists each attempt; reopening the document reads its state.
      await api(`/documents/${doc.id}/illustrations`, {
        method: "POST",
        body: {
          anchors: selected.map((sentence) => ({
            block_id: sentence.block,
            start: sentence.start,
            quote: sentence.text,
          })),
          retry: Boolean(retry),
        },
      });
    } catch (error) {
      if (!scope.signal.aborted) {
        notice.hidden = false;
        notice.textContent = error.message;
      }
    } finally {
      submitting = false;
      if (!scope.signal.aborted) await refresh();
    }
  });
  scope.interval(() => {
    if (
      !demo &&
      (submitting ||
        [...states.values()].some((item) => item.state === "generating"))
    )
      refresh();
  }, 1800);
  scope.cleanup(() => {
    stopped = true;
    epoch++;
  });
  const ready = (async () => {
    if (plan) {
      all.forEach((sentence, index) => {
        const frame = plan.frames.findLast(
          (f) =>
            f.paragraph < sentence.blockIndex ||
            (f.paragraph === sentence.blockIndex && f.start <= sentence.start),
        );
        if (!frame) return;
        const url = new URL(
          frame.file,
          new URL(plan.asset_base, location.origin),
        ).href;
        states.set(index, { ...frame, frame, state: "ready", url });
        preload(url).catch(() => {});
      });
      await paint();
    } else if (demo) {
      try {
        const response = await fetch(manifestURL, { signal: scope.signal });
        if (!response.ok) throw Error("missing manifest");
        const manifest = await response.json();
        if (scope.signal.aborted) return;
        manifest.frames.forEach((frame, index) => {
          if (all[index]?.text !== frame.text) return;
          const url = new URL(frame.file, manifestURL).href;
          states.set(index, { ...frame, state: "ready", url });
          preload(url).catch(() => {});
        });
        await paint();
      } catch (error) {
        if (!scope.signal.aborted) {
          updateControls();
          label.textContent = "示例插画未能加载，请重新打开绘本";
        }
      }
    } else if (initialStatus) {
      configured = initialStatus.configured;
      ingest(initialStatus.items);
      await paint();
    } else await refresh();
  })();
  return {
    show(index) {
      current = index;
      paint();
    },
    ready,
  };
}
