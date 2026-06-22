import { Command } from 'commander'

export interface AgentletOptions {
  // Core connection
  server: string
  token: string
  reconnectMax: number
  bufferLimit: number
  heartbeat: number
  allowInsecure: boolean

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile?: string

  // Bridge mode (--agent provided): spawn and relay a single agent
  agent?: string
  cwd: string
  env: Record<string, string>
  autoRestart: boolean
  restartDelay: number
  restartMax: number

  // Daemon mode (--agent omitted): idle agentlet awaiting server/spawn
  agentletId?: string
  maxAgents: number
}

export function parseCli(argv: string[]): AgentletOptions {
  const program = new Command()

  let parsed: AgentletOptions | undefined

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

      parsed = {
        server: opts.server,
        token,
        reconnectMax: parseInt(opts.reconnectMax, 10),
        bufferLimit: parseInt(opts.bufferLimit, 10),
        heartbeat: parseInt(opts.heartbeat, 10),
        allowInsecure: opts.allowInsecure,
        logLevel: opts.logLevel as AgentletOptions['logLevel'],
        logFile: opts.logFile,
        agent: opts.agent,
        cwd: opts.cwd,
        env: opts.env,
        autoRestart: opts.autoRestart,
        restartDelay: parseInt(opts.restartDelay, 10),
        restartMax: parseInt(opts.restartMax, 10),
        agentletId: opts.agentletId?.trim() || undefined,
        maxAgents: parseInt(opts.maxAgents, 10),
      }
    })

  program.parse(argv)

  if (!parsed) {
    program.help()
    process.exit(1)
  }

  return parsed
}

function collectEnv(value: string, previous: Record<string, string>): Record<string, string> {
  const [key, ...rest] = value.split('=')
  if (key && rest.length > 0) {
    previous[key] = rest.join('=')
  }
  return previous
}
