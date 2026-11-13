#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const root = new URL('../', import.meta.url);
const commandTypes = [
  'CREATE_NODES',
  'MERGE_NODE_DATA',
  'SET_FRAME_LAYOUT',
  'CONNECT_NODES',
];
const queryTypes = ['GET_SPACE_OUTLINE', 'INSPECT_NODES', 'INSPECT_EDGES'];

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
    frame('fixingSkill', 'skill: issue fixing', 0, 620),
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

function assertGeometry(nodes, nodeMap) {
  const owned = Object.values(nodeMap)
    .filter(Boolean)
    .map((nodeId) => nodes.find((node) => node.id === nodeId))
    .filter(Boolean);
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

function resolveSetupState(current, specs, installerNodeId, passedNodes) {
  const frameSpecs = specs.filter(({ nodeType }) => nodeType === 'frame');
  if (passedNodes !== undefined) {
    if (
      !passedNodes ||
      typeof passedNodes !== 'object' ||
      Array.isArray(passedNodes)
    ) {
      throw new Error('Invalid --nodes state; expected a JSON object');
    }
    const required = [
      'common',
      'coordinatorPrompt',
      'fixingSkill',
      'configurationFrame',
      'issues',
      'configuration',
    ];
    for (const role of required) {
      const expectedType = role === 'configuration' ? 'note' : 'frame';
      const node = current.nodes.find(({ id }) => id === passedNodes[role]);
      if (!node || node.type !== expectedType) {
        throw new Error(`Missing or changed setup node for ${role}`);
      }
    }
    const configNode = current.nodes.find(
      ({ id }) => id === passedNodes.configuration,
    );
    if (configNode.parentFrame?.id !== passedNodes.configurationFrame) {
      throw new Error(
        'Issue Tracker Configuration Note is outside its configuration Frame',
      );
    }
    const nodeMap = { ...passedNodes };
    return resolveCoordinatorForSetup(current, nodeMap, installerNodeId);
  }

  const foundFrames = Object.fromEntries(
    frameSpecs.map(({ role, data }) => [
      role,
      current.nodes.filter(
        (node) => node.type === 'frame' && node.label === data.label,
      ),
    ]),
  );
  const totalMatchedFrames = Object.values(foundFrames).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  if (totalMatchedFrames === 0) {
    if (
      current.nodes.some(({ id }) => id !== installerNodeId) ||
      current.edges.length > 0
    ) {
      throw new Error('Non-empty Space; refusing overlay installation');
    }
    return null;
  }
  if (Object.values(foundFrames).some((list) => list.length !== 1)) {
    throw new Error(
      'Incomplete or ambiguous Issue Tracker Frames on Space; inspect existing nodes before retrying',
    );
  }
  const nodeMap = Object.fromEntries(
    Object.entries(foundFrames).map(([role, [node]]) => [role, node.id]),
  );
  for (const spec of specs.filter(({ nodeType }) => nodeType !== 'frame')) {
    const matches = current.nodes.filter(
      (node) =>
        node.type === spec.nodeType &&
        node.label === spec.data.label &&
        (spec.parent ? node.parentFrame?.id === nodeMap[spec.parent] : true),
    );
    if (spec.role === 'configuration' && matches.length !== 1) {
      throw new Error(
        'Missing or ambiguous Issue Tracker Configuration Note inside configuration Frame',
      );
    }
    if (matches.length === 1) nodeMap[spec.role] = matches[0].id;
  }
  return resolveCoordinatorForSetup(current, nodeMap, installerNodeId);
}

function resolveCoordinatorForSetup(current, nodeMap, installerNodeId) {
  const promptId = nodeMap.coordinatorPrompt;
  const connectedAgents = current.edges
    .map((edge) =>
      edge.source === promptId
        ? edge.target
        : edge.target === promptId
          ? edge.source
          : null,
    )
    .filter(Boolean)
    .map((id) => current.nodes.find((node) => node.id === id))
    .filter(
      (node) =>
        node &&
        node.id !== installerNodeId &&
        node.type === 'question' &&
        node.threadId,
    );
  const uniqueAgents = [
    ...new Map(connectedAgents.map((node) => [node.id, node])).values(),
  ];
  if (uniqueAgents.length > 1) {
    throw new Error(
      'Ambiguous Coordinator connections on Coordinator Prompt Frame',
    );
  }
  let coordinatorNode = uniqueAgents[0];
  if (!coordinatorNode && typeof nodeMap.coordinator === 'string') {
    const candidate = current.nodes.find(
      (node) =>
        node.id === nodeMap.coordinator &&
        node.id !== installerNodeId &&
        node.type === 'question' &&
        node.threadId,
    );
    if (!candidate) {
      throw new Error('Recorded Coordinator node no longer exists on Space');
    }
    coordinatorNode = candidate;
  }
  if (!coordinatorNode) {
    const strayAgent = current.nodes.find(
      (node) =>
        node.id !== installerNodeId &&
        node.type === 'question' &&
        !node.parentFrame,
    );
    if (strayAgent) {
      throw new Error(
        `Unconnected Agent node (${strayAgent.id}) found on Space; inspect state before creating another Coordinator`,
      );
    }
  }
  if (coordinatorNode) {
    nodeMap.coordinator = coordinatorNode.id;
  }
  return {
    nodeMap,
    coordinator: coordinatorNode
      ? { nodeId: coordinatorNode.id, threadId: coordinatorNode.threadId }
      : null,
    coordinatorConnected: uniqueAgents.length === 1,
  };
}

export async function install({
  baseUrl = process.env.HUABU_RFS_URL,
  token = process.env.AGENTLET_TOKEN,
  rfsEntry = process.env.HUABU_RFS_ENTRY,
  threadId = process.env.HUABU_THREAD_ID,
  installerNode,
  nodes: passedNodes,
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
  const queryOutline = async () => {
    const payload = { type: 'GET_SPACE_OUTLINE', includeStyle: true };
    const response = useCli
      ? JSON.parse(await runCli(['query', '--json', JSON.stringify(payload)]))
      : await json('query', payload);
    if (
      response.type !== 'GET_SPACE_OUTLINE' ||
      !Array.isArray(response.result?.nodes)
    ) {
      throw new Error('Invalid GET_SPACE_OUTLINE response');
    }
    return response.result.nodes;
  };
  const executeCommands = async (commands) => {
    let result;
    if (useCli) {
      const dir = await mkdtemp(join(tmpdir(), 'issue-tracker-exec-'));
      try {
        const payloadPath = join(dir, 'commands.json');
        await writeFile(payloadPath, JSON.stringify({ commands }));
        result = JSON.parse(
          await runCli(['execute', '--json-file', payloadPath], {
            correlate: true,
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      result = await json('execute', { commands });
    }
    if (
      result.results?.length !== commands.length ||
      result.results.some((entry) => entry.applied !== true) ||
      result.conflicts?.length
    ) {
      throw new Error(
        `Rejected Space command (${commands.map(({ type }) => type).join(', ')}); inspect actual Space state before retrying`,
      );
    }
    return result.results;
  };
  const listProfiles = async () =>
    useCli
      ? JSON.parse(await runCli(['agent', 'profiles']))
      : json('agent/profiles');
  const createCoordinator = async (profileId, position, workingDirPath) =>
    useCli
      ? JSON.parse(
          await runCli(
            [
              'agent',
              'create',
              '--no-start',
              '--json',
              JSON.stringify({ profileId, position, workingDirPath }),
            ],
            { correlate: false },
          ),
        )
      : json(
          'agent',
          { profileId, position, workingDirPath },
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
    !queryTypes.every((type) => capabilities.queryTypes?.includes(type))
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

  let setup = resolveSetupState(
    current,
    specs,
    resolvedInstallerNode,
    passedNodes,
  );
  const configNode = setup
    ? current.nodes.find(({ id }) => id === setup.nodeMap.configuration)
    : null;
  const configuration = configNode
    ? await download(configNode)
    : { content: kit.content['assets/configuration.md'] };
  const errors = validateConfiguration(
    configuration.content,
    kit.configurationSchema,
    profiles,
  );
  const configuredProfile = extractConfigProfile(configuration.content);
  if (profile && configuredProfile && configuredProfile !== profile) {
    errors.push(
      `INVALID coordinatorProfileId: conflicts with --profile ${profile}`,
    );
  }
  const effectiveProfile =
    profile || (!errors.length ? configuredProfile : undefined);
  const canCreateCoordinator = Boolean(
    !errors.length &&
    effectiveProfile &&
    profiles.some(({ id }) => id !== 'huabu' && id === effectiveProfile),
  );

  if (!apply) {
    return {
      mode: 'preview',
      transport: useCli ? 'huabu-rfs' : 'http',
      installerNode: resolvedInstallerNode,
      resume: Boolean(setup),
      state: setup
        ? setup.coordinator && setup.coordinatorConnected && !errors.length
          ? 'ready'
          : 'needs_configuration'
        : 'planned',
      configurationState: errors.length ? 'needs_configuration' : 'valid',
      configuration: errors,
      availableProfiles: profiles.filter(({ id }) => id !== 'huabu'),
      nodes: setup?.nodeMap ?? null,
      coordinator: setup?.coordinator ?? null,
      create: setup
        ? canCreateCoordinator && !setup.coordinator
          ? ['coordinator']
          : []
        : [
            ...specs.map(({ role }) => role),
            ...(canCreateCoordinator ? ['coordinator'] : []),
          ],
      activation:
        'instruction titles are final; Coordinator creation requires valid confirmed configuration',
    };
  }

  if (!setup) {
    const origin = {
      x: installer.absolutePosition.x + installer.size.width + 120,
      y: installer.absolutePosition.y,
    };
    const rootSpecs = specs.filter(({ parent }) => !parent);
    const [rootCreated] = await executeCommands([
      {
        type: 'CREATE_NODES',
        nodes: rootSpecs.map(({ nodeType, data, position, size }) => ({
          nodeType,
          data,
          ...(size ? { size } : {}),
          position: {
            x: origin.x + position.x,
            y: origin.y + position.y,
          },
        })),
      },
    ]);
    const nodeMap = {};
    rootSpecs.forEach(({ role }, index) => {
      const nodeId = rootCreated.nodes?.[index]?.nodeId;
      if (!nodeId) throw new Error(`Missing created identity for ${role}`);
      nodeMap[role] = nodeId;
    });

    const childSpecs = specs.filter(({ parent }) => Boolean(parent));
    const [childrenCreated] = await executeCommands([
      {
        type: 'CREATE_NODES',
        nodes: childSpecs.map(({ parent, nodeType, data, position, size }) => ({
          nodeType,
          data,
          position,
          ...(size ? { size } : {}),
          parentId: nodeMap[parent],
        })),
      },
      ...[
        'common',
        'coordinatorPrompt',
        'fixingSkill',
        'configurationFrame',
      ].map((role) => ({
        type: 'SET_FRAME_LAYOUT',
        frameId: nodeMap[role],
        mode: 'column',
        sizing: 'hug',
      })),
    ]);
    childSpecs.forEach(({ role }, index) => {
      const nodeId = childrenCreated.nodes?.[index]?.nodeId;
      if (!nodeId) throw new Error(`Missing created identity for ${role}`);
      nodeMap[role] = nodeId;
    });

    current = await inventory();
    assertGeometry(current.nodes, nodeMap);
    setup = { nodeMap, coordinator: null, coordinatorConnected: false };
  }

  const latestConfig = await download(
    current.nodes.find(({ id }) => id === setup.nodeMap.configuration),
  );
  const validation = validateConfiguration(
    latestConfig.content,
    kit.configurationSchema,
    profiles,
  );
  const latestConfiguredProfile = extractConfigProfile(latestConfig.content);
  if (
    profile &&
    latestConfiguredProfile &&
    latestConfiguredProfile !== profile
  ) {
    validation.push(
      `INVALID coordinatorProfileId: conflicts with --profile ${profile}`,
    );
  }
  const targetProfile =
    profile || (!validation.length ? latestConfiguredProfile : undefined);

  let coordinator = setup.coordinator;
  let coordinatorConnected = setup.coordinatorConnected;
  if (
    !validation.length &&
    !coordinator &&
    targetProfile &&
    profiles.some(({ id }) => id !== 'huabu' && id === targetProfile)
  ) {
    const promptNode = current.nodes.find(
      ({ id }) => id === setup.nodeMap.coordinatorPrompt,
    );
    const { codebasePath } = resolveConfigurationValues(
      parseConfiguration(latestConfig.content).values,
    );
    const created = await createCoordinator(
      targetProfile,
      {
        x: promptNode.absolutePosition.x,
        y: promptNode.absolutePosition.y + promptNode.size.height + 64,
      },
      codebasePath,
    );
    if (
      !created.nodeId ||
      !created.threadId ||
      created.profileId !== targetProfile
    ) {
      throw new Error('Missing/mismatched Coordinator creation identity');
    }
    coordinator = { nodeId: created.nodeId, threadId: created.threadId };
    setup.nodeMap.coordinator = created.nodeId;
    current = await inventory();
  }

  const outlineNodes = await queryOutline();
  const currentAccent = outlineNodes.find(
    ({ id }) => id === setup.nodeMap.configurationFrame,
  )?.style?.accent;
  const ready = Boolean(!validation.length && coordinator);
  const desiredAccent = ready ? 'green' : 'amber';
  const finalizeCommands = [];

  if (ready) {
    const coordNode = current.nodes.find(({ id }) => id === coordinator.nodeId);
    if (coordNode?.label !== 'Issue Tracker Coordinator') {
      finalizeCommands.push({
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: coordinator.nodeId,
            patch: { label: 'Issue Tracker Coordinator' },
          },
        ],
      });
    }
    if (!coordinatorConnected) {
      finalizeCommands.push({
        type: 'CONNECT_NODES',
        edges: [
          {
            source: setup.nodeMap.coordinatorPrompt,
            target: coordinator.nodeId,
          },
        ],
      });
      coordinatorConnected = true;
    }
  }
  if (currentAccent !== desiredAccent) {
    finalizeCommands.push({
      type: 'MERGE_NODE_DATA',
      patches: [
        {
          nodeId: setup.nodeMap.configurationFrame,
          patch: { style: { accent: desiredAccent } },
        },
      ],
    });
  }
  if (finalizeCommands.length > 0) {
    await executeCommands(finalizeCommands);
  }
  current = await inventory();
  assertGeometry(current.nodes, setup.nodeMap);

  const state =
    !validation.length && coordinator && coordinatorConnected
      ? 'ready'
      : 'needs_configuration';
  return {
    mode: 'installed',
    transport: useCli ? 'huabu-rfs' : 'http',
    installerNode: resolvedInstallerNode,
    state,
    configuration: validation,
    availableProfiles: profiles.filter(({ id }) => id !== 'huabu'),
    nodes: setup.nodeMap,
    coordinator,
    activation: coordinator
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
      nodes: { type: 'string' },
      profile: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node install.mjs [--installer-node NODE_ID] [--nodes JSON] [--profile PROFILE_ID] [--apply]\nPreview is read-only. Uses HUABU_RFS_ENTRY when present, with HUABU_RFS_URL, AGENTLET_TOKEN and optional HUABU_THREAD_ID. Read SKILL.md first.',
    );
  } else {
    try {
      const parsedNodes = values.nodes ? JSON.parse(values.nodes) : undefined;
      console.log(
        JSON.stringify(
          await install({
            installerNode: values['installer-node'],
            nodes: parsedNodes,
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
