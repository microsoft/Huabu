import { describe, expect, it } from 'vitest'
import { createBootstrapEnv, interpolateBootstrapDestination, parseBootstrapEnv } from '../src/bootstrap-env.js'
import { buildAgentProcessEnv } from '../src/agentlet.js'
import { parseCli } from '../src/cli.js'

describe('opaque bootstrap environment', () => {
  it('defaults to an empty frozen map', () => {
    const result = createBootstrapEnv()
    expect(result).toEqual({})
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('copies values without trimming, interpolation or path resolution', () => {
    const values = { ENTRY: ' relative path=a=b ', EMPTY: '', TEMPLATE: '${HOME}' }
    const result = createBootstrapEnv(Object.entries(values))
    values.ENTRY = 'changed'
    expect(result).toEqual({ ENTRY: ' relative path=a=b ', EMPTY: '', TEMPLATE: '${HOME}' })
    expect(Object.isFrozen(result)).toBe(true)
    expect(parseBootstrapEnv(['ENTRY= a=b ', 'EMPTY='])).toEqual({ ENTRY: ' a=b ', EMPTY: '' })
  })

  it('parses repeated CLI injections and keeps the generic default empty', () => {
    const argv = ['node', 'agentlet', 'daemon', '--server', 'wss://example.test', '--token', 'token']
    expect(parseCli(argv).options.bootstrapEnv).toEqual({})
    expect(parseCli([...argv, '--env-inject', 'ENTRY= a=b ', '--env-inject', 'EMPTY=']).options.bootstrapEnv)
      .toEqual({ ENTRY: ' a=b ', EMPTY: '' })
  })

  it.each(['NO_EQUALS', '=secret', 'BAD-KEY=secret', '1KEY=secret', 'KEY=secret\0value', 'BAD\0KEY=secret', 'AGENTLET_TOKEN=secret', 'AGENTLET_SERVER=secret'])(
    'rejects malformed or reserved declarations without logging values (%s)', declaration => {
      let message = ''
      try { parseBootstrapEnv([declaration]) } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('secret')
    },
  )

  it('rejects duplicate keys and applies target-platform case rules', () => {
    expect(() => parseBootstrapEnv(['KEY=a', 'KEY=b'], 'linux')).toThrow('Duplicate')
    expect(() => parseBootstrapEnv(['KEY=a', 'key=b'], 'win32')).toThrow('Duplicate')
    expect(parseBootstrapEnv(['KEY=a', 'key=b'], 'linux')).toEqual({ KEY: 'a', key: 'b' })
    expect(() => parseBootstrapEnv(['agentlet_token=secret'], 'win32')).toThrow('Reserved')
    expect(() => parseBootstrapEnv(['agentlet_server=secret'], 'win32')).toThrow('Reserved')
    expect(parseBootstrapEnv(['agentlet_token=value'], 'linux')).toEqual({ agentlet_token: 'value' })
  })

  it('supports portable keys that overlap object prototype names', () => {
    const bootstrap = parseBootstrapEnv(['__proto__=opaque', 'constructor=entry'])
    expect(Object.keys(bootstrap)).toEqual(['__proto__', 'constructor'])
    expect(bootstrap.__proto__).toBe('opaque')
    expect(interpolateBootstrapDestination('${__proto__}/${constructor}', bootstrap)).toBe('opaque/entry')
  })
})

describe('final child environment', () => {
  it('preserves inherited toolchain, session context and opaque authoritative bootstrap', () => {
    expect(buildAgentProcessEnv('ws://daemon', 'token', { TOOL: ' relative=a=b ' }, {
      HUABU_RFS_URL: 'http://host/rfs/space', HUABU_THREAD_ID: 'thread',
    }, { PATH: '/tools', TOOL: 'ambient', AGENTLET_TOKEN: 'ambient-token' })).toMatchObject({
      PATH: '/tools', TOOL: ' relative=a=b ', AGENTLET_TOKEN: 'token', AGENTLET_SERVER: 'ws://daemon',
      HUABU_RFS_URL: 'http://host/rfs/space', HUABU_THREAD_ID: 'thread',
    })
  })

  it.each(['TOOL', 'AGENTLET_TOKEN', 'AGENTLET_SERVER'])('rejects even an equal session declaration for %s', key => {
    const bootstrap = { TOOL: 'value' }
    const session = { [key]: key === 'TOOL' ? 'value' : key === 'AGENTLET_TOKEN' ? 'token' : 'ws://daemon' }
    expect(() => buildAgentProcessEnv('ws://daemon', 'token', bootstrap, session, {})).toThrow('protected environment key')
  })

  it('normalizes authoritative keys at the final Windows merge without changing inherited input', () => {
    const inherited = { PATH: '/tools', Tool: 'ambient', agentlet_token: 'ambient-token', agentlet_server: 'ws://old' }
    const result = buildAgentProcessEnv('ws://daemon', 'token', { TOOL: 'entry' }, {}, inherited, 'win32')
    expect(result).toMatchObject({ PATH: '/tools', TOOL: 'entry', AGENTLET_TOKEN: 'token', AGENTLET_SERVER: 'ws://daemon' })
    expect(result).not.toHaveProperty('Tool')
    expect(result).not.toHaveProperty('agentlet_token')
    expect(result).not.toHaveProperty('agentlet_server')
    expect(inherited.Tool).toBe('ambient')
    expect(() => buildAgentProcessEnv('ws://daemon', 'token', { TOOL: 'entry' }, { tool: 'entry' }, {}, 'win32')).toThrow('protected')
    expect(() => buildAgentProcessEnv('ws://daemon', 'token', {}, { agentlet_token: 'token' }, {}, 'win32')).toThrow('protected')
    expect(() => buildAgentProcessEnv('ws://daemon', 'token', {}, { agentlet_server: 'ws://old' }, {}, 'win32')).toThrow('protected')
  })

  it('preserves Unix case distinctions', () => {
    expect(buildAgentProcessEnv('ws://daemon', 'token', { TOOL: 'entry' }, { tool: 'session' }, { Tool: 'ambient' }, 'linux'))
      .toMatchObject({ TOOL: 'entry', tool: 'session', Tool: 'ambient' })
  })

  it('does not inject a default reachback directory', () => {
    expect(buildAgentProcessEnv('ws://daemon', 'token', {}, {}, {})).not.toHaveProperty('AGENTLET_REACHBACK_DIR')
  })

  it.each([{ BAD: 'value\0' }, { 'BAD-KEY': 'value' }])('validates session environment before spawning', session => {
    expect(() => buildAgentProcessEnv('ws://daemon', 'token', {}, session, {})).toThrow('Invalid environment')
  })
})

describe('resource destination interpolation', () => {
  it('uses only explicit bootstrap values, including empty strings', () => {
    expect(interpolateBootstrapDestination('${ROOT}/${EMPTY}tool.js', { ROOT: ' relative ', EMPTY: '' })).toBe(' relative /tool.js')
    expect(() => interpolateBootstrapDestination('${AGENTLET_REACHBACK_DIR}/tool.js', {})).toThrow('Unknown bootstrap')
    expect(() => interpolateBootstrapDestination('${toString}/tool.js', {})).toThrow('Unknown bootstrap')
  })
})
