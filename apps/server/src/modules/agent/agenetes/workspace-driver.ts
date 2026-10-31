// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  currentWorkspaceScope,
  runInWorkspace,
} from '../../workspace/context.js';

import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { MountedAgentDriver } from '@agenetes/runtime';

/** Gateway events arrive outside the request that created the agent. */
export function withWorkspaceStateReports(
  driver: MountedAgentDriver,
): MountedAgentDriver {
  return {
    ...driver,
    create(workload, context) {
      const handle = driver.create(workload, context);
      const scope = currentWorkspaceScope();
      // Local mode keeps its process-active Workspace and original handle.
      if (!scope || !handle.onState) return handle;
      const onState = handle.onState.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'onState')
            return (listener: (snapshot: AgentStateSnapshot) => void) =>
              onState((snapshot) =>
                runInWorkspace(scope, () => listener(snapshot)),
              );
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
