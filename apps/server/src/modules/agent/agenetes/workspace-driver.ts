// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';

import { currentWorkspaceScope } from '../../workspace/context.js';

import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { MountedAgentDriver } from '@agenetes/runtime';

/**
 * Gateway events arrive outside the request that created the agent; each
 * state listener runs in that request's async context instead, and so in the
 * Workspace the agent was created in.
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
      const onState = handle.onState.bind(handle);
      const inCreator = AsyncLocalStorage.snapshot();
      return new Proxy(handle, {
        get(target, property) {
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
