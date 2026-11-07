// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';

import { currentWorkspaceScope } from '../../workspace/context.js';
import { getWorkspaceHandle } from '../../workspace.js';

import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { MountedAgentDriver } from '@agenetes/runtime';

/**
 * Gateway events arrive outside the request that created the agent; each
 * state listener runs in that request's async context instead, and so in the
 * Workspace the agent was created in. Using the handle from another Workspace
 * is refused, except closing it, which also runs in the creator's context.
 */
export function withWorkspaceStateReports(
  driver: MountedAgentDriver,
): MountedAgentDriver {
  return {
    ...driver,
    create(workload, context) {
      const handle = driver.create(workload, context);
      // Local mode keeps its process-active Workspace and original handle.
      if (!currentWorkspaceScope() || !handle.onState) return handle;
      const workspaceId = getWorkspaceHandle()?.workspaceId;
      const onState = handle.onState.bind(handle);
      const inCreator = AsyncLocalStorage.snapshot();
      return new Proxy(handle, {
        get(target, property) {
          // Closing is how a Space displaces a handle another Workspace holds
          // under its thread id; the teardown runs in the creator's context,
          // so whatever it persists lands in the owning Workspace.
          if (property === 'close')
            return () => inCreator(() => target.close());
          // Resolving a promise with the handle probes `then`; that is no use.
          if (
            property !== 'then' &&
            getWorkspaceHandle()?.workspaceId !== workspaceId
          )
            throw new Error('Agent handle belongs to another Workspace');
          if (property === 'onState')
            return (listener: (snapshot: AgentStateSnapshot) => void) =>
              onState((snapshot) => inCreator(listener, snapshot));
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
