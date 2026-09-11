# Wise Reader

> 一个把英文原文加工成"对我个人恰好可读"的阅读工具。
>
> **读之前就已经标好了，你的眼睛不需要离开正文。**

当前阶段：**V1 Web 可运行**（L0 词汇层 + 阅读界面 + 词汇量测试）。L1 模型层已接好，无 API key 时自动跳过。

---

## 启动

```bash
# 词库已在 data/；若缺失：python3 scripts/fetch_lexicon.py
uv sync --extra dev
uv run uvicorn wise_reader.app:create_app --factory --host 127.0.0.1 --port 8766
```

打开 http://127.0.0.1:8766/ ，粘贴英文即可读。

命令行验收：

```bash
uv run wise-reader lookup ubiquitous
uv run wise-reader annotate tests/fixtures/b_opinion.txt --vocab 8000 --density 4
uv run pytest -q
```

配置 L1（可选）：复制 `.env.example` 为 `.env`，填 `WR_LLM_API_KEY` 并设 `WR_LLM_ENABLED=true`。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 · 可行性](docs/01-feasibility.md) | 小程序硬约束、载体决策 |
| [02 · 产品方案](docs/02-prd.md) | 原则、范围、非目标 |
| [03 · 开发文档](docs/03-design.md) | 三层架构与算法 |
| [04 · 里程碑](docs/04-milestones.md) | 可判定验收标准 |
| [05 · 本轮验收](docs/05-acceptance.md) | 2026-08-30 实现验收记录 |

---

## 五条不可妥协的原则

1. 宁可漏标，不可滥标
2. 注释密度有硬上限
3. 同一个词一篇只标一次
4. 注释不打断版面（行内灰字）
5. 反馈只需一次点击
