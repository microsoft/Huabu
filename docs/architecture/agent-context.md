# Agent Context

> The full path that carries "thinking on the canvas" to the AI agent: which
> signals are exposed, how they reach the model, and what's still missing.
> Maps to the README principles **Externalize Thinking** / **Share Cognitive Space**.

Core mental model: **chat sends a thin payload (selected nodes only) and the agent
fetches the rest via tools; intent is a single LLM call, so it ships the full
snapshot up front.**

---

## 1. Two wire shapes

Types live in [packages/shared/src/types/agent/context.ts](../../packages/shared/src/types/agent/context.ts).

| Shape              | For               | Carries                                                                              | Entry                                  |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| `AgentChatContext` | chat agent        | only `selectedNodes: WireSelectionNode[]`                                            | `POST /api/agent`                      |
| `IntentContext`    | intent recogniser | `nodes` / `edges{source,target}` / `recentActions` / `screenshot?` / `selectedNodes` | `POST /api/intent/recognize{,-stream}` |

Chat is deliberately thin: everything else (geometry / edges / content / screenshot) is fetched by the agent via tools. Intent is a one-shot call that can't use tools, so it ships the full snapshot at once. Web assembly: `getAgentChatContext()` / `getIntentContext()` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)).

---

## 2. Chat path: the conversation module

Chat context is assembled by [conversation/](../../apps/server/src/modules/agent/conversation) into a `ChatEnvelope`, then serialised into pi-ai messages.

```
POST /api/agent (agent.route.ts)
  ├─ loadAgent(mode)                  # system prompt + tool set
  ├─ readWorkspaceMemory()            # append <workspace_memory> to system prompt (built-in agent only)
  ├─ loadTurns + rebuildContextMessages   # rebuild prior turns
  ├─ buildChatEnvelope()              # this turn: text + selection + anchor + skills
  └─ runAgent(context, envelope)      # tool loop
```

`buildChatEnvelope()` ([envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts)) renders this turn into tagged blocks:

- `<selected_nodes>` — selected nodes `id/type/label/filename/preview?`, **no content** ([prompt/selected-nodes.ts](../../apps/server/src/modules/agent/conversation/prompt/selected-nodes.ts))
- `<canvas_neighbourhood>` — spatial neighbourhood of the anchor node (used by prompt/question nodes, [prompt/neighbourhood.ts](../../apps/server/src/modules/agent/conversation/prompt/neighbourhood.ts))
- `<invoked_skills>` — skills explicitly invoked via `/cmd` (see §3.2)
- attachments → vision parts ([prompt/attachments.ts](../../apps/server/src/modules/agent/conversation/prompt/attachments.ts))

---

## 3. Prompt-level injection: workspace memory + skills

These two are **cross-turn-stable** system-prompt injections (they don't change per turn), kept separate from the per-turn focus signals in §4.

### 3.1 Workspace memory

Every turn appends `.huabu.md` as a `<workspace_memory>` tag block at the end of the system prompt (cache-friendly); built-in agent only — external/ACP has its own preamble. See [agent-memory.md](./agent-memory.md).

### 3.2 Skills — two injection paths

Skills are **not tools**; they reach the prompt via two complementary paths:

| Path                      | Trigger       | Form                                                                                                                                               | Where                                                                                                 |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **catalogue (on-demand)** | agent decides | system prompt expands `{{skillCatalogue}}` into a list (id/name/description only); the agent `read("skills/<id>/SKILL.md")` when it wants the body | [catalogue.ts](../../apps/server/src/prompt/skills/catalogue.ts) `getSkillCatalogue(scope)`           |
| **invoked (explicit)**    | user `/cmd`   | the skill's **entire body** is inlined as an `<invoked_skills>` block (authoritative for this turn)                                                | [prompt/invoked-skills.ts](../../apps/server/src/modules/agent/conversation/prompt/invoked-skills.ts) |

The catalogue is filtered by the agent's frontmatter `skillScope` (ask/operate/sketch/external); a `null` scope injects no catalogue. The difference: catalogue is "a menu you pull from on demand", invoked is "the user named it, full body forced into this turn".

---

## 4. Three "user pointing" signals: selection / anchor / attachment

The envelope splits "where the user pointed this turn" into orthogonal parts ([envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts) `user` / `focus`):

| Signal         | What                                                              | Rendered as                                                | Carries                                                                              | Distinction                                                                                                            |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **selection**  | nodes the user selected on the canvas                             | `<selected_nodes>`                                         | `id/type/label/filename/preview?`, **no content**                                    | "I picked these nodes"; frames include children; selected sketch/image also auto-snapshot to a PNG vision part         |
| **anchor**     | the single node the request is anchored at (e.g. a question node) | anchor identity named in prompt + `<canvas_neighbourhood>` | `nodeId/label` + spatial neighbourhood                                               | "I'm asking from this node" — only present on anchored turns; the neighbourhood disambiguates "this" / "the one above" |
| **attachment** | off-canvas uploads pasted into the chat                           | `<attachment>`                                             | image→base64 vision; pdf/web→extracted text; oversized images degrade to a text note | unrelated to the canvas; not a node                                                                                    |

Key differences: **selection / anchor point at existing canvas nodes** (enriched with a `preview` via node-ref; content via tools); **attachment is a one-off off-canvas asset** (content inlined directly). Anchor is "a single focus point + neighbourhood"; selection is "a set of node metadata".

For both selection and anchor, the server enriches each node ref via [node-ref.ts](../../apps/server/src/modules/agent/node-ref.ts) with `filename` (`nodes/<safeLabel>.md`) + `preview` (ladder `summary > content[:120] > src`), plus the parent label for frames. **No content / geometry sent** — content via `read("nodes/<id>.md")`, layout/style via `inspect_nodes`.

---

## 5. Tools (fetch the rest on demand)

[tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts), assigned by each agent's `tools` frontmatter:

| Tool                            | scope                | Purpose                                                                |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `get_canvas_outline`            | ask/operate          | whole-canvas geometry + topology + clusters, optional 120-char preview |
| `inspect_nodes`                 | ask/operate          | predicate query of node geometry/style                                 |
| `inspect_edges`                 | ask/operate          | edge direction/style                                                   |
| `read` / `grep` / `find` / `ls` | ask/operate(/sketch) | read/search canvas files                                               |
| `snapshot_nodes`                | ask/operate/sketch   | node → PNG vision                                                      |
| `canvas_commands`               | operate              | mutate the canvas (server-side execution)                              |
| `fs_write`                      | operate              | memory/skill writes                                                    |
| `generate_image`                | operate              | AI image generation                                                    |
| `web_search`                    | ask/operate          | Tavily                                                                 |

Skills are not tools (injection in §3.2). Spatial geometry primitives are in [canvas-spatial.ts](../../apps/server/src/modules/canvas/canvas-spatial.ts); the neighbourhood pipeline is in [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts).

---

## 6. Intent path

Single LLM call, full `IntentContext` shipped ([intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) → [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts)): all node skeletons + edge pairs + `recentActions` (~10-item ring buffer, no timestamps) + an optional annotated screenshot + selection. Workspace memory is truncated to ~2000 chars. No tool loop.

`RecentAction` (context.ts, 15 branches) stores only `NodeRef + op/len` — **no node content**.

---

## 7. Code entry points

| Concern                 | File                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context types           | [agent/context.ts](../../packages/shared/src/types/agent/context.ts)                                                                                                                                               |
| Web assembly            | [canvasStore.ts](../../apps/web/src/store/canvasStore.ts)                                                                                                                                                          |
| Chat route              | [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)                                                                                                                                               |
| Turn envelope           | [conversation/envelope.ts](../../apps/server/src/modules/agent/conversation/envelope.ts)                                                                                                                           |
| History rebuild         | [conversation/transcript/history.ts](../../apps/server/src/modules/agent/conversation/transcript/history.ts)                                                                                                       |
| Selected-node refs      | [node-ref.ts](../../apps/server/src/modules/agent/node-ref.ts)                                                                                                                                                     |
| Tool defs / executor    | [tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts) · [tools/executor.ts](../../apps/server/src/modules/agent/tools/executor.ts)                                                      |
| Intent                  | [intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) · [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts)                                                                |
| System prompts          | [prompt/agents/](../../apps/server/src/prompt/agents) (ask / operate / sketch / intent / memory each an AGENT.md, loaded by loader.ts)                                                                             |
| Skill injection         | [skills/catalogue.ts](../../apps/server/src/prompt/skills/catalogue.ts) (catalogue) · [conversation/prompt/invoked-skills.ts](../../apps/server/src/modules/agent/conversation/prompt/invoked-skills.ts) (invoked) |
| Spatial / neighbourhood | [canvas-spatial.ts](../../apps/server/src/modules/canvas/canvas-spatial.ts) · [node-neighbourhood.ts](../../apps/server/src/modules/canvas/node-neighbourhood.ts)                                                  |
