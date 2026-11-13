// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { install, loadKit } from '../scripts/install.mjs';
import rfsRoutes from '../../../apps/server/src/modules/remote_fs/rfs.route.js';
import {
  getCanvasStore,
  resetStorageCache,
} from '../../../apps/server/src/modules/storage/index.js';
import { setWorkspacePath } from '../../../apps/server/src/modules/workspace.js';
import * as profiles from '../../../apps/server/src/modules/agent/selectable-agent-profile.js';
import {
  resolveSpacePrompt,
  resolveSpaceSkill,
} from '../../../apps/server/src/modules/agent/space-instruction-frames.js';
import { agentThreadService } from '../../../apps/server/src/modules/agent/agent-thread.service.js';
import { agenetes } from '../../../apps/server/src/modules/agent/agenetes/drivers.js';

const require = createRequire(
  new URL('../../../apps/server/package.json', import.meta.url),
);
const fastify = require('fastify');
let app;
let workspace;
let writes;
let requests;
let fetchImpl;
const options = () => ({
  baseUrl: 'http://fixture/rfs/c1',
  token: 'fixture-only',
  installerNode: 'node-installer',
  fetchImpl,
});
const store = () => getCanvasStore('c1');
const nodeStyle = (nodeId) =>
  store()
    .read()
    .state.nodes.find((node) => node.id === nodeId)?.data?.style;

function configurationTable({ values, confirmedByUser = true }) {
  return [
    '| Field | Value |',
    '| --- | --- |',
    ...Object.entries({ ...values, confirmedByUser }).map(
      ([field, value]) => `| \`${field}\` | ${value ?? ''} |`,
    ),
  ].join('\n');
}

function fillConfiguration(nodeId) {
  store().writeNode(nodeId, {
    ...store().readNode(nodeId),
    content: configurationTable({
      values: {
        codebasePath: '/projects/example',
        fixingProfileId: 'project-profile',
      },
    }),
  });
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'issue-tracker-rfs-'));
  resetStorageCache();
  setWorkspacePath(workspace);
  const profile = { id: 'project-profile', alias: 'Project coding Agent' };
  vi.spyOn(profiles, 'listAvailableAgentProfiles').mockReturnValue([profile]);
  vi.spyOn(profiles, 'requireSelectableAgentProfile').mockReturnValue(profile);
  vi.spyOn(agentThreadService, 'invoke').mockImplementation(() => {
    throw new Error('Installer must never invoke an Agent');
  });
  vi.spyOn(agenetes, 'create').mockImplementation(() => {
    throw new Error('Installer must never realize a workload');
  });
  store().write({
    canvasId: 'c1',
    title: 'Blank Kit fixture',
    version: 1,
    state: {
      nodes: [
        {
          id: 'node-installer',
          type: 'question',
          position: { x: 100, y: 200 },
          data: {
            threadId: 'thread-installer',
            agentBindingPolicy: 'fixed',
            agentBinding: {
              kind: 'external',
              profileId: profile.id,
              alias: profile.alias,
            },
          },
        },
      ],
      edges: [],
    },
    createdAt: 1,
    updatedAt: 1,
  });
  store().writeNode('node-installer', {
    nodeId: 'node-installer',
    type: 'question',
    label: 'Installer',
    content: '',
  });
  app = fastify();
  await app.register(rfsRoutes, { prefix: '/rfs' });
  await app.ready();
  writes = [];
  requests = [];
  fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, ...init });
    if (init.method === 'POST' && !path.endsWith('/query')) {
      writes.push({ path, ...init });
    }
    const response = await app.inject({
      method: init.method,
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: response.headers,
    });
  };
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

it('creates final instruction titles and an inline configuration table without any ledger Note, then an idle Coordinator only after confirmation', async () => {
  const preview = await install(options());
  expect(preview.state).toBe('planned');
  expect(preview.configurationState).toBe('needs_configuration');
  expect(writes).toEqual([]);
  const initial = await install({ ...options(), apply: true });
  expect(initial.state).toBe('needs_configuration');
  expect(initial.coordinator).toBeNull();
  expect(writes.filter(({ path }) => path.endsWith('/agent'))).toHaveLength(0);
  expect(
    store()
      .read()
      .state.nodes.some((node) =>
        store().readNode(node.id)?.label?.includes('Installation Record'),
      ),
  ).toBe(false);
  const { nodes } = initial;
  const kit = await loadKit();
  for (const [role, file] of Object.entries({
    policy: 'common-policy',
    layout: 'issue-frame-layout',
    safety: 'fixing-agent-preamble',
    coordinatorInstructions: 'coordinator-prompt',
    configuration: 'configuration',
  })) {
    expect(store().readNode(nodes[role]).content).toBe(
      kit.content[`assets/${file}.md`],
    );
  }
  const expectedLabels = {
    common: 'prompt: issue tracking common',
    coordinatorPrompt: 'prompt: issue tracking coordinator',
    fixingSkill: 'skill: issue fixing',
    configurationFrame: 'prompt: issue tracking configuration',
  };
  for (const [role, label] of Object.entries(expectedLabels)) {
    expect(store().readNode(nodes[role]).label).toBe(label);
  }
  expect(nodeStyle(nodes.configurationFrame)?.accent).toBe('amber');
  const warning = store().readNode(nodes.warning);
  expect(warning.content).toContain('Project coding Agent: project-profile');
  expect(warning.content).not.toContain('{{AVAILABLE_PROFILES}}');
  expect(
    store()
      .read()
      .state.nodes.find((node) => node.id === nodes.warning).parentId,
  ).toBeUndefined();
  const initialPrompt = await resolveSpacePrompt('c1', 'node-installer');
  expect(initialPrompt.markdown).toContain(
    kit.content['assets/configuration.md'],
  );
  expect(initialPrompt.markdown).not.toContain('Edit only the Value column');
  writes.length = 0;
  await install({ ...options(), nodes, apply: true });
  expect(writes).toEqual([]);
  fillConfiguration(nodes.configuration);
  const result = await install({ ...options(), nodes, apply: true });
  expect(result.state).toBe('ready');
  expect(nodeStyle(nodes.configurationFrame)?.accent).toBe('green');
  for (const [role, label] of Object.entries(expectedLabels)) {
    expect(store().readNode(nodes[role]).label).toBe(label);
  }
  const prompt = await resolveSpacePrompt('c1', result.coordinator.nodeId);
  const otherPrompt = await resolveSpacePrompt('c1', 'node-installer');
  expect(prompt.diagnostics.truncated).toBe(false);
  expect(prompt.diagnostics.truncatedNoteIds).toEqual([]);
  expect(prompt.markdown).toContain('# Issue Tracker Coordinator');
  expect(prompt.markdown).toContain(
    'stop consuming the response and return control to the user',
  );
  expect(prompt.markdown).toContain(
    '`<status emoji> <issue identity> · <stable issue title>`',
  );
  expect(prompt.markdown).toContain(
    'do not create a per-issue Frame or a separate Execution Note node',
  );
  expect(prompt.markdown).toContain('before ending each milestone turn');
  expect(prompt.markdown).not.toContain('# Issue Execution Note Contract');
  expect(otherPrompt.markdown).not.toContain('# Issue Tracker Coordinator');
  expect(otherPrompt.markdown).toContain('# Issue Frame Layout');
  expect(otherPrompt.markdown).not.toContain('# Issue Execution Note Contract');
  const skill = await resolveSpaceSkill('c1');
  expect(skill.markdown).toContain('Fixing Agent Safety Contract');
  expect(skill.markdown).not.toContain(
    '## Implementation and delivery authority',
  );
  const creation = writes.filter(({ path }) => path.endsWith('/agent'));
  expect(creation).toHaveLength(1);
  expect(creation[0].headers['X-Huabu-Agent-Start']).toBe('false');
  expect(creation[0].headers['X-Huabu-Host-Thread-Id']).toBeUndefined();
  expect(JSON.parse(creation[0].body)).not.toHaveProperty('prompt');
  expect(JSON.parse(creation[0].body)).not.toHaveProperty('parentThreadId');
  expect(agentThreadService.invoke).not.toHaveBeenCalled();
  expect(agenetes.create).not.toHaveBeenCalled();
  expect(await agenetes.record(result.coordinator.threadId)).toBeUndefined();
  expect(
    requests.every(
      ({ headers }) => headers.Authorization === 'Bearer fixture-only',
    ),
  ).toBe(true);

  writes.length = 0;
  await install({ ...options(), apply: true });
  expect(writes).toEqual([]);
});

it('validates edited configuration for a non-Huabu repository without recreating or starting Agents', async () => {
  const step1 = await install({ ...options(), apply: true });
  fillConfiguration(step1.nodes.configuration);
  const ready = await install({
    ...options(),
    nodes: step1.nodes,
    apply: true,
  });
  const values = {
    repository: 'octo/example',
    codebasePath: '/projects/example',
    worktreeRoot: '/projects/worktrees',
    coordinatorProfileId: 'project-profile',
    fixingProfileId: 'project-profile',
    developmentBaseRef: 'upstream/develop',
    pullRequestBase: 'develop',
  };
  const configuration = {
    schemaVersion: 1,
    values,
    confirmedByUser: true,
  };
  const nodeId = step1.nodes.configuration;
  store().writeNode(nodeId, {
    ...store().readNode(nodeId),
    content: configurationTable(configuration),
  });
  writes.length = 0;
  const result = await install({ ...options(), apply: true });
  expect(result.state).toBe('ready');
  expect(result.coordinator).toEqual(ready.coordinator);
  expect(writes).toEqual([]);
  expect(agentThreadService.invoke).not.toHaveBeenCalled();
  expect(agenetes.create).not.toHaveBeenCalled();

  configuration.confirmedByUser = false;
  store().writeNode(nodeId, {
    ...store().readNode(nodeId),
    content: configurationTable(configuration),
  });
  const changed = await install({ ...options(), apply: true });
  expect(changed.state).toBe('needs_configuration');
  expect(changed.configuration).toContain('UNVERIFIED user confirmation');
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toMatch(/\/execute$/);
  expect(nodeStyle(step1.nodes.configurationFrame)?.accent).toBe('amber');
});

it('does not let an explicit Profile bypass missing, invalid, or unconfirmed configuration', async () => {
  const explicit = { ...options(), profile: 'project-profile' };
  const step1 = await install({ ...explicit, apply: true });
  expect(step1.coordinator).toBeNull();
  const nodeId = step1.nodes.configuration;
  for (const [path, confirmedByUser] of [
    ['relative/path', true],
    ['/projects/example', false],
  ]) {
    store().writeNode(nodeId, {
      ...store().readNode(nodeId),
      content: configurationTable({
        values: { codebasePath: path, fixingProfileId: 'project-profile' },
        confirmedByUser,
      }),
    });
    const preview = await install(explicit);
    expect(preview.create).not.toContain('coordinator');
    const result = await install({ ...explicit, apply: true });
    expect(result.state).toBe('needs_configuration');
    expect(result.coordinator).toBeNull();
  }
  expect(writes.filter(({ path }) => path.endsWith('/agent'))).toHaveLength(0);
});

it('blocks non-empty and truncated preflights without any mutation', async () => {
  const original = fetchImpl;
  fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (
      url.endsWith('/query') &&
      JSON.parse(init.body).type === 'INSPECT_NODES'
    ) {
      const body = await response.json();
      body.result.truncated = true;
      return Response.json(body);
    }
    return response;
  };
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Incomplete/,
  );
  expect(writes).toEqual([]);
  fetchImpl = original;
  const canvas = store().read();
  canvas.state.nodes.push({
    id: 'node-unrelated',
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
  });
  store().write(canvas);
  store().writeNode('node-unrelated', {
    nodeId: 'node-unrelated',
    type: 'note',
    label: 'User work',
    content: 'Preserve me',
  });
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Non-empty/,
  );
  expect(writes).toEqual([]);
});

it('allows user notes and instruction edits after layout without blocking Coordinator creation', async () => {
  const step1 = await install({ ...options(), apply: true });
  const canvas = store().read();
  canvas.state.nodes.push({
    id: 'node-user-memo',
    type: 'note',
    position: { x: 50, y: 900 },
    data: {},
  });
  store().write(canvas);
  store().writeNode('node-user-memo', {
    nodeId: 'node-user-memo',
    type: 'note',
    label: 'My scratchpad',
    content: 'Personal notes while onboarding',
  });
  const policyNode = store().readNode(step1.nodes.policy);
  store().writeNode(step1.nodes.policy, {
    ...policyNode,
    content: `${policyNode.content}\nCustom team note.\n`,
  });
  fillConfiguration(step1.nodes.configuration);

  const finalized = await install({
    ...options(),
    nodes: step1.nodes,
    apply: true,
  });
  expect(finalized.state).toBe('ready');
  expect(finalized.coordinator?.threadId).toBeTruthy();
  expect(store().readNode('node-user-memo').content).toBe(
    'Personal notes while onboarding',
  );
  expect(store().readNode(step1.nodes.policy).content).toContain(
    'Custom team note.',
  );
});

it('rejects partial/ambiguous Frames and rejected commands cleanly', async () => {
  const step1 = await install({ ...options(), apply: true });
  const canvas = store().read();
  canvas.state.nodes = canvas.state.nodes.filter(
    (node) => node.id !== step1.nodes.fixingSkill,
  );
  store().write(canvas);
  writes.length = 0;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Incomplete or ambiguous/,
  );
  await expect(
    install({ ...options(), nodes: step1.nodes, apply: true }),
  ).rejects.toThrow(/Missing or changed setup node for fixingSkill/);
  expect(writes).toEqual([]);
});

it('does not duplicate a Coordinator when its creation response is lost', async () => {
  const step1 = await install({ ...options(), apply: true });
  fillConfiguration(step1.nodes.configuration);
  const original = fetchImpl;
  fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (url.endsWith('/agent')) throw new Error('Lost Agent response');
    return response;
  };
  await expect(
    install({ ...options(), nodes: step1.nodes, apply: true }),
  ).rejects.toThrow(/Lost Agent response/);
  const agents = store()
    .read()
    .state.nodes.filter((node) => node.type === 'question');
  expect(agents).toHaveLength(2);
  fetchImpl = original;
  writes.length = 0;
  await expect(
    install({ ...options(), nodes: step1.nodes, apply: true }),
  ).rejects.toThrow(/Unconnected Agent node/);
  expect(writes).toEqual([]);
});

it('runs the cloned standalone CLI over huabu-rfs and 3-step workflow with --nodes from a different cwd', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const clone = join(workspace, 'standalone-kit');
  await cp(new URL('../', import.meta.url), clone, { recursive: true });
  const rfsEntry = new URL(
    '../../../packages/client-runtime/dist/rfs.js',
    import.meta.url,
  ).pathname;
  const env = {
    ...process.env,
    HUABU_RFS_URL: `${address}/rfs/c1`,
    AGENTLET_TOKEN: 'fixture-only',
    HUABU_RFS_ENTRY: rfsEntry,
    HUABU_THREAD_ID: 'thread-installer',
  };
  // Step 1: lay out Space content without passing --installer-node or --profile
  const step1 = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [join(clone, 'scripts/install.mjs'), '--apply'],
        { cwd: workspace, env },
      )
    ).stdout,
  );
  expect(step1.transport).toBe('huabu-rfs');
  expect(step1.installerNode).toBe('node-installer');
  expect(step1.state).toBe('needs_configuration');
  expect(step1.coordinator).toBeNull();
  expect(step1.nodes?.configuration).toBeTruthy();

  // Step 2: user fills in minimal required configuration on the Space
  const configNodeId = step1.nodes.configuration;
  const configuration = {
    schemaVersion: 1,
    values: {
      codebasePath: '/projects/example',
      fixingProfileId: 'project-profile',
      coordinatorProfileId: null,
      repository: null,
      worktreeRoot: null,
      developmentBaseRef: 'origin/main',
      pullRequestBase: 'main',
    },
    confirmedByUser: true,
  };
  store().writeNode(configNodeId, {
    ...store().readNode(configNodeId),
    content: configurationTable(configuration),
  });

  // Step 3: finalize installation passing --nodes from Step 1 conversation history
  const step3 = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [
          join(clone, 'scripts/install.mjs'),
          '--nodes',
          JSON.stringify(step1.nodes),
          '--apply',
        ],
        { cwd: workspace, env },
      )
    ).stdout,
  );
  expect(step3.transport).toBe('huabu-rfs');
  expect(step3.state).toBe('ready');
  expect(step3.coordinator?.threadId).toBeTruthy();
  expect(step3.nodes?.coordinator).toBe(step3.coordinator.nodeId);
  expect(agentThreadService.invoke).not.toHaveBeenCalled();
  expect(agenetes.create).not.toHaveBeenCalled();
});
