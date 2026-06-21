#!/usr/bin/env node

/**
 * Huabu Sideband Tool (HST)
 *
 * Standalone CLI script for external agents to interact with the Huabu
 * canvas through the Agent Sideband channel. Invoked via:
 *
 *   node huabu-sideband-tool.mjs <command> [args...]
 *
 * Environment variables (set by agentlet daemon):
 *   AGENTLET_TOKEN       — Bearer token for Huabu server auth
 *   AGENTLET_SERVER      — Daemon's WS URL (e.g. ws://127.0.0.1:3001/api/acp/agent)
 *                          HST derives HTTP base URL from this automatically.
 *   HUABU_CANVAS_ID      — Canvas ID this session is scoped to
 *   HUABU_SERVER         — (optional override) HTTP base URL; if set, takes priority
 *   AGENTLET_SIDEBAND_DIR — Directory containing this script (informational)
 *
 * Commands:
 *   read-node   [--output-dir <dir>] <node-id>
 *   write-node  --type <type> [options] <content-file>
 *   write-node  --id <node-id> [options] <content-file>
 *   ask-agent   <prompt | @prompt-file>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ── Environment ──────────────────────────────────────────────────────

const TOKEN = process.env.AGENTLET_TOKEN;
const CANVAS_ID = process.env.HUABU_CANVAS_ID;

/**
 * Derive the HTTP base URL from AGENTLET_SERVER (WS URL injected by
 * the daemon), or use HUABU_SERVER as explicit override.
 * e.g., ws://127.0.0.1:3001/api/acp/agent → http://127.0.0.1:3001
 */
function getServerBaseUrl() {
  if (process.env.HUABU_SERVER) return process.env.HUABU_SERVER;
  const wsUrl = process.env.AGENTLET_SERVER;
  if (!wsUrl) {
    process.stderr.write(
      'Error: neither HUABU_SERVER nor AGENTLET_SERVER environment variable is set\n',
    );
    process.exit(1);
  }
  const url = new URL(wsUrl);
  const scheme = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${url.host}`;
}

const SERVER = getServerBaseUrl();

function requireEnv(name, value) {
  if (!value) {
    process.stderr.write(`Error: ${name} environment variable is not set\n`);
    process.exit(1);
  }
  return value;
}

// ── HTTP helpers ─────────────────────────────────────────────────────

async function request(method, urlPath, body) {
  const url = `${SERVER}${urlPath}`;
  const headers = {
    Authorization: `Bearer ${requireEnv('AGENTLET_TOKEN', TOKEN)}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg;
    try {
      const err = await res.json();
      msg = err.message || JSON.stringify(err);
    } catch {
      msg = await res.text();
    }
    process.stderr.write(`Error ${res.status}: ${msg}\n`);
    process.exit(1);
  }
  return res;
}

// ── File extension mapping ───────────────────────────────────────────

const TYPE_TO_EXT = {
  note: '.md',
  text: '.md',
  web: '.html',
  image: '.png',
  pdf: '.pdf',
  video: '.mp4',
  question: '.md',
};

function extForType(nodeType) {
  return TYPE_TO_EXT[nodeType] || '.txt';
}

// ── Argument parser ──────────────────────────────────────────────────

/**
 * Parse CLI arguments into flags and positional args.
 * @param {string[]} args - Raw argument array
 * @param {Object} spec - Flag specifications
 * @param {string[]} spec.valued - Flags that take a value (e.g., '--output-dir')
 * @param {string[]} spec.boolean - Boolean flags (e.g., '--notify')
 * @param {string} spec.help - Help text to print on --help / -h
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
function parseArgs(args, spec = {}) {
  const valued = new Set(spec.valued || []);
  const booleans = new Set(spec.boolean || []);
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      if (spec.help) process.stderr.write(spec.help);
      process.exit(0);
    } else if (valued.has(arg) && i + 1 < args.length) {
      flags[arg] = args[++i];
    } else if (booleans.has(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Error: unknown flag "${arg}"\n`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

// ── Commands ─────────────────────────────────────────────────────────

async function readNode(args) {
  const { flags, positional } = parseArgs(args, {
    valued: ['--output-dir'],
    help: `read-node — Read a canvas node's content to a local file

Usage: node huabu-sideband-tool.mjs read-node [options] <node-id>

Arguments:
  <node-id>              ID of the canvas node to read

Options:
  --output-dir <dir>     Directory to write the file (default: current dir)
  -h, --help             Show this help message

Output:
  stdout: file path of the written file
  stderr: node metadata (type, size)

Example:
  node huabu-sideband-tool.mjs read-node --output-dir ./tmp node-abc123
`,
  });

  if (positional.length !== 1) {
    process.stderr.write('Usage: read-node [--output-dir <dir>] <node-id>\n');
    process.exit(1);
  }

  const outputDir = flags['--output-dir'] || '.';
  const nodeId = positional[0];

  const canvasId = requireEnv('HUABU_CANVAS_ID', CANVAS_ID);
  const res = await request(
    'GET',
    `/api/canvas/${canvasId}/nodes/${nodeId}/content`,
  );
  const data = await res.json();

  if (data.contentMissing) {
    process.stderr.write(`Error: node ${nodeId} has no content\n`);
    process.exit(1);
  }

  const ext = extForType(data.type);
  const filename = `${nodeId}${ext}`;
  const filePath = path.join(outputDir, filename);

  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, data.content || '', 'utf8');

  const size = Buffer.byteLength(data.content || '', 'utf8');
  process.stderr.write(`type=${data.type} size=${size}\n`);
  process.stdout.write(`${filePath}\n`);
}

async function writeNode(args) {
  const { flags, positional } = parseArgs(args, {
    valued: ['--type', '--id', '--link-to', '--link-from'],
    boolean: ['--notify'],
    help: `write-node — Create or update a canvas node

Usage: node huabu-sideband-tool.mjs write-node [options] <content-file>

Arguments:
  <content-file>         Path to file containing node content

Options (one required):
  --type <type>          Create a new node of this type (e.g., text, code)
  --id <node-id>         Update an existing node by ID

Options (optional):
  --link-to <node-id>    Add an edge from this node to <node-id>
  --link-from <node-id>  Add an edge from <node-id> to this node
  --notify               Notify built-in agent after write
  -h, --help             Show this help message

Output:
  stdout: node ID (created or updated)
  stderr: action metadata (action, type/id)

Examples:
  node huabu-sideband-tool.mjs write-node --type text ./draft.md
  node huabu-sideband-tool.mjs write-node --id node-abc123 ./updated.md
`,
  });

  const type = flags['--type'] || null;
  const id = flags['--id'] || null;
  const linkTo = flags['--link-to'] || null;
  const linkFrom = flags['--link-from'] || null;
  const notify = flags['--notify'] || false;

  if ((!type && !id) || (type && id)) {
    process.stderr.write(
      'Usage: write-node [--type <type> | --id <node-id>] [--link-to <id>] [--link-from <id>] [--notify] <content-file>\n',
    );
    process.exit(1);
  }
  if (positional.length !== 1) {
    process.stderr.write('Error: exactly one content file path is required\n');
    process.exit(1);
  }

  const contentFile = positional[0];
  const canvasId = requireEnv('HUABU_CANVAS_ID', CANVAS_ID);
  const content = await readFile(contentFile, 'utf8');

  const commands = [];

  if (type) {
    commands.push({
      type: 'CREATE_NODES',
      nodes: [
        {
          nodeType: type,
          data: { content },
        },
      ],
    });
  } else {
    commands.push({
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: id, patch: { content } }],
    });
  }

  const res = await request('POST', `/api/canvas/${canvasId}/execute`, {
    commands,
    originator: { type: 'sideband' },
  });
  const result = await res.json();

  let nodeId = id;
  if (type && result.results && result.results.length > 0) {
    const createResult = result.results[0];
    if (createResult.ok && createResult.command?.type === 'CREATE_NODES') {
      const createdNodes = createResult.command.nodes;
      if (createdNodes && createdNodes.length > 0) {
        nodeId = createdNodes[0].id;
      }
    }
  }

  const linkCommands = [];
  if (linkTo && nodeId) {
    linkCommands.push({
      type: 'CONNECT_NODES',
      edges: [{ source: nodeId, target: linkTo }],
    });
  }
  if (linkFrom && nodeId) {
    linkCommands.push({
      type: 'CONNECT_NODES',
      edges: [{ source: linkFrom, target: nodeId }],
    });
  }
  if (linkCommands.length > 0) {
    await request('POST', `/api/canvas/${canvasId}/execute`, {
      commands: linkCommands,
      originator: { type: 'sideband' },
    });
  }

  // TODO: handle --notify (fire-and-forget notification to built-in agent)

  const action = type ? 'created' : 'updated';
  process.stderr.write(`action=${action} nodeId=${nodeId || 'unknown'}\n`);
  process.stdout.write(`${nodeId || 'unknown'}\n`);
}

async function askAgent(args) {
  const { flags, positional } = parseArgs(args, {
    boolean: ['--show-steps', '--no-save-session'],
    help: `ask-agent — Send a prompt to a built-in Huabu agent

Usage: node huabu-sideband-tool.mjs ask-agent [options] <prompt | @prompt-file>

Arguments:
  <prompt>               Inline prompt text (multiple words joined)
  @<path>                Read prompt from file (e.g., @./question.txt)

Options:
  --show-steps           Print intermediate events (tool calls, thinking) to stdout
  --no-save-session      Disable saving event log (default: saves to JSONL in sideband dir)
  -h, --help             Show this help message

Output:
  stdout: agent response text (default) or interleaved steps (with --show-steps)
  stderr: progress status, session file path

Examples:
  node huabu-sideband-tool.mjs ask-agent "summarize node-abc123"
  node huabu-sideband-tool.mjs ask-agent --show-steps "what nodes link to node-xyz?"
  node huabu-sideband-tool.mjs ask-agent --no-save-session @./prompt.txt
`,
  });

  if (positional.length === 0) {
    process.stderr.write('Usage: ask-agent [options] <prompt | @prompt-file>\n');
    process.exit(1);
  }

  const showSteps = flags['--show-steps'] || false;
  const saveSession = !flags['--no-save-session'];

  const rawPrompt = positional.join(' ');
  let prompt;

  if (rawPrompt.startsWith('@')) {
    const filePath = rawPrompt.slice(1);
    try {
      prompt = await readFile(filePath, 'utf8');
    } catch {
      process.stderr.write(`Error: cannot read prompt file: ${filePath}\n`);
      process.exit(1);
    }
  } else {
    prompt = rawPrompt;
  }

  const canvasId = requireEnv('HUABU_CANVAS_ID', CANVAS_ID);
  const url = `${SERVER}/api/sideband/ask-agent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireEnv('AGENTLET_TOKEN', TOKEN)}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ prompt, canvasId }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody.message) msg = errBody.message;
    } catch { /* ignore parse errors */ }
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }

  // Consume SSE stream
  const events = [];
  let finalMessage = '';
  let threadId = '';
  let firstEventReceived = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE frames (event: <type>\ndata: <json>\n\n)
    const frames = buffer.split('\n\n');
    buffer = frames.pop(); // Keep incomplete frame in buffer

    for (const frame of frames) {
      if (!frame.trim()) continue;
      // Skip SSE comments (lines starting with :)
      const lines = frame.split('\n').filter((l) => !l.startsWith(':'));
      if (lines.length === 0) continue;

      let eventType = '';
      let eventData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) eventData = line.slice(6);
      }
      if (!eventType || !eventData) continue;

      // Signal progress on first real event
      if (!firstEventReceived) {
        firstEventReceived = true;
        process.stderr.write('⏳ Agent working...\n');
      }

      let parsed;
      try {
        parsed = JSON.parse(eventData);
      } catch {
        continue;
      }

      const event = { type: eventType, data: parsed };
      if (saveSession) events.push(event);

      switch (eventType) {
        case 'text_delta':
          if (showSteps) process.stdout.write(parsed.content || '');
          break;
        case 'thinking_delta':
          if (showSteps)
            process.stdout.write(`[thinking] ${parsed.content || ''}`);
          break;
        case 'tool_call':
          if (showSteps)
            process.stdout.write(
              `\n[tool] ${parsed.internalToolName || parsed.title} ...\n`,
            );
          break;
        case 'tool_call_update':
          if (showSteps)
            process.stdout.write(`[tool result] ${(parsed.rawOutput || '').slice(0, 200)}\n`);
          break;
        case 'done':
          finalMessage = parsed.message || '';
          threadId = parsed.threadId || '';
          break;
        case 'error':
          process.stderr.write(`Error: ${parsed.error || 'agent error'}\n`);
          if (!finalMessage) process.exit(1);
          break;
      }
    }
  }

  // Save session if requested
  if (saveSession && events.length > 0) {
    const sidebandDir = process.env.AGENTLET_SIDEBAND_DIR || '.';
    const sessionsDir = path.join(sidebandDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const filename = `${Date.now()}.jsonl`;
    const filePath = path.join(sessionsDir, filename);
    const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(filePath, content, 'utf8');
    process.stderr.write(`Session saved: ${filePath}\n`);
  }

  // Print thread ID to stderr for future --resume support
  if (threadId) {
    process.stderr.write(`threadId=${threadId}\n`);
  }

  // Final result to stdout (if --show-steps was used, text_delta already printed it)
  if (!showSteps) {
    process.stdout.write(`${finalMessage}\n`);
  } else {
    // Ensure trailing newline after streamed output
    process.stdout.write('\n');
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const COMMANDS = {
  'read-node': readNode,
  'write-node': writeNode,
  'ask-agent': askAgent,
};

const MAIN_HELP = `Huabu Sideband Tool (HST)

Usage: node huabu-sideband-tool.mjs <command> [args...]

Commands:
  read-node   Read a canvas node's content to a local file
  write-node  Create or update a canvas node
  ask-agent   Send a prompt to a built-in Huabu agent

Options:
  -h, --help  Show help (use after a command for command-specific help)

Environment variables (set by agentlet daemon):
  AGENTLET_TOKEN    Auth token for Huabu server (required)
  AGENTLET_SERVER   Daemon WS URL — HTTP base URL derived automatically (required*)
  HUABU_CANVAS_ID   Canvas ID this session is scoped to (required)
  HUABU_SERVER      HTTP base URL override (optional, takes priority over AGENTLET_SERVER)

Examples:
  node huabu-sideband-tool.mjs read-node node-abc123
  node huabu-sideband-tool.mjs write-node --type text ./draft.md
  node huabu-sideband-tool.mjs ask-agent "place the new node near node-xyz"
  node huabu-sideband-tool.mjs read-node --help
`;

if (!command || command === '--help' || command === '-h') {
  process.stderr.write(MAIN_HELP);
  process.exit(0);
}

if (!COMMANDS[command]) {
  process.stderr.write(`Error: unknown command "${command}"\n\n`);
  process.stderr.write(MAIN_HELP);
  process.exit(1);
}

COMMANDS[command](args).catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
