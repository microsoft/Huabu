# Memory Module — Implementation Plan

> Status: Plan
> Last updated: 2026-05-27
> Companion to: [memory-module.md](./memory-module.md)

本文档专注两件先决重构 + memory sub-agent 的落地步骤。先决重构必须先做完，否则 memory 写不进去也接不上 prompt。

---

## 1. Skills 双源 (PR-A · 必须先做)

### 1.1 现状

`apps/server/src/prompt/skills/` 是唯一来源，随程序发布。`resolveSkillPath` 还残留一个 per-canvas probe 形参（`<canvas>/skills/<id>/SKILL.md` 覆盖），但当前已无任何调用方实际使用，[fs-read.ts](../apps/server/src/modules/agent/tools/handlers/fs-read.ts) 传的 probe 永远查不到内容。`<workspace>` 内无 user-owned skill 概念。

### 1.2 目标

两种来源并存（**只有这两层**，删掉残留的 per-canvas probe）：

| 来源   | 路径                                          | 用户可改                             | 来源标签           |
| ------ | --------------------------------------------- | ------------------------------------ | ------------------ |
| System | `apps/server/src/prompt/skills/<id>/SKILL.md` | ❌ 随程序发布                        | `source: 'system'` |
| User   | `<workspace>/setting/skills/<id>/SKILL.md`    | ✅ 用户可编辑，memory sub-agent 写入 | `source: 'user'`   |

> 删除 `resolveSkillPath` 的 `perCanvasProbe` 形参以及 [fs-read.ts](../apps/server/src/modules/agent/tools/handlers/fs-read.ts) 里调用它的代码（搜 `probeLocal`）。

### 1.3 同名拼接规则

当 user skill 和 system skill **同 id** 时，**合并**而非覆盖：

1. **Frontmatter**：以 system 为基底，user 字段逐键 override；`appliesTo` 字段做 union 去重；`triggers` union 去重。
2. **Body**：system body 在前，user body 追加在后，中间夹一段：

   ```markdown
   ---

   ## User extensions
   ```

3. **Catalogue 行**：description 用 user 的（若用户改了），后面加 ` (extended)` 标记。
4. **`read("skills/<id>/SKILL.md")`** 返回合并后的整文，调用方无感。

仅 user 存在的 id 直接返回 user 内容（`source: 'user'`），仅 system 存在的 id 返回 system 内容（`source: 'system'`）。

### 1.4 代码改动

**目录布局**：不搬迁。`apps/server/src/prompt/skills/<id>/` 本身就是 system，重命名只会制造无谓 diff。运行时通过路径推断 `source: 'system'`。

**新增 [paths.ts](../apps/server/src/modules/storage/paths.ts) 常量**：

```ts
export function settingDir(): string {
  return path.join(getWorkspacePath(), 'setting');
}
export function userSkillsDir(): string {
  return path.join(settingDir(), 'skills');
}
```

**`skill-loader.ts` 重写要点**：

- 内部常量保持：`GLOBAL_SKILLS_DIR` 改名为 `SYSTEM_SKILLS_DIR`（指向同一个目录 `apps/server/src/prompt/skills/`），只是语义更清晰。
- 新增 `scanUserSkills()`：扫 `userSkillsDir()`，目录缺失返回 `[]`（用户没建 `setting/skills/` 时不报错）。
- 缓存 layer 拆分（详见 §1.5 动态加载）：`_systemCache`（once-and-done）+ `_userCache`（per-workspace、mtime-aware）。
- 新增 `mergeSkill(system?, user?): LoadedSkill | null`：按 §1.3 合并。
- `listSkills(scope)` 输出已合并的列表，附 `source: 'system' | 'user' | 'merged'` 字段供 catalogue / debug。
- **删除** `resolveSkillPath` 的 `perCanvasProbe` 形参（及其全部调用点）。新签名仅 `(rel) => string | null`，但 SKILL.md 自身的 read 走新路径见下。
- 新增 `readSkillFile(rel): string | null`：返回内容而非路径。命中 merged skill 时在内存里拼出整文（按 §1.3）；命中 user-only / system-only 时返回该文件原文。`references/*` 子路径仍按所在 skill 的来源解析到磁盘路径（system 的 references 在 system 目录下，user 的 references 在 user 目录下）。
- [fs-read.ts](../apps/server/src/modules/agent/tools/handlers/fs-read.ts) 改成优先调用 `readSkillFile`：命中字符串直接返回，跳过 statSync / readFile；未命中再 fallback 到 `resolveSkillPath` 拿 references 的磁盘路径。

**catalogue 渲染**：`getSkillCatalogue(scope)` 输出加 `source` 标记，用户能看出哪些是 system 哪些是自己 / AI 写的。

### 1.5 动态加载 user skills（必做）

**现状问题**：[skill-loader.ts](../apps/server/src/prompt/skill-loader.ts) 的 `ensureCache()` 是 process-lifetime once-and-done，启动后 `_cache` 不再变。System 不变没事，但 user skills 会被三种途径动态修改：

1. memory sub-agent 调用 `memory_skill_write` 落盘新 / 改 skill。
2. 用户在 IDE / 文件管理器里直接编辑 `setting/skills/<id>/SKILL.md`。
3. `setWorkspacePath()` 切换 workspace 后，user skill 集合整体换掉。

不动态加载 → agent 下一次 `read("skills/<id>/SKILL.md")` 还是旧内容，必须重启服务才能生效。**这违反 memory 模块"AI 写完即用"的核心假设**。

**实现**：

- **System cache**：保持 once-and-done。`_systemCache` 在 `preloadSkills()` 首次填充后永不失效。
- **User cache**：per-workspace + per-file mtime 校验 + 短 TTL。

  ```ts
  interface UserCacheEntry {
    skill: LoadedSkill;
    mtimeMs: number; // statSync(SKILL.md).mtimeMs
  }
  let _userCacheWorkspace: string | null = null;
  let _userCache: Map<string, UserCacheEntry> | null = null;
  let _userCacheLastScanMs = 0;
  const USER_SCAN_TTL_MS = 2000; // 至多每 2s 扫一次目录
  ```

  - `ensureUserCache()`：每次调用先比对 `getWorkspacePath()` 与 `_userCacheWorkspace`，不一致整体清空重建。
  - 距上次扫描 < TTL 且无 `forceFresh` 时直接返回 cache（避免每个 tool call 都 stat）。
  - 否则 `readdirSync(userSkillsDir())` 列 id → 每个 `<id>/SKILL.md` 跑 `statSync` 取 mtimeMs：
    - 若 cache 命中且 mtime 未变 → reuse。
    - 若 mtime 变了或 cache 没有 → re-parse frontmatter + body，更新 entry。
    - 若 cache 里有但磁盘上没了 → 删除 entry。
  - `_userCacheLastScanMs = Date.now()`。

- **强失效钩子**：导出 `invalidateUserSkill(id?: string)`。
  - memory sub-agent 在 `memory_skill_write` 写入成功后调用 `invalidateUserSkill(id)` → 把该 id 的 cache entry 标记为脏，下一次 read 一定 re-parse。
  - 写入成功的零等待 read-after-write 路径：writer handler 直接 `_userCache.delete(id)` 并把 `_userCacheLastScanMs = 0`，下一次 `ensureUserCache(forceFresh=true)` 立刻看到新内容。

- **Workspace 切换**：在 [workspace.ts](../apps/server/src/modules/workspace.ts) 的 `setWorkspacePath()` 末尾加 `invalidateUserSkill()`（不传参数表示清空全部 user cache）。System 不动。

- **`invalidateSkillCache()`（已有）**：保留语义不变 = 清空 system + user 双缓存，留给测试用。

**为什么不用 `fs.watch` / chokidar**：

- 跨平台行为差（macOS recursive watch 与 Linux 不一致），Docker bind mount 经常事件丢失。
- 用户场景小：`setting/skills/` 预期 < 50 个文件，每 2s 一次 readdir + statSync 是个位数毫秒，不值得引入 watcher 复杂度。
- mtime 方案天然处理 atomic rename（`writeFile` → `rename`）和外部编辑器的"create new + replace"模式。

**性能边界**：

- 每次 `listSkills` / `getSkillCatalogue` / `read("skills/...")` 都会触发 `ensureUserCache()`，但 TTL 把目录扫描频率压到 ≤ 0.5 Hz，单 agent turn 内的多次调用共享同一个扫描结果。
- Mtime 比对失败时才 readFile + parseFrontmatter，稳态零额外 IO。

### 1.6 兼容性

- 现有 `canvas` / `sketch-gestures` 目录原地不动，prompt agent 无感。
- 若用户 workspace 尚无 `setting/skills/`，行为退化为现状（只有 system）。
- Per-canvas 覆盖路径**移除**：原先的 probe 是空跑（无调用方真正使用），删除后没有功能损失；fs-read 里 `probeLocal` 整块代码一并删除。

---

## 2. Prompt 目录重排 (PR-A · 与 §1 同 PR)

### 2.1 现状

```
apps/server/src/prompt/
  agent-loader.ts
  skill-loader.ts
  enrich.ts
  resolve-label.ts
  agents/{ask,operate,intent,sketch}/AGENT.md
  skills/{canvas,sketch-gestures}/SKILL.md
  skills/index.ts
```

Loader 和子目录平铺，新增 memory agent 后会更乱。

### 2.2 目标布局

```
apps/server/src/prompt/
  index.ts                ← 唯一对外 barrel：re-export agents + skills + enrich
  enrich.ts               ← 不动
  resolve-label.ts        ← 不动
  agents/
    loader.ts             ← 原 agent-loader.ts 搬过来，import 路径相对修正
    ask/AGENT.md
    operate/AGENT.md
    intent/AGENT.md
    sketch/AGENT.md
    memory/AGENT.md       ← 新增：memory sub-agent 的 system prompt
  skills/
    loader.ts             ← 原 skill-loader.ts 搬过来
    catalogue.ts          ← 原 skills/index.ts 改名 (避免和 barrel 冲突)
    canvas/SKILL.md       ← 原地不动，运行时标 source: 'system'
    sketch-gestures/SKILL.md
```

### 2.3 改动点

- `apps/server/src/prompt/agent-loader.ts` → `apps/server/src/prompt/agents/loader.ts`
- `apps/server/src/prompt/skill-loader.ts` → `apps/server/src/prompt/skills/loader.ts`
- `apps/server/src/prompt/skills/index.ts` → `apps/server/src/prompt/skills/catalogue.ts`
- `apps/server/src/prompt/skills/canvas/` 、 `sketch-gestures/` 原地不动
- 新增 `apps/server/src/prompt/index.ts`：

  ```ts
  export * from './agents/loader.js';
  export * from './skills/loader.js';
  export * from './skills/catalogue.js';
  export { enrichSystemPrompt } from './enrich.js';
  export { resolveLabel } from './resolve-label.js';
  ```

- 全仓 import 替换：`from '../../prompt/agent-loader.js'` → `from '../../prompt/index.js'`（统一从 barrel 进，loader 移动后调用方零感知）。
- [fs-read.ts](../apps/server/src/modules/agent/tools/handlers/fs-read.ts) 里 `probeLocal` 块一同删除（对应 §1.6 per-canvas 覆盖移除）。

### 2.4 验收

- `pnpm --filter @sediment/server typecheck` 通过。
- 启动期 `preloadAgents()` + `preloadSkills()` 不报错。
- ask / operate / sketch 三个 surface 的 catalogue 内容不变（除了多出 `source` 标记）。

---

## 3. Memory 子模块落地

### 3.1 Storage 迁移 (PR-B)

**新路径常量**（加在 [paths.ts](../apps/server/src/modules/storage/paths.ts)）：

```ts
export function settingDir(): string;
export function longTermMemoryPath(): string; // setting/.huabu.md
export function userSkillsDir(): string; // setting/skills/
export function workingMemoryDir(canvasId): string; // <canvas>/.memory/
export function workingMemoryPath(canvasId): string; // <canvas>/.memory/canvas.md
export function memoryStatePath(canvasId): string; // <canvas>/.memory/state.json
```

**迁移**：

- 启动时 `migrateLegacyMemory()`：若 `<canvas>/memory/preferences.md` 存在且非空 → mv 到 `<canvas>/.memory/canvas.md`，老目录删除。
- `<canvas>/.memory/` 加入 `ALWAYS_SKIP`（[fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)），agent 工具不可达。
- Workspace 根 `setting/` 不在 canvas sandbox 内，天然不可达，无需补 skip。

**`CanvasStore` 清理**：

- 删除 `readPreferences` / `writePreferences`。
- 不在 store 上加 memory API；memory 写入由 sub-agent 独占，集中在 `modules/agent/memory/writers/`。

### 3.2 Op counter (PR-B)

- `<canvas>/.memory/state.json`：`{ counter: number, lastAnalyzedAt: number | null, lastSeenThreadCursor: number | null }`。
- 入口在 `canvas.route.ts` 的 `POST /events` handler，`appendEvents` 成功后：

  ```ts
  const remaining = bumpOpCounter(canvasId, parsed.data.events.length);
  if (remaining <= 0) memory.enqueue(canvasId); // fire-and-forget
  ```

- `bumpOpCounter` 内部读写 `state.json`，超 100 后清零并 enqueue。读写用 `atomicWriteJson`，IO 失败只 warn。

### 3.3 Memory sub-agent (PR-C / PR-D)

**目录**：

```
apps/server/src/modules/agent/memory/
  index.ts        ← export { enqueue }
  trigger.ts      ← bumpOpCounter / readState / writeState
  worker.ts       ← Map<canvasId, Promise> single-flight；setImmediate
  analyzer.ts     ← 拼输入 → runAgent({ scope: 'memory' }) → 解析输出
  context.ts      ← 构造 canvas snapshot / chat digest / events digest
  writers/
    longterm.ts
    shortterm.ts
    skill.ts
  sandbox.ts      ← workspace + canvas 双根 safeResolve
  tools.ts        ← memory_longterm_write / memory_shortterm_write / memory_skill_write 定义
```

**worker 行为**：

```ts
enqueue(canvasId) {
  if (running.has(canvasId)) { pending.add(canvasId); return; }
  running.set(canvasId, runOnce(canvasId)
    .catch(err => logger.warn({ err, canvasId }, '[memory] failed'))
    .finally(() => {
      running.delete(canvasId);
      if (pending.delete(canvasId)) enqueue(canvasId);
    }));
}
```

**analyzer 接 `runAgent`**：

- 加 `'memory'` 到 `ToolScope`。
- 新建 `prompt/agents/memory/AGENT.md`，tools: `[memory_longterm_write, memory_shortterm_write, memory_skill_write, read]`。
- 用便宜模型：在 [llm.ts](../apps/server/src/modules/agent/llm.ts) 加 `getMemoryModel()`（默认走配置 `memoryModel` 或 fallback 主模型）。
- Context messages：一次性塞 `[SYSTEM Snapshot]` + `[SYSTEM Chat digest]` + `[SYSTEM Recent ops]` + 三层当前 memory 内容，然后给 user-role 一句 "Analyse and write what's worth remembering"。
- `maxIterations: 5`（足够调几次 read + 三个 write）。
- 跑完不写 chat history（不调 `saveContext`），不持久化 context；只关心 writer 的副作用。

### 3.4 Writers (PR-D)

每个 writer 都是纯函数 `(args) → ok | reject`：

- `longterm.ts`：读 `setting/.huabu.md` → 应用 patch（行级 diff，新增 bullet 时去重）→ 超 4 KB / 80 行触发自压缩（再调一次 analyzer 但 mode=consolidate）→ 原子写。
- `shortterm.ts`：直接 replace body，超限压缩。
- `skill.ts`：
  - op=update：读旧 SKILL.md → 调一段固定模板把新内容合进 body → 写回。
  - op=create：检查同 id 是否存在 → 存在 reject 提示用 update → frontmatter 校验（`id / name / description / appliesTo` 必填）→ 创建 `<id>/SKILL.md`。
  - rationale 缺失或 < 20 字符 → reject。

每个 writer handler 内部用 §3.1 的 `memorySandbox.safeResolve` 双根校验，禁止 `..`。

### 3.5 Preamble 注入 (PR-E)

- `prompt/agents/ask/AGENT.md` 和 `operate/AGENT.md` 的 `messageTemplates` 各加一条：

  ```yaml
  memoryPreamble: |
    [SYSTEM Memory]
    [Long-term preferences]
    {{longterm}}

    [Working memory — this canvas]
    {{shortterm}}
  ```

- [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts) 在 `selectedNodesPreamble` push 之前：

  ```ts
  const longterm = readLongTermMemory(); // workspace 单例
  const shortterm = canvasId ? readWorkingMemory(canvasId) : null;
  if (longterm || shortterm) {
    context.messages.push({
      role: 'user',
      content: renderAgentTemplate(agentCfg, 'memoryPreamble', {
        longterm: longterm ?? '(none)',
        shortterm: shortterm ?? '(none)',
      }),
      timestamp: Date.now(),
    });
  }
  ```

- `buildHistoryItems` 已剔除以 `[SYSTEM` 开头的 user message，无需新增过滤。

### 3.6 测试

- Unit：writer 三个分别打 fixture（短小、超长、同名 skill、frontmatter 缺字段）→ verify reject / accept / 合并后的字节流。
- Integration：mock LLM 输出 → end-to-end 触发 enqueue → 100 ops 后真实写入文件并 assert 内容。
- Sanity：连续 enqueue 同 canvas → assert single-flight 串行执行、pending flag 触发第二轮。

---

## 4. PR 拆分总表

| PR   | 范围                                                 | 风险                                 | 回滚                         |
| ---- | ---------------------------------------------------- | ------------------------------------ | ---------------------------- |
| PR-A | §1 + §2：skills 双源 + prompt 目录重排               | 低（纯重构，路径搬迁 + loader 合并） | git revert，单 commit        |
| PR-B | §3.1 + §3.2：storage 迁移 + op counter               | 中（迁移老目录）                     | 保留老目录读路径一个版本兜底 |
| PR-C | §3.3：sub-agent 骨架，writer 全 stub（dry-run 日志） | 低（不真实写入）                     | 关掉 enqueue 调用即可        |
| PR-D | §3.4：真实写入 + 自压缩                              | 中（写 workspace 文件）              | writer 总开关 env 变量       |
| PR-E | §3.5：preamble 注入                                  | 低（只读、可空）                     | 删 push 块                   |

---

## 5. 后续（不在本计划内）

- 跨 workspace 全局 memory（`~/.config/sediment/global.md`）。
- 用户在 UI 里 inline 编辑 long-term memory。
- Memory 显示哪些条目最近被 agent 引用（命中率统计）。
