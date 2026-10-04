import { $, e, api } from "./core.js";
export const voices = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];
export async function speechBlob(text, voice, signal) {
  const response = await fetch("/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.detail || "自然语音暂不可用");
  }
  return response.blob();
}
export async function renderAI(ctx, scope) {
  const config = await api("/ai/config", { signal: scope.signal });
  if (scope.signal.aborted) return;
  const form = (kind) => {
    const p = config[kind],
      speech = kind === "speech";
    return `<form id="ai-${kind}-form" class="card"><div class="setting-row"><div><h2>${speech ? "自然语音" : "文本 AI"}</h2><p>${speech ? "通过兼容 /audio/speech 的服务生成音频，音质由模型与音色决定。" : "生成语法、表达和文化注释，以及章节或整书译文。支持 Chat Completions 兼容服务。"}</p></div><input type="checkbox" class="switch" id="ai-${kind}-enabled" aria-label="启用${speech ? "自然语音" : "文本 AI"}" ${p.enabled ? "checked" : ""}></div>${!speech ? '<div class="row wrap"><button type="button" data-preset="deepseek">DeepSeek</button><button type="button" data-preset="openai">OpenAI 兼容接口</button></div>' : ""}<label for="ai-${kind}-url">服务基础地址</label><input id="ai-${kind}-url" type="url" required value="${e(p.base_url)}"><label for="ai-${kind}-model">模型名称</label><input id="ai-${kind}-model" type="text" required value="${e(p.model)}">${speech ? `<label for="ai-speech-voice">音色</label><input id="ai-speech-voice" type="text" required list="speech-voices" value="${e(p.voice)}"><datalist id="speech-voices">${voices.map((v) => `<option value="${v}">`).join("")}</datalist>` : ""}<label for="ai-${kind}-key">API Key</label><input id="ai-${kind}-key" type="password" autocomplete="off" placeholder="${p.has_api_key ? "已保存 · 留空保留现有凭据" : "填写此服务的 API Key"}"><div class="row gap wrap"><button type="submit" class="primary" id="ai-${kind}-save">保存配置</button><button type="button" id="ai-${kind}-${speech ? "preview" : "test"}">${speech ? "试听自然语音" : "测试连接"}</button><button type="button" class="text-button" id="ai-${kind}-clear">移除凭据并关闭</button></div><p id="ai-${kind}-status" class="save-state gap" role="status">${p.available ? "已启用" : "未启用"} · 修改后点击保存配置</p>${speech ? '<audio id="ai-speech-audio" controls hidden></audio><p class="muted">自然语音由 AI 生成。启用后会将原文片段发送给该服务，并可能按其定价计费。文本 AI 的凭据不会自动用于语音。</p>' : '<p class="muted">启用后，生成操作会发送原文给此服务，并可能产生费用。</p>'}</form>`;
  };
  ctx.root.innerHTML = `<div class="settings-layout"><div class="page-head"><div><div class="eyebrow">UNDERSTAND & LISTEN</div><h1>AI 与语音。</h1><p>分别选择理解和朗读服务，保存后立即生效。凭据只保存在本机服务端，不会回填到页面。</p></div><a class="text-button" href="#/profile">阅读偏好 →</a></div><div class="ai-grid">${form("text")}${form("speech")}</div></div>`;
  let objectURL;
  scope.cleanup(() => {
    $("#ai-speech-audio")?.pause();
    if (objectURL) URL.revokeObjectURL(objectURL);
  });
  for (const kind of ["text", "speech"]) {
    const status = $(`#ai-${kind}-status`),
      key = $(`#ai-${kind}-key`);
    const run = async (button, work) => {
      button.disabled = true;
      status.textContent = "处理中…";
      try {
        await work();
      } catch (err) {
        if (!scope.signal.aborted) status.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    };
    scope.on($(`#ai-${kind}-form`), "submit", (ev) => {
      ev.preventDefault();
      run($(`#ai-${kind}-save`), async () => {
        const body = {
          enabled: $(`#ai-${kind}-enabled`).checked,
          base_url: $(`#ai-${kind}-url`).value,
          model: $(`#ai-${kind}-model`).value,
          api_key: key.value,
        };
        if (kind === "speech") body.voice = $("#ai-speech-voice").value;
        const saved = await api("/ai/config", {
          method: "PUT",
          body: { [kind]: body },
          signal: scope.signal,
        });
        if (scope.signal.aborted) return;
        config[kind] = saved[kind];
        key.value = "";
        key.placeholder = saved[kind].has_api_key
          ? "已保存 · 留空保留现有凭据"
          : "填写此服务的 API Key";
        status.textContent =
          "已保存 ✓ · " + (saved[kind].available ? "已启用" : "已关闭");
      });
    });
    scope.on($(`#ai-${kind}-clear`), "click", (ev) =>
      run(ev.target, async () => {
        const saved = await api("/ai/config", {
          method: "PUT",
          body: { [kind]: { clear_key: true, enabled: false } },
          signal: scope.signal,
        });
        if (scope.signal.aborted) return;
        config[kind] = saved[kind];
        key.value = "";
        key.placeholder = "填写此服务的 API Key";
        $(`#ai-${kind}-enabled`).checked = false;
        status.textContent = "凭据已移除 · 已关闭";
      }),
    );
  }
  scope.on($("#ai-text-test"), "click", (ev) => {
    const button = ev.target;
    button.disabled = true;
    $("#ai-text-status").textContent = "正在测试已保存的配置…";
    api("/ai/test", { method: "POST", signal: scope.signal })
      .then((data) => {
        if (!scope.signal.aborted)
          $("#ai-text-status").textContent = data.message;
      })
      .catch((err) => {
        if (!scope.signal.aborted)
          $("#ai-text-status").textContent = err.message;
      })
      .finally(() => (button.disabled = false));
  });
  scope.on($("#ai-speech-preview"), "click", async (ev) => {
    const button = ev.target;
    button.disabled = true;
    $("#ai-speech-status").textContent = "正在生成试听…";
    try {
      const blob = await speechBlob(
        "Curiosity is a quiet form of courage. Take your time, and enjoy the story.",
        undefined,
        scope.signal,
      );
      if (scope.signal.aborted) return;
      const audio = $("#ai-speech-audio");
      audio.pause();
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = URL.createObjectURL(blob);
      audio.src = objectURL;
      audio.hidden = false;
      await audio.play().catch(() => {});
      $("#ai-speech-status").textContent = "试听已生成 · AI 语音";
    } catch (err) {
      if (!scope.signal.aborted)
        $("#ai-speech-status").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  scope.on($("#ai-text-form"), "click", (ev) => {
    const preset = ev.target.closest("[data-preset]")?.dataset.preset;
    if (!preset) return;
    $("#ai-text-url").value =
      preset === "deepseek"
        ? "https://api.deepseek.com"
        : "https://api.openai.com/v1";
    if (preset === "deepseek") $("#ai-text-model").value = "deepseek-chat";
    else {
      $("#ai-text-model").value = "";
      $("#ai-text-model").placeholder = "填写你账号可用的文本模型";
    }
    $("#ai-text-status").textContent = "已填入服务地址 · 请补全并保存";
  });
}
