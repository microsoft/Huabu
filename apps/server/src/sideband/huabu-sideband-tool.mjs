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
 *   HUABU_CANVAS_ID      — Canvas ID this session is scoped to
 *   HUABU_SERVER         — Huabu server base URL (e.g. http://localhost:3001)
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
const SERVER = process.env.HUABU_SERVER;

function requireEnv(name, value) {
  if (!value) {
    process.stderr.write(`Error: ${name} environment variable is not set\n`);
    process.exit(1);
  }
  return value;
}

// ── HTTP helpers ─────────────────────────────────────────────────────

async function request(method, urlPath, body) {
  const url = `${requireEnv('HUABU_SERVER', SERVER)}${urlPath}`;
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
  const { positional } = parseArgs(args, {
    help: `ask-agent — Send a prompt to a built-in Huabu agent

Usage: node huabu-sideband-tool.mjs ask-agent <prompt | @prompt-file>

Arguments:
  <prompt>               Inline prompt text (multiple words joined)
  @<path>                Read prompt from file (e.g., @./question.txt)

Options:
  -h, --help             Show this help message

Output:
  stdout: agent response text

Examples:
  node huabu-sideband-tool.mjs ask-agent "summarize node-abc123"
  node huabu-sideband-tool.mjs ask-agent @./prompt.txt
`,
  });

  if (positional.length === 0) {
    process.stderr.write('Usage: ask-agent <prompt | @prompt-file>\n');
    process.exit(1);
  }

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
  const res = await request('POST', `/api/sideband/ask-agent`, {
    prompt,
    canvasId,
  });
  const data = await res.json();

  process.stdout.write(`${data.response || ''}\n`);
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
  HUABU_CANVAS_ID   Canvas ID this session is scoped to (required)
  HUABU_SERVER      Server base URL, e.g. http://localhost:3001 (required)

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
