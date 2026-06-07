import { Command } from 'commander'

/** Options when --agent is provided (self-spawn / bridge mode) */
export interface CliOptions {
  agent: string
  server: string
  token: string
  cwd: string
  reconnectMax: number
  bufferLimit: number
  autoRestart: boolean
  restartDelay: number
  restartMax: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile?: string
  env: Record<string, string>
  heartbeat: number
  allowInsecure: boolean
}

/** Options when --agent is NOT provided (idle agentlet / daemon mode) */
export interface DaemonOptions {
  server: string
  token: string
  daemonId?: string
  reconnectMax: number
  bufferLimit: number
  maxAgents: number
  heartbeat: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile?: string
  allowInsecure: boolean
}

export type ParseResult =
  | { mode: 'bridge'; options: CliOptions }
  | { mode: 'daemon'; options: DaemonOptions }

export function parseCli(argv: string[]): ParseResult {
  const program = new Command()

  let parsedResult: ParseResult | undefined

  program
    .name('agentlet')
    .description('A network adapter that makes any local ACP agent remotely accessible over WebSocket')
    .requiredOption('--server <url>', 'Remote server bridge endpoint (WSS URL)')
    .option('--token <token>', 'Authentication token (or set AGENTLET_TOKEN env var)')
    .option('--agent <command>', 'Shell command to spawn the agent (must support ACP stdio). If omitted, runs as idle agentlet awaiting server/spawn.')
    .option('--cwd <dir>', 'Working directory for the agent subprocess', process.cwd())
    .option('--reconnect-max <seconds>', 'Maximum reconnection backoff in seconds', '300')
    .option('--buffer-limit <count>', 'Max messages buffered during disconnection', '1000')
    .option('--auto-restart', 'Restart agent subprocess if it exits unexpectedly', false)
    .option('--restart-delay <ms>', 'Milliseconds to wait before restarting agent', '2000')
    .option('--restart-max <count>', 'Maximum consecutive restart attempts', '5')
    .option('--max-agents <count>', 'Maximum concurrent agents (idle mode only)', '10')
    .option('--agentlet-id <id>', 'Unique agentlet identifier (defaults to hostname, idle mode only)')
    .option('--log-level <level>', 'Logging verbosity: debug, info, warn, error', 'info')
    .option('--log-file <path>', 'Path to write structured log output (JSON lines)')
    .option('--env <KEY=VALUE...>', 'Extra environment variables for the agent (repeatable)', collectEnv, {})
    .option('--heartbeat <seconds>', 'WebSocket ping interval in seconds (0 to disable)', '30')
    .option('--allow-insecure', 'Allow ws:// (non-TLS) connections (local development only)', false)
    .action((opts) => {
      const token = opts.token || process.env['AGENTLET_TOKEN']
      if (!token) {
        console.error('Error: --token is required (or set AGENTLET_TOKEN environment variable)')
        process.exit(1)
      }

      if (opts.agent) {
        // Self-spawn mode (bridge)
        parsedResult = {
          mode: 'bridge',
          options: {
            agent: opts.agent,
            server: opts.server,
            token,
            cwd: opts.cwd,
            reconnectMax: parseInt(opts.reconnectMax, 10),
            bufferLimit: parseInt(opts.bufferLimit, 10),
            autoRestart: opts.autoRestart,
            restartDelay: parseInt(opts.restartDelay, 10),
            restartMax: parseInt(opts.restartMax, 10),
            logLevel: opts.logLevel as CliOptions['logLevel'],
            logFile: opts.logFile,
            env: opts.env,
            heartbeat: parseInt(opts.heartbeat, 10),
            allowInsecure: opts.allowInsecure,
          },
        }
      } else {
        // Idle agentlet mode (daemon)
        parsedResult = {
          mode: 'daemon',
          options: {
            server: opts.server,
            token,
            daemonId: opts.agentletId?.trim() || undefined,
            reconnectMax: parseInt(opts.reconnectMax, 10),
            bufferLimit: parseInt(opts.bufferLimit, 10),
            maxAgents: parseInt(opts.maxAgents, 10),
            heartbeat: parseInt(opts.heartbeat, 10),
            logLevel: opts.logLevel as DaemonOptions['logLevel'],
            logFile: opts.logFile,
            allowInsecure: opts.allowInsecure,
          },
        }
      }
    })

  program.parse(argv)

  if (!parsedResult) {
    program.help()
    process.exit(1)
  }

  return parsedResult
}

function collectEnv(value: string, previous: Record<string, string>): Record<string, string> {
  const [key, ...rest] = value.split('=')
  if (key && rest.length > 0) {
    previous[key] = rest.join('=')
  }
  return previous
}
