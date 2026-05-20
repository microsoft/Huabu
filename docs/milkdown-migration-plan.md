# Milkdown 迁移方案 — 完整规划

> 范围:本文档覆盖 **Phase 1 ~ Phase 6** 的完整迁移路径。
> 每个 Phase 都是独立 PR、独立验收、独立可回滚。Phase 1a 验收 Gate 不通过则全部终止。

> **进度**(`blocknote` 分支):
>
> - ✅ **Phase 1a** 已完成 — 四个 fixture round-trip 在 vitest 里稳定通过(`apps/web/src/components/Milkdown/__tests__/roundTrip.test.ts`,happy-dom + Crepe parser/serializer)
> - ✅ **Phase 1b** 已完成 — 封装层 `apps/web/src/components/Milkdown/` 上线,ESLint `no-restricted-imports` 锁住边界
> - ✅ **Phase 2** 已完成 — `MilkdownMessageCard` 替换 `BlockNoteCard`,多块拖拽行为对齐(详见 §2.6)
> - ⏳ **Phase 3 ~ Phase 6** 未启动 — 按原计划等待 Phase 2 灰度

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

## Phase 3 — 替换 NotePreview(主战场)

**分支**:`feat/milkdown-note-preview`(基于 Phase 2 上线后稳定 1 周)

为什么这是主战场:

- 700+ 行,几乎所有补丁(M1-M6)都集中在这里
- 涉及输入、IME、加载竞态、自动标题、Provenance 入口
- 直接面向用户最高频的交互

### 3.1 输入数据变更

旧:

```ts
const markdown = data.content;
const contentJson = data.contentJson;
const contentJsonSource = data.contentJsonSource;
```

新(只读 markdown 一项):

```ts
const markdown = data.content;
// contentJson / contentJsonSource 字段仍可能存在于历史数据,但不再读取也不再写入
```

**关键决定**:Phase 3 合入后**立即停止写入** `contentJson` / `contentJsonSource`,但不删字段(等 Phase 6)。理由是**把 destructive schema migration 单独成 PR**:Phase 3 期间需要观察期确认 Milkdown 无 silent data loss,期间历史 blob 里的旧字段是事后取证的唯一线索;类型 + zod schema + 数据库迁移本身扇出面广,与"换编辑器"这种行为变更同 PR 容易混进无关 bug。(顺带:`VITE_NOTE_EDITOR` 灰度回退到 BlockNote 时旧字段仍可被读到。)

### 3.2 补丁迁移对照表

| 旧补丁                                        | 位置                                       | 新做法                                                  | 处置                          |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- | ----------------------------- |
| M1 双轨存储 (`loadBlockNoteContent`)          | blockNoteContent.ts                        | `<MilkdownEditor markdown={data.content} />` 受控       | **删**                        |
| M2 空内容归一化                               | blockNoteContent.ts:40 / BlockNoteCard:186 | `ensureNonEmpty()` 在 markdownUtils 内部                | **删调用点,逻辑保留在封装层** |
| M3 `.trim()` 序列化                           | NotePreview ×5 处                          | `normalizeMarkdown()` 在 onChange 出口统一收口          | **删散点,收到 markdownUtils** |
| M4 `lastAppliedMarkdownRef`                   | NotePreview:62                             | 受控组件天然处理,仍保留作为入口去重(避免 setState 反弹) | **保留**                      |
| M5 `lastDocJSONRef` 去重                      | NotePreview:70                             | 改为 `lastEmittedMarkdownRef`(字符串相等比 JSON 还便宜) | **保留,简化**                 |
| M6 `isReplacingRef` + `editable={!loading}`   | NotePreview:72/171                         | 保留,与编辑器无关的异步加载竞态                         | **保留**                      |
| 自动标题提取(从 BlockNote 文档第一个 heading) | NotePreview 顶部函数                       | 重写为基于 markdown 字符串的轻量解析                    | **重写**                      |

### 3.3 自动标题提取

旧实现读 `editor.document` 找第一个 heading block。新实现独立成一个纯函数:

```ts
// apps/web/src/utils/io/extractTitleFromMarkdown.ts
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/m;
const NON_EMPTY_RE = /^([^\s#>\-*].*)$/m;

export function extractTitleFromMarkdown(md: string): string {
  const heading = HEADING_RE.exec(md)?.[2];
  if (heading) return heading.trim();
  return NON_EMPTY_RE.exec(md)?.[1]?.trim().slice(0, 80) ?? '';
}
```

加 vitest 覆盖:无内容、只有 heading、heading + 段落、HTML heading 不识别。

### 3.4 Provenance 处理(Phase 3 期间的临时方案)

Phase 4 还没做,所以 Phase 3 期间**不能真正支持 provenance**。临时策略:

- 加载历史 note 时:**清空** `data.provenance`,加一次性审计字段 `data._legacyProvenanceCleared = true`(Phase 6 删)
- 显示一次性 banner:"AI 修改标记已重置(笔记编辑器升级)",dismiss 后不再出现
- AI 改写时:**不写**任何 provenance(服务端可能仍发 `__all__`,前端忽略)
- "接受 / 拒绝 AI 修改" 按钮:Phase 3 期间**隐藏**

这是有意为之的产品降级,Phase 4 上线后恢复。**必须提前与产品对齐**,并写进 CHANGELOG。

### 3.5 验收

| #     | 检查项              | 标准                                                            |
| ----- | ------------------- | --------------------------------------------------------------- |
| P3.V1 | 历史 note 加载      | 抽样 20 个不同复杂度的 note,内容渲染无丢失                      |
| P3.V2 | 数学公式编辑        | 新建 note,输入 `$E=mc^2$`,渲染、保存、重新打开后字符串完全相同  |
| P3.V3 | IME(中文/日文)      | 输入法选词期间不触发 onChange;光标稳定                          |
| P3.V4 | 加载竞态            | 快速切换 canvas 上 5 个 note,无 stale onChange 反写             |
| P3.V5 | 自动标题            | 新增 / 修改 heading 时,canvas 上的 note 标题同步更新            |
| P3.V6 | 性能                | 5000 字 note 输入流畅,onChange 节流后 ≥ 55 FPS                  |
| P3.V7 | 灰度                | `VITE_NOTE_EDITOR=milkdown\|blocknote`,默认 milkdown,可一键回退 |
| P3.V8 | Provenance 降级提示 | 历史 note 打开时一次性 banner 显示并可 dismiss                  |

### 3.6 不做的事

- ❌ 删除 `@blocknote/*` 依赖(留给 Phase 6)
- ❌ 真正的 provenance 支持(Phase 4)

> **关于拖块到 canvas** — 原计划在 Phase 3 期间禁用此入口并加 banner,等 Phase 5 才接通。
> 由于 Phase 2 已经把多块快照 + drag-image 构建器完整落地在 `MilkdownPreview`(参见 §2.6),Phase 5 实际工作量大幅缩小(主要剩"把 wiring 抽成 hook 让 `MilkdownEditor` 共用 + 防自删 + 删旧文件")。Phase 3 期间有两种走法:
>
> - **路径 A (保守,按原计划)** — Phase 3 仅替换编辑器内核,拖块入口禁用 + banner,Phase 5 单独 PR 接通 drag wiring。PR 范围小、独立可回滚。
> - **路径 B (提前合并)** — Phase 3 顺手把 §5.3 的 hook 抽取 + `MilkdownEditor.onBlockDragStart` 接通做掉,跳过 banner 与"入口暂时不可用"的产品降级。代价:Phase 3 PR 变大、与 Phase 5 风险耦合。
>
> 决策时机:Phase 3 kickoff 前,基于 Phase 2 灰度反馈选定。两条路径都不影响 Phase 4 / Phase 6。

---

## Phase 4 — Provenance 重锚

**分支**:`feat/milkdown-provenance`(基于 Phase 3 稳定 1 周)

整个迁移**最高风险**的一步,**独立 PR,独立验收**,不与其它 phase 混。

### 4.1 设计选定:行区间 + diff 平移(Strategy A)

回顾:Milkdown 的 ProseMirror 节点没有持久 ID(BlockNote 也没有,只是它内部生成了),所以**不能再以 block id 作 key**。三种候选(行区间 / 注入 HTML comment / 内容指纹)中,行区间最契合"markdown 真值"原则。

### 4.2 新数据结构

放在 `packages/shared/src/types/provenance.ts`:

```ts
export interface RangeProvenance {
  /** 0-based start line, inclusive. */
  startLine: number;
  /** 0-based end line, exclusive. */
  endLine: number;
  author: 'ai' | 'user';
  createdAt: string;
  /** AI 改之前用户原本的整段 markdown 子串(供回退). */
  baselineText?: string;
  modifications?: Array<{ by: 'user' | 'ai'; at: string }>;
}

export interface MarkdownProvenance {
  /** Anchoring schema version, bumped on incompatible change. */
  version: 1;
  /** Non-overlapping ranges, sorted by startLine. */
  ranges: RangeProvenance[];
}
```

旧的 `BlockProvenanceMap` 类型保留 + `@deprecated`,Phase 6 删除。

### 4.3 核心算法(`apps/web/src/utils/provenanceShift.ts`)

依赖:`diff-match-patch`(MIT, ~40 KB, 单文件, 无 transitive)。

```ts
/**
 * 用 line-level diff 把所有 range 从 oldMd 平移到 newMd。
 * - 完全被删的 range → 转成 __deleted__ 条目(保留 baselineText)
 * - 部分相交的 range → 按受影响行重新计算边界
 */
export function shiftProvenance(
  oldMd: string,
  newMd: string,
  prov: MarkdownProvenance,
): MarkdownProvenance;

/** 在指定 range 标记为 AI 改动,带 baselineText. */
export function stampAiRange(
  range: { startLine: number; endLine: number },
  baselineText: string,
  prov: MarkdownProvenance,
): MarkdownProvenance;

/** 拒绝:用 baselineText 替换该 range 的当前 markdown,删除条目. */
export function rejectAiRange(
  md: string,
  rangeIndex: number,
  prov: MarkdownProvenance,
): { newMarkdown: string; newProvenance: MarkdownProvenance };

/** 接受:只删除条目,markdown 不变. */
export function acceptAiRange(
  rangeIndex: number,
  prov: MarkdownProvenance,
): MarkdownProvenance;
```

所有用例必须有完整单测,这是整个 phase 的脊柱。

### 4.4 落地 `MilkdownEditor.decorations`(Phase 1 预留的接口)

```ts
export interface MilkdownDecorationSpec {
  ranges: Array<{
    startLine: number;
    endLine: number;
    className: string; // 例如 'sediment-ai-bar-deep'
    accessory?: ReactNode; // 渲染在块尾的接受/拒绝按钮(用 portal)
  }>;
}
```

Milkdown 内部用 ProseMirror `Decoration.node` / `Decoration.widget` 在每次 doc 变化时根据 `ranges` 重建。注意:Decoration 是按 ProseMirror position 而非 markdown line 索引的,封装层需做一次 line → pos 转换(基于 doc 的 nodeAt + lineAt)。

### 4.5 服务端 AI 写入路径

当前 server 用 `provenance.__all__` 哨兵,前端在 BlockNote 解析后展开成 per-block。新流程:

- 服务端**生成新 markdown 时**:直接计算"被改/新增/删除"的 line range,拼成 `MarkdownProvenance`
- 前端收到 → 调 `stampAiRange` 合并到现有 provenance
- 不再使用 `__all__` 哨兵(`expandSentinelProvenance` 删除)

如果服务端短期内做不到精确 range,**保底方案**:把整篇标成 AI 改写(单个 range 覆盖全文,`startLine=0, endLine=lineCount`),后续用户编辑通过 `shiftProvenance` 自然收敛。

### 4.6 数据迁移

```ts
// apps/server/src/modules/canvas/migrations/2026-XX-prov-to-range.ts
export function migrateNoteProvenance(node: NoteNodeData): NoteNodeData {
  const old = node.provenance as unknown;
  if (!old || isMarkdownProvenance(old)) return node;

  // 老 block-keyed 格式没有行号信息,无法精确还原
  // 策略:全部清空,审计字段标记,与 Phase 3 的 banner 复用一个提示
  return {
    ...node,
    provenance: { version: 1, ranges: [] },
    _legacyProvenanceCleared: true,
  };
}
```

**用户感知**:历史 note 的 AI 修改标记一次性清空。Phase 3 已经清过一次,这里只是把字段格式换掉,banner 不会再次出现。

### 4.7 验收

| #     | 检查项                        | 标准                                                                |
| ----- | ----------------------------- | ------------------------------------------------------------------- |
| P4.V1 | `shiftProvenance` 单测        | 覆盖:增行 / 删行 / 替换 / 跨范围编辑 / 整段被删 / 多 range 互相影响 |
| P4.V2 | `rejectAiRange` 恢复          | 拒绝后 markdown byte-for-byte 等于原 baselineText 注入到对应位置    |
| P4.V3 | `acceptAiRange`               | 标记消失,markdown 不变                                              |
| P4.V4 | 多次 AI 改写累计 baselineText | 第一次的 baselineText 在第二次后仍保留                              |
| P4.V5 | UI 视觉:AI 块色条             | 与旧版 BlockNote 实现视觉等效(肉眼对比)                             |
| P4.V6 | 数据迁移                      | 老格式 provenance 被清空且不报错;新格式可写入                       |
| P4.V7 | 性能                          | 1000 行 markdown + 50 个 range,`shiftProvenance` 单次 < 5ms         |
| P4.V8 | 服务端 range 精度             | AI 改写 10 个用例,服务端给出的 range 与前端实际差异行数 ≤ 1         |

### 4.8 风险

- **行号在编辑过程中漂移** —— 算法核心,被 P4.V1 守住
- **服务端 streaming 输出与最终 markdown 不一致** —— 以最终保存的 markdown 为准重新计算 range
- **CJK 字符在 line diff 上的边界** —— 只在 `\n` 对齐,不在字符内切;diff-match-patch 默认行为已经满足

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

## Phase 5 — 拖块到 canvas 重写

**分支**:`feat/milkdown-dragout`(基于 Phase 4 上线)

### 5.1 现状

```
[来源: NotePreview / BlockNoteCard]
       │ dragstart
       ▼
NoteEditorSideMenu.tsx (拦截 + 双 MIME)
  ├─ 'text/html'         ← BlockNote 内部 reorder 用
  ├─ 'BlockNote JSON'    ← BlockNote 内部
  └─ 'SEDIMENT_DND_MIME' ← canvas 落点解析
       │ drop on canvas
       ▼
utils/io/dragDrop.ts → 新建 note 节点
```

### 5.2 新架构

```
[来源: MilkdownEditor / MilkdownPreview]
       │ Crepe block-edit drag handle
       │ (capture mousedown 抢多块快照 → bubble dragstart 重建 payload)
       ▼
Milkdown/useMilkdownBlockDrag.ts
  (Phase 5 把 MilkdownPreview 内的 wiring 抽成共享 hook)
  ├─ 复用 buildBlockDragImage / getMultiBlockSelectionRange / getDragPayload
  │  (Phase 2 已落地,见 §5.6)
  └─ 触发 onBlockDragStart → 消费者写
     'SEDIMENT_DND_MIME' = { kind: 'note', data: { content } }
       │ drop on canvas
       ▼
utils/io/dragDrop.ts(简化,去掉 contentJson 分支)
```

### 5.3 关键改动

| 文件                                                          | 改动                                                                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/Milkdown/useMilkdownBlockDrag.ts`    | **新增**,把当前 `MilkdownPreview` 内的 mousedown capture / dragstart bubble / drag-image 编排抽成 hook;新增 `allowInternalReorder` 选项,让 NotePreview 既能拖到画布也能在编辑器内 reorder |
| `apps/web/src/components/Milkdown/MilkdownPreview.tsx`        | 内联 wiring 替换为 hook 调用,行为不变                                                                                                                                                     |
| `apps/web/src/components/Milkdown/MilkdownEditor.tsx`         | 通过 hook 接通 `enableBlockDrag` + `onBlockDragStart`(目前 prop 是 Phase 1 留的空头)                                                                                                      |
| `apps/web/src/utils/io/dragDrop.ts`                           | 删除 `NoteBlockDragPayload.contentJson` 字段 + `@deprecated` 标记                                                                                                                         |
| `apps/web/src/components/BlockNote/NoteEditorSideMenu.tsx`    | **整文件删除**(此时 NotePreview 已无 BlockNote 引用)                                                                                                                                      |
| `apps/web/src/components/Common/DragToCanvasHandleButton.tsx` | 复用,props 改成接受 markdown                                                                                                                                                              |

> Phase 2 落地时 drag-image 构建 (`buildBlockDragImage`)、多块快照 (`getMultiBlockSelectionRange`)、payload 序列化 (`getDragPayload`) 已经全部在位 —— Phase 5 几乎不写新算法,主要是抽位置 + 加 `allowInternalReorder` 分支。原命名 `sedimentDragOut.ts` 取消,改走 hook,无需深入 Milkdown plugin API。

### 5.4 跨原点 drag 防误删

旧实现里这段微妙逻辑:

```ts
if (e.dataTransfer.dropEffect === 'copy') {
  editor.setTextCursorPosition(dragBlockRef.current, 'start');
}
```

是为了防 BlockNote 拖出后自动删源块。Milkdown 的 `plugin-block` **默认行为是 move 才删、copy 不删**——这一点必须在 Phase 1a 验证期就实测确认(写进验证记录)。如果实测发现也有同样的副作用,在 `sedimentDragOut` 里加 `dragend` 处理。

### 5.5 验收

| #     | 检查项                             | 标准                                                                 |
| ----- | ---------------------------------- | -------------------------------------------------------------------- |
| P5.V1 | 从 NotePreview 拖块到 canvas       | 新建 note,内容 = 源块 markdown;**源 note 内容不变**                  |
| P5.V2 | 从 BlockNoteCard 拖块到 canvas     | 同上,消息保持不变                                                    |
| P5.V3 | NotePreview 内部 reorder(块上下拖) | 工作正常(hook 的 `allowInternalReorder: true` 分支)                  |
| P5.V4 | 拖动预览图                         | 与源块视觉一致;单块 / 多块外观一致(同一 `buildBlockDragImage`)       |
| P5.V5 | 类型检查                           | `dragDrop.ts` 不再引用 `contentJson`                                 |
| P5.V6 | 多选拖拽                           | 复用 Phase 2 已实现的 capture/bubble 多块快照机制,行为与消息卡片一致 |

### 5.6 Phase 2 已落地、可直接复用的范围

迁移启动时 Phase 5 原计划是"重写 drag 路径"。Phase 2 落地后实际已经把以下能力 ship 在 `MilkdownPreview` 里:

- **capture-phase mousedown 抢快照** —— 在 Crepe 把多块 selection 改写为单块 `NodeSelection` 之前
- **bubble-phase dragstart 重建 payload** —— 读快照 → 调 `getDragPayload(snapshot)`
- **统一 drag-image 构建器**(`buildBlockDragImage`)—— 单块 / 多块复用,挂 `document.body` 规避 Shadow DOM `setDragImage` 问题,list wrapper 浅克隆保留 `::marker`
- **生命周期收尾** —— `setTimeout(0)` 移除预览;`dragend` 清理快照 ref

Phase 5 的工作几乎全在"把上面这段代码原地抽成 `useMilkdownBlockDrag` 让 `MilkdownEditor` 共用",新算法接近零。同时顺手补上:

- `allowInternalReorder` 标志(NotePreview 需要 PM 的内部 reorder,聊天卡片不需要),决定是否 `event.stopPropagation()` 屏蔽 Crepe 的 mousedown
- `effectAllowed: 'copyMove'` 的支持(让 PM 当 move、画布当 copy 共存)
- `dragend` 时检测 `dropEffect === 'copy'`,折叠 PM selection 以防 Crepe 自动删源块(等价 [`NoteEditorSideMenu.tsx`](../apps/web/src/components/BlockNote/NoteEditorSideMenu.tsx) 的 `onDragEnd` trick)
- (若 §2.6 #3 的 hot-fix 没在 Phase 3 做掉,这里顺手做)`getMultiBlockSelectionRange` 改读 `view.root.getSelection()`

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

## 时间预估

| Phase       | 工作量 | 触发条件                                                                   |
| ----------- | ------ | -------------------------------------------------------------------------- |
| 1 (1a + 1b) | 4-5 天 | 立即可启动;1a Gate 不通过则终止                                            |
| 2           | 1-2 天 | Phase 1 验收通过                                                           |
| 3           | 5-7 天 | Phase 2 上线 + 灰度 1 周稳定                                               |
| 4           | 5-7 天 | Phase 3 上线 + 灰度 1 周稳定                                               |
| 5           | 1-2 天 | Phase 4 上线 + 灰度 3 天稳定(Phase 2 落地后从 2-3 天降到 1-2 天,详见 §5.6) |
| 6           | 1-2 天 | Phase 5 上线 + 灰度 1 周稳定                                               |

**总计**:**约 3.5-4.5 周纯开发**,加上各阶段灰度等待,日历时间约 **6-7 周**。

Phase 1 是低风险快速验证段(~4-5 天开发,1a 子阶段即时给出 go/no-go)。Phase 3-4 是高风险段,必须留充足灰度。Phase 5-6 是收尾。

---

## 附录 A:Phase 1 完成后的 import 边界

```
✅ 允许:
  apps/web/src/components/Milkdown/**  →  @milkdown/*, katex

❌ 禁止:
  其它任何文件  →  @milkdown/*

  其它任何文件  →  @blocknote/*  (待 Phase 6 整体禁用)
```

## 附录 B:Phase 1a Gate 不通过的备选方案

如果 Milkdown round-trip 仍达不到我们的标准,但数学是硬需求,备选:

1. **保留 BlockNote 0.51**,数学公式用一个**只读 KaTeX 内联渲染器**(在 Markdown source 里嵌 `$...$`,渲染时正则替换)。代价:无法在 WYSIWYG 模式编辑公式。
2. **MDXEditor** 走一遍 Phase 1a 的 gate,作为第二候选(我们前面评估过,缺少官方数学插件,工作量更大)。
3. **CodeMirror 6 + Live Preview**:重写量最大,但天花板最高。只有 1+2 都不行才考虑。
