// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { FileThreadStore } from '@agenetes/agenetes';

import {
  chatEnvelopeSchema,
  createId,
  interactiveViewAgentEventV1Schema,
} from '@huabu/shared';

import {
  rewriteImportContract,
  rewriteImportedChange,
  rewriteImportedInputs,
} from './import-space-contracts.js';
import { safeJoin, sanitizeId } from '../../utils/fs.js';
import {
  parseFrontmatter,
  toFrontmatter,
} from '../../utils/markdown-frontmatter.js';
import { buildReachbackEnv } from '../agent/acp/reachback-env.js';
import { parseMigratableV3Records } from '../workspace/migrations/legacy/acp-sessions-v3.js';
import { migrateAcpSessionsFile } from '../workspace/migrations/migrate-acp-sessions.js';

import type { CanvasFile } from './persistence-types.js';

const NODE_REFERENCE =
  /^(parentId|nodeIds?|frameIds?|edgeIds?|selectedNodeIds|originNodeIds|sourceNodeId|targetNodeId|anchorNodeId|rootNodeId|parentEntryNodeId|createdNodeIds|deletedNodeIds)$/;
const SPACE_REFERENCE =
  /^(canvasId|canvasIdSnapshot|spaceId|targetCanvasId|sourceCanvasId|parentSpaceId)$/;
const THREAD_REFERENCE =
  /^(threadIds?|ownerThreadId|rootThreadId|parentThreadId|targetThreadId)$/;
const REFERENCE_TOOLS = new Set([
  'get_space_outline',
  'inspect_nodes',
  'inspect_edges',
  'space_commands',
  'snapshot_nodes',
  'create_task',
  'start_task_run',
  'complete_task_run',
  'report_ink_intent',
]);
// Legacy records and host extensions only; canonical contracts dispatch before this walker.
const REFERENCE_CONTAINERS = new Set([
  'nodes',
  'node',
  'edges',
  'edge',
  'data',
  'patch',
  'patches',
  'deltas',
  'revertDeltas',
  'commands',
  'results',
  'payload',
  'event',
  'turn',
  'transcript',
  'request',
  'submission',
  'content',
  'user',
  'focus',
  'anchor',
  'selection',
  'resources',
  'refs',
  'neighbourhood',
  'layers',
  'groups',
  'relevantEdges',
  'attachments',
  'imageAttachments',
  'snapshotAttachments',
  'inkRecognition',
  'inkGeometry',
  'strokeSubsets',
  'strokes',
  'resourceBinding',
  'bindings',
  'sources',
  'target',
  'references',
  'interactiveView',
  'definition',
  'conversation',
  'pending',
  'originator',
  'origin',
  'owner',
  'hostContext',
  'snapshots',
  'changes',
  'tasks',
  'runs',
  'task',
  'run',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Re-key the public bundle in staging, before any imported Space is visible. */
export async function remapImportedSpace(
  directory: string,
  record: CanvasFile,
  canvasId: string,
): Promise<CanvasFile> {
  const identities = new Map<string, string>();
  const threads = new Map<string, string>();
  const internalThreads = new Set<string>();
  function threadIdentity(id: string): string {
    if (!id) return id;
    let mapped = threads.get(id);
    if (!mapped) {
      mapped = createId('thread');
      threads.set(id, mapped);
    }
    return mapped;
  }
  for (const [kind, entries] of [
    ['node', record.state.nodes],
    ['edge', record.state.edges],
  ] as const) {
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('id' in entry) ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        identities.has(entry.id)
      ) {
        throw new Error('Invalid or duplicate identity in imported Space');
      }
      identities.set(entry.id, createId(kind));
    }
  }

  const oldCanvas = encodeURIComponent(
    sanitizeId(record.canvasId, 'sourceCanvasId'),
  );
  const newCanvas = encodeURIComponent(canvasId);
  const nodesDirectory = safeJoin(directory, 'nodes');
  const historyDirectory = safeJoin(directory, '.history');
  const legacySessions = safeJoin(historyDirectory, 'acp-sessions.json');
  if (existsSync(legacySessions)) {
    const legacy: unknown = JSON.parse(await readFile(legacySessions, 'utf8'));
    if (
      !isRecord(legacy) ||
      legacy.schemaVersion !== 3 ||
      !isRecord(legacy.records) ||
      parseMigratableV3Records(legacy, () => {
        throw new Error('Unsupported imported ACP recipe');
      }).length !== Object.keys(legacy.records).length
    ) {
      throw new Error('Unsupported or invalid imported ACP session records');
    }
    migrateAcpSessionsFile(
      new FileThreadStore(),
      { name: record.canvasId, storage: { root: historyDirectory } },
      legacySessions,
    );
  }
  const threadFiles = new Map<string, string>();
  for (const node of record.state.nodes) {
    if (
      isRecord(node) &&
      node.type === 'question' &&
      isRecord(node.data) &&
      typeof node.data.threadId === 'string'
    ) {
      threadIdentity(node.data.threadId);
    }
  }
  for (const [subdirectory, pattern] of [
    ['chat_v2', /\.(events|turns)\.jsonl(?:\.bak)?$/],
    ['chat', /\.changes\.json$/],
  ] as const) {
    const root = safeJoin(historyDirectory, subdirectory);
    if (!existsSync(root)) continue;
    for (const name of await readdir(root)) {
      const suffix = name.match(pattern)?.[0];
      if (!suffix) continue;
      const id = name.slice(0, -suffix.length);
      threadFiles.set(
        safeJoin(root, name),
        safeJoin(root, `${threadIdentity(id)}${suffix}`),
      );
    }
  }
  const threadRecordsPath = safeJoin(historyDirectory, 'threads.json');
  if (existsSync(threadRecordsPath)) {
    const data: unknown = JSON.parse(await readFile(threadRecordsPath, 'utf8'));
    if (!isRecord(data) || !isRecord(data.records))
      throw new Error('Invalid imported thread records');
    for (const [id, entry] of Object.entries(data.records)) {
      threadIdentity(id);
      if (
        isRecord(entry) &&
        isRecord(entry.spec) &&
        entry.spec.kind === 'internal'
      )
        internalThreads.add(id);
    }
  }
  const turnsPath = safeJoin(historyDirectory, 'chat_v2', 'turns.sqlite');
  if (existsSync(turnsPath)) {
    const database = new DatabaseSync(turnsPath);
    try {
      for (const table of ['turns', 'turn_generations', 'jsonl_imports']) {
        for (const row of database
          .prepare(`SELECT DISTINCT thread_id FROM ${table}`)
          .all()) {
          if (typeof row.thread_id !== 'string')
            throw new Error('Invalid imported thread key');
          threadIdentity(row.thread_id);
        }
      }
    } finally {
      database.close();
    }
  }
  function rewriteLinks(text: string): string {
    return text
      .split(`/api/canvas/${oldCanvas}/artifact/`)
      .join(`/api/canvas/${newCanvas}/artifact/`)
      .replace(
        new RegExp(`/canvas/${oldCanvas}\\?node=([a-zA-Z0-9_-]+)`, 'g'),
        (_match, nodeId: string) =>
          `/canvas/${newCanvas}?node=${identities.get(nodeId) ?? nodeId}`,
      );
  }
  function rewriteToolOutput(
    text: string,
    internalHistory = false,
    trusted = false,
  ): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Tool output may legitimately be plain text rather than a JSON envelope.
      if (error instanceof SyntaxError) return rewriteLinks(text);
      throw error;
    }
    const envelope =
      parsed !== null &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      typeof parsed.tool === 'string' &&
      REFERENCE_TOOLS.has(parsed.tool) &&
      'status' in parsed &&
      (parsed.status === 'success' || parsed.status === 'error');
    const snapshots =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (item: unknown) =>
          item !== null &&
          typeof item === 'object' &&
          'src' in item &&
          typeof item.src === 'string' &&
          'width' in item &&
          typeof item.width === 'number' &&
          'height' in item &&
          typeof item.height === 'number' &&
          'originNodeIds' in item &&
          Array.isArray(item.originNodeIds) &&
          item.originNodeIds.every((id: unknown) => typeof id === 'string'),
      );
    return envelope || snapshots || trusted
      ? JSON.stringify(rewrite(parsed, '', '', internalHistory))
      : rewriteLinks(text);
  }
  function rewrite(
    value: unknown,
    field = '',
    parent = '',
    internalHistory = false,
  ): unknown {
    if (typeof value === 'string') {
      if (field === 'rawOutput')
        return rewriteToolOutput(value, internalHistory);
      if (THREAD_REFERENCE.test(field)) return threads.get(value) ?? value;
      if (
        NODE_REFERENCE.test(field) ||
        field === 'edge-ref' ||
        (field === 'id' && /^(nodes|node|edges|edge|refs)$/.test(parent)) ||
        (/^(source|target)$/.test(field) &&
          /^(edges|edge|relevantEdges)$/.test(parent)) ||
        (parent === 'selection' && field === 'selectedIds')
      )
        return identities.get(value) ?? rewriteLinks(value);
      if (
        (SPACE_REFERENCE.test(field) ||
          (parent === 'namespace' && field === 'name')) &&
        value === record.canvasId
      )
        return canvasId;
      return rewriteLinks(value);
    }
    if (Array.isArray(value))
      return value.map((item) => rewrite(item, field, parent, internalHistory));
    if (isRecord(value)) {
      const visit = (item: unknown, context = '') =>
        rewrite(item, context, '', internalHistory);
      if (
        (field === 'request' || field === 'submission') &&
        (value.type === 'huabu.chat' || value.type === 'huabu.interactive-view')
      ) {
        const envelope =
          value.type === 'huabu.chat'
            ? chatEnvelopeSchema.parse(value.content)
            : undefined;
        if (!envelope) interactiveViewAgentEventV1Schema.parse(value.content);
        return {
          ...value,
          content: visit(
            value.content,
            envelope ? 'chat-envelope' : 'view-event',
          ),
          ...(value.rendered !== undefined
            ? {
                rendered: rewriteImportedInputs(
                  value.rendered,
                  envelope?.user.text,
                  identities,
                  rewriteLinks,
                  visit,
                ),
              }
            : {}),
        };
      }
      const contract = rewriteImportContract(value, field, visit);
      if (contract) return contract;
      if (
        /^(nodes|edges)$/.test(field) &&
        Object.values(value).every(isRecord)
      ) {
        return Object.fromEntries(
          Object.entries(value).map(([id, item]) => [
            identities.get(id) ?? id,
            rewrite(
              item,
              field === 'nodes' ? 'node' : 'edge',
              '',
              internalHistory,
            ),
          ]),
        );
      }
      const mapped = Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (key === 'data' && /^(node|nodes)$/.test(field))
            return [key, rewrite(item, 'node-data', '', internalHistory)];
          if (key === 'patch' && field === 'patches')
            return [key, rewrite(item, 'node-data', '', internalHistory)];
          if (
            /^(node-data|node-metadata)$/.test(field) &&
            !NODE_REFERENCE.test(key) &&
            !THREAD_REFERENCE.test(key) &&
            !SPACE_REFERENCE.test(key) &&
            !['interactiveView', 'origin', 'strokes'].includes(key)
          )
            return [key, typeof item === 'string' ? rewriteLinks(item) : item];
          // Replacement deltas contain complete nodes/edges, not arbitrary prev/next values.
          if (
            (key === 'prev' || key === 'next') &&
            value.type === 'REPLACE_NODE'
          )
            return [key, rewrite(item, 'node', '', internalHistory)];
          if (
            (key === 'prev' || key === 'next') &&
            value.type === 'REPLACE_EDGE'
          )
            return [key, rewrite(item, 'edge', '', internalHistory)];
          if (key === 'rawInput' || key === 'rawOutput') {
            const knownTool =
              (internalHistory &&
                typeof value.title === 'string' &&
                REFERENCE_TOOLS.has(value.title)) ||
              (typeof value.internalToolName === 'string' &&
                REFERENCE_TOOLS.has(value.internalToolName));
            if (key === 'rawOutput' && typeof item === 'string') {
              return [key, rewriteToolOutput(item, internalHistory, knownTool)];
            }
            return [
              key,
              (key === 'rawOutput' &&
                isRecord(item) &&
                typeof item.tool === 'string' &&
                REFERENCE_TOOLS.has(item.tool)) ||
              knownTool
                ? rewrite(item, key, field, internalHistory)
                : item,
            ];
          }
          if (key === 'state' || key === 'schema' || key === 'value')
            return [key, item];
          if (key === 'source' && field === 'bindings')
            return [key, rewrite(item, key, field, internalHistory)];
          if (
            (field === 'selection' && key === 'selectedIds') ||
            typeof item === 'string' ||
            NODE_REFERENCE.test(key) ||
            THREAD_REFERENCE.test(key) ||
            REFERENCE_CONTAINERS.has(key)
          ) {
            return [key, rewrite(item, key, field, internalHistory)];
          }
          return [key, item];
        }),
      );
      return Array.isArray(value.revertDeltas)
        ? rewriteImportedChange(value, mapped)
        : mapped;
    }
    return value;
  }

  function rewriteThreadRecords(value: unknown): unknown {
    if (!isRecord(value) || !isRecord(value.records)) {
      throw new Error('Invalid imported thread records');
    }
    return {
      ...value,
      records: Object.fromEntries(
        Object.entries(value.records).map(([id, entry]) => {
          if (
            !isRecord(entry) ||
            !isRecord(entry.spec) ||
            entry.spec.threadId !== id
          ) {
            throw new Error('Invalid imported thread identity');
          }
          const threadId = threadIdentity(id);
          const workload = entry.spec;
          let spec = workload.spec;
          let state = entry.state;
          if (isRecord(spec) && workload.kind === 'internal') {
            spec = {
              ...spec,
              hostContext: {
                ...(isRecord(spec.hostContext) ? spec.hostContext : {}),
                canvasId,
                ...(isRecord(spec.hostContext) &&
                spec.hostContext.origin !== undefined
                  ? { origin: rewrite(spec.hostContext.origin, 'origin') }
                  : {}),
              },
            };
          } else if (isRecord(spec) && workload.kind === 'external') {
            const env = { ...(isRecord(spec.env) ? spec.env : {}) };
            delete env.HUABU_RFS_URL;
            delete env.HUABU_THREAD_ID;
            spec = {
              ...spec,
              env: { ...env, ...buildReachbackEnv(threadId, canvasId) },
            };
            state = {
              ...(isRecord(state) ? state : {}),
              driverState: { initialPreambleDelivered: false },
            };
          }
          const hostMetadata = isRecord(entry.hostMetadata)
            ? {
                ...entry.hostMetadata,
                ...(entry.hostMetadata.owner
                  ? { owner: rewrite(entry.hostMetadata.owner, 'owner') }
                  : {}),
              }
            : entry.hostMetadata;
          return [
            threadId,
            {
              ...entry,
              spec: {
                ...workload,
                threadId,
                namespace: { name: canvasId },
                spec,
              },
              state,
              ...(hostMetadata !== undefined ? { hostMetadata } : {}),
            },
          ];
        }),
      ),
    };
  }

  async function rewriteFiles(root: string, markdown: boolean): Promise<void> {
    if (!existsSync(root)) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const filename = safeJoin(root, entry.name);
      if (entry.isDirectory()) {
        await rewriteFiles(filename, markdown);
      } else if (entry.isFile() && /\.(json|jsonl|md)$/.test(entry.name)) {
        if (entry.name.endsWith('.md') && !markdown) continue;
        const hostDocument =
          (root === historyDirectory &&
            /^(threads\.json|tasks\.json|events\.jsonl|delta-log\.jsonl)$/.test(
              entry.name,
            )) ||
          threadFiles.has(filename) ||
          (root === safeJoin(directory, '.ext', 'huabu.recentconversation') &&
            entry.name === 'target.json');
        if (!entry.name.endsWith('.md') && !hostDocument) continue;
        const raw = await readFile(filename, 'utf8');
        let updated: string;
        if (entry.name.endsWith('.md')) {
          const { meta, content } = parseFrontmatter(raw, { strict: true });
          const mapped =
            root === nodesDirectory ? rewrite(meta, 'node-metadata') : meta;
          if (!isRecord(mapped))
            throw new Error('Invalid imported node metadata');
          if (root === nodesDirectory) {
            const id =
              typeof meta.id === 'string' && meta.id
                ? meta.id
                : entry.name.replace(/\.md$/, '');
            const importedId = identities.get(id);
            if (importedId) mapped.id = importedId;
          }
          updated = Object.keys(mapped).length
            ? `${toFrontmatter(mapped)}\n${rewriteLinks(content)}`
            : rewriteLinks(content);
        } else if (entry.name.endsWith('.jsonl')) {
          updated = raw
            .split('\n')
            .map((line) =>
              line.trim()
                ? JSON.stringify(
                    rewrite(
                      JSON.parse(line),
                      '',
                      '',
                      root === safeJoin(historyDirectory, 'chat_v2') &&
                        internalThreads.has(
                          entry.name.replace(/\.(events|turns)\.jsonl$/, ''),
                        ),
                    ),
                  )
                : line,
            )
            .join('\n');
        } else {
          updated = JSON.stringify(
            root === safeJoin(directory, '.history') &&
              entry.name === 'threads.json'
              ? rewriteThreadRecords(JSON.parse(raw))
              : rewrite(JSON.parse(raw)),
          );
        }
        if (updated !== raw) await writeFile(filename, updated);
      } else if (entry.isSymbolicLink()) {
        throw new Error(
          'Symbolic links are not supported in imported Space records',
        );
      }
      const renamed = threadFiles.get(filename);
      if (entry.isFile() && renamed) {
        await rename(filename, renamed);
      }
    }
  }

  await rewriteFiles(nodesDirectory, true);
  await rewriteFiles(safeJoin(directory, '.history'), false);
  await rewriteFiles(safeJoin(directory, '.memory'), true);
  await rewriteFiles(
    safeJoin(directory, '.ext', 'huabu.recentconversation'),
    false,
  );

  // Bundle v2 carries Agenetes Tier-2 turns in SQLite as well as legacy JSONL.
  if (existsSync(turnsPath)) {
    const database = new DatabaseSync(turnsPath);
    try {
      database.exec('BEGIN');
      const update = database.prepare(
        'UPDATE turns SET thread_id = ?, turn_json = ? WHERE thread_id = ? AND ordinal = ?',
      );
      for (const row of database
        .prepare('SELECT thread_id, ordinal, turn_json FROM turns')
        .all()) {
        if (
          typeof row.turn_json !== 'string' ||
          typeof row.thread_id !== 'string' ||
          (typeof row.ordinal !== 'number' && typeof row.ordinal !== 'bigint')
        ) {
          throw new Error('Invalid imported turn');
        }
        const updated = JSON.stringify(
          rewrite(
            JSON.parse(row.turn_json),
            '',
            '',
            internalThreads.has(row.thread_id),
          ),
        );
        update.run(
          threadIdentity(row.thread_id),
          updated,
          row.thread_id,
          row.ordinal,
        );
      }
      for (const table of ['turn_generations', 'jsonl_imports']) {
        for (const row of database
          .prepare(`SELECT thread_id FROM ${table}`)
          .all()) {
          if (typeof row.thread_id !== 'string')
            throw new Error('Invalid imported thread key');
          database
            .prepare(`UPDATE ${table} SET thread_id = ? WHERE thread_id = ?`)
            .run(threadIdentity(row.thread_id), row.thread_id);
        }
      }
      database.exec('COMMIT');
    } finally {
      database.close();
    }
  }

  return {
    ...record,
    canvasId,
    state: {
      ...Object.fromEntries(
        Object.entries(record.state).map(([key, value]) => [
          key,
          rewrite(value, key),
        ]),
      ),
      nodes: record.state.nodes.map((node) => rewrite(node, 'nodes')),
      edges: record.state.edges.map((edge) => rewrite(edge, 'edges')),
    },
  };
}
