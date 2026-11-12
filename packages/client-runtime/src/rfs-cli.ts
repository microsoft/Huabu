// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Command } from 'commander';

export interface InputOptions {
  json?: string;
  jsonFile?: string;
  text?: string;
  textFile?: string;
  noStart?: boolean;
}

export interface ExecuteOptions extends InputOptions {
  operationId?: string;
  basis?: string;
}

export interface DownloadOptions {
  output: string;
  ifRevision?: string;
}

export interface UploadOptions {
  file?: string;
  delete?: boolean;
}

export interface RfsActions {
  rootHelp: () => Promise<void>;
  getSkill: (id: string | undefined, usage: string) => Promise<void>;
  query: (options: InputOptions) => Promise<void>;
  execute: (options: ExecuteOptions) => Promise<void>;
  result: (operationId: string) => Promise<void>;
  download: (path: string, options: DownloadOptions) => Promise<void>;
  upload: (name: string, options: UploadOptions) => Promise<void>;
  profiles: () => Promise<void>;
  create: (options: InputOptions) => Promise<void>;
  prompt: (thread: string, options: InputOptions) => Promise<void>;
  services: () => Promise<void>;
  serviceSkill: (id: string) => Promise<void>;
  serviceManifest: (id: string) => Promise<void>;
  serviceDownload: (id: string, folder: string) => Promise<void>;
}

export function segment(value: string | undefined): string {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value))
    throw new Error(
      'Expected one nonempty logical path segment, not a URL or traversal',
    );
  return encodeURIComponent(value);
}

export function createRfsProgram(
  actions: RfsActions,
  write: (text: string) => void,
) {
  const guides = new Map<Command, string | null>();
  let helpCommand: Command | undefined;
  const program = new Command()
    .name('huabu-rfs')
    .description('Huabu RFS (optional Node client)')
    .exitOverride()
    .configureOutput({
      writeOut: write,
      // runRfs reports Commander errors without exiting the host process.
      writeErr: () => {},
    })
    .addHelpText(
      'after',
      '\nOperation response bodies and SSE are raw; exit 0 means delivery completed, not business success.\n' +
        'No redirects, reconnects or remote cancellation. Only execute retries, re-sending one request id.\n' +
        'Start with get-skill; use COMMAND --help for usage and live contracts when applicable.\n',
    );

  function guide(command: Command, id: string | null = null) {
    guides.set(command, id);
    command.on('beforeHelp', () => {
      helpCommand = command;
    });
    return command;
  }
  function inputs(command: Command, text: boolean) {
    command
      .option('--json <string>', 'Forward JSON bytes unchanged')
      .option(
        '--json-file <path>',
        'Read JSON bytes from a file, or - for stdin',
      );
    if (text)
      command
        .option('--text <string>', 'Forward plain text unchanged')
        .option(
          '--text-file <path>',
          'Read plain text from a file, or - for stdin',
        );
    return command;
  }
  guide(program, '').action(actions.rootHelp);
  guide(
    program
      .command('get-skill [skillId]')
      .description('Load root or focused Skill'),
  ).action((id: string | undefined) =>
    actions.getSkill(id, program.helpInformation()),
  );

  const operationHelp = [
    '-h, --help',
    'Show usage; --help TYPE loads one operation contract',
  ] as const;
  const query = guide(
    inputs(
      program.command('query').description('Send raw query JSON'),
      false,
    ).helpOption(...operationHelp),
  );
  query.action(() => actions.query(query.opts<InputOptions>()));
  const execute = guide(
    inputs(
      program
        .command('execute')
        .description(
          'Send raw execute JSON; retries a dropped connection under one request id',
        ),
      false,
    )
      .option(
        '--operation-id <uuid>',
        'Request id; default: a new one per invocation. Re-use the printed id to get the original result instead of executing twice',
      )
      .option(
        '--basis <token>',
        'Read version from a query, download or execute; stale structural edits are rejected',
      )
      .helpOption(...operationHelp),
  );
  execute.action(() => actions.execute(execute.opts<ExecuteOptions>()));
  guide(
    program
      .command('result <operationId>')
      .description(
        'Print the stored response of an earlier execute; never executes',
      ),
  ).action((id: string) => actions.result(id));
  const download = guide(
    program
      .command('download <logicalPath>')
      .description('Download a file and stream metadata/progress as NDJSON')
      .requiredOption(
        '--output <path>',
        'Replace a local file only after a complete successful transfer',
      )
      .option(
        '--if-revision <revision>',
        'Keep the output file when its Huabu revision is unchanged',
      ),
  );
  download.action((path: string) =>
    actions.download(path, download.opts<DownloadOptions>()),
  );
  const upload = guide(
    program
      .command('upload <name>')
      .description('Stage raw file bytes')
      .option('--file <path>', 'File path, or - for stdin')
      .option('--delete', 'Delete the named staged upload'),
  );
  upload.action((name: string) => actions.upload(name, upload.opts()));

  const agent = guide(
    program.command('agent').description('Create or continue an Agent'),
    'agents',
  );
  guide(
    agent.command('profiles').description('List available Profiles'),
    'agents',
  ).action(actions.profiles);
  const create = guide(
    inputs(
      agent
        .command('create')
        .description('Create an Agent and optionally start its first turn'),
      true,
    ).option('--no-start', 'Create idle; requires a JSON input source'),
    'agents',
  );
  create.action(() =>
    actions.create({
      ...create.opts<InputOptions>(),
      noStart: create.opts<{ start: boolean }>().start === false,
    }),
  );
  const prompt = guide(
    inputs(
      agent
        .command('prompt <threadId>')
        .description('Continue an existing conversation'),
      true,
    ),
    'agents',
  );
  prompt.action((thread: string) =>
    actions.prompt(thread, prompt.opts<InputOptions>()),
  );

  const service = guide(
    program
      .command('service')
      .description('Discover and download Service Packages'),
    'services',
  );
  guide(
    service
      .command('list')
      .description('List Services and masked availability'),
    'services',
  ).action(actions.services);
  guide(
    service.command('skill <id>').description('Read a Package Skill'),
    'services',
  ).action(actions.serviceSkill);
  guide(
    service
      .command('manifest <id>')
      .description('Read a Package Manifest without credentials'),
    'services',
  ).action(actions.serviceManifest);
  const serviceDownload = guide(
    service
      .command('download <id>')
      .description('Download and safely extract a Package without executing it')
      .requiredOption(
        '--out-folder <folder>',
        'Parent directory; creates FOLDER/ID and refuses existing targets',
      ),
    'services',
  );
  serviceDownload.action((id: string) =>
    actions.serviceDownload(
      id,
      serviceDownload.opts<{ outFolder: string }>().outFolder,
    ),
  );

  return {
    program,
    liveHelp() {
      if (!helpCommand) throw new Error('Help target was not selected');
      const name = helpCommand.name();
      if (!guides.has(helpCommand))
        throw new Error('Missing command help selection');
      const guideId = guides.get(helpCommand);
      let capability: string | undefined;
      if (name === 'query' || name === 'execute') {
        const operands = helpCommand.args.filter(
          (arg) => arg !== '--help' && arg !== '-h',
        );
        if (operands.length > 1)
          throw new Error('Help accepts at most one operation type');
        capability = operands[0]
          ? `/capabilities/${name === 'query' ? 'queries' : 'commands'}/${segment(operands[0])}`
          : '/capabilities';
      }
      return {
        guide:
          guideId === undefined || guideId === null
            ? undefined
            : guideId === ''
              ? '/skill'
              : `/skill/${guideId}`,
        capability,
      };
    },
  };
}
