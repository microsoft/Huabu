import { createInterface } from 'node:readline'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface AgentProcessOptions {
  command: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  inheritEnv?: boolean
}

export interface AgentProcessEvents {
  message: [data: unknown]
  error: [error: Error]
  exit: [code: number | null, signal: string | null]
  stderr: [line: string]
}

export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  private process: ChildProcess | null = null
  private processGroupId: number | null = null
  private readonly options: AgentProcessOptions

  get pid(): number | undefined {
    return this.process?.pid ?? this.processGroupId ?? undefined
  }

  get running(): boolean {
    if (this.processGroupId !== null) {
      try {
        process.kill(-this.processGroupId, 0)
        return true
      } catch (error) {
        // Permission denial proves neither exit nor safe release of the owned group.
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        this.processGroupId = null
      }
    }
    return this.process !== null && this.process.exitCode === null
  }

  constructor(options: AgentProcessOptions) {
    super()
    this.options = options
  }

  /** Spawn the agent subprocess */
  start(): void {
    if (this.process || this.running) {
      throw new Error('Agent process already running')
    }

    // Commands are either generated from daemon-owned harness definitions or explicitly authorized by the user.
    // codeql[js/command-line-injection]
    this.process = spawn(this.options.command, {
      shell: true,
      cwd: this.options.cwd,
      env: this.options.inheritEnv === false
        ? this.options.env
        : { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.processGroupId = process.platform === 'win32' ? null : (this.process.pid ?? null)

    const { stdout, stderr } = this.process

    // Read stdout line-by-line, parse each line as JSON
    if (stdout) {
      const rl = createInterface({ input: stdout })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const parsed: unknown = JSON.parse(trimmed)
          this.emit('message', parsed)
        } catch {
          // Not valid JSON — log and skip
          this.emit('error', new Error(`Invalid JSON from agent stdout: ${trimmed.slice(0, 200)}`))
        }
      })
    }

    // Read stderr for diagnostics (not relayed)
    if (stderr) {
      const rl = createInterface({ input: stderr })
      rl.on('line', (line) => {
        this.emit('stderr', line)
      })
    }

    this.process.on('error', (err) => {
      this.emit('error', err)
    })

    this.process.on('exit', (code, signal) => {
      this.process = null
      this.emit('exit', code, signal)
    })
  }

  /** Write a JSON message to agent stdin */
  write(message: unknown): boolean {
    if (!this.process?.stdin?.writable) {
      return false
    }
    const data = JSON.stringify(message) + '\n'
    return this.process.stdin.write(data)
  }

  /** Close stdin (signal EOF to agent) */
  closeStdin(): void {
    this.process?.stdin?.end()
  }

  /** Terminate the owned process tree, including shell wrappers. */
  async terminate(): Promise<void> {
    await this.signalTree('SIGTERM')
  }

  /** Forcefully terminate the owned process tree. */
  async kill(): Promise<void> {
    await this.signalTree('SIGKILL')
  }

  private async signalTree(signal: NodeJS.Signals): Promise<void> {
    if (process.platform !== 'win32') {
      if (this.processGroupId === null) return
      try {
        process.kill(-this.processGroupId, signal)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        this.processGroupId = null
      }
      return
    }
    const pid = this.process?.pid
    if (pid === undefined) return
    await new Promise<void>((resolve, reject) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Timed out terminating agent process tree: ${pid}`))
      }, 5000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Unable to terminate agent process tree ${pid}: taskkill exited ${code}`))
      })
    })
  }
}
