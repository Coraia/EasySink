import { $ } from "../core.js";
export function install(ctx) {
  return ctx.hook("profile", () => {
    const section = document.createElement("section");
    section.className = "card";
    section.innerHTML =
      '<h2>把积累带走</h2><p class="muted">笔记导出为 Markdown，个人词表导出为 CSV。</p><div class="row wrap"><a class="button" href="/api/export/notes.md" download>导出笔记 ↗</a><a class="button" href="/api/export/vocab.csv" download>导出个人词表 ↗</a></div>';
    $("#profile-extensions").append(section);
  });
}
