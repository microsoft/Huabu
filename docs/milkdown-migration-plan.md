# Milkdown 迁移方案 — 完整规划

> 范围:本文档覆盖 **Phase 1 ~ Phase 6** 的完整迁移路径。
> 每个 Phase 都是独立 PR、独立验收、独立可回滚。Phase 1a 验收 Gate 不通过则全部终止。

## 目标

- 验证 Milkdown 能否成为 BlockNote 的稳定替代,**让 Markdown 真正成为单一真值**。
- 建立一层我们自己的封装,把 Milkdown 当成可替换的实现细节。
- 按 "验证 → 只读 → 编辑 → 元数据 → 拖拽 → 清理" 的顺序推进,把每一步的回滚成本压到最低。

## Phase 一览

| Phase | 目标                           | 风险 | 工作量 |
| ----- | ------------------------------ | ---- | ------ |
| 1     | 验证 Gate + 封装层 `Milkdown/` | 中   | 4-5 天 |
| 2     | 替换 `BlockNoteCard`(只读)     | 低   | 1-2 天 |
| 3     | 替换 `NotePreview`(编辑)       | 高   | 5-7 天 |
| 4     | Provenance 重锚                | 高   | 5-7 天 |
| 5     | 拖块到 canvas 重写             | 中   | 2-3 天 |
| 6     | 删除 BlockNote + 数据清理      | 低   | 1-2 天 |

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

### 1.1 依赖安装(两个子阶段共用)

```powershell
pnpm --filter web add `
  @milkdown/core `
  @milkdown/ctx `
  @milkdown/preset-commonmark `
  @milkdown/preset-gfm `
  @milkdown/plugin-math `
  @milkdown/plugin-block `
  @milkdown/plugin-listener `
  @milkdown/plugin-history `
  @milkdown/plugin-clipboard `
  @milkdown/react `
  katex
```

> 按最小必要装;**不**装 `@milkdown/theme-nord`(我们自己写主题映射)。装后立即跑 `pnpm typecheck` 确认无 peer 警告阻塞。

---

### Phase 1a — 验证 Gate

目的:在设计公共 API 之前先确认 Milkdown 能扣住我们的硬指标。

#### 1a.1 临时文件结构(Phase 1b 完成后整体删除)

```
apps/web/src/components/Milkdown/_validate/
├── _validate.tsx              // dev-only 隐藏页面,手动看效果
├── createValidateEditor.ts    // 最小 Milkdown 实例(所需插件)
├── fixtures/
│   ├── simple.md
│   ├── math.md
│   ├── complex.md
│   └── ai-half-baked.md
└── __tests__/
    └── roundTrip.test.ts      // 自动化 Gate G1
```

`_validate.tsx` 挂到隐藏路由(例如 `?milkdown-validate=1`),不进任何菜单。

#### 1a.2 4 类样本(必须覆盖)

| Fixture            | 内容                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `simple.md`        | 标题 H1-H3、加粗、斜体、行内代码、有序/无序列表、引用块、`---` 分隔线、普通链接                |
| `math.md`          | 行内公式 `$E=mc^2$`、块公式 `$$\int...$$`、矩阵 `\begin{pmatrix}`、希腊字母与 `\alpha + \beta` |
| `complex.md`       | 三层嵌套列表、GFM 表格(含空单元格 + 对齐)、任务列表、带语言标识的围栏代码块、含 `<br>` 的段落  |
| `ai-half-baked.md` | 未闭合代码块、悬挂列表项、中文混排英文、`$` 在非数学上下文中(纯文字 `价格 $5`)                 |

#### 1a.3 自动化 round-trip(`roundTrip.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createValidateEditor } from '../createValidateEditor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) =>
  readFileSync(resolve(__dirname, '../fixtures', n), 'utf-8');

async function roundTrip(md: string, iterations = 3) {
  const editor = await createValidateEditor();
  const history: string[] = [md.trimEnd()];
  for (let i = 0; i < iterations; i++) {
    await editor.setMarkdown(history[history.length - 1]);
    const out = (await editor.getMarkdown()).trimEnd();
    history.push(out);
  }
  return history;
}

describe('Milkdown round-trip (Gate G1)', () => {
  for (const name of [
    'simple.md',
    'math.md',
    'complex.md',
    'ai-half-baked.md',
  ]) {
    it(`${name}: stabilizes after first normalization pass`, async () => {
      const h = await roundTrip(fx(name));
      // First → second may normalize (table column widths, list markers).
      // From the second iteration onward it MUST be byte-stable.
      expect(h[2]).toBe(h[1]);
      expect(h[3]).toBe(h[2]);
    });
  }
});
```

> Gate G1 的收敛判准采用"第二次起稳定"而不是"首次即稳定":所有 markdown 序列化器都会在首次做一些归一化(例如表格列宽、list marker 对齐),只要其后不再变化即可。

#### 1a.4 验收 Gate

| #   | 检查项                  | 标准                                      | 验证手段                       |
| --- | ----------------------- | ----------------------------------------- | ------------------------------ |
| G1  | 4 个 fixture round-trip | 第二轮起字符串收敛                        | 自动 vitest                    |
| G2  | KaTeX 渲染              | 行内、块、矩阵肉眼正确 + 无 console error | 手动 in `_validate.tsx`        |
| G3  | drag handle             | 鼠标悬停在块左侧时出现                    | 手动                           |
| G4  | bundle size delta       | gzip 净增 < 250 KB                        | `pnpm --filter web build` 对比 |
| G5  | 受控更新性能            | 5000 字 markdown setMarkdown < 50ms       | console.time 粗测              |
| G6  | 中文 IME                | 拼音输入期间不误触发 onChange;光标不跳    | 手动                           |

**Gate 不通过**:改用附录 B 备选方案,本 Phase 以外不启动。

---

### Phase 1b — 封装层

#### 1b.1 设计原则

1. **对外 API 与 Milkdown 解耦**——外部组件只看到我们自己的 props,Milkdown 类型不外泄。
2. **Markdown 是唯一真值**——所有 API 都收发 `string`,不暴露任何 AST/JSON。
3. **替换性**——未来如果要换成 CodeMirror Live Preview 或其它,只动这个目录。

#### 1b.2 目录结构

```
apps/web/src/components/Milkdown/
├── index.ts                       // 公共导出
├── MilkdownEditor.tsx             // 可编辑组件(给 NotePreview 用)
├── MilkdownPreview.tsx            // 只读组件(给 BlockNoteCard 替换用)
├── createMilkdown.ts              // 内部:统一插件配置 + 主题
├── markdownUtils.ts               // round-trip 工具、normalize、diff
├── shadowStyleCache.ts            // 从 BlockNote/ 平移,内容更新为 milkdown 样式
├── styles/
│   ├── milkdown-theme.css         // 把 milkdown 默认主题 token 映射到 Sediment design tokens
│   └── katex-overrides.css        // KaTeX 字号、行高微调
└── __tests__/
    ├── roundTrip.test.ts          // 把 Phase 1a 的 harness 提升为永久 vitest 用例
    └── markdownUtils.test.ts
```

#### 1b.3 公共 API(冻结接口)

```ts
// MilkdownEditor.tsx
export interface MilkdownEditorProps {
  /** Source of truth. Controlled. */
  markdown: string;
  /** Fired with normalized markdown (trimmed, line endings unified). */
  onChange?: (next: string) => void;
  /** Default true. */
  editable?: boolean;
  /** Optional placeholder. */
  placeholder?: string;
  /** Optional className applied to the editor root. */
  className?: string;
  /**
   * Optional decoration spec (for Phase 4 provenance).
   * Phase 1 only accepts the type; implementation is no-op.
   */
  decorations?: MilkdownDecorationSpec;
  /** Fired when the user drags a block out (Phase 5 wires this up). */
  onBlockDragStart?: (e: MilkdownBlockDragEvent) => void;
}

// MilkdownPreview.tsx
export interface MilkdownPreviewProps {
  markdown: string;
  /** Render inside a Shadow DOM. Default true (for style isolation). */
  isolate?: boolean;
  className?: string;
  /** Fired when the user starts dragging a block out. */
  onBlockDragStart?: (e: MilkdownBlockDragEvent) => void;
}

export interface MilkdownBlockDragEvent {
  /** Markdown sub-string of the dragged block. */
  markdown: string;
  /** Native DragEvent (so caller can call setData / setDragImage). */
  nativeEvent: DragEvent;
  /** Visible DOM node of the block (for setDragImage fallback). */
  blockElement: HTMLElement;
}
```

**这套 API 同时为 Phase 2/3/5 备好**:

- `MilkdownPreview` → Phase 2 替换 `BlockNoteCard`
- `MilkdownEditor` → Phase 3 替换 `NotePreview` 编辑部分
- `onBlockDragStart` → Phase 5 拖块到 canvas
- `decorations` → Phase 4 provenance 装饰

#### 1b.4 插件配置(`createMilkdown.ts`)

启用:

- `commonmark`(基础)
- `gfm`(表格、任务列表、删除线)
- `math`(KaTeX)
- `history`(undo/redo)
- `listener`(暴露 markdown 变化)
- `clipboard`(粘贴 markdown / HTML)
- `block`(drag handle —— 仅可编辑模式)

主题:**不用 `@milkdown/theme-nord`**,直接写自己的 CSS 把 Milkdown 的 CSS 变量映射到我们 [apps/web/src/index.css](apps/web/src/index.css) 已有的 design tokens。

#### 1b.5 `markdownUtils.ts`

收口所有 markdown 字符串处理:

```ts
/** Trim trailing whitespace + unify CRLF -> LF. Single source of truth. */
export function normalizeMarkdown(md: string): string;

/** Empty / whitespace-only input -> single empty paragraph marker. */
export function ensureNonEmpty(md: string): string;

/** Returns true if two markdown strings are semantically equivalent
 *  after normalization. Used by NotePreview to dedupe onChange. */
export function markdownEquals(a: string, b: string): boolean;
```

> 这一步把现存的 M2(空内容)、M3(trim)、M5(去重)三个补丁合并为一个工具模块,杜绝散落。

#### 1b.6 Shadow DOM 复用

把 [apps/web/src/components/BlockNote/shadowStyleCache.ts](apps/web/src/components/BlockNote/shadowStyleCache.ts) 整文件复制到 `Milkdown/shadowStyleCache.ts`,只改两处:

- 监听的样式表来源:`@blocknote/shadcn` → `@milkdown/*` + KaTeX
- HMR fingerprint 选择器同步更新

Phase 6 时再把旧文件删掉。

#### 1b.7 验收

- [ ] `pnpm --filter web typecheck` 通过
- [ ] `vitest run src/components/Milkdown` 通过(round-trip + markdownUtils)
- [ ] `_validate/` 目录已删除,隐藏路由已下架
- [ ] `@milkdown/*` 仅在 `Milkdown/` 目录内被导入(ESLint 规则或 grep 检查)

```powershell
# 把 grep 加到 CI 防止越界
$leaked = Select-String -Path "apps/web/src/**/*.{ts,tsx}" `
  -Pattern "@milkdown/" -SimpleMatch `
  | Where-Object { $_.Path -notmatch "components\\Milkdown" }
if ($leaked) { throw "Milkdown imports leaked outside wrapper" }
```

---

## Phase 2 — 替换 BlockNoteCard

**分支**:`feat/milkdown-message-card`(基于 Phase 1)

为什么先换它:

- **只读** — 不涉及输入、IME、`onChange` 去重等复杂场景
- 数据流单向(message → render),没有持久化
- 出问题不会污染用户数据
- 完整覆盖**渲染 + Shadow DOM + 块拖到 canvas** 三个能力

### 2.1 现状梳理

[apps/web/src/components/Messages/Card/BlockNoteCard.tsx](apps/web/src/components/Messages/Card/BlockNoteCard.tsx) 主要做:

1. 用 `useCreateBlockNote` 创建只读编辑器
2. `tryParseMarkdownToBlocks(content)` 把消息文本转成 blocks
3. `<BlockNoteView editable={false}>` 渲染
4. `<SideMenuController>` + `NoteDragHandleButton` 提供拖块到 canvas
5. 自定义拖动预览(多选时拼接 DOM)
6. `setDragPayload` 写入 `SEDIMENT_DND_MIME` + BlockNote 原生 MIME

### 2.2 替换后的形态

```tsx
// 新的 BlockNoteCard.tsx(文件名暂不改,Phase 6 统一改名)
import { MilkdownPreview } from '@/components/Milkdown';
import { setDragPayload } from '@/utils/io/dragDrop';

export const BlockNoteCard: FC<BlockNoteMessageViewProps> = ({ content }) => {
  return (
    <MilkdownPreview
      markdown={content}
      isolate
      onBlockDragStart={({ markdown, nativeEvent, blockElement }) => {
        setDragPayload(nativeEvent.dataTransfer!, {
          kind: 'note-block',
          markdown, // 只发 markdown,不再发 contentJson
        });
        nativeEvent.dataTransfer!.setDragImage(blockElement, 0, 0);
      }}
    />
  );
};
```

> 多选拖拽暂时**降级为单选**(Milkdown 的 `plugin-block` 当前对多选 drag 支持有限)。如果用户反馈需要,Phase 5 再补。

### 2.3 `utils/io/dragDrop.ts` 同步改动

- `NoteBlockDragPayload` 接口:`contentJson?: string` 字段标记为 `@deprecated`,新写入路径不再产生,但**读取路径暂时保留**(canvas 还可能收到来自 NotePreview 的旧格式 payload,直到 Phase 5 完成)
- 加一行注释引用本文档

### 2.4 验收

| #   | 检查项                    | 标准                                                                                                     |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| V1  | 历史消息渲染              | 抽样 10 条历史 AI 回复,Milkdown 渲染与 BlockNote 视觉一致(或更好)                                        |
| V2  | 数学公式                  | 含 `$...$` 的回复正确渲染                                                                                |
| V3  | 拖块到 canvas             | 拖一个段落到 canvas,新建 note 节点内容正确(只检查 markdown,不检查 contentJson)                           |
| V4  | Shadow DOM 隔离           | 父页面 CSS 不污染消息卡片;反向也不污染                                                                   |
| V5  | typecheck + lint + format | 全绿                                                                                                     |
| V6  | 单元测试                  | 给 `BlockNoteCard` 加一个 RTL 测试,覆盖"渲染 + 拖拽 setData 调用"                                        |
| V7  | 性能                      | 长消息(2000+ 字)首帧渲染 ≤ BlockNote 版本的 1.2 倍                                                       |
| V8  | 灰度                      | 加 feature flag `VITE_MESSAGE_RENDERER=milkdown\|blocknote`(default `milkdown`),允许一键切回旧实现做 A/B |

### 2.5 不做的事

- ❌ 删除 `@blocknote/*` 依赖(NotePreview 还在用)
- ❌ 删除 `dragDrop.ts` 的 `contentJson` 字段
- ❌ 改任何持久化数据
- ❌ 改 `index.css` 里的 ShadCN 桥接(NotePreview 还需要)

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

**关键决定**:Phase 3 合入后**立即停止写入** `contentJson` / `contentJsonSource`,但不删字段(等 Phase 6)。这样如果灰度回退到 BlockNote 实现,旧字段仍能被它读到。

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
- ❌ 走新封装的拖块到 canvas(Phase 5;Phase 3 期间该入口暂时禁用,banner 同时说明)

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
       │ block plugin drag handle
       ▼
Milkdown/plugins/sedimentDragOut.ts
  └─ 只设 'SEDIMENT_DND_MIME' = { kind: 'note-block', markdown }
       │ drop on canvas
       ▼
utils/io/dragDrop.ts(简化,去掉 contentJson 分支)
```

### 5.3 关键改动

| 文件                                                          | 改动                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/web/src/components/Milkdown/plugins/sedimentDragOut.ts` | **新增**,把 `block` 插件的 drag 事件转成我们的 `onBlockDragStart` |
| `apps/web/src/components/Milkdown/MilkdownEditor.tsx`         | 注入插件                                                          |
| `apps/web/src/components/Milkdown/MilkdownPreview.tsx`        | 只读模式同样支持 drag handle(隐藏不可编辑的菜单项)                |
| `apps/web/src/utils/io/dragDrop.ts`                           | 删除 `NoteBlockDragPayload.contentJson` 字段 + `@deprecated` 标记 |
| `apps/web/src/components/BlockNote/NoteEditorSideMenu.tsx`    | **整文件删除**(此时 NotePreview 已无 BlockNote 引用)              |
| `apps/web/src/components/Common/DragToCanvasHandleButton.tsx` | 复用,props 改成接受 markdown                                      |

### 5.4 跨原点 drag 防误删

旧实现里这段微妙逻辑:

```ts
if (e.dataTransfer.dropEffect === 'copy') {
  editor.setTextCursorPosition(dragBlockRef.current, 'start');
}
```

是为了防 BlockNote 拖出后自动删源块。Milkdown 的 `plugin-block` **默认行为是 move 才删、copy 不删**——这一点必须在 Phase 1a 验证期就实测确认(写进验证记录)。如果实测发现也有同样的副作用,在 `sedimentDragOut` 里加 `dragend` 处理。

### 5.5 验收

| #     | 检查项                             | 标准                                                            |
| ----- | ---------------------------------- | --------------------------------------------------------------- |
| P5.V1 | 从 NotePreview 拖块到 canvas       | 新建 note,内容 = 源块 markdown;**源 note 内容不变**             |
| P5.V2 | 从 BlockNoteCard 拖块到 canvas     | 同上,消息保持不变                                               |
| P5.V3 | NotePreview 内部 reorder(块上下拖) | 工作正常                                                        |
| P5.V4 | 拖动预览图                         | 与源块视觉一致(setDragImage 生效)                               |
| P5.V5 | 类型检查                           | `dragDrop.ts` 不再引用 `contentJson`                            |
| P5.V6 | 多选拖拽                           | 如果 Phase 2 决策保留为单选降级,这里也保持单选;否则在此实现多选 |

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

| Phase       | 工作量 | 触发条件                        |
| ----------- | ------ | ------------------------------- |
| 1 (1a + 1b) | 4-5 天 | 立即可启动;1a Gate 不通过则终止 |
| 2           | 1-2 天 | Phase 1 验收通过                |
| 3           | 5-7 天 | Phase 2 上线 + 灰度 1 周稳定    |
| 4           | 5-7 天 | Phase 3 上线 + 灰度 1 周稳定    |
| 5           | 2-3 天 | Phase 4 上线 + 灰度 3 天稳定    |
| 6           | 1-2 天 | Phase 5 上线 + 灰度 1 周稳定    |

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
