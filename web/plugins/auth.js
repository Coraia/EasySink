import { $, e, api, busy } from "../core.js";
export function install(ctx) {
  const login = async (scope) => {
    const status = await api("/auth/status", { signal: scope.signal });
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="settings-layout" style="max-width:480px"><div class="eyebrow">YOUR PRIVATE READING SPACE</div><h1>${status.needs_setup ? "为阅读空间加把锁。" : "欢迎回来。"}</h1><p class="muted">${status.needs_setup ? "这是本机访问锁，所有内容仍保存在当前机器，不提供云同步或多用户空间。" : "登录这台机器上的阅读空间，继续上次的阅读。"}</p><form id="auth-form" class="card stack"><div><label for="auth-user">用户名</label><input id="auth-user" required autocomplete="username" maxlength="40"></div><div><label for="auth-password">密码</label><input id="auth-password" type="password" required minlength="4" autocomplete="${status.needs_setup ? "new-password" : "current-password"}"></div><div id="auth-error" role="alert"></div><button class="primary" type="submit">${status.needs_setup ? "设置访问锁" : "解锁阅读空间"}</button></form></div>`;
    scope.on($("#auth-form"), "submit", (ev) => {
      ev.preventDefault();
      busy($("button[type=submit]", ev.target), async () => {
        try {
          await api("/auth/" + (status.needs_setup ? "register" : "login"), {
            method: "POST",
            body: {
              username: $("#auth-user").value,
              password: $("#auth-password").value,
            },
          });
          ctx.navigate("#/");
        } catch (err) {
          $("#auth-error").textContent =
            err.status === 401 ? "用户名或密码不正确，请重试。" : err.message;
          throw err;
        }
      }).catch(() => {});
    });
  };
  const route = ctx.route("login", login);
  const profile = ctx.hook("profile", async ({ scope }) => {
    const status = await api("/auth/status", { signal: scope.signal });
    if (scope.signal.aborted) return;
    const section = document.createElement("section");
    section.className = "card";
    section.innerHTML = `<h2>本机访问锁</h2><p class="muted">${status.user ? "当前用户：" + e(status.user) : "尚未设置访问锁。此功能保护本机实例，不提供云端账号。"}</p>${status.user ? '<button id="logout-local">退出登录并锁定</button>' : '<a class="button" href="#/login">设置用户名与密码 →</a>'}`;
    $("#profile-extensions").append(section);
    scope.on($("#logout-local"), "click", async () => {
      await api("/auth/logout", { method: "POST" });
      ctx.navigate("#/login");
    });
  });
  return () => {
    route();
    profile();
  };
}
