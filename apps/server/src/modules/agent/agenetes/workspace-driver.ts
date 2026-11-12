// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  currentWorkspaceScope,
  runInWorkspace,
} from '../../workspace/context.js';
import { getWorkspaceDirectory, getWorkspaceHandle } from '../../workspace.js';

import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { MountedAgentDriver } from '@agenetes/runtime';

/**
 * Gateway events arrive outside the request that created the agent; each
 * state listener runs in the creator's async context and captured Workspace,
 * including local mode after the process-active Workspace changes. Ordinary
 * local requests still use process state. Reports and teardown stay in the
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
      const workspace = getWorkspaceHandle();
      if (!workspace) return handle;
      const scope = currentWorkspaceScope() ?? {
        handle: workspace,
        path: getWorkspaceDirectory(),
      };
      const workspaceId = workspace.workspaceId;
      const onState = handle.onState?.bind(handle);
      const inCreator = AsyncLocalStorage.snapshot();
      const inOwner = <T>(fn: () => T): T =>
        inCreator(() => runInWorkspace(scope, fn));
      return new Proxy(handle, {
        get(target, property) {
          // Teardown may be requested outside the owning Workspace. Its final
          // reports and storage operations retain the captured owner.
          if (property === 'close') return () => inOwner(() => target.close());
          // Resolving a promise with the handle probes `then`; that is no use.
          if (
            property !== 'then' &&
            getWorkspaceHandle()?.workspaceId !== workspaceId
          )
            throw new Error('Agent handle belongs to another Workspace');
          if (property === 'onState' && onState)
            return (listener: (snapshot: AgentStateSnapshot) => void) =>
              onState((snapshot) => inOwner(() => listener(snapshot)));
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
