import { e, api } from "./core.js";

export function renderIllustrationSettings(ctx, scope, config) {
  if (!config) return;
  const panel = document.createElement("form");
  panel.className = "card";
  panel.id = "ai-illustration-form";
  panel.innerHTML = `<h2>故事插画服务</h2><p>为少儿版当前一幕的句子生成情节画面。生成后保存在本机，悬浮句子直接切换，不会重复生成。</p><label for="ai-illustration-url">图像服务基础地址</label><input id="ai-illustration-url" type="url" required value="${e(config.base_url)}"><label for="ai-illustration-model">图像模型名称</label><input id="ai-illustration-model" required value="${e(config.model)}" placeholder="填写服务支持的图像生成模型"><label for="ai-illustration-key">API Key</label><input id="ai-illustration-key" type="password" autocomplete="off" placeholder="${config.has_api_key ? "已保存 · 留空保留" : "填写插画服务的凭据"}"><label class="row gap"><input id="ai-illustration-enabled" type="checkbox" ${config.enabled ? "checked" : ""}> 启用故事插画</label><div class="row gap wrap"><button class="primary" type="submit">保存插画服务</button><button type="button" id="ai-illustration-clear">移除凭据并关闭</button></div><p class="save-state gap" id="ai-illustration-status" role="status">${config.available ? "已启用" : "尚未启用"} · 凭据仅保存在本机服务端</p><p class="muted">支持 /images/generations 及 base64 图片响应。点击生成时会发送本幕原文与必要故事上下文，服务可能计费；不会复用文本 AI 的密钥。超时或断连后不自动重试。</p>`;
  ctx.root.querySelector(".ai-grid").append(panel);
  const $ = (selector) => panel.querySelector(selector);
  async function save(clear = false) {
    const status = $("#ai-illustration-status");
    panel.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      const illustration = clear
        ? {
            enabled: false,
            clear_key: true,
            model: config.model || "unconfigured",
          }
        : {
            base_url: $("#ai-illustration-url").value,
            model: $("#ai-illustration-model").value,
            api_key: $("#ai-illustration-key").value,
            enabled: $("#ai-illustration-enabled").checked,
          };
      const saved = await api("/ai/config", {
        method: "PUT",
        body: { illustration },
        signal: scope.signal,
      });
      if (scope.signal.aborted) return;
      config = saved.illustration;
      $("#ai-illustration-key").value = "";
      $("#ai-illustration-key").placeholder = config.has_api_key
        ? "已保存 · 留空保留"
        : "填写插画服务的凭据";
      $("#ai-illustration-enabled").checked = config.enabled;
      status.textContent = config.available
        ? "插画配置已保存并启用；实际生成时验证模型可用性"
        : "已保存 · 插画服务关闭";
    } catch (error) {
      if (!scope.signal.aborted) status.textContent = error.message;
    } finally {
      panel.querySelectorAll("button").forEach((button) => {
        button.disabled = false;
      });
    }
  }
  scope.on(panel, "submit", (event) => {
    event.preventDefault();
    save();
  });
  scope.on($("#ai-illustration-clear"), "click", () => save(true));
}
