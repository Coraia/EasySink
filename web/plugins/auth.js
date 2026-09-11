(() => {
  WR.addNav({ href: "#/login", label: "账号" });
  WR.addRoute("/login", renderAuth);

  async function renderAuth() {
    const st = await WR.api("/api/auth/status");
    const app = document.getElementById("app");
    if (st.user) {
      app.innerHTML = `
        <div class="card">
          <h3>已登录</h3>
          <p>本地账号 <strong>${WR.escapeHtml(st.user)}</strong></p>
          <div class="row"><button id="out">退出</button></div>
        </div>`;
      document.getElementById("out").onclick = async () => {
        await WR.api("/api/auth/logout", { method: "POST", body: {} });
        location.hash = "#/";
        location.reload();
      };
      return;
    }
    app.innerHTML = `
      <div class="card">
        <h3>${st.needs_setup ? "创建本地账号" : "登录"}</h3>
        <p class="hint">${st.needs_setup ? "第一个账号会锁住这个实例。密码只存在本机 SQLite。" : "输入用户名和密码。"}</p>
        <label>用户名</label>
        <input id="u" type="text" autocomplete="username" />
        <label>密码（至少 4 位）</label>
        <input id="p" type="password" autocomplete="current-password" />
        <div class="row">
          <button id="go">${st.needs_setup ? "创建并进入" : "登录"}</button>
        </div>
      </div>`;
    document.getElementById("go").onclick = async () => {
      const username = document.getElementById("u").value.trim();
      const password = document.getElementById("p").value;
      const path = st.needs_setup ? "/api/auth/register" : "/api/auth/login";
      try {
        await WR.api(path, { method: "POST", body: { username, password } });
        location.hash = "#/";
        location.reload();
      } catch (e) {
        WR.toast("失败：" + e.message);
      }
    };
  }
})();
