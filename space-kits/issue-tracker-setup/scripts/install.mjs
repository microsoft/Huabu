#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const root = new URL('../', import.meta.url);
export const recordLabel = 'Issue Tracker Installation Record';
const commandTypes = [
  'CREATE_NODES',
  'MERGE_NODE_DATA',
  'SET_FRAME_LAYOUT',
  'CONNECT_NODES',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonBlock = (heading, value) =>
  `# ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

export function parseRecord(content) {
  const matches = [...content.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)];
  if (matches.length !== 1) throw new Error('Expected exactly one JSON block');
  return JSON.parse(matches[0][1]);
}

export function parseConfiguration(content) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^# /u.test(line));
  const cells = rows.map((row) => {
    if (!/^\s*\|.*\|\s*$/u.test(row)) {
      throw new Error('Expected a Markdown table with Field and Value columns');
    }
    return row
      .trim()
      .slice(1, -1)
      .split(/(?<!\\)\|/u)
      .map((cell) =>
        cell
          .trim()
          .replace(/^`([^`]+)`$/u, '$1')
          .replace(/\\\|/gu, '|'),
      );
  });
  if (
    cells.length < 3 ||
    cells.some((row) => row.length !== 2) ||
    cells[0][0] !== 'Field' ||
    cells[0][1] !== 'Value' ||
    !cells[1].every((cell) => /^:?-{3,}:?$/u.test(cell))
  ) {
    throw new Error('Expected one Markdown table with Field and Value columns');
  }
  const entries = new Map();
  for (const [field, value] of cells.slice(2)) {
    if (entries.has(field))
      throw new Error(`Duplicate configuration field: ${field}`);
    entries.set(field, value || null);
  }
  const confirmed = entries.get('confirmedByUser');
  if (
    confirmed !== undefined &&
    confirmed !== null &&
    !['true', 'false'].includes(confirmed)
  ) {
    throw new Error('confirmedByUser must be true or false');
  }
  entries.delete('confirmedByUser');
  return {
    schemaVersion: 1,
    values: Object.fromEntries(entries),
    confirmedByUser: confirmed === 'true',
  };
}

export async function loadKit() {
  const files = [
    'kit.json',
    'SKILL.md',
    'scripts/install.mjs',
    'assets/common-policy.md',
    'assets/coordinator-prompt.md',
    'assets/fixing-agent-preamble.md',
    'assets/issue-frame-layout.md',
    'assets/configuration.md',
    'assets/configuration-schema.json',
    'assets/setup-instructions.txt',
  ].sort();
  const bytes = await Promise.all(
    files.map(async (file) => [
      file,
      await readFile(new URL(file, root), 'utf8'),
    ]),
  );
  const content = Object.fromEntries(bytes);
  return {
    ...JSON.parse(content['kit.json']),
    digest: hash(JSON.stringify(bytes)),
    content,
    configurationSchema: JSON.parse(
      content['assets/configuration-schema.json'],
    ),
  };
}

export function resolveConfigurationValues(rawValues = {}) {
  const clean = (val) =>
    typeof val === 'string' && val.trim() ? val.trim() : null;
  const codebasePath = clean(rawValues.codebasePath);
  const fixingProfileId = clean(rawValues.fixingProfileId);
  const coordinatorProfileId =
    clean(rawValues.coordinatorProfileId) ?? fixingProfileId;
  const repository = clean(rawValues.repository);
  const worktreeRoot =
    clean(rawValues.worktreeRoot) ??
    (codebasePath ? `${codebasePath.replace(/[\\/]+$/, '')}-worktrees` : null);
  const developmentBaseRef =
    clean(rawValues.developmentBaseRef) ?? 'origin/main';
  const pullRequestBase = clean(rawValues.pullRequestBase) ?? 'main';
  return {
    codebasePath,
    fixingProfileId,
    coordinatorProfileId,
    repository,
    worktreeRoot,
    developmentBaseRef,
    pullRequestBase,
  };
}

export function validateConfiguration(content, schema, profiles) {
  let config;
  try {
    config = parseConfiguration(content);
  } catch (error) {
    return [`INVALID configuration: ${error.message}`];
  }
  if (
    !config ||
    config.schemaVersion !== 1 ||
    !config.values ||
    typeof config.values !== 'object' ||
    Array.isArray(config.values) ||
    typeof config.confirmedByUser !== 'boolean'
  ) {
    return ['INVALID configuration structure; restore the documented schema'];
  }
  const fields = schema.properties.values.properties;
  const requiredFields = new Set(schema.properties.values.required ?? []);
  const errors = [];
  if (
    Object.keys(config).some((key) => !Object.hasOwn(schema.properties, key)) ||
    Object.keys(config.values).some((key) => !Object.hasOwn(fields, key))
  ) {
    errors.push('INVALID unknown configuration field');
  }
  for (const [key, rule] of Object.entries(fields)) {
    const value = config.values[key];
    const isEmpty = value === null || value === undefined || value === '';
    if (isEmpty) {
      if (requiredFields.has(key)) errors.push(`REQUIRED ${key}`);
    } else if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      value.length > 4096 ||
      !new RegExp(rule.pattern).test(value)
    ) {
      errors.push(`INVALID ${key}: ${rule.description}`);
    }
  }
  const resolved = resolveConfigurationValues(config.values);
  for (const profileKey of ['coordinatorProfileId', 'fixingProfileId']) {
    const rawValue = config.values[profileKey];
    const checkId =
      profileKey === 'coordinatorProfileId'
        ? rawValue !== null && rawValue !== undefined && rawValue !== ''
          ? rawValue
          : null
        : resolved.fixingProfileId;
    if (
      typeof checkId === 'string' &&
      !profiles.some(
        (profile) => profile.id !== 'huabu' && profile.id === checkId,
      )
    ) {
      errors.push(`INVALID ${profileKey}: external Profile is not selectable`);
    }
  }
  if (!config.confirmedByUser) errors.push('UNVERIFIED user confirmation');
  return errors;
}

export function extractConfigProfile(content) {
  try {
    const config = parseConfiguration(content);
    return (
      resolveConfigurationValues(config?.values).coordinatorProfileId ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function specifications(kit, profiles) {
  const note = (role, parent, label, file, height) => ({
    role,
    parent,
    nodeType: 'note',
    data: { label, content: kit.content[`assets/${file}.md`] },
    position: { x: 28, y: 80 },
    size: { width: 440, height },
  });
  const frame = (role, label, x, y, accent) => ({
    role,
    nodeType: 'frame',
    data: { label, ...(accent ? { style: { accent } } : {}) },
    position: { x, y },
    size: { width: 520, height: 400 },
  });
  return [
    frame('common', 'prompt: issue tracking common', 0, 0),
    frame('coordinatorPrompt', 'prompt: issue tracking coordinator', 600, 0),
    frame('fixingSkill', 'skill: issue fixing', 600, 620),
    frame(
      'configurationFrame',
      'prompt: issue tracking configuration',
      1200,
      0,
      'amber',
    ),
    frame('issues', 'Issues', 1800, 400),
    note(
      'policy',
      'common',
      'Issue Tracker Common Instructions',
      'common-policy',
      200,
    ),
    note('layout', 'common', 'Issue Frame Layout', 'issue-frame-layout', 200),
    note(
      'coordinatorInstructions',
      'coordinatorPrompt',
      'Coordinator Instructions',
      'coordinator-prompt',
      400,
    ),
    note(
      'safety',
      'fixingSkill',
      'Fixing Agent Safety Contract',
      'fixing-agent-preamble',
      300,
    ),
    note(
      'configuration',
      'configurationFrame',
      'Issue Tracker Configuration',
      'configuration',
      500,
    ),
    {
      role: 'warning',
      nodeType: 'text',
      data: {
        label: 'How to configure Issue Tracker',
        content: kit.content['assets/setup-instructions.txt'].replace(
          '{{AVAILABLE_PROFILES}}',
          profiles
            .filter(({ id }) => id !== 'huabu')
            .map(({ alias, id }) => `${alias ?? id}: ${id}`)
            .join('\n') || '(No external Profiles are currently selectable.)',
        ),
        style: { accent: 'amber', fontWeight: 'bold' },
      },
      position: { x: 1200, y: 700 },
      size: { width: 520 },
    },
  ];
}

function assertGeometry(nodes, objects) {
  const owned = Object.values(objects).map(({ nodeId }) =>
    nodes.find((node) => node.id === nodeId),
  );
  for (const node of owned) {
    const parent = owned.find(
      (candidate) => candidate.id === node.parentFrame?.id,
    );
    if (
      !node.size ||
      !node.absolutePosition ||
      (parent &&
        (node.position.x < 0 ||
          node.position.y < 0 ||
          node.position.x + node.size.width > parent.size.width + 1 ||
          node.position.y + node.size.height > parent.size.height + 1))
    ) {
      throw new Error(
        `Invalid containment/geometry: ${JSON.stringify({
          node: {
            id: node.id,
            label: node.label,
            position: node.position,
            size: node.size,
          },
          parent: parent && { id: parent.id, size: parent.size },
        })}`,
      );
    }
  }
  for (let i = 0; i < owned.length; i++) {
    for (const b of owned.slice(i + 1)) {
      const a = owned[i];
      if (a.parentFrame?.id !== b.parentFrame?.id) continue;
      if (
        a.absolutePosition.x < b.absolutePosition.x + b.size.width - 1 &&
        b.absolutePosition.x < a.absolutePosition.x + a.size.width - 1 &&
        a.absolutePosition.y < b.absolutePosition.y + b.size.height - 1 &&
        b.absolutePosition.y < a.absolutePosition.y + a.size.height - 1
      ) {
        throw new Error(`Overlapping installed nodes: ${a.id}, ${b.id}`);
      }
    }
  }
}

export async function install({
  baseUrl = process.env.HUABU_RFS_URL,
  token = process.env.AGENTLET_TOKEN,
  rfsEntry = process.env.HUABU_RFS_ENTRY,
  threadId = process.env.HUABU_THREAD_ID,
  installerNode,
  profile,
  apply = false,
  fetchImpl,
}) {
  if (!baseUrl || !token) {
    throw new Error('Require HUABU_RFS_URL and AGENTLET_TOKEN');
  }
  if (profile === 'huabu') {
    throw new Error('Coordinator Profile must be an external Profile');
  }
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid RFS base URL');
  }
  const useCli = Boolean(rfsEntry && !fetchImpl);
  const httpFetch = fetchImpl ?? fetch;
  let cliModule;
  const runCli = async (args, { correlate = false } = {}) => {
    const env = {
      ...process.env,
      HUABU_RFS_URL: baseUrl,
      AGENTLET_TOKEN: token,
    };
    if (!correlate) delete env.HUABU_THREAD_ID;
    cliModule ??= await import(pathToFileURL(rfsEntry).href).catch(() => null);
    if (typeof cliModule?.runRfs === 'function') {
      const { PassThrough, Writable } = await import('node:stream');
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdin = new PassThrough();
      stdin.end();
      const stdout = new Writable({
        write(chunk, _encoding, callback) {
          stdoutChunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const stderr = new Writable({
        write(chunk, _encoding, callback) {
          stderrChunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const code = await cliModule.runRfs(args, {
        env,
        stdin,
        stdout,
        stderr,
        signal: AbortSignal.timeout(30_000),
      });
      const out = Buffer.concat(stdoutChunks).toString('utf8');
      const err = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        throw new Error(
          `huabu-rfs ${args[0] ?? ''} failed: ${(err || out).trim()}`,
        );
      }
      return out;
    }
    const { stdout } = await execFileAsync(
      process.execPath,
      [rfsEntry, ...args],
      {
        env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    return stdout;
  };
  const request = async (path, body, extraHeaders = {}) => {
    const response = await httpFetch(
      `${base.href.replace(/\/$/, '')}/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `RFS ${path.split('/')[0]} failed (${response.status}); inspect state before retrying`,
      );
    }
    return response;
  };
  const json = async (path, body, headers) =>
    (await request(path, body, headers)).json();
  const query = async (type) => {
    const response = useCli
      ? JSON.parse(
          await runCli([
            'query',
            '--json',
            JSON.stringify({ type, limit: 200 }),
          ]),
        )
      : await json('query', { type, limit: 200 });
    const result = response.result;
    const items = type === 'INSPECT_NODES' ? result?.nodes : result?.edges;
    if (
      response.type !== type ||
      !Array.isArray(items) ||
      result.truncated !== false ||
      result.count !== items.length ||
      result.total !== items.length
    ) {
      throw new Error(
        `Incomplete ${type} inventory; cannot prove blankness/ownership`,
      );
    }
    return items;
  };
  const inventory = async () => {
    const [nodes, edges] = await Promise.all([
      query('INSPECT_NODES'),
      query('INSPECT_EDGES'),
    ]);
    return { nodes, edges };
  };
  const download = async (node) => {
    if (
      !node?.filename?.startsWith('nodes/') ||
      node.filename.split('/').includes('..')
    ) {
      throw new Error('Missing/invalid canonical node download path');
    }
    let sidecar;
    let revision;
    if (useCli) {
      const dir = await mkdtemp(join(tmpdir(), 'issue-tracker-dl-'));
      try {
        const out = join(dir, 'node.md');
        const stdout = await runCli([
          'download',
          '--output',
          out,
          node.filename,
        ]);
        const events = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const completed = events.find(
          (entry) => entry.event === 'download_completed',
        );
        revision = completed?.revision;
        sidecar = await readFile(out, 'utf8');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      const response = await request(
        `download/${node.filename.split('/').map(encodeURIComponent).join('/')}`,
      );
      sidecar = await response.text();
      revision = response.headers.get('etag')?.replace(/^"|"$/g, '');
    }
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(sidecar);
    if (!match || !revision) throw new Error('Node sidecar/revision missing');
    return { content: sidecar.slice(match[0].length), revision };
  };
  const execute = async (command) => {
    let result;
    if (useCli) {
      const dir = await mkdtemp(join(tmpdir(), 'issue-tracker-exec-'));
      try {
        const payloadPath = join(dir, 'commands.json');
        await writeFile(payloadPath, JSON.stringify({ commands: [command] }));
        result = JSON.parse(
          await runCli(['execute', '--json-file', payloadPath], {
            correlate: true,
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      result = await json('execute', { commands: [command] });
    }
    if (
      result.results?.length !== 1 ||
      result.results[0].applied !== true ||
      result.conflicts?.length
    ) {
      throw new Error(
        `Rejected ${command.type}; inspect pending write and all command results`,
      );
    }
    return result.results[0];
  };
  const listProfiles = async () =>
    useCli
      ? JSON.parse(await runCli(['agent', 'profiles']))
      : json('agent/profiles');
  const createCoordinator = async (profileId, position) =>
    useCli
      ? JSON.parse(
          await runCli(
            [
              'agent',
              'create',
              '--no-start',
              '--json',
              JSON.stringify({ profileId, position }),
            ],
            { correlate: false },
          ),
        )
      : json(
          'agent',
          { profileId, position },
          { 'X-Huabu-Agent-Start': 'false' },
        );

  const checkCapabilities = async () =>
    useCli
      ? (() =>
          runCli(['execute', '--help']).then((stdout) =>
            JSON.parse(stdout.split('\nLive operation contract\n')[1] ?? '{}'),
          ))()
      : json('capabilities');

  const kit = await loadKit();
  const capabilities = await checkCapabilities();
  if (
    capabilities.protocolVersion !== 2 ||
    !capabilities.permissions?.read ||
    (apply && !capabilities.permissions?.write) ||
    !commandTypes.every((type) => capabilities.commandTypes?.includes(type)) ||
    !['INSPECT_NODES', 'INSPECT_EDGES'].every((type) =>
      capabilities.queryTypes?.includes(type),
    )
  ) {
    throw new Error(
      'Unsupported RFS capabilities; load the authenticated root guide',
    );
  }
  const catalogue = await listProfiles();
  const profiles = catalogue.profiles;
  if (!Array.isArray(profiles)) {
    throw new Error('Could not load available Agent Profiles');
  }
  if (profile && !profiles.some(({ id }) => id !== 'huabu' && id === profile)) {
    throw new Error('Coordinator Profile is not selectable');
  }
  const specs = specifications(kit, profiles);
  let current = await inventory();
  const resolvedInstallerNode =
    installerNode ||
    (threadId
      ? current.nodes.find(
          (node) => node.type === 'question' && node.threadId === threadId,
        )?.id
      : undefined);
  const installer = current.nodes.find(
    ({ id }) => id === resolvedInstallerNode,
  );
  if (installer?.type !== 'question' || !installer.threadId) {
    throw new Error(
      'Installer must be an existing Agent Node with a thread (set HUABU_THREAD_ID or pass --installer-node)',
    );
  }
  const candidates = current.nodes.filter(({ label }) => label === recordLabel);
  if (candidates.length > 1) throw new Error('Ambiguous Installation Records');
  let record;
  let recordContent;
  if (candidates.length) {
    recordContent = await download(candidates[0]);
    record = parseRecord(recordContent.content);
    if (
      record.schema !== 'issue-tracker-installation/v1' ||
      record.recordNodeId !== candidates[0].id ||
      record.kitId !== kit.id ||
      record.version !== kit.version ||
      record.digest !== kit.digest ||
      (record.profileId !== null && typeof record.profileId !== 'string') ||
      (profile && record.profileId && record.profileId !== profile) ||
      record.installerNodeId !== resolvedInstallerNode ||
      !record.objects ||
      typeof record.objects !== 'object' ||
      Array.isArray(record.objects) ||
      typeof record.instanceId !== 'string' ||
      !record.instanceId ||
      !Number.isFinite(record.origin?.x) ||
      !Number.isFinite(record.origin?.y) ||
      !['installing', 'needs_configuration', 'ready'].includes(record.state) ||
      !Array.isArray(record.completed)
    ) {
      throw new Error(
        'Installation identity/version/digest conflict; no automatic adoption or upgrade',
      );
    }
    if (record.pending) {
      throw new Error(
        `Unresolved write ${record.pending}; inspect actual state and request explicit recovery`,
      );
    }
  } else {
    record = {
      schema: 'issue-tracker-installation/v1',
      kitId: kit.id,
      version: kit.version,
      digest: kit.digest,
      instanceId: randomUUID(),
      installerNodeId: resolvedInstallerNode,
      profileId: profile ?? null,
      recordNodeId: null,
      origin: {
        x: installer.absolutePosition.x + installer.size.width + 120,
        y: installer.absolutePosition.y,
      },
      state: 'installing',
      objects: {},
      completed: [],
      pending: null,
    };
  }

  const baseSteps = [
    ...specs.map(({ role }) => `create:${role}`),
    ...['common', 'coordinatorPrompt', 'fixingSkill', 'configurationFrame'].map(
      (role) => `layout:${role}`,
    ),
  ];
  const coordinatorSteps = [
    'create:coordinator',
    'label:coordinator',
    'connect',
  ];
  const steps = [...baseSteps, ...coordinatorSteps];
  if (
    record.completed.some((name) => !steps.includes(name)) ||
    new Set(record.completed).size !== record.completed.length ||
    [...specs.map(({ role }) => role), 'coordinator'].some(
      (role) =>
        record.completed.includes(`create:${role}`) !==
        Object.hasOwn(record.objects, role),
    )
  ) {
    throw new Error(
      'Invalid Installation Record step/object mapping; reconcile before resuming',
    );
  }
  const verifiedContent = new Map();
  async function checkOwned() {
    const allowed = new Set([
      resolvedInstallerNode,
      record.recordNodeId,
      ...Object.values(record.objects).map(({ nodeId }) => nodeId),
    ]);
    if (current.nodes.some(({ id }) => !allowed.has(id))) {
      throw new Error(
        'Non-empty Space/unrecorded content; refusing overlay installation',
      );
    }
    for (const [role, object] of Object.entries(record.objects)) {
      const spec = specs.find((entry) => entry.role === role);
      if (!spec && role !== 'coordinator')
        throw new Error('Unknown installed role');
      if (
        !object ||
        typeof object.nodeId !== 'string' ||
        (spec?.data.content &&
          role !== 'warning' &&
          object.contentHash !== hash(spec.data.content))
      ) {
        throw new Error(`Invalid installed content baseline: ${role}`);
      }
      const node = current.nodes.find(({ id }) => id === object.nodeId);
      const parent = spec?.parent
        ? record.objects[spec.parent]?.nodeId
        : undefined;
      if (
        !node ||
        node.type !== (role === 'coordinator' ? 'question' : spec.nodeType) ||
        node.parentFrame?.id !== parent ||
        (role === 'coordinator' && node.threadId !== object.threadId)
      ) {
        throw new Error(
          `Missing/changed installed identity or parent: ${role}`,
        );
      }
      if (
        object.contentHash &&
        role !== 'configuration' &&
        (!node.rev || verifiedContent.get(node.id) !== node.rev)
      ) {
        const downloaded = await download(node);
        if (hash(downloaded.content) !== object.contentHash) {
          throw new Error(
            `User-edited installed content: ${role}; preserving it`,
          );
        }
        verifiedContent.set(node.id, downloaded.revision);
      }
      if (spec?.nodeType === 'frame') {
        if (node.label !== spec.data.label)
          throw new Error(`Changed instruction/Frame label: ${role}`);
      }
    }
    const coordinator = record.objects.coordinator?.nodeId;
    const prompt = record.objects.coordinatorPrompt?.nodeId;
    if (
      current.edges.some(
        (edge) =>
          !(
            (edge.source === coordinator && edge.target === prompt) ||
            (edge.source === prompt && edge.target === coordinator)
          ),
      ) ||
      current.edges.length > 1
    ) {
      throw new Error(
        'Unexpected edges/Prompt scope; refusing automatic repair',
      );
    }
    if (record.completed.includes('connect') && current.edges.length !== 1) {
      throw new Error(
        'Deleted Coordinator Prompt edge; preserving user change',
      );
    }
  }
  await checkOwned();
  const configNode = current.nodes.find(
    ({ id }) => id === record.objects.configuration?.nodeId,
  );
  const configuration = configNode
    ? await download(configNode)
    : { content: kit.content['assets/configuration.md'] };
  const errors = validateConfiguration(
    configuration.content,
    kit.configurationSchema,
    profiles,
  );
  const configuredProfile = extractConfigProfile(configuration.content);
  if (
    record.profileId &&
    configuredProfile &&
    configuredProfile !== record.profileId
  ) {
    errors.push(
      `INVALID coordinatorProfileId: conflicts with existing Coordinator Profile ${record.profileId}`,
    );
  }
  const effectiveProfile =
    profile ||
    record.profileId ||
    (!errors.length ? configuredProfile : undefined);
  const canCreateCoordinator = Boolean(
    !errors.length &&
    effectiveProfile &&
    profiles.some(({ id }) => id !== 'huabu' && id === effectiveProfile),
  );
  if (!apply) {
    const baseComplete = baseSteps.every((name) =>
      record.completed.includes(name),
    );
    const complete = steps.every((name) => record.completed.includes(name));
    if (baseComplete) assertGeometry(current.nodes, record.objects);
    return {
      mode: 'preview',
      transport: useCli ? 'huabu-rfs' : 'http',
      installerNode: resolvedInstallerNode,
      kit: { id: kit.id, version: kit.version, digest: kit.digest },
      resume: Boolean(record.recordNodeId),
      state: complete
        ? errors.length
          ? 'needs_configuration'
          : 'ready'
        : baseComplete
          ? 'needs_configuration'
          : record.recordNodeId
            ? 'installing'
            : 'planned',
      configurationState: errors.length ? 'needs_configuration' : 'valid',
      configuration: errors,
      availableProfiles: profiles.filter(({ id }) => id !== 'huabu'),
      create: [
        ...specs.map(({ role }) => role),
        ...(canCreateCoordinator ? ['coordinator'] : []),
      ].filter((role) => !record.objects[role]),
      activation:
        'instruction titles are final; Coordinator creation requires valid confirmed configuration',
    };
  }

  if (!record.recordNodeId) {
    const result = await execute({
      type: 'CREATE_NODES',
      nodes: [
        {
          nodeType: 'note',
          data: { label: recordLabel, content: jsonBlock(recordLabel, record) },
          position: { x: record.origin.x, y: record.origin.y + 1400 },
          size: { width: 520, height: 260 },
        },
      ],
    });
    record.recordNodeId = result.nodes?.[0]?.nodeId;
    if (!record.recordNodeId)
      throw new Error(
        'Lost Installation Record identity; inspect before retrying',
      );
    current = await inventory();
    recordContent = await download(
      current.nodes.find(({ id }) => id === record.recordNodeId),
    );
  }
  const save = async () => {
    const body = jsonBlock(recordLabel, record);
    const node = (await query('INSPECT_NODES')).find(
      ({ id }) => id === record.recordNodeId,
    );
    const latest = await download(node);
    if (latest.revision !== recordContent.revision) {
      throw new Error(
        'Installation Record changed; stop competing installer or reconcile edits',
      );
    }
    if (recordContent.content === body) return;
    await execute({
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: record.recordNodeId,
          expectRev: latest.revision,
          patch: { content: body },
        },
      ],
    });
    recordContent = await download(node);
    if (recordContent.content !== body)
      throw new Error('Installation Record readback mismatch');
  };
  await save();
  const step = async (name, action) => {
    if (record.completed.includes(name)) return;
    current = await inventory();
    await checkOwned();
    record.pending = name;
    await save();
    await action();
    record.completed.push(name);
    record.pending = null;
    await save();
  };
  for (const { role, parent, ...spec } of specs) {
    await step(`create:${role}`, async () => {
      const result = await execute({
        type: 'CREATE_NODES',
        nodes: [
          {
            ...spec,
            ...(parent
              ? { parentId: record.objects[parent].nodeId }
              : {
                  position: {
                    x: record.origin.x + spec.position.x,
                    y: record.origin.y + spec.position.y,
                  },
                }),
          },
        ],
      });
      const nodeId = result.nodes?.[0]?.nodeId;
      if (!nodeId) throw new Error(`Missing created identity for ${role}`);
      record.objects[role] = {
        nodeId,
        ...(spec.data.content ? { contentHash: hash(spec.data.content) } : {}),
      };
    });
  }
  for (const role of [
    'common',
    'coordinatorPrompt',
    'fixingSkill',
    'configurationFrame',
  ]) {
    await step(`layout:${role}`, () =>
      execute({
        type: 'SET_FRAME_LAYOUT',
        frameId: record.objects[role].nodeId,
        mode: 'column',
        sizing: 'hug',
      }),
    );
  }
  const finalConfigBeforeCoordinator = await download(
    (await query('INSPECT_NODES')).find(
      ({ id }) => id === record.objects.configuration.nodeId,
    ),
  );
  const preCoordinatorValidation = validateConfiguration(
    finalConfigBeforeCoordinator.content,
    kit.configurationSchema,
    profiles,
  );
  const finalConfiguredProfile = extractConfigProfile(
    finalConfigBeforeCoordinator.content,
  );
  if (
    record.profileId &&
    finalConfiguredProfile &&
    finalConfiguredProfile !== record.profileId
  ) {
    preCoordinatorValidation.push(
      `INVALID coordinatorProfileId: conflicts with existing Coordinator Profile ${record.profileId}`,
    );
  }
  const targetProfile =
    profile ||
    record.profileId ||
    (!preCoordinatorValidation.length ? finalConfiguredProfile : undefined);
  if (
    !preCoordinatorValidation.length &&
    targetProfile &&
    profiles.some(({ id }) => id !== 'huabu' && id === targetProfile)
  ) {
    record.profileId = targetProfile;
    await step('create:coordinator', async () => {
      const result = await createCoordinator(targetProfile, {
        x: record.origin.x + 1800,
        y: record.origin.y,
      });
      if (
        !result.nodeId ||
        !result.threadId ||
        result.profileId !== targetProfile
      ) {
        throw new Error('Missing/mismatched Coordinator creation identity');
      }
      record.objects.coordinator = {
        nodeId: result.nodeId,
        threadId: result.threadId,
      };
    });
    await step('label:coordinator', () =>
      execute({
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: record.objects.coordinator.nodeId,
            patch: { label: 'Issue Tracker Coordinator' },
          },
        ],
      }),
    );
    await step('connect', () =>
      execute({
        type: 'CONNECT_NODES',
        edges: [
          {
            source: record.objects.coordinatorPrompt.nodeId,
            target: record.objects.coordinator.nodeId,
          },
        ],
      }),
    );
  }
  current = await inventory();
  await checkOwned();
  assertGeometry(current.nodes, record.objects);
  const finalConfig = await download(
    current.nodes.find(({ id }) => id === record.objects.configuration.nodeId),
  );
  const validation = validateConfiguration(
    finalConfig.content,
    kit.configurationSchema,
    profiles,
  );
  if (
    record.profileId &&
    extractConfigProfile(finalConfig.content) &&
    extractConfigProfile(finalConfig.content) !== record.profileId
  ) {
    validation.push(
      `INVALID coordinatorProfileId: conflicts with existing Coordinator Profile ${record.profileId}`,
    );
  }
  const allStepsDone = steps.every((name) => record.completed.includes(name));
  const nextState =
    validation.length || !allStepsDone ? 'needs_configuration' : 'ready';
  const prevAccent = record.state === 'ready' ? 'green' : 'amber';
  const nextAccent = nextState === 'ready' ? 'green' : 'amber';
  if (prevAccent !== nextAccent) {
    record.pending = 'status:configuration';
    await save();
    await execute({
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: record.objects.configurationFrame.nodeId,
          patch: { style: { accent: nextAccent } },
        },
      ],
    });
    record.pending = null;
  }
  record.state = nextState;
  record.configuration = {
    contentHash: hash(finalConfig.content),
    errors: validation,
  };
  await save();
  return {
    mode: 'installed',
    transport: useCli ? 'huabu-rfs' : 'http',
    installerNode: resolvedInstallerNode,
    state: record.state,
    configuration: validation,
    availableProfiles: profiles.filter(({ id }) => id !== 'huabu'),
    coordinator: record.objects.coordinator ?? null,
    recordNodeId: record.recordNodeId,
    version: kit.version,
    digest: kit.digest,
    activation: record.objects.coordinator
      ? 'none; Coordinator stays idle until its first user message'
      : 'deferred; complete Issue Tracker Configuration and rerun with --apply to create the Coordinator',
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      'installer-node': { type: 'string' },
      profile: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node install.mjs [--installer-node NODE_ID] [--profile PROFILE_ID] [--apply]\nPreview is read-only. Uses HUABU_RFS_ENTRY when present, with HUABU_RFS_URL, AGENTLET_TOKEN and optional HUABU_THREAD_ID. Read SKILL.md first.',
    );
  } else {
    try {
      console.log(
        JSON.stringify(
          await install({
            installerNode: values['installer-node'],
            profile: values.profile,
            apply: values.apply,
          }),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(`Issue Tracker installation stopped: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
