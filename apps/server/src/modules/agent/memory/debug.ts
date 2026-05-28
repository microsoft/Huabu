/**
 * Memory module debug surface — ONE file, removable in a single git rm.
 *
 * This is dev-only diagnostics. Nothing else in the memory module
 * imports from here; this module imports from the memory module only
 * via its public surface (`./index.js`) plus a handful of read-only
 * `storage/paths.js` helpers. To kill the debug panel:
 *
 *   1. Delete this file (`git rm apps/server/src/modules/agent/memory/debug.ts`)
 *   2. Remove the four `memoryDebug.record*` calls in
 *      `apps/server/src/modules/agent/memory/worker.ts`
 *      (each tagged with a `// [debug-tap]` comment).
 *   3. Remove the `memoryDebugRoutes` registration in
 *      `apps/server/src/app.ts` (one line, also tagged).
 *
 * That's the entire surface — no DB rows, no shared state outside this
 * file, no front-end changes (the panel is served as a self-contained
 * HTML page from the same router).
 *
 * Endpoints (all under `/api/memory-debug`):
 *
 *   GET /                     → the HTML UI
 *   GET /snapshot             → JSON: list of canvases + workspace files
 *   GET /snapshot/:canvasId   → JSON: per-canvas memory state + recent events
 *                                + on-disk content of every memory file
 *
 * The recorder uses a fixed-size ring buffer (per canvas) so the
 * memory footprint is bounded regardless of activity. No persistence
 * — events vanish on process restart; persisted state already lives
 * on disk so the panel re-hydrates correctly.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  canvasJsonPath,
  longTermMemoryPath,
  memoryStatePath,
  userSkillsDir,
  workingMemoryPath,
} from '../../storage/paths.js';
import { getWorkspacePath } from '../../workspace.js';

import { OP_THRESHOLD, readMemoryState } from './index.js';

import type { WriteResult } from './writers.js';
import type { FastifyPluginAsync } from 'fastify';

// ─── Ring buffer ───────────────────────────────────────────────────────────

const MAX_EVENTS_PER_CANVAS = 50;

export type MemoryDebugEvent =
  | { type: 'enqueue'; ts: number }
  | { type: 'pass_start'; ts: number; bundle: string }
  | { type: 'write_result'; ts: number; result: WriteResult }
  | {
      type: 'pass_end';
      ts: number;
      ok: number;
      rejected: number;
      latestChatTs: number | null;
    }
  | { type: 'error'; ts: number; message: string };

const buffers = new Map<string, MemoryDebugEvent[]>();

function push(canvasId: string, event: MemoryDebugEvent): void {
  let buf = buffers.get(canvasId);
  if (!buf) {
    buf = [];
    buffers.set(canvasId, buf);
  }
  buf.push(event);
  if (buf.length > MAX_EVENTS_PER_CANVAS) {
    buf.splice(0, buf.length - MAX_EVENTS_PER_CANVAS);
  }
}

// ─── Recorder API used by the memory worker ────────────────────────────────
//
// These four functions are the only outside-facing surface. They are
// designed to be safe to call from a worker tick: no throws, no
// awaits, no IO. The worker imports `memoryDebug` and calls them
// from its existing tap points. Removing the debug module means
// deleting these four call sites — see the file-level header.

export const memoryDebug = {
  recordEnqueue(canvasId: string): void {
    push(canvasId, { type: 'enqueue', ts: Date.now() });
  },
  recordPassStart(canvasId: string, bundleSummary: string): void {
    push(canvasId, {
      type: 'pass_start',
      ts: Date.now(),
      bundle: bundleSummary,
    });
  },
  recordWriteResult(canvasId: string, result: WriteResult): void {
    push(canvasId, { type: 'write_result', ts: Date.now(), result });
  },
  recordPassEnd(
    canvasId: string,
    summary: {
      ok: number;
      rejected: number;
      latestChatTs: number | null;
    },
  ): void {
    push(canvasId, { type: 'pass_end', ts: Date.now(), ...summary });
  },
  recordError(canvasId: string, err: unknown): void {
    push(canvasId, {
      type: 'error',
      ts: Date.now(),
      message: err instanceof Error ? err.message : String(err),
    });
  },
};

// ─── Snapshot builder ──────────────────────────────────────────────────────

interface MemorySnapshot {
  /** Op-count threshold the worker is currently configured for. */
  threshold: number;
  canvases: Array<{ id: string; title: string | null }>;
  workspace: {
    longterm: FilePeek;
    userSkills: Array<{ id: string; file: FilePeek }>;
  };
  selected?: {
    canvasId: string;
    title: string | null;
    state: ReturnType<typeof readMemoryState> | null;
    working: FilePeek;
    events: MemoryDebugEvent[];
  };
}

interface FilePeek {
  path: string;
  exists: boolean;
  /** Truncated content (max 16 KB) so the panel stays responsive. */
  content: string | null;
  bytes: number | null;
  mtime: number | null;
}

const PEEK_MAX_BYTES = 16 * 1024;

function peek(file: string): FilePeek {
  if (!existsSync(file)) {
    return {
      path: file,
      exists: false,
      content: null,
      bytes: null,
      mtime: null,
    };
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return {
      path: file,
      exists: false,
      content: null,
      bytes: null,
      mtime: null,
    };
  }
  let content: string | null = null;
  try {
    const buf = readFileSync(file);
    content = buf
      .subarray(0, Math.min(buf.length, PEEK_MAX_BYTES))
      .toString('utf8');
    if (buf.length > PEEK_MAX_BYTES) {
      content += `\n\n…(truncated, ${buf.length - PEEK_MAX_BYTES} bytes more)`;
    }
  } catch {
    /* leave content null */
  }
  return {
    path: file,
    exists: true,
    content,
    bytes: stat.size,
    mtime: stat.mtimeMs,
  };
}

function listCanvasesFromDisk(): Array<{ id: string; title: string | null }> {
  let ws: string;
  try {
    ws = getWorkspacePath();
  } catch {
    return [];
  }
  if (!existsSync(ws)) return [];
  const out: Array<{ id: string; title: string | null }> = [];
  for (const entry of readdirSync(ws, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'setting') continue;
    const cj = path.join(ws, entry.name, 'canvas.json');
    if (!existsSync(cj)) continue;
    try {
      const raw = JSON.parse(readFileSync(cj, 'utf8')) as {
        canvasId?: string;
        title?: string | null;
      };
      if (raw.canvasId)
        out.push({ id: raw.canvasId, title: raw.title ?? null });
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
  return out;
}

function listUserSkills(): Array<{ id: string; file: FilePeek }> {
  let root: string;
  try {
    root = userSkillsDir();
  } catch {
    return [];
  }
  if (!existsSync(root)) return [];
  const out: Array<{ id: string; file: FilePeek }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    out.push({
      id: entry.name,
      file: peek(path.join(root, entry.name, 'SKILL.md')),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function buildSnapshot(canvasId: string | null): MemorySnapshot {
  const canvases = listCanvasesFromDisk();
  let longTermPeek: FilePeek;
  try {
    longTermPeek = peek(longTermMemoryPath());
  } catch {
    longTermPeek = {
      path: '(workspace not configured)',
      exists: false,
      content: null,
      bytes: null,
      mtime: null,
    };
  }
  const snapshot: MemorySnapshot = {
    threshold: OP_THRESHOLD,
    canvases,
    workspace: {
      longterm: longTermPeek,
      userSkills: listUserSkills(),
    },
  };
  if (canvasId) {
    const known = canvases.find((c) => c.id === canvasId);
    if (known) {
      let state: ReturnType<typeof readMemoryState> | null = null;
      try {
        if (existsSync(memoryStatePath(canvasId))) {
          state = readMemoryState(canvasId);
        }
      } catch {
        /* state file unreadable — leave null */
      }
      // Touch canvas.json so we can show its modification time as a
      // rough liveness indicator alongside the memory artefacts.
      void canvasJsonPath(canvasId);
      snapshot.selected = {
        canvasId,
        title: known.title,
        state,
        working: peek(workingMemoryPath(canvasId)),
        events: [...(buffers.get(canvasId) ?? [])].reverse(),
      };
    }
  }
  return snapshot;
}

// ─── Routes ────────────────────────────────────────────────────────────────

export const memoryDebugRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_request, reply) => {
    // `reply.type(...)` is the supported way to set Content-Type without
    // confusing @fastify/compress (it short-circuits on empty bodies when
    // the header is set via .header(...), producing a zero-length zstd
    // payload that browsers render as a blank page).
    return reply.type('text/html; charset=utf-8').send(renderDebugHtml());
  });

  fastify.get('/snapshot', async () => buildSnapshot(null));

  fastify.get<{ Params: { canvasId: string } }>(
    '/snapshot/:canvasId',
    async (request) => buildSnapshot(request.params.canvasId),
  );
};

// ─── Embedded HTML UI ──────────────────────────────────────────────────────
//
// Self-contained: no build step, no external assets, no front-end
// component to register. The page polls /snapshot every 2 s and
// re-renders. CSS variables match the design tokens used by the
// product UI so it doesn't look completely alien when you open it.

function renderDebugHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Memory Debug · Sediment</title>
  <style>
    :root {
      color-scheme: light dark;
      --fg: #1f2328;
      --fg-muted: #57606a;
      --bg: #ffffff;
      --surface: #f6f8fa;
      --border: #d0d7de;
      --accent: #0969da;
      --ok: #1a7f37;
      --err: #cf222e;
      --warn: #9a6700;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --fg: #e6edf3;
        --fg-muted: #8b949e;
        --bg: #0d1117;
        --surface: #161b22;
        --border: #30363d;
        --accent: #4493f8;
        --ok: #3fb950;
        --err: #f85149;
        --warn: #d29922;
      }
    }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, sans-serif; }
    body { padding: 16px 24px 40px; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    h2 { font-size: 14px; margin: 16px 0 6px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    h3 { font-size: 13px; margin: 12px 0 4px; }
    .row { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
    .row > * { margin: 0; }
    select { font: inherit; padding: 4px 8px; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
    button { font: inherit; padding: 4px 10px; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
    button:hover { background: var(--border); }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 12px; }
    .pill.ok { color: var(--ok); border-color: var(--ok); }
    .pill.err { color: var(--err); border-color: var(--err); }
    .pill.warn { color: var(--warn); border-color: var(--warn); }
    .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
    .card .label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .card .value { font: 18px var(--mono); margin-top: 4px; }
    .card .sub { font-size: 12px; color: var(--fg-muted); margin-top: 2px; }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 8px; }
    pre.file { font-family: var(--mono); font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 4px 0 0; }
    .empty { color: var(--fg-muted); font-style: italic; }
    table.events { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.events th, table.events td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
    table.events th { color: var(--fg-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    table.events td.ts { font-family: var(--mono); white-space: nowrap; color: var(--fg-muted); }
    table.events td.detail { font-family: var(--mono); word-break: break-word; }
    .muted { color: var(--fg-muted); }
    .filepath { font-family: var(--mono); font-size: 11px; color: var(--fg-muted); word-break: break-all; }
  </style>
</head>
<body>
  <div class="row">
    <h1>Memory Debug</h1>
    <span class="muted" id="updated"></span>
    <span style="flex: 1"></span>
    <label class="row" style="gap:6px">
      <span class="muted">canvas</span>
      <select id="canvas-select"></select>
    </label>
    <label class="row" style="gap:6px">
      <span class="muted">auto-refresh</span>
      <select id="interval-select">
        <option value="2000" selected>2 s</option>
        <option value="5000">5 s</option>
        <option value="0">off</option>
      </select>
    </label>
    <button id="refresh-btn">refresh</button>
  </div>

  <h2>Per-canvas state</h2>
  <div class="cards" id="counter-cards"></div>

  <h2>Recent events <span class="muted" id="event-count"></span></h2>
  <div class="panel" id="events-panel"></div>

  <h2>On-disk memory</h2>
  <div class="panel" id="files-panel"></div>

  <h2>User skills (workspace)</h2>
  <div class="panel" id="skills-panel"></div>

  <script>
    const $ = (id) => document.getElementById(id);
    const fmtTs = (ts) => ts === null || ts === undefined ? '—' : new Date(ts).toLocaleTimeString();
    const fmtBytes = (n) => n === null || n === undefined ? '—' : (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

    let selectedCanvas = localStorage.getItem('memory-debug-canvas') || '';
    let intervalMs = Number(localStorage.getItem('memory-debug-interval') || '2000');
    let timer = null;

    async function fetchSnapshot() {
      const url = selectedCanvas
        ? '/api/memory-debug/snapshot/' + encodeURIComponent(selectedCanvas)
        : '/api/memory-debug/snapshot';
      const res = await fetch(url);
      if (!res.ok) throw new Error('snapshot ' + res.status);
      return res.json();
    }

    function renderCanvasOptions(canvases) {
      const sel = $('canvas-select');
      const current = selectedCanvas;
      sel.innerHTML = '<option value="">— pick a canvas —</option>' +
        canvases.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === current ? ' selected' : '') + '>' + esc(c.title || c.id) + '</option>').join('');
    }

    function renderCounters(snap) {
      const selected = snap.selected;
      const threshold = snap.threshold ?? 50;
      if (!selected) {
        $('counter-cards').innerHTML = '<div class="card"><div class="label">canvas</div><div class="value">—</div><div class="sub">pick a canvas above</div></div>';
        return;
      }
      const s = selected.state || { counter: 0, lastAnalyzedAt: null, lastSeenThreadCursor: null };
      const cards = [
        { label: 'op counter', value: s.counter, sub: 'threshold ' + threshold },
        { label: 'last analysis', value: fmtTs(s.lastAnalyzedAt), sub: s.lastAnalyzedAt ? new Date(s.lastAnalyzedAt).toLocaleString() : 'never' },
        { label: 'cursor (lastSeenThreadCursor)', value: fmtTs(s.lastSeenThreadCursor), sub: 'newer chat turns analyse next' },
        { label: 'recent events', value: selected.events.length, sub: 'rolling buffer' },
      ];
      $('counter-cards').innerHTML = cards.map((c) =>
        '<div class="card"><div class="label">' + esc(c.label) + '</div><div class="value">' + esc(c.value) + '</div><div class="sub">' + esc(c.sub) + '</div></div>'
      ).join('');
    }

    function renderEvents(selected) {
      if (!selected) {
        $('event-count').textContent = '';
        $('events-panel').innerHTML = '<div class="empty">pick a canvas to see events</div>';
        return;
      }
      const evs = selected.events;
      $('event-count').textContent = '(' + evs.length + ', newest first)';
      if (evs.length === 0) {
        $('events-panel').innerHTML = '<div class="empty">no recorded activity — trigger 100 ops to fire a pass</div>';
        return;
      }
      const rows = evs.map((e) => {
        let typePill = '<span class="pill">' + esc(e.type) + '</span>';
        let detail = '';
        if (e.type === 'enqueue') detail = 'op-counter crossed threshold';
        else if (e.type === 'pass_start') detail = 'bundle: ' + esc(e.bundle);
        else if (e.type === 'write_result') {
          const r = e.result;
          typePill = '<span class="pill ' + (r.ok ? 'ok' : 'warn') + '">' + esc(e.type) + '</span>';
          detail = (r.ok ? '✓ ' : '✗ ') + esc(r.reason) + '\\n' + esc(r.target);
        } else if (e.type === 'pass_end') {
          detail = e.ok + ' ok, ' + e.rejected + ' rejected, cursor → ' + (e.latestChatTs === null ? 'unchanged' : new Date(e.latestChatTs).toLocaleTimeString());
        } else if (e.type === 'error') {
          typePill = '<span class="pill err">' + esc(e.type) + '</span>';
          detail = esc(e.message);
        }
        return '<tr><td class="ts">' + fmtTs(e.ts) + '</td><td>' + typePill + '</td><td class="detail">' + detail + '</td></tr>';
      }).join('');
      $('events-panel').innerHTML = '<table class="events"><thead><tr><th>time</th><th>event</th><th>detail</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderFile(label, p) {
      let head = '<div class="row"><h3>' + esc(label) + '</h3>';
      if (!p.exists) {
        head += '<span class="pill warn">missing</span>';
      } else {
        head += '<span class="pill">' + fmtBytes(p.bytes) + '</span>';
        head += '<span class="muted">' + (p.mtime ? new Date(p.mtime).toLocaleString() : '') + '</span>';
      }
      head += '</div><div class="filepath">' + esc(p.path) + '</div>';
      if (!p.exists) return head + '<div class="empty">file does not exist yet</div>';
      const body = (p.content && p.content.trim().length > 0) ? '<pre class="file">' + esc(p.content) + '</pre>' : '<div class="empty">file is empty</div>';
      return head + body;
    }

    function renderFiles(snap) {
      const parts = [];
      parts.push(renderFile('long-term memory (cross-canvas)', snap.workspace.longterm));
      if (snap.selected) {
        parts.push(renderFile('working memory (this canvas)', snap.selected.working));
      } else {
        parts.push('<div class="empty" style="margin-top:8px">working memory only shown when a canvas is picked</div>');
      }
      $('files-panel').innerHTML = parts.join('');
    }

    function renderSkills(snap) {
      const skills = snap.workspace.userSkills;
      if (!skills || skills.length === 0) {
        $('skills-panel').innerHTML = '<div class="empty">no user-side skills yet — the memory curator creates them in &lt;workspace&gt;/setting/skills/</div>';
        return;
      }
      $('skills-panel').innerHTML = skills.map((s) => renderFile(s.id, s.file)).join('');
    }

    async function refresh() {
      const updated = $('updated');
      try {
        const snap = await fetchSnapshot();
        renderCanvasOptions(snap.canvases);
        renderCounters(snap);
        renderEvents(snap.selected);
        renderFiles(snap);
        renderSkills(snap);
        updated.textContent = 'updated ' + new Date().toLocaleTimeString();
      } catch (err) {
        updated.textContent = 'error: ' + err.message;
      }
    }

    function scheduleAutoRefresh() {
      if (timer) clearInterval(timer);
      if (intervalMs > 0) timer = setInterval(refresh, intervalMs);
    }

    $('canvas-select').addEventListener('change', (e) => {
      selectedCanvas = e.target.value;
      localStorage.setItem('memory-debug-canvas', selectedCanvas);
      refresh();
    });
    $('interval-select').addEventListener('change', (e) => {
      intervalMs = Number(e.target.value);
      localStorage.setItem('memory-debug-interval', String(intervalMs));
      scheduleAutoRefresh();
    });
    $('interval-select').value = String(intervalMs);
    $('refresh-btn').addEventListener('click', refresh);

    refresh();
    scheduleAutoRefresh();
  </script>
</body>
</html>`;
}
