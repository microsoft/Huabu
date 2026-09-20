import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { AgentProcess } from '../src/agent-process.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

beforeEach(() => {
  vi.mocked(spawn).mockClear()
  vi.mocked(spawn).mockReturnValue(Object.assign(new EventEmitter(), {
    stdout: null, stderr: null, exitCode: null, pid: 123,
  }) as unknown as ReturnType<typeof spawn>)
})

describe('process transport selection', () => {
  it('preserves legacy trusted shell commands byte-for-byte', () => {
    const command = '  ENV=value agent --acp "user flags" && echo trusted  '
    new AgentProcess({ command, cwd: '/work', env: { HOST: 'value' } }).start()
    expect(spawn).toHaveBeenCalledWith(command, expect.objectContaining({
      shell: true, cwd: '/work', env: expect.objectContaining({ HOST: 'value' }),
    }))
  })

  it('never interpolates structured executable paths or argument values', () => {
    const executable = '/path with spaces/adapter'
    const argv = ['literal argument', '$(not-run); | &', '"quoted"']
    new AgentProcess({
      command: 'display-only',
      launchPlan: { version: 1, executable, argv, env: {} },
      cwd: '/work',
    }).start()
    expect(spawn).toHaveBeenCalledWith(executable, argv, expect.objectContaining({
      shell: false, cwd: '/work', stdio: ['pipe', 'pipe', 'pipe'],
    }))
  })
})
