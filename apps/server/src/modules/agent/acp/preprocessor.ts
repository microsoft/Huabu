/**
 * ACP Preprocessor — intent translator.
 *
 * The external agent (Claude Code, Copilot CLI, …) **never sees the
 * canvas**. This module reads the user's raw message plus the bodies
 * of any selected canvas nodes (≤ {@link INLINE_BODY_THRESHOLD_BYTES})
 * and emits an {@link ExternalAgentPrompt}: a self-contained `task`
 * briefing the agent can act on with no other context, plus a small
 * `attachments` list reserved for cases where verbatim file access
 * is essential.
 *
 * Why translate intent instead of routing files:
 *   - Most turns don't need raw canvas data — the user's *intent*
 *     does. Synthesising into `task` keeps the agent's context tiny
 *     and avoids leaking canvas metadata it can't act on.
 *   - Verbatim reading is a fallback (e.g. "review this code",
 *     binary artifacts, oversize nodes). The preprocessor decides
 *     when to attach.
 *   - Attachments render as absolute disk paths so OS-native `Read`
 *     tools (Copilot CLI) and ACP-fs-bridging agents (Claude Code)
 *     both reach the file. See {@link serializePrompt} for the
 *     wire-format trade-off.
 *
 * Failure model: callers `try`/`catch` and fall back to the raw user
 * text. The route-level service emits a `prepared_prompt` SSE event
 * with `prompt: null` + an `error` description so the UI can replace
 * its "Preparing…" placeholder with a visible failure note.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

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

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Maximum on-disk size of a selected node whose body we inline into
 * the preprocessor LLM payload. Larger nodes are surfaced as
 * metadata + size only — the preprocessor will then almost certainly
 * route them through `attachments` since it has no body to synthesise
 * from.
 *
 * 16 KB is a deliberate compromise: comfortably fits typical research
 * notes (a few pages of markdown) while keeping the preprocessor's
 * input bounded even if the user selects many nodes at once.
 */
export const INLINE_BODY_THRESHOLD_BYTES = 16 * 1024;

/**
 * Pattern for the slash-command short-circuit (see
 * {@link prepareExternalAgentPrompt}). Matches `/<name>` followed by
 * whitespace OR end of string. The leading character class is ASCII
 * letters only so URLs / Windows paths pasted mid-thought don't trip
 * it. Exported for tests.
 */
export const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w-]*(?:\s|$)/;

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
const PREPROCESSOR_SYSTEM_PROMPT = `You are the **intent translator** inside Sediment, a visual research canvas.

The user is chatting with an **external** coding/research agent (Claude Code, Copilot CLI, Gemini CLI, …). That agent runs on the user's own machine and **never sees the canvas directly**. Your job is to translate the user's intent — together with whatever canvas nodes they attached — into a self-contained briefing the agent can act on with no other context.

## Inputs you receive

- **rawMessage**: the user's literal chat input.
- **agentAlias**: short name of the bound external agent.
- **selectedNodes**: zero or more canvas nodes the user explicitly attached to this turn. Each node has \`{ id, type, label?, filename }\`. Nodes ≤ 16 KB also include a \`body\` field (full markdown content) — use it to synthesise inline. Larger nodes include \`sizeBytes\` instead, signalling they exist but cannot fit inline.
- **recentTurns**: brief excerpt of the recent dialog between user and external agent. Use only for context — do **not** re-issue earlier asks.

## Your output

Return **only** a JSON object (no markdown fences, no commentary) with this exact shape:

\`\`\`
{
  "task": "<self-contained briefing the external agent can act on>",
  "attachments": [
    { "path": "nodes/<file>.md", "reason": "<≤80 chars why verbatim>" }
  ]
}
\`\`\`

## Translation rules

**Default to SYNTHESIS.** The external agent should not need to read any files. Quote, paraphrase, and embed selected-node \`body\` content directly inside \`task\` whenever feasible. Speak in the user's voice; do not invent requirements they did not state.

**Use \`attachments\` only as a fallback** when verbatim file access is essential:

  1. **Verbatim required** — the user asks for byte-exact analysis (e.g. "review this code", "find the bug in this YAML", "reformat this snippet"). Inlining would risk paraphrase drift.
  2. **Node too large** — \`selectedNodes[i].body\` is absent because the file exceeds the inline threshold; surface it as an attachment.
  3. **Artifact files** — paths under \`.artifacts/\` (generated or binary content) are always attachments.

**Attachment rules**

  - \`path\` must come from \`selectedNodes[].filename\` or start with \`.artifacts/\`. Never invent paths. Never list \`canvas.json\`.
  - \`reason\` is **required**: short, concrete, explains why verbatim is needed (e.g. "user asks to refactor this code", "100 KB file, too large to inline", "binary artifact").
  - Cap at 8 entries — most turns should have **zero**.

**Task rules**

  - Use second person ("you") to address the external agent.
  - Stand-alone: an agent reading only \`task\` (plus any attachments) must know what to do — no canvas metadata, no node ids, no app jargon.
  - If the user pasted code/config/markdown directly in \`rawMessage\`, paraphrase the intent and quote the snippet inline (don't try to externalise it).
  - For general questions unrelated to selected nodes, just answer the literal request and leave \`attachments: []\`.
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
   * Absolute on-disk path of the canvas directory. When supplied,
   * the preprocessor:
   *   - reads selected-node bodies (≤ {@link INLINE_BODY_THRESHOLD_BYTES})
   *     from `<canvasRoot>/<filename>` so the LLM can synthesise them
   *     inline into `task`;
   *   - {@link serializePrompt} renders `attachments[].path` as **real
   *     absolute on-disk paths** under this root so OS-native `Read`
   *     tools (Copilot CLI) and ACP-fs-bridging agents (Claude Code)
   *     both reach the file.
   *
   * When omitted (no-canvas edge case): bodies are never loaded and
   * `serializePrompt` falls back to the `/canvas/<rel>` virtual
   * prefix. In practice service.ts always supplies `canvasRoot`.
   */
  canvasRoot?: string;
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
  const { rawText, agentAlias, canvasContext, canvasRoot, history, logger } =
    input;

  // ── Slash-command short-circuit ────────────────────────────────────
  //
  // ACP agents recognise slash commands (`/<name> <args>`) natively
  // inside `session/prompt` text. The intent-translator LLM rewrites
  // would corrupt that wire format — e.g. wrap `/compact` in prose,
  // strip the leading `/`, or attach noise. When the raw user input
  // starts with a slash command we forward it verbatim and skip the
  // LLM round-trip entirely. Cheaper AND correct.
  //
  // Match rule: starts with `/`, followed by an ASCII letter and zero
  // or more word/dash chars, then whitespace OR end of input. Avoids
  // false positives for forward-slashes inside URLs / paths the user
  // might paste mid-sentence.
  if (SLASH_COMMAND_RE.test(rawText.trim())) {
    const trimmed = rawText.trim();
    logger.debug(
      { agentAlias, command: trimmed.split(/\s+/)[0] },
      '[acp/preprocessor] slash command detected — forwarding verbatim',
    );
    return {
      // Surface as a minimal ExternalAgentPrompt so the UI's
      // PreparedPromptCard still has something to render. No
      // attachments by design — slash commands speak for themselves.
      prompt: { task: trimmed, attachments: [] },
      serialized: trimmed,
    };
  }

  const selectedRefs = canvasContext?.selectedNodes
    ? flattenSelection(canvasContext.selectedNodes)
    : [];

  // Load each selected node's body up to the inline threshold so the
  // LLM can synthesise it directly into `task`. Larger nodes surface
  // as metadata-only entries; the LLM is instructed to attach those.
  const selectedWithBody = selectedRefs.map((ref) =>
    loadNodeBody(ref, canvasRoot),
  );

  const userPayload = {
    rawMessage: rawText,
    agentAlias,
    selectedNodes: selectedWithBody.map((ref) => ({
      id: ref.id,
      type: ref.type,
      ...(ref.label ? { label: ref.label } : {}),
      filename: ref.filename,
      ...(ref.body !== null ? { body: ref.body } : {}),
      ...(ref.body === null && ref.sizeBytes !== null
        ? { sizeBytes: ref.sizeBytes }
        : {}),
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
      attachmentsCount: prompt.attachments.length,
    },
    '[acp/preprocessor] prepared prompt',
  );

  return {
    prompt,
    serialized: serializePrompt(prompt, { canvasRoot }),
  };
}

/**
 * Convert an {@link ExternalAgentPrompt} into the plain-text payload
 * sent over ACP `session/prompt`. Format is deliberately simple
 * markdown so any agent's text rendering picks it up cleanly.
 *
 * Most turns should produce **just `task`** — the intent-translator
 * design synthesises selected-node content inline. The optional
 * `## Attachments` section is rendered only when the preprocessor
 * decided verbatim access is essential (large nodes, code-review
 * asks, `.artifacts/` files).
 *
 * Path rendering is **gated by `canvasRoot`** because not every agent
 * honours ACP's `fs/read_text_file` capability:
 *
 *   - **With `canvasRoot`** (normal case): each `attachments[].path`
 *     is joined onto `canvasRoot` to produce a real absolute on-disk
 *     path (e.g. `/home/me/sediment-data/huabu/<dir>/nodes/foo.md`).
 *     Empirically Copilot CLI's `Read` tool **never** calls
 *     `fs/read_text_file` — it always uses the OS directly (and asks
 *     `session/request_permission` for paths outside its trusted
 *     dirs). Feeding it absolute paths is the only way it can reach
 *     canvas content. Spec-compliant agents (Claude Code) read those
 *     same absolute paths fine via either channel.
 *
 *   - **Without `canvasRoot`** (no-canvas edge case): paths are
 *     rendered under the virtual prefix `/canvas/<rel>` so agents
 *     that DO route Read through ACP fs hit the `fs/read_text_file`
 *     handler in `acp/capabilities/fs.ts`. Reserved for threads
 *     without a bound canvas; in practice service.ts always supplies
 *     `canvasRoot`.
 *
 * Trade-off: the absolute-path mode effectively re-extends the
 * agent's OS reach into the canvas dir, so the `/canvas/` VFS
 * sandbox is **bypassed** by native-fs agents — they read canvas
 * files directly via syscall and the allowlist in
 * `acp/capabilities/fs.ts` never gets a chance to refuse. Real
 * isolation against an adversarial agent would require OS-level
 * sandboxing (FUSE / containers); ACP fs capabilities alone are a
 * cooperative protocol.
 *
 * Either way `attachments[].path` itself stays canvas-relative so
 * storage / UI / future internal consumers stay free of wire concerns.
 */
export function serializePrompt(
  prompt: ExternalAgentPrompt,
  opts: { canvasRoot?: string } = {},
): string {
  const lines: string[] = [prompt.task.trim()];
  if (prompt.attachments.length > 0) {
    lines.push('', '## Attachments', '');
    lines.push(
      'Read each file below before answering — they were attached because verbatim content is required:',
      '',
    );
    for (const ref of prompt.attachments) {
      const wirePath = opts.canvasRoot
        ? path.join(opts.canvasRoot, ref.path)
        : `${ACP_CANVAS_VFS_PREFIX}${ref.path}`;
      lines.push(`- \`${wirePath}\` — ${ref.reason}`);
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
 * `selectedRefs` is used to validate `attachments[].path` against the
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

  const rawRefs = Array.isArray(obj.attachments) ? obj.attachments : [];
  const attachments: ExternalAgentPrompt['attachments'] = [];
  for (const r of rawRefs) {
    if (!r || typeof r !== 'object') continue;
    const ref = r as Record<string, unknown>;
    const refPath = typeof ref.path === 'string' ? ref.path.trim() : '';
    if (!refPath) continue;
    // Allowlist mirrors the runtime fs/read_text_file handler
    // (`capabilities/fs.ts:isAllowedRead`): only canvas nodes and
    // artifact files. canvas.json is intentionally excluded — the
    // canvas structure was already synthesised into `task`.
    const allowed =
      knownPaths.has(refPath) ||
      refPath.startsWith('nodes/') ||
      refPath.startsWith('.artifacts/');
    if (!allowed) continue;
    const rawReason = typeof ref.reason === 'string' ? ref.reason.trim() : '';
    attachments.push({
      path: refPath,
      reason: rawReason ? truncate(rawReason, 80) : 'verbatim content required',
    });
    if (attachments.length >= 8) break;
  }

  return { task, attachments };
}

// ─── Node-body loader ─────────────────────────────────────────────────────

/**
 * Result of trying to load a selected node's body for the
 * preprocessor LLM. Exactly one of `body` / `sizeBytes` is set:
 *   - `body` non-null → file was small enough to inline.
 *   - `sizeBytes` non-null → file exists but exceeds the threshold;
 *     the LLM is expected to surface it as an attachment.
 *   - both null → file missing / unreadable / canvasRoot absent;
 *     the LLM only sees metadata and will likely skip it.
 */
interface SelectedNodeWithBody extends AgentNodeRef {
  body: string | null;
  sizeBytes: number | null;
}

function loadNodeBody(
  ref: AgentNodeRef,
  canvasRoot: string | undefined,
): SelectedNodeWithBody {
  if (!canvasRoot) {
    return { ...ref, body: null, sizeBytes: null };
  }
  const abs = path.join(canvasRoot, ref.filename);
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) {
      return { ...ref, body: null, sizeBytes: null };
    }
    if (stat.size <= INLINE_BODY_THRESHOLD_BYTES) {
      return {
        ...ref,
        body: readFileSync(abs, 'utf8'),
        sizeBytes: stat.size,
      };
    }
    // Oversize: surface size only; the LLM will attach it verbatim.
    return { ...ref, body: null, sizeBytes: stat.size };
  } catch {
    // Missing / unreadable: leave body null — the LLM only sees
    // metadata and will likely skip the node.
    return { ...ref, body: null, sizeBytes: null };
  }
}
