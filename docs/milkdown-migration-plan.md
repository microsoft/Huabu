# Milkdown 迁移方案 — 完整规划

> 范围:本文档覆盖 **Phase 1 ~ Phase 6** 的完整迁移路径。
> 每个 Phase 都是独立 PR、独立验收、独立可回滚。Phase 1a 验收 Gate 不通过则全部终止。

> **进度**(`blocknote` 分支):
>
> - ✅ **Phase 1a** 已完成 — 四个 fixture round-trip 在 vitest 里稳定通过(`apps/web/src/components/Milkdown/__tests__/roundTrip.test.ts`,happy-dom + Crepe parser/serializer)
> - ✅ **Phase 1b** 已完成 — 封装层 `apps/web/src/components/Milkdown/` 上线,ESLint `no-restricted-imports` 锁住边界
> - ✅ **Phase 2** 已完成 — `MilkdownMessageCard` 替换 `BlockNoteCard`,多块拖拽行为对齐(详见 §2.6)
> - ✅ **Phase 3** 已完成 — NoteNode + NotePreview 迁移到 Milkdown,blockDrag.ts 提前提取为共享 hook,拖块到 canvas 功能完整可用
> - ⏳ **Phase 4 ~ Phase 6** 待启动

## 目标

- 验证 Milkdown 能否成为 BlockNote 的稳定替代,**让 Markdown 真正成为单一真值**。
- 建立一层我们自己的封装,把 Milkdown 当成可替换的实现细节。
- 按 "验证 → 只读 → 编辑 → 元数据 → 拖拽 → 清理" 的顺序推进,把每一步的回滚成本压到最低。

## Phase 一览

| Phase | 目标                           | 风险 | 工作量                                                                         |
| ----- | ------------------------------ | ---- | ------------------------------------------------------------------------------ |
| 1     | 验证 Gate + 封装层 `Milkdown/` | 中   | 4-5 天                                                                         |
| 2     | 替换 `BlockNoteCard`(只读)     | 低   | 1-2 天                                                                         |
| 3     | 替换 `NotePreview`(编辑)       | 高   | 5-7 天                                                                         |
| 4     | Provenance 重锚                | 高   | 5-7 天                                                                         |
| 5     | 拖块到 canvas 重写             | 中   | 1-2 天(Phase 2 已落地多块快照 + drag-image 构建器,主要工作是抽 hook,详见 §5.6) |
| 6     | 删除 BlockNote + 数据清理      | 低   | 1-2 天                                                                         |

## 当前痛点(动机回顾)

| 现状                                                                   | 问题                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `content`(Markdown)+ `contentJson`(BlockNote JSON)双轨存储             | Agent 直接改 Markdown 时,JSON 旁路常常错位,需要 `contentJsonSource` 校验 + lossy 回退 |
| BlockNote 0.51 自研 Markdown 解析器明确表示**不打算支持所有 Markdown** | 复杂文档(数学、嵌套表格、AI 半成品)解析有损                                           |
| 不支持数学公式(`$...$` / `$$...$$`)                                    | 产品需求未满足                                                                        |
| 大量补丁(M2 空内容、M3 trim、M1 双轨)是在为有损序列化器打补丁          | 长期维护负担                                                                          |

---

## Phase 1 — 验证 + 封装层

**分支**:`feat/milkdown-wrapper`(从 `main` 拉)

本 Phase 拆成两个密闭的子阶段:

- **1a 验证**(1.5-2 天):最小 Milkdown 实例 + 4 个 fixture + 自动化 round-trip + KaTeX/IME/性能粗测。**Gate 不通过就止损**,1a 代码丢弃,整个迁移计划归档。
- **1b 封装**(2-3 天):Gate 通过后,才设计公共 API 与主题/工具。**顺序不可插队**,避免 API 让步于未验证的假设。

### 1.1 依赖(实际落地)

实际安装的不是计划里那一长串 `@milkdown/preset-*` + `@milkdown/plugin-*`,而是 **Crepe** 套件,它把 commonmark / gfm / math / block / listener / history / clipboard 等都打包好:

```bash
pnpm --filter web add @milkdown/core @milkdown/crepe @milkdown/ctx \
  @milkdown/prose @milkdown/react @milkdown/utils katex
```

> Crepe 透传依赖了 `@milkdown/preset-commonmark` / `preset-gfm` / `transformer`,所以无需再单独装。
> 主题用 Crepe 自带 + 我们自己的 `milkdown-overrides.css` 覆盖,**不**装 `@milkdown/theme-nord`。

---

### Phase 1a — 验证 Gate ✅ 已完成

**实际产物**:

- `apps/web/src/components/Milkdown/__tests__/roundTrip.test.ts`(永久 vitest 用例,不是临时 `_validate/`)
- 4 个 fixture 在 `__tests__/fixtures/`:`simple.md` / `math.md` / `complex.md` / `ai-half-baked.md`,覆盖原计划 1a.2 表格的全部场景
- 测试用 `// @vitest-environment happy-dom` 直接对 Crepe 的 `parserCtx` + `serializerCtx` 做 round-trip,绕开 ProseMirror EditorView 在 happy-dom 下的事务边界问题
- `apps/web/src/components/Milkdown/__tests__/markdownUtils.test.ts`(21 个 case,验证 `normalizeMarkdown` / `markdownEquals` / `ensureNonEmpty`)

**Gate 结论**:

| #   | 检查项                  | 结果       | 备注                                                        |
| --- | ----------------------- | ---------- | ----------------------------------------------------------- |
| G1  | 4 个 fixture round-trip | ✅ 通过    | 自动 vitest;第二轮起字符串收敛                              |
| G2  | KaTeX 渲染              | ✅ 通过    | 通过 Crepe latex feature(remark-math + KaTeX);手动验证      |
| G3  | drag handle             | ✅ 通过    | Crepe `BlockEdit` feature 在 preview/edit 模式下都启用      |
| G4  | bundle size delta       | ⏸ 跟踪中   | 未测;Phase 6 才与"未迁移基线"做净增量对比                   |
| G5  | 受控更新性能            | ⏸ 推迟到 4 | 见 §4.9,Phase 1a 的 7k 字符 fixture 测出 ~50ms,贴线但不阻塞 |
| G6  | 中文 IME                | ✅ 通过    | Crepe 自带 IME 处理;手动验证                                |

---

### Phase 1b — 封装层 ✅ 已完成

#### 1b.1 设计原则(保持不变)

1. **对外 API 与 Milkdown 解耦**——外部组件只看到我们自己的 props,Milkdown 类型不外泄。
2. **Markdown 是唯一真值**——所有 API 都收发 `string`,不暴露任何 AST/JSON。
3. **替换性**——未来如果要换成 CodeMirror Live Preview 或其它,只动这个目录。

#### 1b.2 实际目录结构

```
apps/web/src/components/Milkdown/
├── index.ts                       // 公共 barrel,边界由 ESLint 守住
├── types.ts                       // MilkdownBlockDragEvent / MilkdownDecorationSpec
├── MilkdownEditor.tsx             // 可编辑组件(给 NotePreview 用,占位)
├── MilkdownPreview.tsx            // 只读 / drag-only 组件(MilkdownMessageCard 在用)
├── createMilkdown.ts              // 内部 Crepe 工厂 + MilkdownInstance 5 动词 API
├── markdownUtils.ts               // normalize / equals / ensureNonEmpty
├── milkdown-overrides.css         // Crepe 主题 + KaTeX 在 Sediment design tokens 下的覆盖
└── __tests__/
    ├── roundTrip.test.ts
    ├── markdownUtils.test.ts
    └── fixtures/{simple,math,complex,ai-half-baked}.md
```

差异说明:

- 原计划的 `styles/milkdown-theme.css` + `styles/katex-overrides.css` 合并为单个 `milkdown-overrides.css`,因为两个文件都在覆盖同一套 CSS 变量,拆开反而要在两处维护 token。
- `shadowStyleCache.ts` 不放在本目录,而是相对路径 `apps/web/src/utils/shadowStyleCache.ts` —— `NoteNode` 与 `MilkdownPreview` 都要用,放在 `utils/` 才是共享位置。

#### 1b.3 公共 API(实际形态,已冻结)

```ts
// types.ts
export interface MilkdownBlockDragEvent {
  /** Markdown of the block(s) being dragged. */
  markdown: string;
  /** Native DragEvent; consumer only needs setData. */
  nativeEvent: DragEvent;
}

// MilkdownPreview.tsx
export interface MilkdownPreviewProps {
  markdown: string;
  isolate?: boolean; // 默认 true,Shadow DOM 隔离
  className?: string;
  onBlockDragStart?: (e: MilkdownBlockDragEvent) => void;
}
```

> **与原计划的差异**:删除了 `dragImageElement` / `dragImageOffset` 两个字段。
> 落地时发现 drag image 的生命周期(挂 `document.body` → 截图 → `setTimeout(0)` 移除)由 `MilkdownPreview` 内部全权负责更稳:消费者只关心 `markdown`,不需要也不该接触 `dataTransfer.setDragImage`。计划里那种"把元素递给调用方"的设计反而把内部时序泄漏出去了。

`MilkdownEditor` 暂为占位,Phase 3 才接通(`markdown` / `onChange` / `editable` / `decorations` 等保留原 API)。

#### 1b.4 内部抽象 — `createMilkdown` + `MilkdownInstance`

`createMilkdown.ts` 暴露一个 5 动词 API 把 Crepe 彻底封掉:

```ts
interface MilkdownInstance {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  setReadonly(readonly: boolean): void;
  onMarkdownUpdated(cb: (md: string) => void): () => void;
  getDragPayload(snapshot?: SelectionSnapshot): { markdown: string } | null;
  destroy(): void;
}
```

启用的 Crepe features:`CodeMirror, ListItem, LinkTooltip, Cursor, ImageBlock, BlockEdit, Toolbar, Placeholder, Table, Latex`(不含 `TopBar, AI`)。
`previewMode` 选项关掉 `Toolbar / LinkTooltip / Table / Cursor`,只保留 `BlockEdit` 让 drag handle 仍然可用。

#### 1b.5 `markdownUtils.ts`(无差异)

```ts
export function normalizeMarkdown(md: string): string;
export function ensureNonEmpty(md: string): string; // 保留导出,Phase 3 NotePreview 才会用
export function markdownEquals(a: string, b: string): boolean;
```

#### 1b.6 Shadow DOM(共享于 NoteNode + MilkdownPreview)

`apps/web/src/utils/shadowStyleCache.ts` 中的 `applySharedStyles(shadowRoot)`:同源样式表走 `adoptedStyleSheets`,跨源走 `<link>` clone 兜底。

`MilkdownPreview` 的挂载顺序很关键 —— **先清空子元素,再调 `applySharedStyles`**,否则跨源 `<link>` 兜底会被默默 strip(见 `MilkdownPreview.tsx` ~L240 注释)。

#### 1b.7 边界守护(ESLint 规则,不再用 grep)

`eslint.config.mjs` 中 `no-restricted-imports` 禁止 `@milkdown/*` / `katex` / `katex/*` 在 `apps/web/src/components/Milkdown/**` 之外被引用。CI 跑 `pnpm exec eslint` 即可,无需额外脚本。

```js
{
  files: ['apps/web/src/**/*.{ts,tsx}'],
  ignores: ['apps/web/src/components/Milkdown/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{ group: ['@milkdown/*', 'katex', 'katex/*'], message: '...' }],
    }],
  },
}
```

**Phase 1 验收(最终结果)**:

- ✅ `pnpm --filter web typecheck`
- ✅ `vitest run src/components/Milkdown`(round-trip + markdownUtils,26+ 个 case)
- ✅ ESLint `no-restricted-imports` 规则上线
- N/A `_validate/` 已删除(从未引入,直接生成永久 fixture)

---

## Phase 2 — 替换 BlockNoteCard ✅ 已完成

**分支**:`feat/milkdown-message-card`(基于 Phase 1) — 已合入 `blocknote` 工作分支

为什么先换它:

- **只读** — 不涉及输入、IME、`onChange` 去重等复杂场景
- 数据流单向(message → render),没有持久化
- 出问题不会污染用户数据
- 完整覆盖**渲染 + Shadow DOM + 块拖到 canvas** 三个能力

### 2.1 现状梳理(替换前)

[apps/web/src/components/Messages/Card/BlockNoteCard.tsx](apps/web/src/components/Messages/Card/BlockNoteCard.tsx) 主要做:

1. 用 `useCreateBlockNote` 创建只读编辑器
2. `tryParseMarkdownToBlocks(content)` 把消息文本转成 blocks
3. `<BlockNoteView editable={false}>` 渲染
4. `<SideMenuController>` + `NoteDragHandleButton` 提供拖块到 canvas
5. 自定义拖动预览(多选时拼接 DOM)
6. `setDragPayload` 写入 `SEDIMENT_DND_MIME` + BlockNote 原生 MIME

### 2.2 实际落地形态

新增 [apps/web/src/components/Messages/Card/MilkdownMessageCard.tsx](../apps/web/src/components/Messages/Card/MilkdownMessageCard.tsx)(`BlockNoteCard` 暂未删除,等 Phase 6):

```tsx
import { MilkdownPreview } from '@/components/Milkdown';
import { setDragPayload } from '@/utils/io/dragDrop';

export const MilkdownMessageCard: FC<MilkdownMessageCardProps> = ({
  content,
  threadId,
}) => (
  <MilkdownPreview
    markdown={content}
    isolate
    onBlockDragStart={({ markdown, nativeEvent }) => {
      // Drag image lifecycle is owned by MilkdownPreview internally.
      // Caller only writes the SEDIMENT MIME payload.
      setDragPayload(nativeEvent as unknown as React.DragEvent, {
        kind: 'note',
        origin: buildNoteDragPayload(threadId),
        data: { content: markdown },
      });
    }}
  />
);
```

> 多选拖拽**保留了 BlockNote 时期的体验**:在 `MilkdownPreview` 内部
> 通过 capture-phase mousedown 快照多块 TextSelection,bubbling
> dragstart 再按快照拼出 markdown + 堆叠预览(`buildBlockDragImage` 挂在 `document.body` 的 light DOM 里以规避 Chromium 对 Shadow DOM `setDragImage` 渲染不稳的问题),消费方无需感知"单/多块"差异。详见 [`MilkdownPreview.tsx`](../apps/web/src/components/Milkdown/MilkdownPreview.tsx) 中 `mousedownCaptureHandler` / `dragHandler` 注释。

### 2.3 `utils/io/dragDrop.ts` 同步改动

- `NoteBlockDragPayload.contentJson?: string` 标记为 `@deprecated`,新写入路径不再产生,读取路径暂时保留(canvas 还可能收到来自旧 NotePreview 的 payload,直到 Phase 5 完成)。

### 2.4 验收(实际完成情况)

| #   | 检查项                    | 结果     | 备注                                                                                                |
| --- | ------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| V1  | 历史消息渲染              | ✅ 通过  | 视觉与 BlockNote 等效或更好(数学场景明显更好)                                                       |
| V2  | 数学公式                  | ✅ 通过  | KaTeX 行内 / 块 / 矩阵                                                                              |
| V3  | 拖块到 canvas             | ✅ 通过  | 单 / 多块均正常,落点新建 note 仅含 `content`                                                        |
| V4  | Shadow DOM 隔离           | ✅ 通过  | 双向无样式串扰                                                                                      |
| V5  | typecheck + lint + format | ✅ 通过  | —                                                                                                   |
| V6  | 单元测试                  | ⚠ 部分   | `MilkdownMessageCard.test.ts` 覆盖纯 `buildNoteDragPayload` helper;组件级 RTL 留待与 Phase 3 一起做 |
| V7  | 性能                      | ⏸ 未量化 | 主观流畅,Phase 4 §4.9 一并量化                                                                      |
| V8  | 灰度                      | ✅ 通过  | `VITE_MESSAGE_RENDERER=milkdown\|blocknote` 上线,默认 `milkdown`                                    |

### 2.5 不做的事

- ❌ 删除 `@blocknote/*` 依赖(NotePreview 还在用)
- ❌ 删除 `dragDrop.ts` 的 `contentJson` 字段
- ❌ 改任何持久化数据
- ❌ 改 `index.css` 里的 ShadCN 桥接(NotePreview 还需要)

### 2.6 Phase 2 落地后的发现 & follow-up

落地实现与 §1b.3 / §2.2 的预案有几处偏差,记录在此供 Phase 3 / Phase 5 参考:

1. **多块拖拽**没有降级为单选,而是在 [`MilkdownPreview.tsx`](../apps/web/src/components/Milkdown/MilkdownPreview.tsx) 内通过 capture-phase mousedown 抓快照 + bubbling dragstart 重建实现。Phase 5 因此不需要再写多块算法,直接抽 hook 复用即可(参见 §5.6)。

2. **drag-image 构建器**(`buildBlockDragImage`)同时服务单块与多块,挂在 `document.body` 的 light DOM 里以规避 Chrome 对 Shadow DOM 元素 `setDragImage` 渲染不稳的问题。`MilkdownPreview` 持有 image 生命周期,消费者只负责写 `SEDIMENT_DND_MIME`。

3. **已知问题** — `getMultiBlockSelectionRange` 当前读 `view.state.selection`,而 `prosemirror-view@1.41.6` 的 `selectionchange` 监听器只挂在 outer document、不响应 Shadow DOM 内的 selection 变化(Safari 有 `safariShadowSelectionRange` workaround,Chromium 走兜底)。在较老的 Chromium 版本上,多块文字选择可能拿到 stale 的 PM state,从而被静默降级为单选。

   **修复建议**(可作为 Phase 2 hot-fix 或并入 Phase 3):把 `getMultiBlockSelectionRange` 改成直接读 `view.root.getSelection()`(shadow-scoped),用 `view.posAtDOM` 翻译为 PM positions,绕过 PM 的过期 state。改动局限在 [`createMilkdown.ts`](../apps/web/src/components/Milkdown/createMilkdown.ts) 一个函数内。

---

## Phase 3 — 替换 NotePreview(主战场) ✅ 已完成

**分支**:`feat/milkdown-note-preview`(基于 Phase 2)

### 3.0 范围:NoteNode + NotePreview 同 PR 替换 ✅ 已完成

| 文件              | 用途                      | 当前实现 → Phase 3                                         |
| ----------------- | ------------------------- | ---------------------------------------------------------- |
| `NoteNode.tsx`    | canvas 折叠态只读渲染     | BlockNote → `<MilkdownPreview markdown={data.content} />`  |
| `NotePreview.tsx` | canvas 展开态可编辑编辑器 | BlockNote → `<MilkdownEditor markdown=... onChange=... />` |

**为什么必须同 PR**:两者读同一份 `data.content`,防止折叠/展开态内容视觉不一致。

### 3.1 输入数据变更 ✅ 已完成

- **只读 Markdown**:NotePreview / NoteNode 仅读取 `data.content`
- **停止写入**:`contentJson` / `contentJsonSource` 不再由前端生成(历史数据保留,Phase 6 清理)
- **Provenance 处理**:Phase 4 之前暂不显示 AI 修改标记

### 3.2 补丁迁移 ✅ 已完成

所有 BlockNote 时期的补丁(M1-M6)已集成到 Milkdown 封装层或被消除:

| 旧补丁                               | 处置                                      |
| ------------------------------------ | ----------------------------------------- |
| M1 双轨加载 (`loadBlockNoteContent`) | **删** — 直接受控 markdown                |
| M2 空内容归一化                      | **封装** — `ensureNonEmpty()` 内部处理    |
| M3 `.trim()` 散点                    | **收口** — `normalizeMarkdown()` 统一处理 |
| M4 去重 (`lastAppliedMarkdownRef`)   | **简化** → `lastEmittedMarkdownRef`       |
| M5 JSON 去重                         | **简化** → 字符串去重                     |
| M6 加载竞态                          | **保留** — 由 `MilkdownEditor` 内部封装   |

### 3.3 拖块到 canvas ✅ 已完成

原计划 Phase 5 的任务在 Phase 3 提前完成:

- **blockDrag.ts**:从 `MilkdownPreview` 提取出的共享 drag 处理器,同时服务编辑态和预览态
- **MilkdownEditor.onBlockDragStart**:拖块到 canvas 的完整入口已接通
- **多块拖拽**:capture-phase mousedown 快照 + drag-image 生成器,单/多块视觉一致
- **不需要 Phase 5 单独处理**:拖拽能力完整可用,无需进一步重写

### 3.4 验收 ✅ 已完成

| 检查项           | 状态 | 备注                                   |
| ---------------- | ---- | -------------------------------------- |
| 历史 note 加载   | ✅   | 折叠/展开态渲染一致                    |
| 数学公式编辑     | ✅   | KaTeX 行内/块皆可                      |
| IME(中文/日文)   | ✅   | 选词期间无误触发 onChange              |
| 加载竞态         | ✅   | 无 stale onChange 反写                 |
| 拖块到 canvas    | ✅   | 单/多块均正常,新建 note 仅含 `content` |
| typecheck + lint | ✅   | 零错误                                 |
| CHANGELOG 更新   | ✅   | 已记录用户感知变化                     |

### 3.5 不做的事

- ❌ Provenance 支持 — Phase 4 事项
- ❌ 删除 BlockNote 依赖 — Phase 6 清理
- ❌ 自动标题提取 — 旧方案也未实现,不再需要

---

## Phase 4 — Provenance 重锚

**分支**:`feat/milkdown-provenance`(基于 Phase 3 稳定 1 周)

**目标**:用块 fingerprint 模型最小化地还原旧 BlockNote 时代的 AI 改写标记体验(色条 / 接受 / 拒绝 / 删除恢复)。Phase 4 后续可继续迭代视觉与交互细节。

**前置已敲定的决策**(2026-05 Pre-flight):

| 决策               | 选择                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 锚定策略           | **块 fingerprint**(非行 diff)。任何方案都需回答"这块还是不是那块",fingerprint 把这件事压缩到最小决策面。                                                                                  |
| 历史数据           | **完全抛弃**。无迁移、无兼容,旧字段(`provenance`/`contentJson`/`contentJsonSource`/`_legacyProvenanceCleared`)读到即丢弃。                                                                |
| 服务端精确 range   | **拆出 Phase 4.5 单独 PR**。Phase 4 期间前端自标(diff 块集合),Phase 4.5 接入服务端给出的精确块集合。                                                                                      |
| fingerprint 公式   | `hash(node.toJSON())` —— 包含 marks、子结构,粗体/斜体修改会触发标记;ProseMirror 自有归一化避免 markdown serializer 风格差。                                                               |
| 同 doc 重复块去重  | `key + occurrenceIndex` 后缀。                                                                                                                                                            |
| streaming 标记时机 | **stream 结束一次性 stamp**(对 stream 开始前的 doc 与最终 doc 做块 diff),不在 chunk 中抖动。                                                                                              |
| 删除块呈现         | **数据 + 算法保留**;UI 用 React **portal 贴附到锚点块**(不进 ProseMirror doc),复用 `<MilkdownPreview>` 渲染原文 + 划线样式 + 单块 reject 按钮;**默认展开**,与旧 `InlineBlockDiffs` 一致。 |
| P1 产品语义        | **沿用旧 BlockNote 实现**:per-block accept/reject、整篇 accept-all/reject-all、用户编辑被标块时 fingerprint 变 → 标记自动消失("视为接受")、纯格式调整若 marks 改变也算改动。              |

### 4.1 块 fingerprint —— 概念回顾

ProseMirror 节点没有持久 ID。要在两次 markdown 之间识别"这块还是那块",我们对每个 top-level block 计算一个稳定 key:

```ts
function blockFingerprint(node: PMNode, occurrenceIndex: number): string {
  const json = node.toJSON(); // 包含 type / attrs / content / marks
  const base = stableStringify(json); // 排序 key 的 JSON.stringify
  return `${sha1(base)}#${occurrenceIndex}`;
}
```

- 用于 stamp:AI 写入后,fingerprint 在旧 doc 不存在 = 新增/被改写,stamp 上 ai 标记。
- 用于 shift:每次用户编辑后重新算 doc 块 fingerprint,标记天然跟随到新位置。
- 用于 decoration:`fingerprint → block.pos` 反查表 → `Decoration.node`。

容器宽度、滚动、wrap 都不影响 fingerprint —— 它只读 markdown 真值经过 PM schema 归一化的结果。

### 4.2 数据结构

放在 `packages/shared/src/types/provenance.ts`,**直接替换**旧 `BlockProvenanceMap`(无 deprecate 期):

```ts
export interface BlockProvenance {
  /** PM-JSON-hash + #occurrenceIndex,见 §4.1. */
  key: string;
  /** Markdown of the block as it was right before the AI edit. */
  baselineMarkdown: string;
  at: string;
}

export interface DeletedBlockInfo {
  key: string;
  baselineMarkdown: string;
  /** key of the surviving block this tombstone hangs after; null = doc head. */
  anchorKey: string | null;
  at: string;
}

export interface MarkdownProvenance {
  version: 1;
  blocks: BlockProvenance[];
  deletedBlocks: DeletedBlockInfo[];
}
```

`NoteNodeData` 用新字段 `provenanceV2: MarkdownProvenance | undefined`,旧字段 `provenance` 一并在 Phase 4 PR 中删除(无迁移)。

### 4.3 核心算法(`apps/web/src/utils/blockProvenance.ts`)

无第三方依赖,纯 PM 操作。

```ts
/** Compute fingerprints for every top-level block of a doc. */
export function computeBlockKeys(doc: PMNode): string[];

/** Diff old/new key arrays; produce per-block changes (added/removed/kept). */
export function diffBlockKeys(
  oldKeys: string[],
  newKeys: string[],
): {
  addedKeys: string[];
  removedKeysWithAnchor: Array<{ key: string; anchorKey: string | null }>;
};

/**
 * stamp() — called once when an AI streaming write completes.
 * - For each addedKey → push BlockProvenance with baselineMarkdown = serialized old block at that position (or '' if pure insertion).
 * - For each removedKey → push DeletedBlockInfo with baselineMarkdown + anchorKey.
 */
export function stampAiEdit(
  oldDoc: PMNode,
  newDoc: PMNode,
  prov: MarkdownProvenance,
): MarkdownProvenance;

/**
 * shift() — called on every user edit's onChange.
 * - Drop entries whose key no longer appears in current doc → "user edited, auto-accept".
 * - Drop tombstones whose anchorKey no longer exists → "context lost, cannot restore".
 */
export function shiftProvenance(
  currentDoc: PMNode,
  prov: MarkdownProvenance,
): MarkdownProvenance;

/** Accept one block: just remove the entry; markdown unchanged. */
export function acceptBlock(
  key: string,
  prov: MarkdownProvenance,
): MarkdownProvenance;

/** Accept all: clear blocks[] AND deletedBlocks[]. */
export function acceptAll(prov: MarkdownProvenance): MarkdownProvenance;

/**
 * Reject one block: replace the live block with its baselineMarkdown.
 * Returns a transaction the caller applies to the editor.
 */
export function rejectBlock(
  key: string,
  prov: MarkdownProvenance,
  ctx: { editor: MilkdownInstance },
): { tr: Transaction; newProvenance: MarkdownProvenance };

/** Reject one tombstone: insert baselineMarkdown after anchorKey. */
export function rejectDeletedBlock(
  deletedKey: string,
  prov: MarkdownProvenance,
  ctx: { editor: MilkdownInstance },
): { tr: Transaction; newProvenance: MarkdownProvenance };

/** Reject all: walk in stable order, applying both shapes above. */
export function rejectAll(
  prov: MarkdownProvenance,
  ctx: { editor: MilkdownInstance },
): { tr: Transaction; newProvenance: MarkdownProvenance };
```

`MilkdownInstance` 在 Phase 1b 已有 5 动词 API,需要为 Phase 4 扩展:

```ts
interface MilkdownInstance {
  // ...existing 5 verbs
  /** Locate block start/end positions by fingerprint key. */
  getBlockRangeByKey(key: string): { from: number; to: number } | null;
  /** Get DOM element of the block (for portal anchoring). */
  getBlockDOMByKey(key: string): HTMLElement | null;
  /** Parse markdown to PM nodes, used by reject paths. */
  parseMarkdownFragment(md: string): Fragment;
}
```

### 4.4 Decoration 与 Tombstone Portal

`MilkdownEditor.decorations` 接收编译好的 spec:

```ts
export interface MilkdownDecorationSpec {
  /** Highlight live ai blocks via Decoration.node. */
  blocks: Array<{ key: string; className: string }>;
  /** Tombstones rendered via React portal anchored on a surviving block. */
  tombstones: Array<{
    deletedKey: string;
    anchorKey: string | null;
    markdown: string;
  }>;
}
```

封装层负责:

- **blocks**:`fingerprint → pos` 反查 → `Decoration.node(from, to, { class })`。
- **tombstones**:不进入 ProseMirror doc。上层 `<TombstoneOverlay>` 组件 useEffect 里:
  - 通过 `getBlockDOMByKey(anchorKey)` 拿到锚点 DOM(`anchorKey === null` 用 editor root)
  - 用 React portal 在锚点 DOM 子树末尾(absolute / position: relative 父级)挂一个折叠样式的 tombstone 卡片
  - 卡片内部用 `<MilkdownPreview markdown={info.baselineMarkdown} isolate />` 复用 Phase 1b 组件,保真渲染
  - 卡片自带 `Reject`(恢复该块)/ `Dismiss`(放弃恢复)按钮;hover 显示完整内容,默认展开
- 锚点 DOM 在编辑过程中由于 wrap / 高度变化的位置漂移,**因为 portal 挂在锚点子节点上,跟随是 CSS 层面的,不需要监听几何变化**

### 4.5 服务端 AI 写入路径(Phase 4 内的保底)

服务端短期内**仍按现有协议输出最终 markdown**,Phase 4 PR 中:

- 删除 `provenance.__all__` 哨兵处理 / `expandSentinelProvenance`。
- 前端在收到 `stream-done` 边界时:
  1. 取 stream 开始前的 `oldDoc` 快照
  2. 用最终 `newDoc` 调 `stampAiEdit(oldDoc, newDoc, prov)` 一次性标记
- 这意味着 Phase 4 期间**纯格式调整**(只改 marks)也会被标 ai —— 接受这一行为,Phase 4.5 服务端给出精确块集合后自然收窄。

**保底再保底**:如果 Phase 4 上线后发现"前端自标"在某些 case 下噪声过大,临时退化方案是**把所有变化块标成 ai 而不计较"原本是什么"** —— 即跳过 stampAiEdit 的 baselineMarkdown 计算,baseline 留空,reject 退化为"删除该块"。该退化通过 `VITE_PROVENANCE` 灰度切换。

### 4.6 服务端精确 range —— Phase 4.5 后续 PR

不在 Phase 4 范围内。届时:

- 服务端在生成 markdown 时同时输出 `aiBlockKeys: string[]`(与前端 fingerprint 公式对齐)。
- 前端收到 → 不再做"diff 整篇" stamp,改为按服务端给出的 keys 精确标记。
- wire schema 加入 `packages/shared`,zod 校验。
- 灰度:服务端字段缺失时自动 fallback 到 Phase 4 的"前端自标"路径。

### 4.7 验收

| #      | 检查项                                    | 标准                                                                                                    |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P4.V1  | `computeBlockKeys` / `diffBlockKeys` 单测 | 覆盖:同 doc 重复块的 occurrenceIndex 消歧、纯 marks 变化触发 key 变化、表格/代码块/数学块完整作为单 key |
| P4.V2  | `stampAiEdit` 单测                        | 覆盖:整段替换 / 局部插入 / 局部删除 / 块顺序调换 / 同 baseline 多次 stamp                               |
| P4.V3  | `shiftProvenance` 单测                    | 覆盖:用户编辑 ai 块 → 标记消失、用户改了 anchor 块 → 对应 tombstone 消失、用户没动任何 ai 块 → 标记保留 |
| P4.V4  | `rejectBlock`                             | 块替换为 baselineMarkdown,markdown round-trip 一致                                                      |
| P4.V5  | `rejectDeletedBlock`                      | tombstone 内容插回 anchor 块之后                                                                        |
| P4.V6  | `rejectAll`                               | 顺序应用所有 reject,最终 markdown = 第一个 ai 编辑前的状态                                              |
| P4.V7  | UI:色条 + tombstone                       | 与旧 BlockNote 实现视觉等效(肉眼对比);tombstone portal 在锚点滚动/wrap 时跟随正确                       |
| P4.V8  | 旧数据兼容                                | 加载到旧 `provenance` / `contentJson` 字段一律忽略,不报错                                               |
| P4.V9  | 性能                                      | 500 块 doc + 50 ai 块,fingerprint 全量重算 + decoration 编译 < 5ms                                      |
| P4.V10 | 灰度                                      | `VITE_PROVENANCE=on\|off`,off 时编辑器完全不渲染色条/tombstone                                          |

### 4.8 风险

- **fingerprint 碰撞**:同 doc 内容完全相同的块 → `#occurrenceIndex` 后缀解决;跨 doc 不需要稳定。
- **Streaming 期间用户编辑**:stream 中如果用户在另一台设备编辑,stamp 时的 `oldDoc` 不再是真实历史。Phase 4 范围内**禁止 streaming 期间编辑**(沿用 NotePreview 现有 `editable={!loading}`)。
- **tombstone portal 与 ReactFlow 缩放**:Phase 4 内的 NoteNode 是非折叠态,正常嵌入 React tree,缩放由父级处理,无额外工作。
- **anchor 链断裂**:连续多次 AI 改写后,anchorKey 可能被另一次 AI 改写改变 → shiftProvenance 中"anchor 不存在则丢弃 tombstone",产品语义可接受(等同于"上下文消失,无法精确恢复")。

### 4.9 性能跟踪 — setMarkdown 流式延迟(从 Phase 1a 延后)

**Phase 1a Gate G5 结论**:7k 字符 `replaceAll` 稳态 median ≈ 50ms,贴线但不阻塞迁移。原因是探针测的是"病态结构 fixture(200+ 块) + 全文 replace",真实节点结构更稀疏。

**Phase 4 接入 AI 流式写入时必须做的评估**:

1. 用真实 Sediment note 形态(30-50 段、若干 list/table/math 混合)的 fixture 重测 setMarkdown 延迟。
2. 接入服务端实际 chunk 节奏(典型 10-20Hz)做端到端流式压测。
3. 如果端到端帧时间超过 100ms 或主线程长任务出现,**择一接入**:
   - `@milkdown/plugin-streaming`(官方增量 append,per-chunk O(chunk) 而非 O(全文))
   - 上层 chunk buffer + `requestAnimationFrame` 节流(把多个 chunk 合并成一次 setMarkdown)
4. 该决定不影响 Phase 1b 封装层 API —— `MilkdownEditor.markdown` 受控接口对两种实现方式都兼容。

---

## Phase 5 — 拖块到 canvas(已在 Phase 3 完成)

**原计划分支**:`feat/milkdown-dragout`

Phase 3 的实现中,`blockDrag.ts` 已从 `MilkdownPreview` 提取为独立共享模块。`MilkdownEditor.onBlockDragStart` 也已完整接通,拖块能力在展开态和预览态都完全可用。

**Phase 5 实际工作**:清理旧 BlockNote 基础设施、整理 drag 模块位置。不需要新的算法实现。

### 5.1 已完成的能力

- ✅ `blockDrag.ts`:共享 drag 处理器(capture mousedown 快照 + bubble dragstart payload)
- ✅ `buildBlockDragImage()`:统一 drag-image 构建,单/多块一致
- ✅ `MilkdownEditor.onBlockDragStart`:拖块到 canvas 入口已接通
- ✅ SEDIMENT_DND_MIME payload 生成:`{ kind: 'note', data: { content: markdown } }`

### 5.2 后续清理(与 Phase 6 并行)

| 任务                     | 文件                     | 说明                            |
| ------------------------ | ------------------------ | ------------------------------- |
| 删除 BlockNote drag 入口 | `NoteEditorSideMenu.tsx` | 整文件删除                      |
| 删除 contentJson 字段    | `dragDrop.ts`            | 标记 `@deprecated`              |
| 简化 drag payload        | `dragDrop.ts`            | 仅需 `kind: 'note'` + `content` |
| 删除 BlockNote 依赖      | 各 import                | 见 Phase 6                      |

---

## Phase 6 — Cleanup & 数据迁移

**分支**:`chore/remove-blocknote`(基于 Phase 5)

### 6.1 代码清理

| 项                                                                    | 操作                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/web/src/components/BlockNote/`                                  | **整目录删除**                                                      |
| `package.json` 三个 `@blocknote/*` 依赖                               | 删除                                                                |
| `apps/web/src/main.tsx` 两条 BlockNote CSS import                     | 删除                                                                |
| `apps/web/src/index.css` `@source @blocknote/shadcn`                  | 删除                                                                |
| `apps/web/src/index.css` ShadCN 桥接段(`--radius`、`--background` 等) | **谨慎确认其它地方不引用**(grep `--background`、`--primary` ……)再删 |
| `apps/web/src/components/Messages/Card/BlockNoteCard.tsx`             | 改名 `NoteMessageCard.tsx`,所有 import 更新                         |
| `apps/web/src/handler/canvasCommand/commands/changeNodeType.ts`       | 从字段清单移除 `contentJson` / `contentJsonSource`                  |
| `apps/web/src/utils/provenance.ts` 中所有 block-id-keyed 的旧 API     | 删除                                                                |
| `packages/shared/src/types` 中旧的 `BlockProvenanceMap`               | 删除                                                                |

### 6.2 持久化数据迁移

```ts
// apps/server/src/modules/canvas/migrations/2026-XX-strip-blocknote-fields.ts
// 启动时跑一次,幂等,记日志
export async function stripBlockNoteFields() {
  // For each note node in every canvas:
  //   delete data.contentJson
  //   delete data.contentJsonSource
  //   delete data._legacyProvenanceCleared
  // 返回受影响节点数量
}
```

上线前先在测试库灌一份 production snapshot 跑一遍。

### 6.3 Feature flag 清理

| Flag                    | 引入 Phase | 操作                   |
| ----------------------- | ---------- | ---------------------- |
| `VITE_MESSAGE_RENDERER` | 2          | 删除,代码固定 milkdown |
| `VITE_NOTE_EDITOR`      | 3          | 删除,代码固定 milkdown |

### 6.4 文档

- `docs/user-guide/CHANGELOG.md` 新增一条:
  - **What Changed**:笔记编辑器内核切换到 Milkdown,新增数学公式支持(LaTeX `$...$` / `$$...$$`)
  - **Notes**:历史笔记的"AI 修改标记"已在升级时一次性清除;笔记**内容本身完全保留**
- 本文档加 `> Status: Completed (YYYY-MM)`,移到 `docs/archive/`(如有该目录)或保留原位
- `.github/copilot-instructions.md` 如果有 BlockNote 相关提示,同步更新

### 6.5 验收

| #     | 检查项                                | 标准                                        |
| ----- | ------------------------------------- | ------------------------------------------- |
| P6.V1 | `package.json` 无 `@blocknote/*`      | grep 通过                                   |
| P6.V2 | `node_modules/@blocknote` 不存在      | `pnpm i` 后确认                             |
| P6.V3 | 全量 typecheck + lint + format + test | 全绿                                        |
| P6.V4 | bundle size                           | 净减少 ≥ 400 KB gzip(相对未迁移基线)        |
| P6.V5 | 持久化迁移                            | 测试库上跑一次,字段确实被清,note 渲染无差异 |
| P6.V6 | 用户文档                              | CHANGELOG 已更新,本迁移文档已标记完成       |

---

## 跨阶段:回滚与风险

| 风险                             | Phase | 缓解                                          |
| -------------------------------- | ----- | --------------------------------------------- |
| Phase 1a 任一 Gate 不通过        | 1a    | 直接放弃 Milkdown,文档归档,按附录 B 走备选    |
| 数学某种边缘场景 round-trip 失败 | 1a    | 文档化为已知限制,与产品确认是否阻塞           |
| 消息卡片样式回退                 | 2     | feature flag `VITE_MESSAGE_RENDERER` 一键切回 |
| 笔记编辑出现严重 bug             | 3     | feature flag `VITE_NOTE_EDITOR` 一键切回      |
| Milkdown import 泄漏到封装层外   | 1+    | CI grep 检查(1.7)                             |
| Shadow DOM 在某些浏览器异常      | 2     | `<MilkdownPreview isolate={false}>` 可降级    |
| Provenance 行号在编辑漂移中失准  | 4     | `shiftProvenance` 全覆盖单测(P4.V1)           |
| Provenance 数据迁移丢失用户标注  | 4     | 提前 Phase 3 banner 通知,降低用户预期         |
| 删除 ShadCN CSS 桥接误伤其它组件 | 6     | grep `--radius` / `--background` 全量扫描     |

**回滚边界**:

- Phase 1-2:可任意 revert,无数据影响
- Phase 3:可通过 feature flag 切回 BlockNote;数据上 `contentJson` 字段会过时但仍存在
- Phase 4:**单向**,因为 provenance 格式已经换。要回滚得跑反向 migration,且会丢新写入的 AI 标注
- Phase 5:可 revert,但要先把 Phase 4 一起 revert
- Phase 6:删除性操作,**不可回滚**,只能从 git 历史恢复

## 附录 A:Phase 1 完成后的 import 边界

```
✅ 允许:
  apps/web/src/components/Milkdown/**  →  @milkdown/*, katex

❌ 禁止:
  其它任何文件  →  @milkdown/*

  其它任何文件  →  @blocknote/*  (待 Phase 6 整体禁用)
```
