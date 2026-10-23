import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildProcess, spawn } from 'node:child_process'
import { AgentProcess } from '../src/agent-process.js'
import type * as ChildProcessModule from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof ChildProcessModule>(),
  spawn: vi.fn(),
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  vi.mocked(spawn).mockClear()
  vi.mocked(spawn).mockReturnValue(Object.assign(new ChildProcess(), { pid: 123 }))
})

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('process transport selection', () => {
  it.each([
    '  ENV=value agent --acp "user flags" && echo trusted  ',
    'prepare-agent | custom-adapter --acp',
    '"C:\\Program Files\\Custom Agent\\launch.cmd" --acp',
  ])('preserves legacy trusted shell commands byte-for-byte: %s', (command) => {
    new AgentProcess({ command, cwd: '/work', env: { HOST: 'value' } }).start()
    expect(spawn).toHaveBeenCalledWith(command, expect.objectContaining({
      shell: true, cwd: '/work', env: expect.objectContaining({ HOST: 'value' }),
    }))
  })

  it('executes a compiled known-harness command through the platform shell', () => {
    const command = 'copilot --acp --allow-all'
    new AgentProcess({ command, cwd: '/work' }).start()
    expect(spawn).toHaveBeenCalledWith(command, expect.objectContaining({
      shell: true, cwd: '/work', stdio: ['pipe', 'pipe', 'pipe'],
    }))
  })

  it('does not reintroduce ambient values after the managed environment has been finalized', () => {
    const env = { AGENTLET_TOKEN: 'authoritative', TOOL: 'entry' }
    new AgentProcess({ command: 'agent --acp', env, inheritEnv: false }).start()
    expect(spawn).toHaveBeenCalledWith('agent --acp', expect.objectContaining({ env }))
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.env).toBe(env)
  })

  it('owns an isolated process group on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    new AgentProcess({ command: 'agent --acp' }).start()
    expect(spawn).toHaveBeenCalledWith('agent --acp', expect.objectContaining({
      detached: true,
    }))
  })

  it('retains POSIX ownership after shell exit until the group is confirmed absent', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const root = Object.assign(new ChildProcess(), { pid: 123 })
    vi.mocked(spawn).mockReturnValueOnce(root)
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const agent = new AgentProcess({ command: 'agent --acp' })
    agent.start()
    root.emit('exit', 0)
    expect(agent.running).toBe(true)
    expect(agent.pid).toBe(123)
    expect(() => agent.start()).toThrow('already running')
    await agent.terminate()
    expect(signal).toHaveBeenLastCalledWith(-123, 'SIGTERM')
    signal.mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    expect(agent.running).toBe(true)
    signal.mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(agent.running).toBe(false)
    expect(agent.pid).toBeUndefined()
  })

  it('terminates the entire Windows tree and waits for taskkill to finish', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const agent = new AgentProcess({ command: 'agent --acp' })
    agent.start()
    const task = new ChildProcess()
    vi.mocked(spawn).mockReturnValueOnce(task)
    const stopped = vi.fn()
    const operation = agent.terminate().then(stopped)
    expect(spawn).toHaveBeenLastCalledWith('taskkill', ['/PID', '123', '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    })
    expect(stopped).not.toHaveBeenCalled()
    task.emit('exit', 0)
    await operation
    expect(stopped).toHaveBeenCalledOnce()
  })

  it.each(['exit', 'error'])('surfaces Windows tree cleanup %s failures', async (event) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const agent = new AgentProcess({ command: 'agent --acp' })
    agent.start()
    const task = new ChildProcess()
    vi.mocked(spawn).mockReturnValueOnce(task)
    const operation = agent.kill()
    const rejection = expect(operation).rejects.toThrow()
    if (event === 'exit') task.emit('exit', 1)
    else task.emit('error', new Error('taskkill unavailable'))
    await rejection
  })

  it('bounds Windows tree cleanup and terminates only its taskkill helper on timeout', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.useFakeTimers()
    const agent = new AgentProcess({ command: 'agent --acp' })
    agent.start()
    const task = new ChildProcess()
    const kill = vi.spyOn(task, 'kill').mockReturnValue(true)
    vi.mocked(spawn).mockReturnValueOnce(task)
    const rejection = expect(agent.kill()).rejects.toThrow('Timed out terminating')
    await vi.advanceTimersByTimeAsync(5000)
    await rejection
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})
