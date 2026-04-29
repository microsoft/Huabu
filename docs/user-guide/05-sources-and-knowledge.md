# 05 · Sources 与知识库

Sources 是 Huabu 的**持久化知识层**：所有被画布"摄入"过的内容（PDF 正文、网页正文、Note 文字、Text 块）都会被抽取出来，存为带 frontmatter 的 Markdown 文件，让 AI 在后续对话和意图识别中可以**检索整个工作区**，而不只是当前画布。

---

## 一句话区分 Source 与 Node

| 概念       | 在哪里              | 生命周期                               |
| ---------- | ------------------- | -------------------------------------- |
| **Node**   | 画布上的视觉单元    | 跟随画布存在；删除画布时一同消失       |
| **Source** | 工作区的 `sources/` | 跨画布共享；可被多张画布的多个节点引用 |

一个 Source 可以被**多个节点**引用（例如同一篇 PDF 在两张画布里各放了一个节点），节点删除并不会立即删除 Source。

---

## Source 的产生

下列动作会自动触发**预处理流水线**（[apps/server/src/modules/preprocessing](../../apps/server/src/modules/preprocessing)），把内容入库为 Source：

| 节点 | 触发动作               | 入库内容                    |
| ---- | ---------------------- | --------------------------- |
| PDF  | 上传 / 粘贴 / 添加链接 | 提取后的全文文本 + 元数据   |
| Web  | 粘贴 URL / 链接弹窗    | 抓取页面正文（去广告/导航） |
| Note | 编辑后保存             | Markdown 全文               |
| Text | 编辑后保存             | 纯文本                      |

预处理流水线会做：解析输入 → 提取文本 → 计算指纹去重 → 解析标题 → （可选）让 LLM 生成摘要 / 关键词 / 标签 → 写入 `sources/<Title>.md`。

> 失败时（例如网络抓取失败）也会写入一个**占位 Source**并附带错误诊断，节点保持可见，可后续重试。

---

## Sources 列表页

入口：画布列表页顶部的"Sources"链接。

页面展示工作区下所有 Source：

| 列       | 说明                                               |
| -------- | -------------------------------------------------- |
| 类型图标 | PDF / Web / Note / Text                            |
| 标题     | Source 标题（来自 frontmatter）                    |
| 引用情况 | 哪些画布、哪些节点正在引用这个 Source              |
| 删除     | 单个删除时若被引用会提示冲突；可一键清理所有未使用 |

---

## 侧栏的 DataSourcePanel

画布左侧的面板有两个 Tab（[DataSourcePanel](../../apps/web/src/components/Panels/DataSourcePanel)）：

- **Canvas** — 当前画布的层级树，按 Frame / 父子关系展示
- **Sources** — 当前工作区的所有 Source 库

Sources Tab 支持：

- 排序（按字母 / 按重要性 / 按时间 / 手动）
- 搜索过滤
- **拖到画布**：把一个 Source 拖到画布生成对应节点；多张画布间复用同一个 Source

---

## AI 如何使用 Sources

在与 AI 协作时，Sources 通过两种方式参与（详见 [06 · 人机协作](./06-ai-collaboration.md)）：

1. **被选节点的入库内容自动注入上下文**  
   选中的节点若已有对应 Source，其完整文本会作为上下文传给 AI（不截断）。
2. **AI 主动检索**  
   AI 可调用以下工具按需检索：
   - `read_source` — 读取某个 Source 的全文
   - `search_knowledge` — 在工作区 Sources 中按关键词检索
   - `ingest_content` — 主动让某个尚未入库的节点入库（Operate 模式）

---

## 自动布局中的"知识来源边"

布局引擎也会用 Sources 做**隐式语义边**：

- **节点 → 它所属的 Source 节点**（权重 0.4）
- **合成节点 → 它引用的来源节点**（权重 0.6）

也就是说，即使你没手动连线，从同一份 Source 衍生出的节点会被自动布局拉得更近。详见 [07 · 意图与自动布局](./07-intent-and-auto-layout.md#隐式语义边)。

---

## 文件存储

Sources 直接以 Markdown 文件保存在 `<workspace>/sources/<Title>.md`，文件结构示例：

```markdown
---
id: src_xxx
type: pdf
title: Attention Is All You Need
fingerprint: sha256:...
summary: ...
keywords: [transformer, attention, ...]
---

<提取后的全文>
```

可以用任意 Markdown 编辑器直接查看 / 修改。元数据 `id` 用于跨画布引用，请勿手动改动。

---

[← 04 · 节点详解](./04-nodes.md) ｜ [06 · 人机协作 →](./06-ai-collaboration.md)
