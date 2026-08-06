import { createInterface } from 'node:readline'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface AgentProcessOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
}

export interface AgentProcessEvents {
  message: [data: unknown]
  error: [error: Error]
  exit: [code: number | null, signal: string | null]
  stderr: [line: string]
}

export class AgentProcess extends EventEmitter<AgentProcessEvents> {
  private process: ChildProcess | null = null
  private readonly options: AgentProcessOptions

  get pid(): number | undefined {
    return this.process?.pid
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  constructor(options: AgentProcessOptions) {
    super()
    this.options = options
  }

  /** Spawn the agent subprocess */
  start(): void {
    if (this.process) {
      throw new Error('Agent process already running')
    }

    this.process = spawn(this.options.command, {
      shell: true,
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

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

  /** Send SIGTERM to the agent */
  terminate(): void {
    this.process?.kill('SIGTERM')
  }

  /** Send SIGKILL to the agent */
  kill(): void {
    this.process?.kill('SIGKILL')
  }
}
