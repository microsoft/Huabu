/**
 * L1 wiring for the ACP profile-schema-cache port (M3).
 *
 * The ACP composition shell (`service.ts`, destined L2) does not import the
 * profile-schema cache directly — it declares an {@link AcpProfileCachePort}
 * it needs and consumes whatever L1 injects. This module is that injection:
 * it assembles the port from the L1-owned cache functions and installs it
 * into the shell. Called once by the host composition root (`app.ts`).
 *
 * This keeps the dependency arrow L1→L2: the cache (an L1 UX concern) is fed
 * BY L1 from the meta pushes L2 surfaces, rather than L2 reaching up into the
 * cache. See docs/proposals/layered-architecture.md §7 (M3).
 */

import {
  getProfileSchemaCache,
  mirrorAcpEntryToProfileCache,
} from './profile-schema-cache.js';
import { setAcpProfileCachePort } from './service.js';

/** Install the L1 profile-schema-cache port into the ACP composition shell. */
export function installAcpProfileCachePort(): void {
  setAcpProfileCachePort({
    mirror: mirrorAcpEntryToProfileCache,
    readCommands: (profileId) => {
      const cache = getProfileSchemaCache(profileId);
      if (!cache?.availableCommands || cache.availableCommands.length === 0) {
        return null;
      }
      return {
        availableCommands: cache.availableCommands,
        commandsUpdatedAt: cache.commandsUpdatedAt ?? 0,
      };
    },
  });
}
