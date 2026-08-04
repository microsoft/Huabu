/**
 * Reusable contract for {@link SpaceRepository}.
 *
 * ⚠️ **Adapter-local guarantees.** Everything asserted here is a property of
 * the adapter under test, *not* of the running application. The compatibility
 * facade is still a second mutation entry point (see
 * docs/proposals/multi-backend-storage.md §12.2.3), so a facade writer can
 * interleave without passing through this repository. A passing run means the
 * adapter upholds single-winner CAS; it does not mean the system has one
 * write authority. Promoting these to system guarantees is a later phase's
 * job, once the last legacy mutation entry point is gone.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceRepository } from '../structured.js';

export interface SpaceRepositoryHarness {
  /** Repository under test, scoped to a Space that already exists. */
  repository: SpaceRepository;
  /** Repository scoped to a Space id that has no record. */
  missing: SpaceRepository;
  /**
   * The id `missing` is scoped to. A repository is scoped by construction and
   * does not expose its own id, so the harness has to name it for the suite
   * to build a well-formed record aimed at it.
   */
  missingCanvasId: string;
  /**
   * A second repository handle for the *same* Space as `repository`, used by
   * the concurrency case so the two writers are genuinely independent objects
   * rather than one instance called twice.
   */
  concurrent: SpaceRepository;
  cleanup?: () => Promise<void> | void;
}

/** Yield to the macrotask queue — long enough for a pending write to land. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function describeSpaceRepositoryContract(
  name: string,
  createHarness: () => Promise<SpaceRepositoryHarness> | SpaceRepositoryHarness,
): void {
  describe(`SpaceRepository contract (adapter-local): ${name}`, () => {
    let harness: SpaceRepositoryHarness | null = null;

    async function open(): Promise<SpaceRepositoryHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    /** Build the next record from a current one, bumping only the version. */
    function bump(current: CanvasFile, nodes: unknown[] = []): CanvasFile {
      return {
        ...current,
        version: current.version + 1,
        state: { ...current.state, nodes },
        updatedAt: current.updatedAt + 1,
      };
    }

    it('reads null for a Space with no record', async () => {
      const { missing } = await open();
      await expect(missing.read()).resolves.toBeNull();
    });

    it('reads back the record it stored', async () => {
      const { repository } = await open();
      const current = await repository.read();
      expect(current).not.toBeNull();

      const next = bump(current!, [{ id: 'n1' }]);
      await expect(repository.compareAndSwap(current!.version, next)).resolves
        .toEqual({ ok: true });

      const stored = await repository.read();
      expect(stored?.version).toBe(next.version);
      expect(stored?.state.nodes).toEqual([{ id: 'n1' }]);
    });

    it('reports not-found when the Space has no record', async () => {
      const { missing, missingCanvasId } = await open();
      const result = await missing.compareAndSwap(0, {
        canvasId: missingCanvasId,
        title: null,
        version: 1,
        state: { nodes: [], edges: [] },
        createdAt: 1,
        updatedAt: 2,
      });
      expect(result).toEqual({ ok: false, reason: 'not-found' });
    });

    it('reports version-conflict with the actual version', async () => {
      const { repository } = await open();
      const current = await repository.read();
      await repository.compareAndSwap(current!.version, bump(current!));

      // Retry with the now-stale baseline.
      const stale = await repository.compareAndSwap(
        current!.version,
        bump(current!),
      );
      expect(stale).toEqual({
        ok: false,
        reason: 'version-conflict',
        actualVersion: current!.version + 1,
      });
    });

    it('refuses a record whose canvasId is not this Space', async () => {
      const { repository } = await open();
      const current = await repository.read();
      await expect(
        repository.compareAndSwap(current!.version, {
          ...bump(current!),
          canvasId: 'someone-else',
        }),
      ).rejects.toThrow();
    });

    it('refuses a next version that is not expectedVersion + 1', async () => {
      const { repository } = await open();
      const current = await repository.read();
      await expect(
        repository.compareAndSwap(current!.version, {
          ...current!,
          version: current!.version + 2,
        }),
      ).rejects.toThrow();
      await expect(
        repository.compareAndSwap(current!.version, { ...current! }),
      ).rejects.toThrow();
    });

    it('refuses to change the immutable identity fields', async () => {
      const { repository } = await open();
      const current = await repository.read();

      await expect(
        repository.compareAndSwap(current!.version, {
          ...bump(current!),
          title: 'renamed through the record path',
        }),
      ).rejects.toThrow();

      await expect(
        repository.compareAndSwap(current!.version, {
          ...bump(current!),
          createdAt: current!.createdAt + 1000,
        }),
      ).rejects.toThrow();

      // The refusal must not have partially applied.
      expect((await repository.read())?.version).toBe(current!.version);
    });

    it('lets exactly one of two writers racing from one tick win', async () => {
      const { repository, concurrent } = await open();
      const current = await repository.read();
      const baseline = current!.version;

      // Both writers read the same baseline and are issued with **no
      // intervening await**. This is the arrangement that actually
      // discriminates: an adapter whose critical section runs to completion
      // in one turn serializes them, while one that `await`s between its
      // version read and its write lets the second writer observe the stale
      // version and both "succeed" — a lost update. Yielding before the
      // second call instead would make this sequential and vacuous, because
      // the second writer would simply read the already-updated record.
      const results = await Promise.all([
        repository.compareAndSwap(baseline, bump(current!, [{ id: 'first' }])),
        concurrent.compareAndSwap(baseline, bump(current!, [{ id: 'second' }])),
      ]);

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toEqual([
        {
          ok: false,
          reason: 'version-conflict',
          actualVersion: baseline + 1,
        },
      ]);

      // And exactly one write landed: the version advanced by one, not two,
      // and the record is not a mix of both writers' state.
      const stored = await repository.read();
      expect(stored?.version).toBe(baseline + 1);
      expect(stored?.state.nodes).toEqual([{ id: 'first' }]);
    });

    it('refuses a second write against a baseline that has moved on', async () => {
      const { repository, concurrent } = await open();
      const current = await repository.read();
      const baseline = current!.version;

      // The sequential counterpart: the writers are separated by a yield, so
      // the second one is issued against a record that has already advanced.
      await repository.compareAndSwap(baseline, bump(current!, [{ id: 'a' }]));
      await tick();

      const late = await concurrent.compareAndSwap(
        baseline,
        bump(current!, [{ id: 'b' }]),
      );
      expect(late).toEqual({
        ok: false,
        reason: 'version-conflict',
        actualVersion: baseline + 1,
      });
      expect((await repository.read())?.state.nodes).toEqual([{ id: 'a' }]);
    });
  });
}
