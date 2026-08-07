import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const physicalState = vi.hoisted(() => ({ root: '' }));

vi.mock('../agent.service.js', () => ({ runAgent: vi.fn() }));
vi.mock('./trigger.js', () => ({ readMemoryState: vi.fn() }));
vi.mock('../../../prompt/index.js', () => ({
  loadAgent: vi.fn(),
  listSkills: vi.fn(),
}));
vi.mock('../../storage/index.js', () => ({ getStructuredStore: vi.fn() }));
vi.mock('../../workspace/disk/paths.js', () => ({
  canvasMemoryPath: (canvasId: string) =>
    `${physicalState.root}/${canvasId}/.memory/space.md`,
  chatDir: (canvasId: string) =>
    `${physicalState.root}/${canvasId}/.history/chat`,
  workspaceMemoryPath: () => `${physicalState.root}/setting/user.md`,
}));

import { runAgent } from '../agent.service.js';
import { runAnalysisPass } from './analyzer.js';
import { readMemoryState } from './trigger.js';
import { loadAgent, listSkills } from '../../../prompt/index.js';
import { getStructuredStore } from '../../storage/index.js';

import type {
  CanvasEvent,
  CanvasFile,
  SpaceHandle,
} from '../../storage/index.js';
import type { IntentEpisode } from '@sediment/shared';

let root = '';

async function* emptyAgentStream() {}

function canvasRecord(): CanvasFile {
  return {
    canvasId: 'canvas-a',
    title: 'Canvas A',
    version: 2,
    state: {
      nodes: [
        {
          id: 'node-a',
          type: 'note',
          position: { x: 12, y: 24 },
          data: { label: 'First note' },
        },
      ],
      edges: [],
    },
    createdAt: 1,
    updatedAt: 2,
  } as CanvasFile;
}

function episode(id: string, timestamp: number): IntentEpisode {
  return {
    id,
    timestamp,
    contextSummary: `context-${id}`,
    candidates: [],
    outcome: {
      type: 'selected',
      chosenIndex: 0,
      chosenLabel: `choice-${id}`,
    },
  };
}

function createHandle(
  options: {
    record?: CanvasFile | null;
    recordError?: Error;
    events?: CanvasEvent[];
    eventsError?: Error;
    intents?: IntentEpisode[];
    intentsError?: Error;
  } = {},
) {
  const record = 'record' in options ? options.record : canvasRecord();
  const recordRead = options.recordError
    ? vi.fn().mockRejectedValue(options.recordError)
    : vi.fn().mockResolvedValue(record);
  const eventsRead = options.eventsError
    ? vi.fn().mockRejectedValue(options.eventsError)
    : vi.fn().mockResolvedValue(options.events ?? []);
  const intentsRead = options.intentsError
    ? vi.fn().mockRejectedValue(options.intentsError)
    : vi.fn().mockResolvedValue(options.intents ?? []);
  const handle = {
    canvasId: 'canvas-a',
    record: { read: recordRead },
    events: { read: eventsRead },
    intents: { read: intentsRead },
  } as unknown as SpaceHandle;
  return { handle, recordRead, eventsRead, intentsRead };
}

function installHandle(handle: SpaceHandle) {
  const space = vi.fn(() => handle);
  vi.mocked(getStructuredStore).mockReturnValue({
    space,
  } as unknown as ReturnType<typeof getStructuredStore>);
  return space;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sediment-memory-analyzer-'));
  physicalState.root = root;
  vi.mocked(runAgent)
    .mockReset()
    .mockReturnValue(
      emptyAgentStream() as unknown as ReturnType<typeof runAgent>,
    );
  vi.mocked(readMemoryState).mockReset().mockReturnValue({
    counter: 0,
    lastAnalyzedAt: null,
    lastSeenThreadCursor: null,
    lastSeenIntentCursor: 10,
  });
  vi.mocked(loadAgent)
    .mockReset()
    .mockReturnValue({
      systemPrompt: 'memory system prompt',
      runtime: { maxIterations: 5 },
    } as ReturnType<typeof loadAgent>);
  vi.mocked(listSkills).mockReset().mockReturnValue([]);
  vi.mocked(getStructuredStore).mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runAnalysisPass repository sources', () => {
  it('skips a missing Space before reading logs or starting the agent', async () => {
    const { handle, recordRead, eventsRead, intentsRead } = createHandle({
      record: null,
    });
    const space = installHandle(handle);

    await expect(runAnalysisPass('canvas-a')).resolves.toEqual({
      status: 'skipped',
      reason: 'space-not-found',
    });
    expect(space).toHaveBeenCalledTimes(1);
    expect(space).toHaveBeenCalledWith('canvas-a');
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(eventsRead).not.toHaveBeenCalled();
    expect(intentsRead).not.toHaveBeenCalled();
    expect(readMemoryState).not.toHaveBeenCalled();
    expect(loadAgent).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('assembles record, event, and intent context through one handle', async () => {
    const events: CanvasEvent[] = [
      {
        ts: 11,
        payload: {
          action: 'node_selected',
          node: { id: 'node-a', type: 'note', label: 'First note' },
        },
      },
      {
        ts: 12,
        payload: {
          action: 'node_selected',
          node: { id: 'node-b', type: 'note', label: 'Second note' },
          kind: 'legacy-kind',
          description: 'x'.repeat(130),
        } as unknown as CanvasEvent['payload'],
      },
    ];
    const { handle, recordRead, eventsRead, intentsRead } = createHandle({
      events,
      intents: [episode('old', 5), episode('fresh', 20)],
    });
    const space = installHandle(handle);

    await expect(runAnalysisPass('canvas-a')).resolves.toEqual({
      status: 'completed',
      results: [],
      latestChatTs: null,
      latestIntentTs: 20,
    });

    expect(space).toHaveBeenCalledTimes(1);
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(eventsRead).toHaveBeenCalledWith(100);
    expect(intentsRead).toHaveBeenCalledTimes(1);
    expect(recordRead.mock.invocationCallOrder[0]).toBeLessThan(
      eventsRead.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(recordRead.mock.invocationCallOrder[0]).toBeLessThan(
      intentsRead.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const call = vi.mocked(runAgent).mock.calls[0]?.[0];
    const messages = call?.context.messages ?? [];
    const text = messages.map((message) => message.content).join('\n---\n');
    expect(text).toContain('[SYSTEM Canvas snapshot]\ntitle: Canvas A');
    expect(text).toContain('- [note] node-a "First note" @ (12,24)');
    // Phase 3 deliberately preserves the known payload.kind/action bug.
    expect(text).toContain('[SYSTEM Recent ops]\n- event: ');
    expect(text).toContain(`- legacy-kind: ${'x'.repeat(120)}`);
    expect(text).not.toContain(`- legacy-kind: ${'x'.repeat(121)}`);
    expect(text).toContain('summary: 1 new episode(s)');
    expect(text).toContain('selected "choice-fresh"');
    expect(text).not.toContain('choice-old');
  });

  it.each(['record', 'events', 'intents'] as const)(
    'propagates strict %s repository failures without starting the agent',
    async (source) => {
      const error = new Error(`${source} failed`);
      const setup = createHandle({
        ...(source === 'record' ? { recordError: error } : {}),
        ...(source === 'events' ? { eventsError: error } : {}),
        ...(source === 'intents' ? { intentsError: error } : {}),
      });
      installHandle(setup.handle);

      await expect(runAnalysisPass('canvas-a')).rejects.toBe(error);
      expect(runAgent).not.toHaveBeenCalled();
      if (source === 'record') {
        expect(setup.eventsRead).not.toHaveBeenCalled();
        expect(setup.intentsRead).not.toHaveBeenCalled();
      }
    },
  );
});
