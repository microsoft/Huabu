# External Agent System — Design Document

> Pluggable external agent integration for Sediment canvas.

## 1. Goal

Allow users to connect external coding agents (GitHub Copilot, Claude Code, etc.) as pluggable modules. Each agent appears as a first-class participant in the canvas chat — users `@mention` an agent to route a message to it, and the agent's response streams back alongside the built-in Sediment agent.

**Non-goals**: We are not building agents from scratch. We are bridging existing agents that the user already has installed on their machine.

---

## 2. Core Concept: Workspace ≠ Code Repository

Sediment's **workspace** is a _thinking space_ — canvas files, notes, knowledge sources. It is NOT a code repository. External coding agents (Copilot, Claude Code) need a **code repository path** to know which project to work on. These two paths are independent:

```
Sediment Workspace (思考空间)         Code Repository (工作空间)
D:/sediment-vault/api-redesign/      D:/code/my-app/
  ├─ canvas/                           ├─ src/
  ├─ sources/                          ├─ package.json
  └─ artifacts/                        └─ tsconfig.json
```

A canvas MAY be associated with zero or more code repositories. The binding is **lazy** — only prompted when the user first `@mention`s a coding agent on that canvas.

---

## 3. User Experience

### 3.1 First-Time Code Repo Binding (Lazy, On-Demand)

The user never configures anything upfront. The first time they `@copilot` on a canvas, the system asks:

```
  You: @copilot 帮我看看这个函数的性能问题

  ┌─────────────────────────────────────────────┐
  │ 🐙 Copilot needs a code repository          │
  │                                              │
  │ Select the project directory Copilot         │
  │ should work in:                              │
  │                                              │
  │ [📁 Browse...]                               │
  │                                              │
  │ ☑ Remember for this canvas                   │
  └─────────────────────────────────────────────┘

  (user selects D:/code/my-app)

  🐙 Copilot: 我来看看 my-app 项目...
    [tool] read_file: src/utils.ts
  找到了 2 个性能问题...
```

After binding, subsequent `@copilot` messages on the same canvas go straight to work with **zero friction**.

### 3.2 Multi-Repo (Optional, Future)

When a canvas is bound to multiple repos, the user specifies with a bracket prefix:

```
@copilot [shared-lib] 这个 utils 函数需要类型修复
```

If only one repo is bound (the common case), no prefix needed.

### 3.3 Chat Interaction

```
┌─────────────────────────────────────────────────────────┐
│ Chat                                                     │
│                                                          │
│  You: @copilot 帮我重构 app.ts 的错误处理                  │
│                                                          │
│  🐙 Copilot: 我来分析一下 app.ts...                       │
│    [tool] read_file: src/app.ts                          │
│    [tool] edit_file: src/app.ts                          │
│  找到了 3 处可以改进的地方:                                 │
│  1. ...                                                  │
│                                                          │
│  You: @sediment 把 Copilot 的建议整理成 canvas 节点        │
│                                                          │
│  🪨 Sediment: 已创建 3 个节点...                           │
│    [tool] canvas_commands: CREATE_NODES                   │
│                                                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │  Message input                        [@] [▶ Send]   │ │
│ │                                                      │ │
│ │  ┌─ autocomplete ──────────────────┐                 │ │
│ │  │ 🪨 Sediment (built-in)          │                 │ │
│ │  │ 🐙 GitHub Copilot   ● connected│                 │ │
│ │  │ 🟣 Claude Code      ○ available│                 │ │
│ │  └─────────────────────────────────┘                 │ │
│ └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 3.4 Agent Management (Settings UI)

```
┌─ External Agents ────────────────────────────────────────┐
│                                                          │
│  🐙 GitHub Copilot CLI                                   │
│     Status: ● Connected (gpt-4o)                         │
│     [Disconnect] [Settings]                              │
│                                                          │
│  🟣 Claude Code                                          │
│     Status: ○ Not installed                              │
│     [Install guide]                                      │
│                                                          │
│  [+ Add Agent...]                                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 3.5 Canvas Settings — Code Repository Binding

```
┌─ Canvas Settings ──────────────────────────────────────┐
│                                                         │
│  Code Repositories (for external coding agents)         │
│  ┌────────────────────────────────────────────────┐     │
│  │ 📁 D:/code/my-app               [primary] [✕]  │     │
│  └────────────────────────────────────────────────┘     │
│  [+ Add repository...]                                  │
│                                                         │
│  Tip: External agents like @copilot work on files       │
│  in these directories.                                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Architecture

### 4.1 Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (Web)                          │
│  ChatPanel → useAgentStream hook                            │
│  Parse @mention → resolve agentId                           │
│  AgentRequest { content, agentId?, ... }                    │
└────────────────────────┬────────────────────────────────────┘
                         │ POST /api/agent
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Server (Fastify)                          │
│                                                              │
│  agent.route.ts                                              │
│  ├─ if agentId == null or 'sediment' → existing pipeline    │
│  └─ if agentId == 'copilot' etc → ExternalAgentRouter       │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │          ExternalAgentRouter                        │     │
│  │  ┌──────────────┐  ┌──────────────┐                │     │
│  │  │ AgentRegistry │  │ AdapterFactory│               │     │
│  │  │ (config JSON) │  │              │                │     │
│  │  └──────┬───────┘  └──────┬───────┘                │     │
│  │         │                  │                        │     │
│  │         ▼                  ▼                        │     │
│  │  ┌─────────────────────────────────────────┐       │     │
│  │  │        ExternalAgentAdapter (interface)  │       │     │
│  │  ├─────────────────────────────────────────┤       │     │
│  │  │ + isAvailable(): Promise<boolean>        │       │     │
│  │  │ + connect(): Promise<void>               │       │     │
│  │  │ + stream(req): AsyncGenerator<StreamEvent│       │     │
│  │  │ + disconnect(): Promise<void>            │       │     │
│  │  │ + getInfo(): AgentInfo                   │       │     │
│  │  └────┬─────────────┬──────────────┬───────┘       │     │
│  │       │             │              │               │     │
│  │  ┌────▼───┐   ┌─────▼────┐   ┌────▼───────┐       │     │
│  │  │Copilot │   │ Claude   │   │  Generic   │       │     │
│  │  │Adapter │   │ Adapter  │   │ CLI Adapter│       │     │
│  │  │(SDK)   │   │(CLI)     │   │            │       │     │
│  │  └────┬───┘   └─────┬────┘   └────┬───────┘       │     │
│  │       │             │              │               │     │
│  └───────┼─────────────┼──────────────┼───────────────┘     │
│          │             │              │                      │
└──────────┼─────────────┼──────────────┼──────────────────────┘
           ▼             ▼              ▼
    @github/copilot-sdk  claude CLI     any CLI agent
    (JSON-RPC)           (subprocess)   (subprocess)
```

### 4.2 Key Design Decisions

1. **Same SSE protocol** — External agents emit the same `StreamEvent` types (`text_delta`, `tool_start`, `tool_result`, `done`, `error`). The frontend doesn't know or care whether the response came from built-in or external agent.

2. **Same chat thread** — External agent messages live in the same thread. Context is shared (the user can talk to Sediment, then @copilot in the same conversation).

3. **Agent-specific context persistence** — Each external agent keeps its own session state (Copilot SDK manages its own sessions).

4. **No changes to `runAgent()`** — The built-in agent pipeline stays untouched. External agents are a parallel path, not a fork of the existing code.

5. **Lazy code-repo binding** — External coding agents need a code repository path (cwd), which is NOT the Sediment workspace. The binding is prompted on first `@mention` and stored per-canvas.

---

## 5. Type Definitions

### 5.1 Shared Types (`packages/shared/src/types/agent.ts`)

```typescript
// --- NEW types (append to existing file) ---

/** Registered external agent descriptor */
export interface ExternalAgentInfo {
  id: string; // 'copilot' | 'claude' | user-defined
  name: string; // 'GitHub Copilot'
  type: ExternalAgentType; // adapter type
  icon?: string; // emoji or icon name
  description?: string; // 'Code review, implementation, debugging'
  status: ExternalAgentStatus;
}

export type ExternalAgentType = 'copilot-sdk' | 'claude-cli' | 'generic-cli';

export type ExternalAgentStatus =
  | 'available' // installed, not connected
  | 'connected' // active session running
  | 'unavailable' // not installed or not authenticated
  | 'error'; // connection failed

/** Extend existing AgentRequest */
// Add to AgentRequest:
//   agentId?: string;  // undefined = built-in Sediment agent

/** Code repository binding (stored per-canvas) */
export interface CanvasCodeRepository {
  path: string; // absolute path, e.g. 'D:/code/my-app'
  alias: string; // short name, e.g. 'my-app' (derived from dir name)
  primary?: boolean; // default repo when no [alias] prefix given
}

// Extend existing CanvasFile:
//   codeRepositories?: CanvasCodeRepository[];
```

### 5.2 Server Types (`apps/server/src/modules/agent/external/types.ts`)

```typescript
import type { AgentMode } from '@sediment/shared';

/** Config stored in data/external-agents.json */
export interface ExternalAgentConfig {
  id: string;
  name: string;
  type: ExternalAgentType;
  icon?: string;
  description?: string;
  enabled: boolean;

  // Type-specific config
  copilotSdk?: {
    model?: string; // default: 'claude-sonnet-4.5'
    cwd?: string; // default: workspace path
    streaming?: boolean; // default: true
    allowAllTools?: boolean; // default: false (safety)
  };
  claudeCli?: {
    command?: string; // default: 'claude'
    args?: string[];
    cwd?: string;
  };
  genericCli?: {
    command: string;
    args?: string[];
    cwd?: string;
    outputFormat?: 'text' | 'json-stream';
  };
}

/** Runtime interface all adapters implement */
export interface ExternalAgentAdapter {
  readonly id: string;
  readonly config: ExternalAgentConfig;

  /** Check if the agent CLI/SDK is installed and authenticated */
  isAvailable(): Promise<boolean>;

  /** Initialize connection (start SDK client, etc.) */
  connect(): Promise<void>;

  /** Stream a response — same StreamEvent protocol as built-in agent */
  stream(request: ExternalAgentRequest): AsyncGenerator<StreamEvent>;

  /** Abort current stream */
  abort(): Promise<void>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;

  /** Current status */
  getStatus(): ExternalAgentStatus;
}

export interface ExternalAgentRequest {
  content: string;
  threadId: string;
  sessionId?: string; // external agent's own session (Copilot SDK sessionId)
  cwd: string; // code repository path (resolved from canvas binding)
  canvasId?: string; // for canvas tools if agent can operate canvas
  attachments?: Array<{ type: string; data: string; mimeType?: string }>;
}
```

---

## 6. Module Structure

```
apps/server/src/modules/agent/external/
├── types.ts                  # Type definitions above
├── registry.ts               # Agent registry (CRUD, discovery)
├── router.ts                 # Route external agent requests
├── adapters/
│   ├── copilot-sdk.adapter.ts   # @github/copilot-sdk integration
│   ├── claude-cli.adapter.ts    # Claude Code CLI integration
│   └── generic-cli.adapter.ts   # Generic CLI subprocess adapter
└── external-agent.route.ts      # HTTP endpoints for agent management
```

---

## 7. Implementation Details

### 7.1 Agent Registry (`registry.ts`)

```typescript
const CONFIG_FILE = 'data/external-agents.json';
const adapters = new Map<string, ExternalAgentAdapter>();

export function getRegisteredAgents(): ExternalAgentInfo[];
export function getAgent(id: string): ExternalAgentAdapter | undefined;
export function registerAgent(config: ExternalAgentConfig): void;
export function removeAgent(id: string): void;
export async function connectAgent(id: string): Promise<void>;
export async function disconnectAgent(id: string): Promise<void>;
export async function discoverAgents(): Promise<ExternalAgentConfig[]>;
// ^ Auto-detect: check if `copilot` CLI exists, `claude` CLI exists, etc.
```

### 7.2 Copilot SDK Adapter (`copilot-sdk.adapter.ts`)

This is the primary adapter. It wraps `@github/copilot-sdk` and translates its events to Sediment's `StreamEvent` format.

```typescript
import { CopilotClient, approveAll, defineTool } from '@github/copilot-sdk';

export class CopilotSdkAdapter implements ExternalAgentAdapter {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotSession>(); // threadId → session
  private status: ExternalAgentStatus = 'unavailable';

  async connect(): Promise<void> {
    this.client = new CopilotClient({
      useLoggedInUser: true, // Use existing copilot login
    });
    await this.client.start();
    this.status = 'connected';
  }

  async *stream(request: ExternalAgentRequest): AsyncGenerator<StreamEvent> {
    const session = await this.getOrCreateSession(request.threadId);

    // Use event-driven approach: collect events into an async queue
    const queue = new AsyncQueue<StreamEvent>();

    session.on('assistant.message_delta', (event) => {
      queue.push({
        type: 'text_delta',
        data: { content: event.data.deltaContent },
      });
    });

    session.on('tool.execution_start', (event) => {
      queue.push({
        type: 'tool_start',
        data: { toolName: event.data.toolName, toolArgs: event.data.toolArgs },
      });
    });

    session.on('tool.execution_complete', (event) => {
      queue.push({
        type: 'tool_result',
        data: { toolName: event.data.toolName, toolResult: event.data.result },
      });
    });

    session.on('assistant.message', (event) => {
      queue.push({
        type: 'done',
        data: { message: event.data.content },
      });
      queue.close();
    });

    // Send message (non-blocking)
    await session.send({
      prompt: request.content,
      attachments: request.attachments?.map((a) => ({
        type: 'blob' as const,
        data: a.data,
        mimeType: a.mimeType ?? 'text/plain',
      })),
    });

    // Yield events as they arrive
    yield* queue;
  }

  private async getOrCreateSession(
    threadId: string,
    cwd: string,
  ): Promise<CopilotSession> {
    // Key includes cwd so switching repos gets a fresh session
    const key = `${threadId}:${cwd}`;
    let session = this.sessions.get(key);
    if (!session) {
      // Copilot CLI process cwd determines what files it can see
      session = await this.client!.createSession({
        model: this.config.copilotSdk?.model ?? 'claude-sonnet-4.5',
        streaming: true,
        systemMessage: {
          content: `Your working directory is: ${cwd}`,
        },
        onPermissionRequest: approveAll, // TODO: configurable policy
      });
      this.sessions.set(key, session);
    }
    return session;
  }
}
```

### 7.3 Route Integration (`agent.route.ts` changes)

Minimal change to the existing POST handler. Key addition: **resolve code repo from canvas binding** and handle first-time setup.

```typescript
// In agent.route.ts POST handler, BEFORE the existing pipeline:

const { agentId, content, threadId, canvasId, ...rest } = request.body;

if (agentId && agentId !== 'sediment') {
  // --- External agent path ---
  const adapter = getAgent(agentId);
  if (!adapter) {
    return reply.code(404).send({ error: `Agent '${agentId}' not found` });
  }

  // Resolve code repository from canvas binding
  const cwd = await resolveCodeRepository(canvasId, agentId);
  if (!cwd) {
    // No code repo bound yet → tell frontend to prompt user
    return reply.code(428).send({
      error: 'code_repo_required',
      message: `Agent '${agentId}' needs a code repository. Please select one.`,
      agentId,
    });
  }

  const resolvedThreadId = getOrCreateThreadId(threadId);

  // Setup SSE (same as existing code)
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  emit('meta', { threadId: resolvedThreadId, agentId });

  try {
    const stream = adapter.stream({
      content,
      threadId: resolvedThreadId,
      cwd, // ← code repo path, NOT Sediment workspace
    });
    for await (const event of stream) {
      emit(event.type, { ...event.data, agentId });
    }
  } catch (error) {
    emit('error', { error: error.message, agentId });
  } finally {
    emit('end', {});
  }

  return;
}

// --- Existing built-in agent pipeline (unchanged) ---
```

**`resolveCodeRepository()` logic:**

```typescript
async function resolveCodeRepository(
  canvasId: string | undefined,
  agentId: string,
): Promise<string | null> {
  if (!canvasId) return null;
  const canvas = await readCanvas(canvasId);
  if (!canvas?.codeRepositories?.length) return null;
  // Return primary repo, or first one if no primary set
  const primary = canvas.codeRepositories.find((r) => r.primary);
  return primary?.path ?? canvas.codeRepositories[0].path;
}
```

**Frontend handling of 428 response:**

```typescript
// In useAgentStream.startStream():
// If server returns 428 code_repo_required:
//   → Show directory picker dialog
//   → POST /api/canvas/:canvasId/code-repo { path }
//   → Retry the original message
```

### 7.4 Management Endpoints (`external-agent.route.ts`)

```typescript
// Agent management
// GET /api/agent/external — List registered agents + status
// POST /api/agent/external — Register new agent
// PUT /api/agent/external/:id — Update agent config
// DELETE /api/agent/external/:id — Remove agent
// POST /api/agent/external/:id/connect — Connect agent
// POST /api/agent/external/:id/disconnect — Disconnect agent
// GET /api/agent/external/discover — Auto-detect available agents

// Canvas code-repo binding
// GET  /api/canvas/:canvasId/code-repos — List bound repos for canvas
// POST /api/canvas/:canvasId/code-repos — Bind a code repo { path }
// DELETE /api/canvas/:canvasId/code-repos/:alias — Remove binding
```

### 7.5 Frontend Changes

#### AgentRequest (add `agentId`)

```typescript
// packages/shared/src/types/agent.ts
interface AgentRequest {
  content: string;
  threadId?: string;
  mode?: AgentMode;
  agentId?: string; // NEW — undefined = 'sediment'
  // ...existing fields
}
```

#### Chat Input (`@` mention parsing)

```typescript
// apps/web/src/components/Panels/ChatPanel/ChatInput.tsx

function parseAgentMention(text: string): {
  agentId?: string;
  content: string;
} {
  const match = text.match(/^@(\w+)\s+([\s\S]*)/);
  if (match) {
    return { agentId: match[1], content: match[2] };
  }
  return { content: text };
}
```

#### Stream Event Handler (show agent identity)

```typescript
// In handleStreamEvent — meta event now includes agentId
case 'meta':
  if (event.data.agentId) {
    // Mark assistant message with agent identity
    updateMessage(assistantId, msg => ({
      ...msg,
      agentId: event.data.agentId,
      agentName: event.data.agentName,
    }));
  }
  break;
```

#### Chat Message Rendering

```typescript
// Show agent avatar/badge on messages
function AgentBadge({ agentId }: { agentId?: string }) {
  if (!agentId || agentId === 'sediment') return <SedimentIcon />;
  if (agentId === 'copilot') return <span>🐙</span>;
  if (agentId === 'claude') return <span>🟣</span>;
  return <span>🤖</span>;
}
```

---

## 8. Config File Format

```jsonc
// apps/server/data/external-agents.json
[
  {
    "id": "copilot",
    "name": "GitHub Copilot",
    "type": "copilot-sdk",
    "icon": "🐙",
    "description": "Code implementation, review, debugging, Git operations",
    "enabled": true,
    "copilotSdk": {
      "model": "claude-sonnet-4.5",
      "streaming": true,
      "allowAllTools": false,
    },
  },
  {
    "id": "claude",
    "name": "Claude Code",
    "type": "claude-cli",
    "icon": "🟣",
    "description": "Code analysis, refactoring, architecture planning",
    "enabled": false,
    "claudeCli": {
      "command": "claude",
      "args": ["--output-format", "stream-json"],
    },
  },
]
```

---

## 9. Event Mapping

### Copilot SDK → Sediment StreamEvent

| Copilot SDK Event           | Sediment StreamEvent | Notes                      |
| --------------------------- | -------------------- | -------------------------- |
| `assistant.message_delta`   | `text_delta`         | `deltaContent` → `content` |
| `assistant.reasoning_delta` | `thinking_delta`     | `deltaContent` → `content` |
| `tool.execution_start`      | `tool_start`         | `toolName` + `toolArgs`    |
| `tool.execution_complete`   | `tool_result`        | `toolName` + JSON result   |
| `assistant.message`         | `done`               | Final complete message     |
| error / timeout             | `error`              | Error string               |

### Claude CLI → Sediment StreamEvent

| Claude CLI `--output-format stream-json`              | Sediment StreamEvent |
| ----------------------------------------------------- | -------------------- |
| `{"type": "assistant", "content": "..."}`             | `text_delta`         |
| `{"type": "tool_use", "name": "...", "input": {...}}` | `tool_start`         |
| `{"type": "tool_result", ...}`                        | `tool_result`        |
| `{"type": "result", "result": "..."}`                 | `done`               |

---

## 10. Implementation Phases

### Phase 1: Foundation (MVP)

**Server:**

- [ ] `ExternalAgentAdapter` interface + types
- [ ] `AgentRegistry` with JSON config persistence
- [ ] `CopilotSdkAdapter` (stream, connect, disconnect)
- [ ] Route integration: `agentId` routing in POST /api/agent
- [ ] Management endpoints: GET/POST /api/agent/external

**Shared:**

- [ ] Add `agentId` to `AgentRequest`
- [ ] Add `ExternalAgentInfo` type

**Frontend:**

- [ ] `@` mention parsing in ChatInput
- [ ] Autocomplete dropdown (available agents)
- [ ] Agent badge on chat messages
- [ ] Basic agent settings panel

**Dependencies:**

- [ ] `@github/copilot-sdk` in apps/server/package.json

### Phase 2: Polish

- [ ] Auto-discovery (detect installed agents on startup)
- [ ] Claude CLI adapter
- [ ] Permission UI (approve/deny tool calls from external agents)
- [ ] Canvas integration: external agent output → canvas nodes
- [ ] Custom tools: expose Sediment canvas_commands to external agents (via SDK `defineTool`)
- [ ] Agent status indicator in chat header

### Phase 3: Advanced

- [ ] Agent Node on canvas (visual representation of agent)
- [ ] Multi-agent orchestration (Sediment delegates sub-tasks)
- [ ] Generic CLI adapter (any stdin/stdout agent)
- [ ] ACP protocol support (Agent Client Protocol)

---

## 11. Giving External Agents Canvas Powers

A key advanced feature: register Sediment's canvas tools with the Copilot SDK so that Copilot can create/modify canvas nodes.

```typescript
// In CopilotSdkAdapter.getOrCreateSession():

const canvasTools = [
  defineTool('sediment_create_nodes', {
    description: 'Create nodes on the Sediment canvas',
    parameters: {
      /* ... CreateNodes schema ... */
    },
    handler: async (args) => {
      return await executeTool(
        'canvas_commands',
        {
          commands: [{ type: 'CREATE_NODES', nodes: args.nodes }],
        },
        { canvasId },
      );
    },
  }),
  defineTool('sediment_get_canvas', {
    description: 'Get current canvas state from Sediment',
    parameters: {
      /* ... */
    },
    handler: async () => {
      return await executeTool('get_canvas_outline', {}, { canvasId });
    },
  }),
];

session = await this.client.createSession({
  model: this.config.copilotSdk?.model,
  streaming: true,
  tools: canvasTools, // Copilot can now operate the canvas!
  onPermissionRequest: approveAll,
});
```

This creates a **bidirectional bridge**: Sediment can send tasks to Copilot, and Copilot can write back to the canvas.

---

## 12. Security Considerations

1. **Tool approval** — External agents run with file system access. The `onPermissionRequest` handler should be configurable (not always `approveAll`). Default: require approval for shell commands and file writes.

2. **Working directory scoping** — External agents should be constrained to the user's workspace path. Don't expose arbitrary file system access.

3. **No credential leaking** — Agent configs stored in `data/external-agents.json` should NOT contain sensitive credentials. Auth handled by each agent's own mechanism (Copilot: OAuth, Claude: ~/.claude/config).

4. **Abort propagation** — When user clicks "Stop" in Sediment, the abort signal must propagate to the external agent (Copilot: `session.abort()`, CLI: `process.kill()`).

---

## 13. Dependencies

| Package               | Version | Purpose                               |
| --------------------- | ------- | ------------------------------------- |
| `@github/copilot-sdk` | ^0.3.0  | Copilot CLI integration (Node.js SDK) |

No other new dependencies needed. Claude CLI adapter just uses `child_process.spawn`. Generic CLI adapter likewise.
