import { platform } from 'node:os'
import { discoverCommand } from './common/command-discovery.js'
import { defineCommandHarness } from './common/define-command-harness.js'
import type { HarnessDefinition } from './types.js'

const prerequisites = 'Requires Node.js >=22.19.0 and native Pi on PATH: npm install -g @earendil-works/pi-coding-agent@1.5.2. Configure Pi providers/login separately. Install only one pi-acp package; discovery does not verify its version, origin, or authentication.'

export const piHarness: HarnessDefinition = {
  ...defineCommandHarness({
    id: 'pi',
    displayName: 'Pi',
    command: 'pi-acp',
    acpArgs: [],
    installHint: prerequisites,
    probeVersion: false,
  }),
  get installHint() {
    return platform() === 'win32'
      ? `${prerequisites} Windows requires pi.cmd. For fixed Windows session-path escaping, prefer npm install -g pi-acp@0.0.34 (requires Pi >=0.81.0), but its Bash output uses terminal metadata and may not display in terminal-less clients. Alternative: @geohar/pi-acp@0.4.0 exposes plain-text Bash output but has known Windows session-path quoting risks. Neither package is guaranteed fully compatible; Agentlet does not repair or switch adapters.`
      : `${prerequisites} Recommended ACP adapter: npm install -g @geohar/pi-acp@0.4.0, whose plain-text Bash output works with terminal-less clients. It lacks upstream context-usage reporting and model-specific thinking levels. Alternative: pi-acp@0.0.34 requires Pi >=0.81.0 and emits Bash output only through terminal metadata. Agentlet does not repair or switch adapters.`
  },
  async discover() {
    const nativeCommand = platform() === 'win32' ? 'pi.cmd' : 'pi'
    const [adapter, native] = await Promise.all([
      discoverCommand('pi-acp', { probeVersion: false }),
      discoverCommand(nativeCommand, { probeVersion: false }),
    ])
    const diagnostics = [
      ...(adapter.diagnostics ?? []).map((diagnostic) => ({
        code: diagnostic.code === 'binary_missing' ? 'adapter_missing' : diagnostic.code,
        message: `pi-acp: ${diagnostic.message}`,
      })),
      ...(native.diagnostics ?? []).map((diagnostic) => ({
        code: diagnostic.code === 'binary_missing' ? 'native_runtime_missing' : diagnostic.code,
        message: `${nativeCommand}: ${diagnostic.message}`,
      })),
    ]
    return {
      status: adapter.status === 'ready' && native.status === 'ready'
        ? 'ready'
        : native.status === 'ready' && !diagnostics.some(({ code }) => code === 'lookup_failed')
          ? 'adapter-missing'
          : 'not-found',
      ...(diagnostics.length ? { diagnostics } : {}),
    }
  },
}
