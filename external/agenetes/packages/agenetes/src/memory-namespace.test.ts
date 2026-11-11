import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './mount.js';
import { InMemoryTurnStore } from './turn-store.js';

import type { PersistedTurn } from './turn-store.js';
import type { Namespace } from '@agenetes/protocol';

const schema = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
};
const driver = defineDriver({
  schemaVersion: 1,
  workloadTypes: ['Deployment'],
  specSchema: schema,
  stateSchema: schema,
  initialState: () => ({}),
  create: (spec) => ({
    capabilities: { supportedControlMessages: [], turnInput: 'blocking' },
    async *run() {
      yield { type: 'text_delta', data: { content: String(spec.spec) } };
      yield { type: 'end', data: {} };
    },
    async control() {
      return { ok: true };
    },
    close() {},
  }),
});

const pairs: [string, Namespace, Namespace][] = [
  ['owners', { name: 'same', ownerId: 'a' }, { name: 'same', ownerId: 'b' }],
  [
    'owners sharing a root',
    { name: 'same', ownerId: 'a', storage: { root: '/same' } },
    { name: 'same', ownerId: 'b', storage: { root: '/same' } },
  ],
  [
    'ownerless roots',
    { name: 'same', storage: { root: '/a' } },
    { name: 'same', storage: { root: '/b' } },
  ],
];

describe.each(pairs)(
  'default stores isolate matching names across %s',
  (_label, a, b) => {
    it('keeps records, folded history and event tails in the owning namespace', async () => {
      const instance = mountAgenetes({ drivers: { test: driver } });
      const spec = (namespace: Namespace, content: string) => ({
        kind: 'test',
        workloadType: 'Deployment' as const,
        threadId: 'same-thread',
        namespace,
        spec: content,
      });
      const first = await instance.create(spec(a, 'a-private'));
      try {
        for await (const _event of first.run(null, {})) {
          /* drain */
        }
        expect(
          (await instance.history(b, 'same-thread', { withTail: true })).turns,
        ).toEqual([]);
        expect(await instance.records(b)).toEqual([]);
        const second = await instance.create(spec(b, 'b-private'));
        for await (const _event of second.run(null, {})) {
          /* drain */
        }
        expect((await instance.record(a, 'same-thread'))?.spec.spec).toBe(
          'a-private',
        );
        expect((await instance.record(b, 'same-thread'))?.spec.spec).toBe(
          'b-private',
        );
        const history = await instance.history(b, 'same-thread', {
          withTail: true,
        });
        expect(history.turns).toHaveLength(1);
        expect(history.turns[0]!.transcript).toEqual([
          { type: 'text', data: { content: 'b-private' } },
        ]);
        expect(await instance.logMetadata(a, 'same-thread')).toEqual(
          await instance.logMetadata(b, 'same-thread'),
        );
        await instance.close('same-thread', a);
        expect(instance.get('same-thread', b)).toBe(second);
      } finally {
        await instance.close('same-thread', a);
        await instance.close('same-thread', b);
      }
    });

    it("does not replace, delete or invalidate another namespace's turn cursor", () => {
      const store = new InMemoryTurnStore();
      const persisted = (text: string, seq: number): PersistedTurn => ({
        seqStart: seq,
        seqEnd: seq,
        turn: { request: { type: 'user_text', content: text }, transcript: [] },
      });
      store.append(a, 'same-thread', persisted('a', 1));
      store.append(b, 'same-thread', persisted('b-1', 1));
      store.append(b, 'same-thread', persisted('b-2', 2));
      const before = store.page(b, 'same-thread', { limit: 1 }).before!;
      store.replace(a, 'same-thread', [persisted('replacement', 1)]);
      store.delete(a, 'same-thread');
      expect(store.list(b, 'same-thread')).toEqual([
        persisted('b-1', 1),
        persisted('b-2', 2),
      ]);
      expect(
        store.page(b, 'same-thread', { limit: 1, before }).groups[0]!.turns,
      ).toEqual([persisted('b-1', 1)]);
      expect(store.count(b, 'same-thread')).toBe(2);
      expect(store.fence(b, 'same-thread')).toBe(2);
    });
  },
);
