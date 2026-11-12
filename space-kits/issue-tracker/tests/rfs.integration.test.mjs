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

import {
  install,
  loadKit,
  parseRecord,
  recordLabel,
} from '../scripts/install.mjs';
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
  profile: 'project-profile',
  fetchImpl,
});
const store = () => getCanvasStore('c1');
const ledger = () => {
  const node = store()
    .read()
    .state.nodes.find(
      (node) => store().readNode(node.id)?.label === recordLabel,
    );
  return parseRecord(store().readNode(node.id).content);
};

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

it('previews without writes; installs exact assets and an unrealized scoped Coordinator', async () => {
  const preview = await install(options());
  expect(preview.state).toBe('planned');
  expect(preview.configurationState).toBe('needs_configuration');
  expect(writes).toEqual([]);
  const result = await install({ ...options(), apply: true });
  expect(result.state).toBe('needs_configuration');
  const record = ledger();
  expect(record.pending).toBeNull();
  const kit = await loadKit();
  for (const [role, file] of Object.entries({
    policy: 'common-policy',
    layout: 'issue-frame-layout',
    safety: 'fixing-agent-preamble',
    coordinatorInstructions: 'coordinator-prompt',
    configuration: 'configuration',
  })) {
    expect(store().readNode(record.objects[role].nodeId).content).toBe(
      kit.content[`assets/${file}.md`],
    );
  }
  expect(record.objects.contract).toBeUndefined();
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
  await install({ ...options(), apply: true });
  const record = ledger();
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
    evidence: Object.fromEntries(
      Object.keys(values).map((key) => [
        key,
        'User confirmed on intended execution device',
      ]),
    ),
    confirmedByUser: true,
  };
  const nodeId = record.objects.configuration.nodeId;
  store().writeNode(nodeId, {
    ...store().readNode(nodeId),
    content: `# Issue Tracker Configuration\n\n\`\`\`json\n${JSON.stringify(configuration)}\n\`\`\`\n`,
  });
  writes.length = 0;
  const result = await install({ ...options(), apply: true });
  expect(result.state).toBe('ready');
  expect(result.coordinator).toEqual(record.objects.coordinator);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toMatch(/\/execute$/);
  expect(agentThreadService.invoke).not.toHaveBeenCalled();
  expect(agenetes.create).not.toHaveBeenCalled();
  writes.length = 0;
  await install({ ...options(), apply: true });
  expect(writes).toEqual([]);
  configuration.confirmedByUser = false;
  store().writeNode(nodeId, {
    ...store().readNode(nodeId),
    content: `# Issue Tracker Configuration\n\n\`\`\`json\n${JSON.stringify(configuration)}\n\`\`\`\n`,
  });
  const changed = await install({ ...options(), apply: true });
  expect(changed.state).toBe('needs_configuration');
  expect(changed.configuration).toContain('UNVERIFIED user confirmation');
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

it('preserves edited static content and blocks mismatched versions', async () => {
  await install({ ...options(), apply: true });
  const record = ledger();
  const nodeId = record.objects.policy.nodeId;
  const original = store().readNode(nodeId);
  store().writeNode(nodeId, {
    ...original,
    content: 'User edited instructions',
  });
  writes.length = 0;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /User-edited/,
  );
  expect(writes).toEqual([]);
  expect(store().readNode(nodeId).content).toBe('User edited instructions');
  store().writeNode(nodeId, original);
  record.version = '99.0.0';
  store().writeNode(record.recordNodeId, {
    ...store().readNode(record.recordNodeId),
    content: `# ${recordLabel}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n`,
  });
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /identity\/version\/digest/,
  );
  expect(writes).toEqual([]);
});

it('stops after a dropped creation acknowledgement instead of duplicating accepted nodes', async () => {
  const original = fetchImpl;
  let dropped = false;
  fetchImpl = async (url, init) => {
    const response = await original(url, init);
    const command = init.body && JSON.parse(init.body).commands?.[0];
    if (
      !dropped &&
      command?.type === 'CREATE_NODES' &&
      command.nodes[0].nodeType === 'frame'
    ) {
      dropped = true;
      throw new Error('Lost acknowledgement');
    }
    return response;
  };
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Lost acknowledgement/,
  );
  expect(ledger().pending).toBe('create:common');
  const count = store().read().state.nodes.length;
  writes.length = 0;
  fetchImpl = original;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Unresolved write create:common/,
  );
  expect(store().read().state.nodes).toHaveLength(count);
  expect(writes).toEqual([]);
});

it('resumes an acknowledged prefix with unchanged identities', async () => {
  const original = fetchImpl;
  let interrupted = false;
  fetchImpl = async (url, init) => {
    if (
      !interrupted &&
      url.endsWith('/query') &&
      ledgerIfPresent()?.completed.includes('create:common')
    ) {
      interrupted = true;
      throw new Error('Interrupted between acknowledged steps');
    }
    return original(url, init);
  };
  function ledgerIfPresent() {
    const node = store()
      .read()
      .state.nodes.find(
        (node) => store().readNode(node.id)?.label === recordLabel,
      );
    return node ? parseRecord(store().readNode(node.id).content) : null;
  }
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Interrupted/,
  );
  const prefix = ledger();
  expect(prefix.pending).toBeNull();
  fetchImpl = original;
  await install({ ...options(), apply: true });
  expect(ledger().objects.common).toEqual(prefix.objects.common);
  expect(writes.filter(({ path }) => path.endsWith('/agent'))).toHaveLength(1);
});

it('preserves deleted objects and unexpected topology instead of recreating or repairing', async () => {
  await install({ ...options(), apply: true });
  const record = ledger();
  const canvas = store().read();
  const originalEdges = canvas.state.edges;
  canvas.state.edges = [];
  store().write(canvas);
  writes.length = 0;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Deleted Coordinator Prompt edge/,
  );
  expect(writes).toEqual([]);
  canvas.state.edges = originalEdges;
  canvas.state.nodes = canvas.state.nodes.filter(
    (node) => node.id !== record.objects.safety.nodeId,
  );
  store().write(canvas);
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Missing\/changed installed identity/,
  );
  expect(writes).toEqual([]);
});

it('keeps durable pending state after a rejected command or lost Agent response', async () => {
  const original = fetchImpl;
  let rejected = false;
  fetchImpl = async (url, init) => {
    const command = init.body && JSON.parse(init.body).commands?.[0];
    if (!rejected && command?.type === 'SET_FRAME_LAYOUT') {
      rejected = true;
      return Response.json({
        results: [{ applied: false, reason: 'conflict' }],
      });
    }
    return original(url, init);
  };
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Rejected SET_FRAME_LAYOUT/,
  );
  expect(ledger().pending).toBe('layout:common');
  fetchImpl = original;
  writes.length = 0;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Unresolved write/,
  );
  expect(writes).toEqual([]);
});

it('does not duplicate a Coordinator when its creation response is lost', async () => {
  const original = fetchImpl;
  fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (url.endsWith('/agent')) throw new Error('Lost Agent response');
    return response;
  };
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Lost Agent response/,
  );
  expect(ledger().pending).toBe('create:coordinator');
  const agents = store()
    .read()
    .state.nodes.filter((node) => node.type === 'question');
  expect(agents).toHaveLength(2);
  fetchImpl = original;
  writes.length = 0;
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Unresolved write/,
  );
  expect(writes).toEqual([]);
});

it('detects a concurrent ledger edit even on an otherwise unchanged rerun', async () => {
  await install({ ...options(), apply: true });
  const record = ledger();
  const original = fetchImpl;
  let edited = false;
  writes.length = 0;
  fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (
      !edited &&
      decodeURIComponent(new URL(url).pathname).endsWith(
        '/download/nodes/Issue Tracker Configuration.md',
      )
    ) {
      edited = true;
      const current = store().readNode(record.recordNodeId);
      store().writeNode(record.recordNodeId, {
        ...current,
        content: `${current.content}\nUser recovery decision: stop here.\n`,
      });
    }
    return response;
  };
  await expect(install({ ...options(), apply: true })).rejects.toThrow(
    /Installation Record changed/,
  );
  expect(writes).toEqual([]);
  expect(store().readNode(record.recordNodeId).content).toContain(
    'User recovery decision',
  );
});

it('runs the cloned standalone CLI over huabu-rfs and 3-step workflow from a different cwd', async () => {
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
  expect(ledger().objects.coordinator).toBeUndefined();

  // Step 2: user fills in configuration on the Space
  const configNodeId = ledger().objects.configuration.nodeId;
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
    evidence: Object.fromEntries(
      Object.keys(values).map((key) => [
        key,
        'User confirmed on intended execution device',
      ]),
    ),
    confirmedByUser: true,
  };
  store().writeNode(configNodeId, {
    ...store().readNode(configNodeId),
    content: `# Issue Tracker Configuration\n\n\`\`\`json\n${JSON.stringify(configuration)}\n\`\`\`\n`,
  });

  // Step 3: finalize installation and create Coordinator from configuration
  const step3 = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [join(clone, 'scripts/install.mjs'), '--apply'],
        { cwd: workspace, env },
      )
    ).stdout,
  );
  expect(step3.transport).toBe('huabu-rfs');
  expect(step3.state).toBe('ready');
  expect(step3.coordinator?.threadId).toBeTruthy();
  expect(ledger().objects.coordinator.threadId).toBe(
    step3.coordinator.threadId,
  );
  expect(agentThreadService.invoke).not.toHaveBeenCalled();
  expect(agenetes.create).not.toHaveBeenCalled();
});
