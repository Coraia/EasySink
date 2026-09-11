from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PluginSpec:
    id: str
    name: str
    summary: str
    default_on: bool = True
    backend: str | None = None  # wise_reader.plugins.<backend> 模块名；纯前端则为 None


# 顺序即实验室展示顺序。backend 模块只负责路由/表；前端一律 web/plugins/<id>.js
PLUGINS: tuple[PluginSpec, ...] = (
    PluginSpec("auth", "本地登录", "用户名密码锁住本机实例；未建账号前保持开放。", backend="auth"),
    PluginSpec("library", "书架", "把文章收成书，按章节打开。", backend="library"),
    PluginSpec("importer", "导入 EPUB/TXT", "上传 EPUB、TXT、Markdown，拆章入库。", backend="importer"),
    PluginSpec("immersive", "沉浸阅读", "隐藏顶栏，只留正文。"),
    PluginSpec("notes", "笔记", "划词记下想法，集中在笔记页查看。", backend="notes"),
    PluginSpec("translate", "翻译书", "对照译文：可粘贴或在配置了 LLM 时生成。", backend="translate"),
    PluginSpec("bookmarks", "书签", "给当前滚动位置打书签。", backend="bookmarks"),
    PluginSpec("progress", "续读", "记住读到哪，首页可继续。", backend="progress"),
    PluginSpec("export", "导出", "导出生词表和笔记。", backend="export"),
    PluginSpec("tts", "朗读", "用浏览器语音读正文。"),
    PluginSpec("theme", "主题", "纸色 / 夜间 / 羊皮纸。"),
    PluginSpec("typography", "排版", "字号、行距、栏宽。"),
    PluginSpec("search", "文内搜索", "在当前篇里找词并跳转。"),
    PluginSpec("stats", "阅读统计", "累计阅读时长与篇数。", backend="stats"),
    PluginSpec("shortcuts", "快捷键", "键盘操作密度、沉浸、搜索。"),
)

BY_ID = {p.id: p for p in PLUGINS}
