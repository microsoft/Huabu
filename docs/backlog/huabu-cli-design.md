# Huabu CLI — Design Document

> 让 Huabu 成为 agent 生态里的一等公民：任何能调 bash / MCP 的 agent
> 都能理解、读取、操作画布，无需为 Huabu 写专门适配器。
>
> Status: **Backlog** · Last reviewed: 2026-07-22
>
> **Non-authoritative exploration.** This document predates the native RFS HTTP direction in [issue #348](https://github.com/hai-team/Huabu/issues/348). Its CLI-first API boundary, separate CLI contract, and `huabu mcp` assumptions are not approved architecture. Any future CLI should be reconsidered as an optional adapter over the canonical `SpaceQuery` / `CanvasCommand` HTTP facade.

---

## 0. TL;DR

新增 `apps/cli/`，提供 `huabu` 命令行工具，三种用法共享一套实现：

```bash
huabu canvas list                       # 人在终端用
huabu node search -c X -p "corridor"    # bash agent 调用
huabu mcp                               # MCP server，给 Claude Code / Cursor 用
```

CLI 是 **server 的瘦客户端**（HTTP 调用），不是第二套业务逻辑。
长远定位：CLI + MCP 是 Huabu 暴露给外部世界的**主要程序接口**，
HTTP API 仍为 web app 服务，但其它消费者（agent / 脚本 / 第三方工具）
统一走 CLI。

CLI 解决三个真问题：

1. **让其它 agent 能操作 Huabu**，对应 [agent-reachback.md](../architecture/agent-reachback.md) 的镜像方向；
2. **把 ripgrep 等可选系统依赖收进 CLI bundle**，对用户透明；
3. **给"脚本化操作画布"提供干净入口**（导出、批量处理、自动化）。

---

## 1. Goals & Non-goals

### Goals

- **一套命令、四种用户**：人 / bash agent / MCP agent / 自动化脚本，统一接口。
- **零业务重复**：CLI 只做协议转换，业务逻辑 100% 在 server。
- **跨平台单一发行物**：macOS / Linux / Windows 都能装、能跑。
- **稳定 contract**：CLI 输出格式（特别是 `--json`）一旦发版即视为 v1 API，遵循 semver。
- **跟现有 `external_agent_design` 对称**：外部 agent 能被 Huabu 调用（已设计），Huabu 也能被外部 agent 调用（本设计）。

### Non-goals

- **不是 server 的替代**：web app 仍然依赖 server，CLI 不会让 server 消失。
- **不重新实现 UI**：CLI 不做 TUI 富交互（不打算变成 lazygit 那种全屏 TUI；只做命令行 + 结构化输出）。
- **不做远程协作**：CLI 只连本机 server（v1 范围内）。
- **不暴露 LLM 调用细节**：CLI 不直接调 LLM，所有 LLM 调用都经过 server 的 agent loop。

---

## 2. 为什么是 CLI（而不是直接让 agent 调 HTTP API）

理论上其它 agent 可以直接 `curl localhost:PORT/...` 调 server API。但有几个问题：

| 维度            | 直接 HTTP API                        | 走 CLI                              |
| --------------- | ------------------------------------ | ----------------------------------- |
| 端口发现        | agent 要知道 PORT、host、可能的 auth | `huabu` 自己处理                    |
| 自动启动 server | 用户要先 `pnpm dev`                  | `huabu serve` / 自动拉起            |
| 输出格式        | API 是 zod schema，对人不友好        | CLI 提供人类友好 + `--json`         |
| 错误信息        | HTTP 4xx/5xx，要解码                 | 自然语言错误，LLM 直接懂            |
| 命令稳定性      | API 是 server-web 之间的契约，会变   | CLI 自己一套独立 contract，可以稳定 |
| MCP             | 没有                                 | `huabu mcp` 一行启动                |
| 分发            | 别人不知道你这有 HTTP API            | `huabu --help` 自描述               |

**关键认知**：HTTP API 是 web app 的内部协议，**不应该作为外部消费者的接口**。CLI 是隔离层。

---

## 3. 三种用户模式

### 3.1 人在终端

```bash
$ huabu canvas list
ID                NAME                    NODES   UPDATED
paper-reading     Paper reading           42      2 days ago
sketch-test       Sketch Test             7       1 week ago

$ huabu canvas show paper-reading
Title: Paper reading
Nodes: 42
Edges: 28
...
```

输出对人友好（表格、相对时间、彩色）。

### 3.2 Bash agent（Claude Code / Codex / Aider）

```bash
$ huabu node search -c paper-reading -p "corridor" --json
{
  "matches": [
    { "nodeId": "abc", "label": "Dolphin Migration", "line": 12, "text": "..." },
    { "nodeId": "def", "label": "Whale Sightings", "line": 7, "text": "..." }
  ],
  "count": 2,
  "truncated": false
}
```

`--json` 是结构化输出，LLM 解析后做下一步决策。

### 3.3 MCP agent（Claude Code / Cursor / Windsurf 配 MCP）

用户在 agent 配置里加：

```json
{
  "mcpServers": {
    "huabu": { "command": "huabu", "args": ["mcp"] }
  }
}
```

之后 agent 自动获得带 typed schema 的工具：

- `huabu_canvas_list`
- `huabu_node_search`
- `huabu_node_read`
- `huabu_node_create`
- ...

LLM 用 typed tool calling，比拼 bash 命令更可靠（不会引号转义出错）。

### 3.4 自动化脚本

```bash
# 把某个 canvas 的所有节点导出成 JSONL 喂给数据流水线
huabu node list -c paper-reading --json | jq -c '.[]' > nodes.jsonl

# 批量给一组节点加标签
cat node-ids.txt | xargs -I{} huabu node update {} --add-tag important
```

`gh`、`kubectl` 风格——管道友好、退出码语义清晰。

---

## 4. 架构

```
┌─────────────────────────────────────────────────────────────┐
│  外部消费者                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐         │
│  │  人 (term)  │  │  bash agent  │  │ MCP agent  │         │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘         │
│         │                │                 │                │
│         └────────────────┴─────────────────┘                │
│                          │                                   │
│                  ┌───────▼────────┐                          │
│                  │  huabu CLI     │  ← 本设计文档范围        │
│                  │  - cmd parser  │                          │
│                  │  - mcp server  │                          │
│                  │  - output fmt  │                          │
│                  │  - rg sidecar  │                          │
│                  └───────┬────────┘                          │
│                          │ HTTP                              │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  apps/server                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ agent    │  │ canvas   │  │ storage  │  │ artifact │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                                              │
│  workspace = <HUABU_WORKSPACE> 或 UI 选择的路径           │
└──────────────────────────────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │ huabu-data/  │
                  │   huabu/        │
                  │     <canvas>/   │
                  └─────────────────┘
```

**关键约束**：CLI **永远不直接读写 `huabu-data/`**。所有数据访问都走 server HTTP。
这是为了：

1. server 已经有 storage 模块、文件锁、缓存、name index——重复实现等于埋雷；
2. 多个 CLI 进程 + web app 同时跑时，并发安全只在 server 一处保证；
3. 业务规则（节点命名、frontmatter schema、命令副作用）变化时，只改一处。

### 4.1 Server 自启动

CLI 启动时检测：

```
1. 是否有 HUABU_SERVER_URL 指向已运行 server？  → 用它
2. 默认 localhost:PORT 是否 ping 通？              → 用它
3. 本机有 huabu serve 后台进程吗？                  → 用它
4. 都没有 → huabu 自己 spawn 一个 huabu serve 后台进程，等就绪
```

参考 `docker` / `colima` 的 daemon 拉起模式。
带 `--no-autostart` flag 给"我就是想直接报错"的用户。

### 4.2 Workspace 定位

Server 已有的两种模式：

- **Managed mode**：`HUABU_WORKSPACE=/path` 启动，锁死；
- **Unmanaged mode**：UI 让用户挑文件夹。

CLI 加第三种：

- **CLI mode**：`HUABU_WORKSPACE=/path` 或 `huabu --workspace /path`；如果未指定，按下面顺序探：
  1. 当前目录及其父级有 `.huabu/` 标记 → 用它（git 风格）；
  2. `$XDG_CONFIG_HOME/huabu/config.toml` 里的 `default_workspace`；
  3. `$HOME/huabu-data/` 这种约定路径；
  4. 报错，让用户 `huabu workspace set <path>`。

`huabu serve` 启动 server 时把 workspace 透传给 server（`HUABU_WORKSPACE` env），不污染 web app 的"用户在 UI 里选"流程。

---

## 5. 命令树

按"读 / 写 / 元 / 桥接"四类组织。所有 verb 都是名词 + 动词（kubectl 风格）。

```
huabu canvas list                          # 列出所有 canvas
huabu canvas show <id>                     # 详情
huabu canvas create [--title T]
huabu canvas delete <id> [--force]
huabu canvas rename <id> <new-title>
huabu canvas export <id> [--format md|json|zip]
huabu canvas import <file>

huabu node list -c <canvas> [--type T] [--parent F]
huabu node show -c <canvas> <node-id>
huabu node read -c <canvas> <node-id> [--offset N] [--limit N]
huabu node search -c <canvas> -p <pattern> [--glob G] [--ignore-case]
huabu node find -c <canvas> -p <glob>
huabu node create -c <canvas> --label L --type T [--content @file|-]
huabu node update -c <canvas> <node-id> [--label L] [--content @file]
huabu node delete -c <canvas> <node-id>...
huabu node link -c <canvas> --from A --to B [--style S]
huabu node unlink -c <canvas> <edge-id>...

huabu agent ask -c <canvas> "<prompt>" [--mode ask|operate]
huabu agent stream -c <canvas> "<prompt>"     # SSE → stdout

huabu workspace set <path>
huabu workspace show
huabu config get <key>
huabu config set <key> <value>

huabu serve [--port P] [--detach]
huabu status                               # server + workspace + version
huabu mcp                                  # 启动 MCP server (stdio)
huabu version
huabu help [<command>]
```

### 5.1 工具映射（CLI ↔ 现有 agent tool）

CLI 子命令一一对应现有的 agent tool，**复用同一份业务逻辑**：

| CLI                              | 对应 agent tool               | 对应 HTTP endpoint                   |
| -------------------------------- | ----------------------------- | ------------------------------------ |
| `node read`                      | `read`                        | `GET /canvas/:id/nodes/:nid/content` |
| `node search`                    | `grep`                        | `POST /canvas/:id/search`            |
| `node find`                      | `find`                        | `POST /canvas/:id/find`              |
| `node list`                      | `inspect_nodes`               | `GET /canvas/:id/nodes`              |
| `canvas show`                    | `get_canvas_outline`          | `GET /canvas/:id`                    |
| `node create/update/delete/link` | `canvas_commands`             | `POST /canvas/:id/commands`          |
| `agent ask`                      | 不是 tool，是 agent loop 本身 | `POST /agent/chat` (SSE)             |

未列出的（`canvas list / create / delete / export / workspace / config`）走对应的现有 workspace / canvas 管理 endpoint。

### 5.2 全局 flags

```
--workspace, -w   覆盖 workspace 路径
--server-url      指向已运行的 server（默认 http://localhost:PORT）
--json            JSON 输出（默认人类友好）
--no-color        关掉 ANSI 色
--quiet, -q       只输出结果，不输出 progress
--verbose, -v     debug 日志到 stderr
--help, -h
```

### 5.3 退出码

```
0   成功
1   通用错误
2   用法错误（参数错）
3   未找到（canvas / node 不存在）
4   server 不可达
5   workspace 未配置
130 用户 Ctrl-C
```

参考 `git`、`gh`。

---

## 6. 输出格式契约

### 6.1 默认输出（人类）

- 表格用 `cli-table3` 或自己实现（避免重依赖）；
- 相对时间（"2 days ago"）；
- ANSI 色，自动检测 TTY 决定开关；
- 多行内容用 `less`-like 分页（非 TTY 时不分页）。

### 6.2 `--json` 输出

**这是 v1 contract 的核心，一旦发版不能 breaking change。**

约定：

- 每个命令的 `--json` 输出有固定 schema，定义在 `packages/cli-types/`（新增 package）；
- schema 用 zod 写，CLI 输出前过一遍 schema 保证不漏；
- 列表命令返回 `{ items: [...], total, truncated? }` 包装；
- 错误用 `{ error: { code, message, details? } }`，对应非 0 exit code；
- 时间戳一律 ISO 8601 字符串。

例：

```jsonc
// huabu node search -c X -p "corridor" --json
{
  "matches": [
    {
      "nodeId": "abc-123",
      "label": "Dolphin Migration",
      "path": "nodes/dolphin-migration.md",
      "line": 12,
      "text": "...corridor for whales...",
      "nodeType": "note",
    },
  ],
  "count": 1,
  "truncated": false,
}
```

这个 schema 跟现有 `handleGrep` 的输出**故意保持一致**——让 LLM 在 agent tool 和 CLI 之间迁移时认知零成本。

### 6.3 错误输出

```jsonc
// stderr (always JSON 当 --json 时)
{
  "error": {
    "code": "CANVAS_NOT_FOUND",
    "message": "Canvas 'paper-readin' not found. Did you mean 'paper-reading'?",
    "details": { "suggestion": "paper-reading" },
  },
}
```

- 错误消息**一定要人话**——LLM 会读它来决定下一步；
- `code` 是稳定 enum，定义在 `packages/cli-types/errors.ts`；
- 带建议时把建议放 `details` 里，便于 LLM 重试。

---

## 7. MCP 模式

`huabu mcp` 启动一个 stdio MCP server。

### 7.1 暴露的工具集（首发）

按"读多写少"原则，先暴露安全的读操作：

| MCP 工具            | 等价 CLI      | 风险                                     |
| ------------------- | ------------- | ---------------------------------------- |
| `huabu_canvas_list` | `canvas list` | 无                                       |
| `huabu_canvas_show` | `canvas show` | 无                                       |
| `huabu_node_list`   | `node list`   | 无                                       |
| `huabu_node_read`   | `node read`   | 无                                       |
| `huabu_node_search` | `node search` | 无                                       |
| `huabu_node_find`   | `node find`   | 无                                       |
| `huabu_node_create` | `node create` | 写——v2 再开                              |
| `huabu_node_update` | `node update` | 写——v2 再开                              |
| `huabu_node_delete` | `node delete` | 写——**永不**默认开，要 `--enable-writes` |

写操作默认关闭。开关：`huabu mcp --enable-writes`。理由：MCP agent 跑的 LLM 不一定是用户信任的那个；默认只读是安全 baseline。

### 7.2 实现路径

不重新发明 MCP server。用现成 SDK：

- TypeScript：`@modelcontextprotocol/sdk`（官方）
- 每个 CLI subcommand 写一遍 MCP tool adapter，复用底层 client（指向 server HTTP）

### 7.3 跟现有 server agent tool 的区别

**现有 agent tool**（`grep` / `find` / `read` 等）：跑在 server 内部，给 Huabu 自己的 agent loop 用。
**MCP tool**：跑在 CLI 进程，给**外部** agent 用。

两者**互不替代**：

- server 内部 tool 直接访问 `CanvasStore`，省一跳 HTTP，性能更好；
- MCP tool 经 CLI 经 HTTP 经 server，但完成了"暴露给外部"的目标。

不要试图合并——它们解决的是不同问题。

---

## 8. 分发与打包

### 8.1 三种发行渠道

| 渠道                  | 形态                                              | 优先级  |
| --------------------- | ------------------------------------------------- | ------- |
| **npm**               | `npm i -g @huabu/huabu-cli`（或直接 `npx huabu`） | v1 必做 |
| **Homebrew tap**      | `brew install huabu/huabu`                        | v1.1    |
| **standalone binary** | GitHub Releases，每平台一个 `.tar.gz` / `.zip`    | v1.2    |

npm 路径最容易上手；standalone 给"完全不想装 Node"的用户。

### 8.2 ripgrep 集成

CLI bundle 里**带上** `@vscode/ripgrep`：

```jsonc
// apps/cli/package.json
{
  "optionalDependencies": {
    "@vscode/ripgrep": "^1.x",
  },
}
```

server 仍然支持 Node fallback（[fs-search.ts](../../apps/server/src/modules/agent/tools/handlers/fs-search.ts)），但 CLI 进程跑 `huabu serve` 时，**通过 env 把 rg 路径传给 server**：

```ts
// CLI 启动 server 前
const rgPath = require('@vscode/ripgrep').rgPath;
spawn(serverEntry, [...], { env: { ...env, HUABU_RG_BIN: rgPath } });
```

server 端 [fs-search.ts](../../apps/server/src/modules/agent/tools/handlers/fs-search.ts) 改造：

```ts
const rgBin = process.env.HUABU_RG_BIN ?? detectSystemRipgrep();
if (rgBin) useRipgrep(rgBin);
else useNodeFallback();
```

**收益**：

- 用 CLI 启动的 server 自动获得 rg 加速；
- 直接 `pnpm dev` 跑的 server 走原来的 Node 实现，开发体验不变；
- 用户不需要懂 ripgrep 是什么。

### 8.3 standalone binary 怎么 build

候选工具：

- [`@vercel/ncc`](https://github.com/vercel/ncc) + Node SEA（单文件）
- [`bun build --compile`](https://bun.sh/docs/bundler/executables)（最简单，但要决定是否依赖 Bun runtime）
- [`pkg`](https://github.com/vercel/pkg)（已 deprecate，不推荐）

推荐 `bun build --compile`，因为：

- 单命令出 binary；
- 跨平台 cross-compile 支持；
- 把 `@vscode/ripgrep` 的 rg binary 作为 sidecar 打进去（要确认 Bun 的 SEA 支持 native binary）。

需要先做小型 POC 验证。

### 8.4 签名 / 公证

- **macOS**：Apple Developer ID Application cert + notarytool。Apple Developer Program $99/年。不签的话 Gatekeeper 会拦。
- **Windows**：EV Code Signing Certificate（$200-400/年）。不签 SmartScreen 会警告。
- **Linux**：不需要签。

v1 范围内可以**不签**（用户从 npm 装的 CLI 不触发 Gatekeeper），等 standalone binary 渠道做时再上签名。

---

## 9. 跟外部 agent 集成的关系

[agent-reachback.md](../architecture/agent-reachback.md) 描述的方向是：

```
用户在 Huabu 里 @copilot → Huabu 调用 Claude/Copilot CLI → 它们处理用户的代码仓库
```

本设计的方向是**对称的**：

```
用户在 Claude Code 里说话 → Claude 调用 huabu CLI → 操作 Huabu 画布
```

两者**互不冲突**，可以同时存在。最终形成：

```
        ┌────────────────────────────┐
        │  外部 agent (Claude等)      │
        └──────┬─────────────┬───────┘
               │             ▲
       ① 调 huabu CLI       │
               │             │
               ▼             │
        ┌────────────┐       │ ② Huabu 调外部 agent
        │ huabu CLI  │       │    (external_agent_design)
        └──────┬─────┘       │
               │             │
               ▼             │
        ┌────────────────────┴───────┐
        │  Huabu Server              │
        │  (canvas store, agent)     │
        └────────────────────────────┘
```

①和② 一起，让 Huabu 成为 agent 生态里**双向互通**的节点。

**实施上的接口**：external_agent_design 里"check if external CLI is installed"那一段，可以反过来给本设计参考——LLM agent 也会想知道"`huabu` 装了没"，所以我们的 CLI 要：

- 输出版本信息到 stderr 用一致格式：`huabu/1.2.3`；
- `huabu status --json` 返回机器可读的健康信息；
- 主流 agent 配置文档里写清楚怎么"discover" Huabu。

---

## 10. 实施阶段

四阶段，每阶段独立可发布。

### Phase 0：基础设施（1 PR）

- 新建 `apps/cli/`，最小 `huabu` 二进制（只支持 `huabu version` / `huabu help` / `huabu status`）
- 决定 CLI 框架：推荐 [`commander`](https://github.com/tj/commander.js) 或 [`yargs`](https://github.com/yargs/yargs)。**不要**用 oclif（太重）。
- 新建 `packages/cli-types/`，放 CLI ↔ server 通信契约 schema
- 接入 `pnpm-workspace.yaml`
- CI 加 `pnpm --filter @huabu/huabu-cli build` smoke test

**Exit criteria**：能 `pnpm cli huabu version` 输出版本号。

### Phase 1：只读命令（2-3 PR）

- `canvas list` / `canvas show`
- `node list` / `node show` / `node read` / `node search` / `node find`
- `status`
- `--json` 输出格式 + schema 校验
- server 端补齐对应的 HTTP endpoint（如果 web app 没用到，新增；如果用到了，复用）

**Exit criteria**：

- 在终端能完整浏览一个 canvas；
- 用 `--json` 输出能在 bash 脚本里拼出"找含某词的节点列表"。

### Phase 2：写命令（2 PR）

- `node create` / `node update` / `node delete`
- `node link` / `node unlink`
- `canvas create` / `canvas delete`
- 测试：跟 web app 同时操作同一 canvas，验证并发安全

**Exit criteria**：CLI 能完成一次完整的"创建画布 → 加节点 → 连边 → 改内容 → 删节点"。

### Phase 3：高级集成（1-2 PR）

- `huabu serve` daemon 模式 + 自动拉起
- `huabu agent ask` / `huabu agent stream`（SSE 流到 stdout）
- ripgrep sidecar 集成（[#8.2](#82-ripgrep-集成)）
- workspace discovery（`.huabu/` 标记 + config 文件）

**Exit criteria**：用户完全无感、不需要先启动 server。

### Phase 4：MCP（1-2 PR）

- 引入 `@modelcontextprotocol/sdk`
- `huabu mcp` 启动 stdio server
- 暴露只读工具集；写工具藏在 `--enable-writes` 后
- 文档：怎么在 Claude Code / Cursor / Windsurf 里配置

**Exit criteria**：在 Claude Code 里能用 `huabu_node_search` 这种 typed tool。

### Phase 5：分发（独立 track）

- npm publish（私有？公开？要先决定）
- Homebrew tap
- standalone binary（POC + CI build matrix）
- 签名（可推迟）

---

## 11. 关键风险 & 开放问题

### R1：CLI ↔ server schema 漂移

CLI 是 server HTTP 的 thin client，server API 改动会直接影响 CLI。**对策**：

- `packages/cli-types/` 跟 `packages/shared/` 区别开——CLI 自己有 stable contract，server 内部 contract 可以变；
- CLI 用 adapter 把 server response 映射到 CLI schema，schema 校验失败就报清晰错误；
- 版本协商：`huabu status` 返回 server 版本，CLI 检测不兼容时告诉用户升级。

### R2：单用户假设

当前 Huabu 是单用户的。CLI 也按单用户设计——没有 auth token。**如果 Huabu 走向多用户**，CLI 需要：

- `huabu login` / OAuth flow；
- token 存 keychain（Mac）/ credman（Win）/ libsecret（Linux），不存明文；
- 所有命令带 token header。

这是 v2+ 的事，但 schema 设计时**不要做"全局只有一个用户"的硬假设**——比如不要 `node create -c X --label L`，而是 `node create --workspace W -c X --label L`，留扩展空间。

### R3：性能（多次 spawn 开销）

如果 LLM 一次性调 30 次 `huabu node read`，每次都是新进程 + HTTP roundtrip。**对策**：

- v1 不优化，先看真实瓶颈在哪；
- v2 可以引入 `huabu shell` REPL 模式（保持 server 连接，避免重复 connect）；
- 或者推 LLM 用 `--json` + 一次 list 多个 nodeId 的批量命令。

### R4：rg sidecar 跨平台 build 复杂度

Bun build --compile 把 native binary 打进去，跨平台 matrix 验证麻烦。**对策**：

- v1 用 npm 路径，user-install 时 `@vscode/ripgrep` 自动下二进制；
- standalone binary 推迟到 Phase 5，给充分时间验证。

### R5：MCP write 工具的安全模型

允许外部 agent 写画布是真有风险——LLM 可能误删节点。**对策**：

- 默认只读（已设计）；
- 写操作即使开了，CLI 也加一层"危险操作日志"：所有 write 写到 `~/.huabu/audit.log`，可回溯；
- v2 考虑 "soft delete + undo"——`huabu undo` 撤销最近 N 次 write。

### Q1：CLI 名字到底叫 `huabu` 还是 `huabu`？

- `huabu` 跟数据目录、产品昵称一致，更贴近用户；
- `huabu` 跟 npm scope `@huabu/` 一致，更"官方"。
- **推荐 `huabu`**，更短、更易输入、避免跟"huabu 这个组织"混淆。

### Q2：CLI 跟 server 是同一个仓库吗？

- 同仓库（monorepo）：版本绑死、共享类型省事；
- 独立仓库：CLI 可以独立 release cadence。
- **推荐同仓库**，符合现有 monorepo 风格；如果将来 CLI 用户增长再 split。

### Q3：要不要做 `huabu shell`（REPL）？

像 `gh` 没有但 `aws` 有的功能。短期不做，v2 看反馈。

---

## 12. 一句话总结

> Huabu CLI 是把"Huabu 是个 web app"重新定义成"Huabu 是个本机服务 + 多种接口"。
> CLI 是接口之一，跟 web、agent loop、MCP 并列。
> 它的价值不在"性能更快"或"功能更多"——而在**让 Huabu 加入 agent 生态**，
> 同时为 rg 这类系统依赖、未来的桌面化、对外开放 API 提供干净的承载层。

---

## Appendix A：参考实现

- [`gh` (GitHub CLI)](https://github.com/cli/cli)：命令树设计、`--json` + jq 协议、自动 update
- [`kubectl`](https://kubernetes.io/docs/reference/kubectl/)：名词+动词组织、daemon 自动连接
- [`docker`](https://docs.docker.com/engine/reference/commandline/cli/)：CLI ↔ daemon 模式、socket 自启
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)：MCP 实现
- [`@vscode/ripgrep`](https://github.com/microsoft/vscode-ripgrep)：rg 跨平台分发参考
- VS Code [`server/`](https://github.com/microsoft/vscode/tree/main/src/vs/server) 的 CLI 部分：远程 server 自启模型

## Appendix B：与现有文档的关系

- [agent-architecture.md](../architecture/agent-architecture.md)：agent loop + 9 tool 的实现，本设计**不改这部分**。CLI 调 server，server 内部 agent 仍然用 tool。
- [agent-reachback.md](../architecture/agent-reachback.md)：Huabu 调外部 agent；本设计是镜像方向（外部 agent 调 Huabu），互不冲突。
- [api-design.md](../architecture/api-design.md)：HTTP API 规范；CLI 是 HTTP API 的另一个消费者，本设计 follow 同样的 zod schema 规则但加一层 CLI-specific contract。
- [canvas-storage.md](../architecture/canvas-storage.md)：磁盘格式；CLI 不读磁盘，所以这部分对 CLI 透明。
- setup.md：现有 monorepo 结构；CLI 加入为 `apps/cli/`。
