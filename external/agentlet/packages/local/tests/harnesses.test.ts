import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { HarnessDiscoveryResult, JsonRpcMessage } from '@agentlet/protocol'
import { ServerMethods } from '@agentlet/protocol'

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  mkdir: vi.fn(),
  platform: vi.fn(() => 'linux'),
  home: vi.fn(() => '/home/agentlet-test'),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.probe }) }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), mkdir: mocks.mkdir,
}))
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(), platform: mocks.platform, homedir: mocks.home,
}))

import { KNOWN_CLIS } from '../src/harnesses/catalogue.js'
import { discoverHarnesses, parseHarnessDiscoveryParams } from '../src/harnesses/detect.js'
import { prepareHarnessWorkspace } from '../src/harnesses/workspace.js'
import { Agentlet } from '../src/agentlet.js'
import { AgentProcess } from '../src/agent-process.js'
import { Logger } from '../src/logger.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform.mockReturnValue('linux')
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.probe.mockImplementation(async (file: string, args: string[]) => ({
    stdout: file === 'which' ? `/usr/local/bin/${args[0]}\n` : '1.2.3\nignored',
    stderr: '',
  }))
})

describe('trusted harness discovery', () => {
  it('returns the complete stable catalogue without creating workspaces by default', async () => {
    const { harnesses } = await discoverHarnesses()
    expect(harnesses.map((entry) => entry.id)).toEqual(KNOWN_CLIS.map((entry) => entry.id))
    expect(harnesses).toHaveLength(10)
    expect(harnesses.every((entry) => entry.installed)).toBe(true)
    expect(harnesses.every((entry) => !('skipVersionProbe' in entry))).toBe(true)
    expect(harnesses.every((entry) => !entry.workingDirPath)).toBe(true)
    expect(harnesses[0]).toMatchObject({ executablePath: '/usr/local/bin/copilot', version: '1.2.3' })
    expect(mocks.mkdir).not.toHaveBeenCalled()
    for (const [file, , options] of mocks.probe.mock.calls) {
      expect(file).not.toBe('sh')
      expect(options).toMatchObject({ shell: false, timeout: 2500, maxBuffer: 65536, killSignal: 'SIGKILL' })
    }
  })

  it('never invokes adapters that skip the optional version probe', async () => {
    const { harnesses } = await discoverHarnesses()
    expect(KNOWN_CLIS.filter((entry) => entry.skipVersionProbe).map((entry) => entry.id))
      .toEqual(['claude', 'codex', 'hermes'])
    for (const cli of KNOWN_CLIS.filter((entry) => entry.skipVersionProbe)) {
      expect(mocks.probe).not.toHaveBeenCalledWith(`/usr/local/bin/${cli.binary}`, ['--version'], expect.anything())
      expect(harnesses.find((entry) => entry.id === cli.id)?.version).toBeUndefined()
    }
  })

  it('distinguishes a missing binary from a failed or timed-out PATH lookup', async () => {
    mocks.probe.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === 'copilot') throw Object.assign(new Error('not found'), { code: 1 })
      if (args[0] === 'gemini') throw Object.assign(new Error('lookup timed out'), { killed: true, code: 1 })
      throw Object.assign(new Error('lookup executable missing'), { code: 'ENOENT' })
    })
    const { harnesses } = await discoverHarnesses({ prepareWorkspaces: true })
    expect(harnesses.every((entry) => !entry.installed)).toBe(true)
    expect(harnesses[0]?.diagnostics?.[0]?.code).toBe('binary_missing')
    expect(harnesses.find((entry) => entry.id === 'gemini')?.diagnostics?.[0]?.code).toBe('lookup_failed')
    expect(harnesses.find((entry) => entry.id === 'qwen')?.diagnostics?.[0]?.code).toBe('lookup_failed')
    expect(mocks.mkdir).not.toHaveBeenCalled()
  })

  it.each(['', 'failure', 'timeout'])('keeps installed state when version is unknown: %s', async (outcome) => {
    mocks.probe.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'which') return { stdout: `/usr/local/bin/${args[0]}\n` }
      if (outcome) throw Object.assign(new Error(outcome), { killed: outcome === 'timeout' })
      return { stdout: '' }
    })
    const { harnesses } = await discoverHarnesses({ prepareWorkspaces: true })
    expect(harnesses[0]).toMatchObject({
      installed: true,
      workingDirPath: join('/home/agentlet-test', '.agentlet', 'workspace', 'copilot'),
      diagnostics: [{ code: outcome ? 'version_probe_failed' : 'version_unknown', message: expect.any(String) }],
    })
    expect(harnesses[0]?.version).toBeUndefined()
  })

  it('supports Windows lookup without a shell and probes the first absolute result', async () => {
    mocks.platform.mockReturnValue('win32')
    mocks.probe.mockImplementation(async (file: string, args: string[]) => ({
      stdout: file === 'where.exe' ? `C:\\Tools\\${args[0]}.exe\r\nD:\\Other\\${args[0]}.exe\r\n` : '2.0\r\n',
    }))
    expect((await discoverHarnesses()).harnesses[0]).toMatchObject({
      executablePath: 'C:\\Tools\\copilot.exe', installed: true, version: '2.0',
    })
    expect(mocks.probe).toHaveBeenCalledWith('C:\\Tools\\copilot.exe', ['--version'], expect.objectContaining({ shell: false }))
  })

  it('does not trust malformed lookup output', async () => {
    mocks.probe.mockResolvedValue({ stdout: 'relative-path' })
    expect((await discoverHarnesses()).harnesses[0]).toMatchObject({
      installed: false, diagnostics: [{ code: 'lookup_failed', message: expect.any(String) }],
    })
  })

  it('reuses daemon-local workspaces without clearing them and never accepts arbitrary IDs', async () => {
    const expected = join('/home/agentlet-test', '.agentlet', 'workspace', 'copilot')
    expect(await prepareHarnessWorkspace('copilot')).toBe(expected)
    expect(await prepareHarnessWorkspace('copilot')).toBe(expected)
    expect(mocks.mkdir).toHaveBeenNthCalledWith(1, expected, { recursive: true })
    expect(mocks.mkdir).toHaveBeenNthCalledWith(2, expected, { recursive: true })
    await expect(prepareHarnessWorkspace('../escape')).rejects.toThrow('Unknown harness')
    await expect(prepareHarnessWorkspace('/absolute')).rejects.toThrow('Unknown harness')
    expect(mocks.mkdir).toHaveBeenCalledTimes(2)
  })

  it('reports workspace failure without losing installation state or returning a fallback path', async () => {
    mocks.mkdir.mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }))
    const { harnesses } = await discoverHarnesses({ prepareWorkspaces: true })
    expect(harnesses[0]).toMatchObject({
      installed: true, diagnostics: [{ code: 'workspace_failed', message: 'access denied' }],
    })
    expect(harnesses[0]?.workingDirPath).toBeUndefined()
  })

  it.each([null, [], true, { prepareWorkspaces: 'yes' }, { command: 'evil' }, { candidates: [] }, { root: '/elsewhere' }])(
    'rejects invalid discovery options %j', (params) => {
      expect(() => parseHarnessDiscoveryParams(params)).toThrow()
    },
  )
})

describe('daemon discovery RPC', () => {
  function createDaemon() {
    const daemon = new Agentlet({
      server: 'wss://example.test', token: 'test', reconnectMax: 1,
      bufferLimit: 10, heartbeat: 0, allowInsecure: false, logLevel: 'error', maxAgents: 10,
    }, new Logger('error'))
    const responses: JsonRpcMessage[] = []
    const internal = daemon as unknown as {
      controlWs: { readyState: number; send: (text: string) => void }
      handleDaemonRequest: (request: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }) => void
    }
    internal.controlWs = { readyState: 1, send: (text) => responses.push(JSON.parse(text)) }
    return {
      async request(method: string, params?: unknown) {
        internal.handleDaemonRequest({ jsonrpc: '2.0', id: 12, method, params })
        await vi.waitFor(() => expect(responses).toHaveLength(1))
        return responses[0]!
      },
    }
  }

  it.each([undefined, {}, { prepareWorkspaces: false }, { prepareWorkspaces: true }])(
    'honors the explicit workspace option %j without ACP startup', async (params) => {
      const start = vi.spyOn(AgentProcess.prototype, 'start')
      try {
        const response = await createDaemon().request(ServerMethods.DISCOVER_HARNESSES, params)
        expect(response).toHaveProperty('result')
        const result = ('result' in response ? response.result : undefined) as HarnessDiscoveryResult
        expect(result.harnesses).toHaveLength(10)
        expect(mocks.mkdir).toHaveBeenCalledTimes(params && 'prepareWorkspaces' in params && params.prepareWorkspaces ? 10 : 0)
        expect(start).not.toHaveBeenCalled()
      } finally {
        start.mockRestore()
      }
    },
  )

  it('rejects unknown options before probing', async () => {
    expect(await createDaemon().request(ServerMethods.DISCOVER_HARNESSES, { roots: ['/elsewhere'] }))
      .toMatchObject({ error: { code: -32602 } })
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}])('refuses any retired agentTeam field, even alongside a command (%j)', async (agentTeam) => {
    expect(await createDaemon().request(ServerMethods.SPAWN, {
      sessionSpec: { command: 'must-not-run', agentTeam },
    })).toMatchObject({ error: { code: -32602, message: expect.stringContaining('agentTeam') } })
  })

  it.each(['agent-team/scan', 'agent-team/setup', 'agent-team/setup-cancel', 'agent-team/validate'])(
    'does not implement retired RPC %s', async (method) => {
      expect(await createDaemon().request(method, {})).toMatchObject({ error: { code: -32601 } })
    },
  )
})
