# 05 · 节点内容与知识存储

Huabu 把每个节点的"摄入内容"（PDF 正文、网页正文、Note 文字、Text 块）持久化为带 frontmatter 的 Markdown 文件。AI 在对话和意图识别时可读取这些文件，作为上下文使用。

---

## 存储模型：以画布为单位

每张画布对应一个文件夹：

```
<workspace>/<canvas-title>/
├── canvas.json              # 画布拓扑（节点位置、连线、frame 层级等）
├── nodes/<node-title>.md    # 每个节点的摄入内容 + 元数据
├── .artifacts/              # 隐藏：二进制原文件（PDF、图片、视频）、文件名 = artifactId
└── .history/                # 隐藏：对话 / 意图 / 事件历史
```

节点的"内容"和"画布上的可视位置"是**两份分离的状态**：

- `canvas.json` 由前端 store 同步，描述画布拓扑
- `nodes/<node-title>.md` 由预处理流水线写入，描述节点的可被 AI 读取的内容

> 哪些节点会生成 `.md`？**note / text / web / pdf / image / video / frame** 都会。其中 image / video / frame 的 `.md` 只存元数据（image / video 指向 `.artifacts/` 里的原始文件，frame 仅记录标题）。annotation / question / intent 不生成 `.md`。

> 早期版本中存在跨画布共享的 `sources/` 池，现已移除。每张画布独立存储自己的节点内容。

---

## 节点内容的产生

下列动作会自动触发**预处理流水线**（[apps/server/src/modules/preprocessing](../../apps/server/src/modules/preprocessing)），把内容写入 `nodes/<nodeId>.md`：

| 节点 | 触发动作               | 入库内容                    |
| ---- | ---------------------- | --------------------------- |
| PDF  | 上传 / 粘贴 / 添加链接 | 提取后的全文文本 + 元数据   |
| Web  | 粘贴 URL / 链接弹窗    | 抓取页面正文（去广告/导航） |
| Note | 编辑后保存             | Markdown 全文               |
| Text | 编辑后保存             | 纯文本                      |

预处理流水线会做：解析输入 → 提取文本 → 解析标题 → （可选）让 LLM 生成摘要 / 关键词 / 标签 → 写入 `nodes/<nodeId>.md`。

> 失败时（例如网络抓取失败）也会写入一个**占位文件**并附带错误诊断，节点保持可见，可后续重试。

---

## Markdown 文件结构

```markdown
---
id: <nodeId>
contentKind: pdf | web | note | text
title: Attention Is All You Need
summary: ...
keywords: [transformer, attention, ...]
---

<提取后的全文>
```

可以用任意 Markdown 编辑器直接查看 / 修改正文部分。`id` 必须保持与节点一致，请勿手动改动。

---

## 侧栏的 Layers Panel

画布左侧的 [CanvasLayerPanel](../../apps/web/src/components/Panels/CanvasLayerPanel) 以树状结构显示当前画布的所有节点 / Frame 层级，支持：

- 拖拽改变层级
- 锁定 / 重命名节点
- 双击进入节点预览

---

## AI 如何使用节点内容

在与 AI 协作时（详见 [06 · 人机协作](./06-ai-collaboration.md)）：

1. **被选节点的入库内容自动注入上下文**
   选中的节点若已有 `nodes/<nodeId>.md`，其完整文本会作为上下文传给 AI（不截断）。
2. **AI 主动读取**
   AI 可调用 `read("nodes/<nodeId>.md")` 按需读取某个节点的完整内容（label / 正文 / summary / keywords），用 `inspect_nodes({ ids: ["<nodeId>"] })` 拿位置 / 大小 / 父 frame / 样式；在 Operate 模式下还可调用 `ingest_content` 主动让某个尚未入库的节点入库。

---

## 自动布局中的"语义边"

布局引擎会用节点之间的引用关系做**隐式语义边**：

- **摘录节点 → 来源节点**（权重 0.4）
- **合成节点 → 它引用的来源节点**（权重 0.6）

也就是说，即使你没手动连线，从同一来源衍生出的节点会被自动布局拉得更近。详见 [07 · 意图与自动布局](./07-intent-and-auto-layout.md#隐式语义边)。

---

[← 04 · 节点详解](./04-nodes.md) ｜ [06 · 人机协作 →](./06-ai-collaboration.md)
