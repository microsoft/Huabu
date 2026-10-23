import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AgentProcess } from '../src/agent-process.js'
import { Agentlet } from '../src/agentlet.js'
import { Logger } from '../src/logger.js'

async function waitForExit(agent: AgentProcess): Promise<void> {
  const deadline = Date.now() + 5000
  while (agent.running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(agent.running).toBe(false)
}

describe.skipIf(process.platform === 'win32')('owned process tree cleanup', () => {
  it.each(['direct', 'forced daemon shutdown'])('kills stubborn descendants after the shell exits: %s', async mode => {
    const grandchild = `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      process.send('ready');
    `
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.on('message', () => console.log(JSON.stringify({
        pid: process.pid, childPid: child.pid,
      })));
    `
    const agent = new AgentProcess({
      command: `${JSON.stringify(process.execPath)} -e '${script.replace(/'/g, "'\\''")}'; wait`,
    })
    const started = once(agent, 'message', { signal: AbortSignal.timeout(5000) })
    agent.start()
    try {
      const [message] = await started
      const exited = once(agent, 'exit', { signal: AbortSignal.timeout(5000) })
      agent.closeStdin()
      await agent.terminate()
      await exited
      expect(agent.running).toBe(true)
      process.kill(message.pid, 0)
      process.kill(message.childPid, 0)
      if (mode === 'direct') {
        await agent.kill()
      } else {
        const entries = vi.fn()
        const daemon = new Agentlet({
          server: 'ws://127.0.0.1:1', token: 'test-token', agentletId: 'force-test',
          allowInsecure: true, reconnectMax: 1, bufferLimit: 10, heartbeat: 0,
          logLevel: 'error', maxAgents: 1,
        }, new Logger('error', undefined, entries))
        const pending: unknown = Reflect.get(daemon, 'startingAgents')
        if (!(pending instanceof Set)) throw new Error('Expected pending process ownership')
        pending.add(agent)
        Reflect.set(daemon, 'shutdownInProgress', true)
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        try {
          await daemon.forceStop()
          expect(exit).toHaveBeenCalledWith(1)
          expect(entries).toHaveBeenCalledWith(expect.objectContaining({ event: 'stopped' }))
        } finally {
          exit.mockRestore()
        }
      }
      await waitForExit(agent)
      expect(() => process.kill(message.pid, 0)).toThrow()
      expect(() => process.kill(message.childPid, 0)).toThrow()
    } finally {
      await agent.kill()
      await waitForExit(agent)
    }
  }, 15_000)
})
