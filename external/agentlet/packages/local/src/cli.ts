import { Command } from 'commander'
import type { SetupCommandArgs } from '@agentlet/agent-team'

export interface AgentletOptions {
  server: string
  token: string
  reconnectMax: number
  bufferLimit: number
  heartbeat: number
  allowInsecure: boolean

  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile?: string

  agentletId?: string
  maxAgents: number
}

/**
 * Result of parsing the `agentlet` CLI: either run the daemon, or run an
 * Agent Team setup command. The two roles are exposed as explicit
 * subcommands (`agentlet daemon …` / `agentlet agent-team …`).
 */
export type CliResult =
  | { mode: 'daemon'; options: AgentletOptions }
  | { mode: 'agent-team'; args: SetupCommandArgs }

export function parseCli(argv: string[]): CliResult {
  const program = new Command()

  let result: CliResult | undefined

  program
    .name('agentlet')
    .description('A network adapter that makes any local ACP agent remotely accessible over WebSocket')

  program
    .command('daemon')
    .description('Run the agentlet daemon, bridging local ACP agents to a remote server over WebSocket')
    .requiredOption('--server <url>', 'Remote server bridge endpoint (WSS URL)')
    .option('--token <token>', 'Authentication token (or set AGENTLET_TOKEN env var)')
    .option('--reconnect-max <seconds>', 'Maximum reconnection backoff in seconds', '300')
    .option('--buffer-limit <count>', 'Max messages buffered during disconnection', '1000')
    .option('--max-agents <count>', 'Maximum concurrent agents', '10')
    .option('--agentlet-id <id>', 'Machine identity reported to the host (defaults to hostname)')
    .option('--log-level <level>', 'Logging verbosity: debug, info, warn, error', 'info')
    .option('--log-file <path>', 'Path to write structured log output (JSON lines)')
    .option('--heartbeat <seconds>', 'WebSocket ping interval in seconds (0 to disable)', '30')
    .option('--allow-insecure', 'Allow ws:// (non-TLS) connections (local development only)', false)
    .action((opts) => {
      const token = opts.token || process.env['AGENTLET_TOKEN']
      if (!token) {
        console.error('Error: --token is required (or set AGENTLET_TOKEN environment variable)')
        process.exit(1)
      }

      result = {
        mode: 'daemon',
        options: {
          server: opts.server,
          token,
          reconnectMax: parseInt(opts.reconnectMax, 10),
          bufferLimit: parseInt(opts.bufferLimit, 10),
          heartbeat: parseInt(opts.heartbeat, 10),
          allowInsecure: opts.allowInsecure,
          logLevel: opts.logLevel as AgentletOptions['logLevel'],
          logFile: opts.logFile,
          agentletId: opts.agentletId?.trim() || undefined,
          maxAgents: parseInt(opts.maxAgents, 10),
        },
      }
    })

  const agentTeam = program
    .command('agent-team')
    .description('Manage Agent Team packages (setup, validate, doctor). Run from inside the agent-team folder.')

  agentTeam
    .command('setup')
    .alias('unpack')
    .description('Prepare per-harness workspaces from the agentlet.yaml in the current directory')
    .option('--harness <name>', 'Target a specific harness (defaults to all in the manifest)')
    .action((opts) => {
      result = { mode: 'agent-team', args: { command: 'setup', harness: opts.harness } }
    })

  agentTeam
    .command('validate')
    .description('Validate that the agentlet.yaml in the current directory is well-formed and ready')
    .option('--harness <name>', 'Target a specific harness (defaults to all in the manifest)')
    .action((opts) => {
      result = { mode: 'agent-team', args: { command: 'validate', harness: opts.harness } }
    })

  agentTeam
    .command('doctor')
    .description('Diagnose the readiness of the agent-team package in the current directory')
    .option('--harness <name>', 'Target a specific harness (defaults to all in the manifest)')
    .action((opts) => {
      result = { mode: 'agent-team', args: { command: 'doctor', harness: opts.harness } }
    })

  program.parse(argv)

  if (!result) {
    program.help()
    process.exit(1)
  }

  return result
}
