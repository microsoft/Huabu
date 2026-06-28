/**
 * Argv parser for the legacy `runSetup()` entry point.
 *
 * Used by per-package `agent-setup.mjs` scripts that call `runSetup()`.
 * The primary CLI is exposed via the `agentlet agent-team` subcommand,
 * which parses args itself and calls `runSetupCommand()` directly.
 */

import { Command } from 'commander';

export interface ParsedArgs {
  command: 'setup' | 'unpack' | 'validate' | 'doctor';
  harness?: string;
  /** Target agent-team directory (standalone CLI mode). */
  dir?: string;
}

/** Build and parse the CLI from process.argv. */
export function parseSetupArgs(argv: string[] = process.argv): ParsedArgs {
  let result: ParsedArgs | undefined;

  const program = new Command()
    .name('agent-team')
    .description('Set up and manage Agent Team packages for agentlet')
    .version('0.1.0');

  program
    .command('setup [dir]')
    .description(
      'Prepare workspace(s) for one or all supported harnesses (alias: unpack)',
    )
    .option('-H, --harness <name>', 'target a specific harness')
    .action((dir: string | undefined, opts: { harness?: string }) => {
      result = { command: 'setup', harness: opts.harness, dir };
    });

  program
    .command('unpack [dir]')
    .description(
      'Prepare workspace(s) for one or all supported harnesses',
    )
    .option('-H, --harness <name>', 'target a specific harness')
    .action((dir: string | undefined, opts: { harness?: string }) => {
      result = { command: 'unpack', harness: opts.harness, dir };
    });

  program
    .command('validate [dir]')
    .description('Check that workspace(s) are properly set up')
    .option('-H, --harness <name>', 'check a specific harness')
    .action((dir: string | undefined, opts: { harness?: string }) => {
      result = { command: 'validate', harness: opts.harness, dir };
    });

  program
    .command('doctor [dir]')
    .description('Run diagnostics and print status')
    .option('-H, --harness <name>', 'diagnose a specific harness')
    .action((dir: string | undefined, opts: { harness?: string }) => {
      result = { command: 'doctor', harness: opts.harness, dir };
    });

  program.parse(argv);

  if (!result) {
    program.help();
    // help() calls process.exit, but TypeScript doesn't know that
    throw new Error('No command specified');
  }

  return result;
}
