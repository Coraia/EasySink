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
    PluginSpec(
        "auth",
        "本机访问锁",
        "用户名密码锁住本机实例；未建账号前保持开放。",
        backend="auth",
    ),
    PluginSpec(
        "library",
        "书架",
        "按书籍与章节组织内容。关闭后仍可阅读全部文章。",
        backend="library",
    ),
    PluginSpec(
        "importer",
        "导入阅读材料",
        "导入 EPUB、PDF、TXT 和 Markdown，按书籍保留。",
        backend="importer",
    ),
    PluginSpec(
        "pdf",
        "PDF 阅读",
        "本机转换 PDF，沿用沉浸阅读；关闭处理仍保留原件、正文和记录。",
        backend="pdf",
    ),
    PluginSpec("immersive", "沉浸阅读", "隐藏顶栏，只留正文。"),
    PluginSpec("notes", "笔记", "划词记下想法，集中在笔记页查看。", backend="notes"),
    PluginSpec("collections", "词句收藏", "保留此处词语与摘录，独立记录理解与注释，在书架再次遇见。", backend="collections"),
    PluginSpec(
        "translate",
        "选区翻译",
        "只翻译主动选中的文字，右侧与原文联动。",
        backend="translate",
    ),
    PluginSpec("grammar", "语法分析", "选句后主动分析，在原段落下方展开并关联原文。", backend="grammar"),
    PluginSpec("bookmarks", "书签", "给原文位置打书签，换页或改变排版仍能返回。", backend="bookmarks"),
    PluginSpec("progress", "续读", "记住原文位置，重新分页后继续阅读。", backend="progress"),
    PluginSpec("export", "导出", "导出生词表和笔记。", backend="export"),
    PluginSpec("tts", "朗读", "优先电脑本地语音，就地播放与停止；远程语音由你选择。", backend="tts"),
    PluginSpec("theme", "主题", "纸色 / 夜间 / 羊皮纸。"),
    PluginSpec("typography", "排版", "字号、行距、栏宽。"),
    PluginSpec("search", "文内搜索", "在当前篇里找词并跳转。"),
    PluginSpec("stats", "阅读统计", "累计阅读时长与篇数。", backend="stats"),
    PluginSpec("evidence", "本机阅读证据", "首次明确开启后才采集；独立关闭、导出与清除。", backend="evidence"),
    PluginSpec("shortcuts", "快捷键", "键盘操作密度、沉浸、搜索。"),
)

BY_ID = {p.id: p for p in PLUGINS}
