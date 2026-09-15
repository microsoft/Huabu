// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentBindingSchema } from '@huabu/shared';
import {
  AGENT_NODE_PREPARATION_KEYS,
  changesAgentNodePreparation,
} from '@huabu/shared/canvas-engine';

import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  INTERNAL_DRIVER_KIND,
} from './agenetes/drivers.js';
import { agentNodeLifecycle } from './agent-node-lifecycle.js';
import { acquireAgentTurn } from './turn-lease.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { AgentBinding } from '@huabu/shared';

type ExecutionRecord = NonNullable<ReturnType<typeof agenetes.record>>;

interface BindingDependencies {
  record: (target: AgentNodeTarget) => ExecutionRecord | undefined;
  hasHistory: (target: AgentNodeTarget) => boolean;
  promote: (target: AgentNodeTarget, alreadyLocked?: boolean) => Promise<void>;
  acquireTurn: typeof acquireAgentTurn;
}

export class AgentNodeBindingError extends Error {
  constructor(
    public readonly code:
      | 'execution_record_missing'
      | 'execution_record_invalid'
      | 'agent_binding_conflict'
      | 'agent_draft_busy',
    message: string,
  ) {
    super(message);
    this.name = 'AgentNodeBindingError';
  }
}

export function sameAgentIdentity(
  left: AgentBinding,
  right: AgentBinding,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'external' ||
      (right.kind === 'external' && left.profileId === right.profileId))
  );
}

const DEFAULT_DEPENDENCIES: BindingDependencies = {
  record: (target) =>
    agenetes.record(canvasAcpNamespace(target.canvasId), target.threadId),
  hasHistory: (target) =>
    agenetes.history(canvasAcpNamespace(target.canvasId), target.threadId, {
      withTail: true,
    }).turns.length > 0,
  promote: (target, alreadyLocked) =>
    agentNodeLifecycle.bind(target, alreadyLocked),
  acquireTurn: acquireAgentTurn,
};

/** Canonical record confirmation, shared by prompts, controls and draft writes. */
export class AgentNodeBindingCoordinator {
  constructor(
    private readonly dependencies: BindingDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async confirm(
    target: AgentNodeTarget,
    options: {
      required?: boolean;
      alreadyLocked?: boolean;
      record?: ExecutionRecord | null;
    } = {},
  ): Promise<AgentBinding | null> {
    const record =
      options.record === undefined
        ? this.dependencies.record(target)
        : options.record;
    if (!record) {
      if (
        options.required ||
        target.bindingState === 'bound' ||
        this.dependencies.hasHistory(target)
      ) {
        throw new AgentNodeBindingError(
          'execution_record_missing',
          `Thread ${target.threadId} has no canonical execution record`,
        );
      }
      return null;
    }
    const spec = record.spec;
    if (
      spec.threadId !== target.threadId ||
      spec.namespace.name !== target.canvasId
    ) {
      throw new AgentNodeBindingError(
        'execution_record_invalid',
        `Thread ${target.threadId} has a mismatched execution record`,
      );
    }
    let binding: AgentBinding;
    if (spec.kind === INTERNAL_DRIVER_KIND) {
      binding = { kind: 'internal' };
    } else if (spec.kind === EXTERNAL_DRIVER_KIND) {
      const driverSpec = spec.spec as { binding?: Record<string, unknown> };
      const parsed = agentBindingSchema.safeParse({
        ...driverSpec.binding,
        kind: 'external',
      });
      if (!parsed.success) {
        throw new AgentNodeBindingError(
          'execution_record_invalid',
          `Thread ${target.threadId} has an invalid external execution binding`,
        );
      }
      binding = parsed.data;
    } else {
      throw new AgentNodeBindingError(
        'execution_record_invalid',
        `Thread ${target.threadId} uses an unsupported driver`,
      );
    }
    if (target.bindingState !== 'bound') {
      await this.dependencies.promote(target, options.alreadyLocked);
      target.bindingState = 'bound';
    }
    this.assertRequestedBinding(binding, target.agentBinding);
    return binding;
  }

  assertRequestedBinding(saved: AgentBinding, requested?: AgentBinding): void {
    if (requested && !sameAgentIdentity(saved, requested)) {
      throw new AgentNodeBindingError(
        'agent_binding_conflict',
        'The requested Agent does not match the acknowledged execution binding',
      );
    }
  }

  /**
   * Called with the Canvas mutex held. Never wait for a turn here: move and
   * prompt admission acquire these same resources in opposite order.
   * Keep the returned lease until the draft has actually been persisted.
   */
  async guardDraftEdit(
    target: AgentNodeTarget,
    patch: Record<string, unknown>,
  ): Promise<() => void> {
    if (
      !AGENT_NODE_PREPARATION_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(patch, key),
      )
    )
      return () => {};
    const changed = changesAgentNodePreparation(
      {
        agentBinding: target.agentBinding,
        agentLaunchOverrides: target.launchOverrides,
      },
      patch,
    );
    if (target.bindingState === 'bound') {
      if (changed)
        throw new AgentNodeBindingError(
          'agent_binding_conflict',
          'Execution preparation cannot change after binding',
        );
      return () => {};
    }
    const release = this.dependencies.acquireTurn(target.threadId);
    if (!release) {
      // A layout save can echo unchanged preparation while an admitted turn
      // owns confirmation. It cannot replace that turn's configuration.
      if (!changed) return () => {};
      throw new AgentNodeBindingError(
        'agent_draft_busy',
        `Thread ${target.threadId} is preparing or running`,
      );
    }
    try {
      const canonical = await this.confirm(target, { alreadyLocked: true });
      if (canonical && changed) {
        throw new AgentNodeBindingError(
          'agent_binding_conflict',
          'Execution preparation cannot change after binding',
        );
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
}

export const agentNodeBinding = new AgentNodeBindingCoordinator();
