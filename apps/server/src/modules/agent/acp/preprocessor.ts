/**
 * ACP Preprocessor.
 *
 * Rewrites the user's raw message into a structured
 * {@link ExternalAgentPrompt} (a focused `task` + a `fileRefs` list of
 * paths the external agent should consider reading) before Sediment
 * hands it to `session/prompt`. Acts as Huabu's "project manager" so
 * the external agent receives a clean briefing instead of a token
 * dump of canvas state.
 *
 * Why a separate one-shot LLM call rather than stuffing canvas state
 * inline:
 *   - Large canvases would blow past the external agent's context.
 *   - The agent doesn't need every node — only the ones relevant to
 *     this turn. We let the preprocessor LLM cull.
 *   - Path-based output lines up with the upcoming `fs/read_text_file`
 *     capability so the external agent reads on demand.
 *
 * Failure model: callers `try`/`catch` and fall back to the raw user
 * text. The route-level service emits a `prepared_prompt` SSE event
 * with `prompt: null` + an `error` description so the UI can replace
 * its "Preparing…" placeholder with a visible failure note.
 */

import { llmComplete } from '../llm.js';
import { buildAgentNodeRef } from '../node-ref.js';
import { ACP_CANVAS_VFS_PREFIX } from './capabilities/fs.js';

import type { AgentNodeRef } from '../node-ref.js';
import type { Context } from '@earendil-works/pi-ai';
import type {
  AgentChatContext,
  ExternalAgentPrompt,
  WireSelectionNode,
} from '@sediment/shared';
import type { FastifyBaseLogger } from 'fastify';

// ─── System prompt ────────────────────────────────────────────────────────

/**
 * Inlined system prompt for the preprocessor.
 *
 * Kept here (rather than in `prompt/agents/<id>/AGENT.md`) because the
 * preprocessor has no tools, no skills, and no per-canvas runtime
 * config — promoting it to a full `AgentId` would require widening the
 * loader's `VALID_AGENT_IDS` set for marginal benefit. Extract later
 * if we add a second pure one-shot LLM helper.
 */
const PREPROCESSOR_SYSTEM_PROMPT = `You are the prompt preprocessor inside Sediment, a visual research canvas.

The user is chatting with an **external** coding/research agent (Claude Code, Copilot CLI, Gemini CLI, …) that runs on the user's machine and can read files via its own \`Read\` tool. Sediment is acting as that agent's project manager: your job is to take the user's raw message plus what we know about their canvas and produce a clean briefing.

## Inputs you receive

- **rawMessage**: the user's literal chat input.
- **agentAlias**: the short name of the bound external agent.
- **selectedNodes**: zero or more canvas nodes the user has explicitly selected, each given as \`{ id, type, label?, filename }\`. The \`filename\` is a path relative to the canvas directory (\`nodes/<safeLabel>.md\` or \`nodes/<id>.md\`); the external agent can pass it straight to its \`Read\` tool.
- **recentTurns**: brief excerpt of the recent conversation between user and external agent. Use only for context — do **not** re-issue earlier asks.

## Your output

Return **only** a JSON object (no markdown fences, no commentary) with this exact shape:

\`\`\`
{
  "task": "<clear, self-contained task description for the external agent>",
  "fileRefs": [
    { "path": "nodes/<file>.md", "reason": "<≤80 chars why>" }
  ]
}
\`\`\`

### Rules

1. \`task\` must stand alone: an agent reading **only** \`task\` and \`fileRefs\` (with no other context) should know what to do. Quote the user's intent faithfully — do not invent requirements.
2. Use second person ("you") to address the external agent.
3. Mention the canvas only when it matters for this turn. If the user asks something fully general, \`fileRefs\` may be \`[]\`.
4. \`fileRefs\` paths must come from \`selectedNodes[].filename\` (i.e. \`nodes/<file>.md\`) or be under \`.artifacts/\`. Never invent paths and never reference \`canvas.json\` — the canvas structure was summarised for you above.
5. Keep \`reason\` short and concrete (≤80 chars). Skip \`reason\` if obvious from the filename.
6. Order \`fileRefs\` by relevance, most relevant first. Cap at 8 entries — leave the rest for the agent to discover via tools.
7. If the user's message is itself code/config/markdown they want analysed, paraphrase the request in \`task\` and quote the snippet inside \`task\` (don't try to externalise it as a file).
`;

// ─── Public API ───────────────────────────────────────────────────────────

export interface PreparePromptInput {
  /** Raw user text Sediment is about to send via ACP `session/prompt`. */
  rawText: string;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /** Canvas chat context for this turn (may be omitted when client didn't send one). */
  canvasContext?: AgentChatContext;
  /**
   * Conversational history for THIS thread (user/assistant turns so
   * far). We only forward a short tail to keep the preprocessor LLM
   * call cheap; full long-term memory lives on the external agent's
   * own ACP session.
   */
  history: Context['messages'];
  logger: FastifyBaseLogger;
}

export interface PreparePromptResult {
  /** Structured prompt the UI renders and the history persists. */
  prompt: ExternalAgentPrompt;
  /**
   * The plain-text payload Sediment actually hands to ACP
   * `session/prompt`. Derived from `prompt` via {@link serializePrompt}
   * so server, log, and external agent all see the same wording.
   */
  serialized: string;
}

/**
 * Run the preprocessor LLM. Throws on network / parse / shape errors;
 * callers should catch and fall back to {@link serializeRawPrompt}.
 */
export async function prepareExternalAgentPrompt(
  input: PreparePromptInput,
): Promise<PreparePromptResult> {
  const { rawText, agentAlias, canvasContext, history, logger } = input;

  const selectedRefs = canvasContext?.selectedNodes
    ? flattenSelection(canvasContext.selectedNodes)
    : [];

  const userPayload = {
    rawMessage: rawText,
    agentAlias,
    selectedNodes: selectedRefs.map((ref) => ({
      id: ref.id,
      type: ref.type,
      ...(ref.label ? { label: ref.label } : {}),
      filename: ref.filename,
    })),
    recentTurns: extractRecentTurns(history, 4),
  };

  const piContext: Context = {
    systemPrompt: PREPROCESSOR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: JSON.stringify(userPayload, null, 2),
        timestamp: Date.now(),
      },
    ],
  };

  const response = await llmComplete(piContext);

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  const prompt = parsePromptJson(raw, selectedRefs);
  if (!prompt) {
    throw new Error(
      '[acp/preprocessor] LLM response was not valid ExternalAgentPrompt JSON',
    );
  }

  logger.debug(
    {
      agentAlias,
      taskLength: prompt.task.length,
      fileRefsCount: prompt.fileRefs.length,
    },
    '[acp/preprocessor] prepared prompt',
  );

  return {
    prompt,
    serialized: serializePrompt(prompt),
  };
}

/**
 * Convert an {@link ExternalAgentPrompt} into the plain-text payload
 * sent over ACP `session/prompt`. Format is deliberately simple
 * markdown so any agent's text rendering picks it up cleanly.
 *
 * Every `fileRefs[].path` is rendered as `<ACP_CANVAS_VFS_PREFIX><rel>`
 * (i.e. `/canvas/nodes/foo.md`) — absolute paths in the virtual
 * namespace owned by `acp/capabilities/fs.ts`. The agent's `Read`
 * tool emits the same absolute path back over `fs/read_text_file`,
 * which is what the sandbox handler expects. Keep `fileRefs[].path`
 * itself canvas-relative; serialization is the only layer that adds
 * the prefix so storage / UI / future internal consumers stay free
 * of wire concerns.
 */
export function serializePrompt(prompt: ExternalAgentPrompt): string {
  const lines: string[] = [prompt.task.trim()];
  if (prompt.fileRefs.length > 0) {
    lines.push('', '## Files to consider', '');
    for (const ref of prompt.fileRefs) {
      const wirePath = `${ACP_CANVAS_VFS_PREFIX}${ref.path}`;
      lines.push(
        ref.reason ? `- \`${wirePath}\` — ${ref.reason}` : `- \`${wirePath}\``,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Fallback used when the preprocessor throws: just hand the raw user
 * text straight through. Kept here so the route layer doesn't have to
 * know about the prompt shape.
 */
export function serializeRawPrompt(rawText: string): string {
  return rawText;
}

// ─── Internals ────────────────────────────────────────────────────────────

/** Flatten the wire selection (frame children included) into AgentNodeRefs. */
function flattenSelection(nodes: WireSelectionNode[]): AgentNodeRef[] {
  const refs: AgentNodeRef[] = [];
  const walk = (list: WireSelectionNode[]) => {
    for (const n of list) {
      refs.push(buildAgentNodeRef({ id: n.id, type: n.type, label: n.label }));
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return refs;
}

/**
 * Pull a short tail of user/assistant turns into a compact form for
 * the preprocessor LLM. Strips system preambles / metadata tags so
 * the payload stays small and on-topic.
 */
function extractRecentTurns(
  messages: Context['messages'],
  maxTurns: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let i = messages.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = stringifyMessageContent(msg.content);
    if (!text) continue;
    const cleaned = stripSystemMarkers(text).trim();
    if (!cleaned) continue;
    out.push({ role: msg.role, text: truncate(cleaned, 800) });
  }
  return out.reverse();
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          !!b &&
          typeof b === 'object' &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Strip Huabu's internal `[SYSTEM ...]` metadata tags + the
 * `[SYSTEM Error]` / `[SYSTEM Interrupted]` / `[SYSTEM PreparedPrompt]`
 * markers we encode into user messages. Mirrors the cleanup in
 * `buildHistoryItems` so the preprocessor sees the same content the
 * human did.
 */
function stripSystemMarkers(text: string): string {
  // Drop whole-message markers — these are status / sidecar rows that
  // were never spoken by the user.
  if (
    text.startsWith('[SYSTEM Error]') ||
    text.startsWith('[SYSTEM Interrupted]') ||
    text.startsWith('[SYSTEM PreparedPrompt]')
  ) {
    return '';
  }
  return text
    .replace(/\n?\[SYSTEM selectedNodeIds:\[.*?\]\]/g, '')
    .replace(/\n?\[SYSTEM attachments:\[.*\]\]/g, '')
    .replace(/^\[Canvas ID: [^\]]+\]\n\n/, '');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Parse the LLM's JSON output into an ExternalAgentPrompt, clipping
 * malformed entries. Returns `null` if the JSON itself is unusable.
 * `selectedRefs` is used to validate `fileRefs[].path` against the
 * known canvas surface (selected node filenames + a small allowlist).
 */
function parsePromptJson(
  raw: string,
  selectedRefs: AgentNodeRef[],
): ExternalAgentPrompt | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  if (!task) return null;

  const knownPaths = new Set<string>(selectedRefs.map((r) => r.filename));

  const rawRefs = Array.isArray(obj.fileRefs) ? obj.fileRefs : [];
  const fileRefs: ExternalAgentPrompt['fileRefs'] = [];
  for (const r of rawRefs) {
    if (!r || typeof r !== 'object') continue;
    const ref = r as Record<string, unknown>;
    const path = typeof ref.path === 'string' ? ref.path.trim() : '';
    if (!path) continue;
    // Allowlist mirrors the runtime fs/read_text_file handler
    // (`capabilities/fs.ts:isAllowedRead`): only canvas nodes and
    // artifact files. canvas.json is intentionally excluded — the
    // canvas structure is summarised in `task`, not re-read by the
    // agent.
    const allowed =
      knownPaths.has(path) ||
      path.startsWith('nodes/') ||
      path.startsWith('.artifacts/');
    if (!allowed) continue;
    const entry: ExternalAgentPrompt['fileRefs'][number] = { path };
    if (typeof ref.reason === 'string' && ref.reason.trim()) {
      entry.reason = truncate(ref.reason.trim(), 80);
    }
    fileRefs.push(entry);
    if (fileRefs.length >= 8) break;
  }

  return { task, fileRefs };
}
