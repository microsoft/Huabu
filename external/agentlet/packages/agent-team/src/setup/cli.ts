/**
 * CLI definition for agent-setup.mjs entry points.
 * Uses commander to parse subcommands and flags.
 */

import { Command } from 'commander';

export interface ParsedArgs {
  command: 'unpack' | 'validate' | 'doctor';
  harness?: string;
}

/** Build and parse the CLI from process.argv. */
export function parseSetupArgs(argv: string[] = process.argv): ParsedArgs {
  let result: ParsedArgs | undefined;

  const program = new Command()
    .name('agent-setup')
    .description('Set up an Agent Team package for use with agentlet')
    .version('0.1.0');

  program
    .command('unpack')
    .description(
      'Prepare workspace(s) for one or all supported harnesses',
    )
    .option('-H, --harness <name>', 'target a specific harness')
    .action((opts: { harness?: string }) => {
      result = { command: 'unpack', harness: opts.harness };
    });

  program
    .command('validate')
    .description('Check that workspace(s) are properly set up')
    .option('-H, --harness <name>', 'check a specific harness')
    .action((opts: { harness?: string }) => {
      result = { command: 'validate', harness: opts.harness };
    });

  program
    .command('doctor')
    .description('Run diagnostics and print status')
    .option('-H, --harness <name>', 'diagnose a specific harness')
    .action((opts: { harness?: string }) => {
      result = { command: 'doctor', harness: opts.harness };
    });

  program.parse(argv);

  if (!result) {
    program.help();
    // help() calls process.exit, but TypeScript doesn't know that
    throw new Error('No command specified');
  }

  return result;
}
