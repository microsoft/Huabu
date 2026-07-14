#!/usr/bin/env node
/**
 * deepv.mjs — minimal DeepV slide-generation driver.
 *
 * Drives the DeepV backend end-to-end from a single natural-language intent and
 * harvests the results (outline, per-page PNG slides, final .pptx) into an
 * output directory. Designed to be called by the deepv-slides-maker agent team,
 * which then writes the harvested materials back onto the Huabu Space.
 *
 * Usage:
 *   node deepv.mjs "<intent>" [outputDir] [options]
 *
 * Arguments:
 *   <intent>       Natural-language description of the deck to make (required).
 *   [outputDir]    Where to write results. Default: ./deepv-out
 *
 * Options:
 *   --endpoint <url>   DeepV base URL. Default: $DEEPV_SERVER_ENDPOINT
 *   --api-key <key>    DeepV account token. Default: $DEEPV_SERVER_API_KEY
 *   --mode <mode>      permission_mode: full_auto | generation | all. Default: full_auto
 *   --template <id>    Design template id to use. Default: skip (no template)
 *   --no-web-search    Disable DeepV's web search for this run.
 *   --timeout <sec>    Overall wall-clock budget in seconds. Default: 900
 *   -h, --help         Show this help.
 *
 * Output:
 *   Progress/log lines go to stderr. The final line on stdout is a JSON summary:
 *   {
 *     "sessionId", "taskId", "outputDir",
 *     "outline": "<path to outline.md>|null",
 *     "slides": ["<path>", ...],
 *     "pptx": "<path>|null"
 *   }
 *
 * Requires Node >= 18 (global fetch + web streams).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Logging (stderr only; stdout is reserved for the final JSON summary)
// ---------------------------------------------------------------------------
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = (msg, code = 1) => {
  log('✖ ' + msg);
  process.exit(code);
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    mode: 'full_auto',
    template: null, // null => skip template
    webSearch: true,
    timeout: 900,
    endpoint: process.env.DEEPV_SERVER_ENDPOINT,
    apiKey: process.env.DEEPV_SERVER_API_KEY,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        printHelpAndExit();
        break;
      case '--endpoint':
        opts.endpoint = argv[++i];
        break;
      case '--api-key':
        opts.apiKey = argv[++i];
        break;
      case '--mode':
        opts.mode = argv[++i];
        break;
      case '--template':
        opts.template = argv[++i];
        break;
      case '--no-web-search':
        opts.webSearch = false;
        break;
      case '--timeout':
        opts.timeout = Number(argv[++i]);
        break;
      default:
        if (arg.startsWith('--')) die(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  opts.intent = positional[0];
  opts.outputDir = positional[1] || './deepv-out';
  return opts;
}

function printHelpAndExit() {
  // Print the top doc comment's usage section.
  log(
    [
      'Usage: node deepv.mjs "<intent>" [outputDir] [options]',
      '',
      'Options:',
      '  --endpoint <url>    DeepV base URL (default: $DEEPV_SERVER_ENDPOINT)',
      '  --api-key <key>     DeepV account token (default: $DEEPV_SERVER_API_KEY)',
      '  --mode <mode>       full_auto | generation | all (default: full_auto)',
      '  --template <id>     Design template id (default: skip)',
      '  --no-web-search     Disable web search for this run',
      '  --timeout <sec>     Overall budget in seconds (default: 900)',
      '  -h, --help          Show this help',
    ].join('\n'),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
class Deepv {
  constructor({ endpoint, apiKey }) {
    this.base = endpoint.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async req(method, pathname, body) {
    const res = await fetch(this.base + pathname, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(
        `${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`,
      );
      err.status = res.status;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  createSession() {
    return this.req('POST', '/api/sessions', {});
  }

  patchSession(id, patch) {
    return this.req('PATCH', `/api/sessions/${id}`, patch);
  }

  sendMessage(id, content, extra = {}) {
    return this.req('POST', `/api/sessions/${id}/messages`, {
      content,
      ...extra,
    });
  }

  getSession(id) {
    return this.req('GET', `/api/sessions/${id}`);
  }

  getTask(id) {
    return this.req('GET', `/api/tasks/${id}`);
  }

  getResources(id) {
    return this.req('GET', `/api/sessions/${id}/resources`);
  }

  /** Download a DeepV path (relative like "/api/...") to a local file. */
  async download(pathname, destFile) {
    const url = pathname.startsWith('http') ? pathname : this.base + pathname;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destFile));
    return destFile;
  }
}

// ---------------------------------------------------------------------------
// Gate resolution
//
// DeepV opens blocking "gates" that must be answered before the agent turn can
// finish. In full_auto only the template-selection gate blocks in practice, but
// we auto-approve every known confirm_* gate so higher permission modes also
// flow through. Question gates cannot be answered mechanically — we surface them
// and stop rather than guess.
// ---------------------------------------------------------------------------
async function resolveGate(dv, sessionId, gate) {
  const { id, kind } = gate;
  const post = (suffix, payload) =>
    dv.req('POST', `/api/sessions/${sessionId}/${suffix}`, payload);
  try {
    switch (kind) {
      case 'confirm_template_selection':
        // Empty body / null template_id = skip and use no template.
        await post('confirm-template-selection', {
          template_id: OPTS.template,
        });
        break;
      case 'confirm_spec_update':
        await post('confirm-spec-update', { confirmed: true });
        break;
      case 'confirm_generation':
        await post('confirm-generation', { confirmed: true });
        break;
      case 'confirm_batch_edit':
        await post('confirm-batch-edit', { confirmed: true });
        break;
      default:
        die(
          `Encountered a gate that cannot be auto-resolved: kind="${kind}" id="${id}". ` +
            `Re-run in full_auto mode or answer it interactively.`,
        );
    }
    log(`  ↳ resolved gate ${kind} (${id})`);
  } catch (e) {
    // 409 = gate already invalidated/decided; safe to ignore and continue.
    if (e.status === 409) {
      log(`  ↳ gate ${kind} already invalidated, ignoring`);
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// SSE consumption
//
// Reads /stream, dispatching events as they arrive. Resolves gates inline,
// captures the generation task id, and resolves once the turn emits `done`.
// ---------------------------------------------------------------------------
async function runTurn(dv, sessionId, deadline) {
  const res = await fetch(`${dv.base}/api/sessions/${sessionId}/stream`, {
    headers: {
      Authorization: `Bearer ${dv.apiKey}`,
      Accept: 'text/event-stream',
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream → ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let taskId = null;
  let done = false;

  const handleEvent = async (event, dataRaw) => {
    let data = null;
    try {
      data = dataRaw ? JSON.parse(dataRaw) : null;
    } catch {
      data = null;
    }
    switch (event) {
      case 'gate_opened':
        if (data) {
          log(`• gate opened: ${data.kind}`);
          await resolveGate(dv, sessionId, data);
        }
        break;
      case 'task_started':
        if (data?.task_id) {
          taskId = data.task_id;
          log(`• generation task started: ${taskId}`);
        }
        break;
      case 'phase_pill':
        if (data?.title) log(`• phase: ${data.title}`);
        break;
      case 'done':
        done = true;
        break;
    }
  };

  try {
    while (!done) {
      if (Date.now() > deadline) throw new Error('timeout while running turn');
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:'))
            dataLines.push(line.slice(5).trim());
          // ":" comment lines (keepalive) are ignored.
        }
        await handleEvent(event, dataLines.join('\n'));
        if (done) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // Fallback: if the task id didn't appear on the stream, read it off the session.
  if (!taskId) {
    const session = await dv.getSession(sessionId).catch(() => null);
    const ids = session?.task_ids || [];
    if (ids.length) taskId = ids[ids.length - 1];
  }
  return taskId;
}

// ---------------------------------------------------------------------------
// Task polling
// ---------------------------------------------------------------------------
async function waitForTask(dv, taskId, deadline) {
  let last = '';
  while (true) {
    if (Date.now() > deadline)
      throw new Error('timeout while generating slides');
    const task = await dv.getTask(taskId);
    const status = task.status;
    const prog = task.progress || {};
    const line = `${status} ${prog.current_slide ?? '?'}/${prog.total_slides ?? '?'}`;
    if (line !== last) {
      log(`• generating: ${line}`);
      last = line;
    }
    if (status === 'completed' && task.has_result) return task;
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(
        `generation task ${status}: ${task.error || 'unknown error'}`,
      );
    }
    await sleep(4000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Harvest: pull outline, slides, and pptx out of the resources panel.
// ---------------------------------------------------------------------------
async function harvest(dv, sessionId, outputDir) {
  const resources = await dv.getResources(sessionId);
  const groups = resources.groups || [];
  const byKey = (k) => groups.find((g) => g.group_key === k);

  const result = { outline: null, slides: [], pptx: null };

  // Outline → outline.md (one section per page). Each item's content is already
  // self-contained markdown (its own "## Title" heading + body), so use it
  // verbatim and only fall back to the item name when content is missing.
  const outlineGroup = byKey('resource.outline');
  if (outlineGroup?.items?.length) {
    const md = outlineGroup.items
      .map((it, i) => {
        const body = (it.content || '').trim();
        return body || `## ${it.name || `Slide ${i + 1}`}`;
      })
      .join('\n\n');
    const outlinePath = path.join(outputDir, 'outline.md');
    await writeFile(outlinePath, `# Outline\n\n${md}\n`, 'utf8');
    result.outline = outlinePath;
    log(`✓ outline → ${outlinePath}`);
  }

  // Slides → slide_N.png
  const slidesGroup = byKey('resource.slides');
  if (slidesGroup?.items?.length) {
    for (const it of slidesGroup.items) {
      if (!it.url) continue;
      const base = path.basename(it.url.split('?')[0]); // strip cache-buster
      const dest = path.join(outputDir, base);
      await dv.download(it.url, dest);
      result.slides.push(dest);
    }
    log(`✓ ${result.slides.length} slide(s) → ${outputDir}`);
  }

  // Final .pptx
  const finalGroup = byKey('resource.final');
  const pptxItem = finalGroup?.items?.find((it) => it.url);
  if (pptxItem) {
    const dest = path.join(outputDir, 'deck.pptx');
    await dv.download(pptxItem.url, dest);
    result.pptx = dest;
    log(`✓ pptx → ${dest}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let OPTS; // referenced by resolveGate for the template choice

async function main() {
  OPTS = parseArgs(process.argv.slice(2));

  if (!OPTS.intent)
    die('Missing <intent>. Try: node deepv.mjs "Make a 5-slide deck about X"');
  if (!OPTS.endpoint)
    die('Missing DeepV endpoint (set DEEPV_SERVER_ENDPOINT or --endpoint).');
  if (!OPTS.apiKey)
    die('Missing DeepV API key (set DEEPV_SERVER_API_KEY or --api-key).');

  const deadline = Date.now() + OPTS.timeout * 1000;
  const outputDir = path.resolve(OPTS.outputDir);
  await mkdir(outputDir, { recursive: true });

  const dv = new Deepv(OPTS);

  log(`• DeepV endpoint: ${dv.base}`);
  const session = await dv.createSession();
  const sessionId = session.id;
  log(`• session created: ${sessionId}`);

  await dv.patchSession(sessionId, {
    permission_mode: OPTS.mode,
    web_search_enabled: OPTS.webSearch,
  });

  log(`• sending intent (mode=${OPTS.mode}, web_search=${OPTS.webSearch})`);
  await dv.sendMessage(sessionId, OPTS.intent, {
    permission_mode: OPTS.mode,
    web_search: OPTS.webSearch,
  });

  const taskId = await runTurn(dv, sessionId, deadline);
  if (!taskId) {
    die(
      'DeepV finished the turn without starting a generation task. ' +
        'The intent may need clarification, or a non-auto gate blocked it.',
    );
  }

  await waitForTask(dv, taskId, deadline);
  const harvested = await harvest(dv, sessionId, outputDir);

  const summary = {
    sessionId,
    taskId,
    outputDir,
    outline: harvested.outline,
    slides: harvested.slides,
    pptx: harvested.pptx,
  };
  // Machine-readable summary on stdout (final line).
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((e) => die(e.stack || e.message));
