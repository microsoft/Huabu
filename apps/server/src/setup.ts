// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import './load-env.js';

import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import * as prompts from '@clack/prompts';
import { z } from 'zod';

import {
  InvalidPublicOriginError,
  normalizePublicOrigin,
} from '@huabu/client-runtime';

import { getDataDir } from './data-dir.js';
import {
  isLoopbackHost,
  resolveDeploymentConfig,
} from './modules/security/deployment-config.js';
import { parseStorageProfile } from './modules/storage/profile.js';
import {
  deploymentUsernameSchema,
  readDeploymentSettings,
  resolveAuthenticationMode,
  resolveDeploymentEnvironment,
  saveDeploymentSettings,
} from './security/deployment-settings.js';
import { getConfigDir } from './security/private-config.js';
import { SECRET_IDS } from './security/secret-ids.js';
import {
  getPersistedSecret,
  initializeSecretStore,
  readPersistedSecret,
  setSecret,
} from './security/secret-store.js';
import { resolveServerPort } from './server-port.js';
import { resolveDirectChildPath } from './utils/fs.js';

import type { DeploymentSettings } from './security/deployment-settings.js';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function suggestPublicOrigins(port: number): string[] {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        addresses.add(`http://${address.address}:${port}`);
      }
    }
  }
  return [...addresses];
}

export function validateSetupPassword(password: string): void {
  if (password.length === 0 || /\p{Cc}/u.test(password)) {
    throw new Error('Enter a non-empty password without control characters.');
  }
}

function suggestWorkspacePath(env: NodeJS.ProcessEnv): string {
  const previous = readDeploymentSettings(env)?.remoteAccess;
  return (
    (previous?.enabled && previous.workspacePath) ||
    resolveDirectChildPath(getDataDir(env), 'workspace')
  );
}

interface SetupInput {
  remote: boolean;
  login?: boolean;
  origin?: string;
  username?: string;
  password?: string;
  allowHttp?: boolean;
  workspacePath?: string;
}

function normalizeSetupOrigin(value: string): string {
  const origin = normalizePublicOrigin(value);
  if (['0.0.0.0', '[::]'].includes(new URL(origin).hostname)) {
    throw new InvalidPublicOriginError(
      'Use a reachable server address, not a wildcard address.',
    );
  }
  return origin;
}

export function readSetupEnvironment(env: NodeJS.ProcessEnv) {
  const authenticationMode = resolveAuthenticationMode(env);
  const bindHost = env.HUABU_BIND_HOST;
  if (
    bindHost !== undefined &&
    !isIP(bindHost) &&
    !z.hostname().safeParse(bindHost).success
  ) {
    throw new Error('HUABU_BIND_HOST must be an IP address or hostname.');
  }
  const origin =
    env.HUABU_PUBLIC_ORIGIN !== undefined
      ? normalizeSetupOrigin(env.HUABU_PUBLIC_ORIGIN)
      : undefined;
  if (
    bindHost !== undefined &&
    !isLoopbackHost(bindHost) &&
    origin &&
    isLoopbackHost(new URL(origin).hostname)
  ) {
    throw new Error(
      'HUABU_PUBLIC_ORIGIN must be reachable beyond loopback when HUABU_BIND_HOST is not loopback.',
    );
  }
  const credentials =
    env.HUABU_BASIC_AUTH_USER !== undefined ||
    env.HUABU_BASIC_AUTH_PASS !== undefined;
  if (credentials) {
    if (!env.HUABU_BASIC_AUTH_USER || !env.HUABU_BASIC_AUTH_PASS) {
      throw new Error(
        'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS must be configured together with non-empty values.',
      );
    }
    const username = deploymentUsernameSchema.safeParse(
      env.HUABU_BASIC_AUTH_USER,
    );
    if (!username.success || username.data !== env.HUABU_BASIC_AUTH_USER) {
      throw new Error(
        'HUABU_BASIC_AUTH_USER must be a non-empty username without colons, control characters, or surrounding whitespace.',
      );
    }
    if (/\p{Cc}/u.test(env.HUABU_BASIC_AUTH_PASS)) {
      throw new Error(
        'HUABU_BASIC_AUTH_PASS must not contain control characters.',
      );
    }
  }
  const disk = parseStorageProfile(env).structured.kind === 'disk';
  const workspacePath = env.HUABU_WORKSPACE;
  if (workspacePath !== undefined) {
    if (!disk) {
      throw new Error(
        'This database backend does not use HUABU_WORKSPACE. Remove that override before setup.',
      );
    }
    if (!isAbsolute(workspacePath)) {
      throw new Error('HUABU_WORKSPACE must be an absolute Home directory.');
    }
  }
  const allowedHosts = env.HUABU_ALLOWED_HOSTS;
  if (allowedHosts !== undefined) {
    for (const value of allowedHosts
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)) {
      const host = value.replace(/^\[(.*)\]$/, '$1');
      if (!isIP(host) && !z.hostname().safeParse(host).success) {
        throw new Error(
          'HUABU_ALLOWED_HOSTS must contain comma-separated hostnames or IP addresses without ports or paths.',
        );
      }
    }
  }
  resolveServerPort(env);
  return {
    bindHost,
    remote: bindHost !== undefined ? !isLoopbackHost(bindHost) : undefined,
    origin,
    credentials,
    authentication:
      env.HUABU_AUTH_MODE !== undefined || credentials
        ? authenticationMode
        : undefined,
    workspacePath,
    allowedHosts,
  };
}

function environmentValue(label: string, value: string): void {
  prompts.log.info(`${label}\n${value} · environment`);
}

export function buildSetupSummary(
  env: NodeJS.ProcessEnv,
  settings: DeploymentSettings | null,
  password: string | null,
): string[] {
  const effective = resolveDeploymentEnvironment(env, settings, password);
  const deployment = resolveDeploymentConfig(effective);
  const source = (key: string) =>
    env[key] !== undefined ? ' · environment' : '';
  return [
    `Access   ${deployment.bindScope === 'network' ? 'Remote' : 'Local only'}${source('HUABU_BIND_HOST')}`,
    `Bind     ${deployment.bindHost}${source('HUABU_BIND_HOST')}`,
    `Port     ${resolveServerPort(env)}${source('SERVER_PORT')}`,
    ...(deployment.publicOrigin
      ? [`Address  ${deployment.publicOrigin}${source('HUABU_PUBLIC_ORIGIN')}`]
      : []),
    ...(effective.HUABU_WORKSPACE
      ? [`Home     ${effective.HUABU_WORKSPACE}${source('HUABU_WORKSPACE')}`]
      : []),
    ...(deployment.basicAuthConfigured
      ? [
          `Login    ${effective.HUABU_BASIC_AUTH_USER}${source('HUABU_BASIC_AUTH_USER')}`,
          `Password configured${source('HUABU_BASIC_AUTH_PASS')}`,
        ]
      : []),
    ...(deployment.authenticationDisabled
      ? [`Login    Disabled${source('HUABU_AUTH_MODE')}`]
      : []),
    ...(env.HUABU_ALLOWED_HOSTS !== undefined
      ? [`Aliases  ${env.HUABU_ALLOWED_HOSTS.trim() || 'None'} · environment`]
      : []),
  ];
}

class SetupCancelled extends Error {}

async function answer<T extends string | boolean>(
  prompt: Promise<T | typeof prompts.CANCEL_SYMBOL>,
): Promise<T> {
  const value = await prompt;
  if (prompts.isCancel(value)) throw new SetupCancelled();
  return value;
}

export async function promptDeployment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupInput> {
  const overrides = readSetupEnvironment(env);
  const previous = readDeploymentSettings(env)?.remoteAccess;
  const remote =
    overrides.remote ??
    (await answer(
      prompts.confirm({
        message: 'Allow remote access?',
        initialValue: previous?.enabled ?? false,
      }),
    ));
  if (overrides.bindHost !== undefined) {
    environmentValue(
      'Access mode',
      `${remote ? 'Remote' : 'Local only'} (${overrides.bindHost})`,
    );
  }
  if (env.SERVER_PORT !== undefined) {
    environmentValue('Server port', String(resolveServerPort(env)));
  }
  if (overrides.allowedHosts !== undefined) {
    environmentValue(
      'Additional host aliases',
      overrides.allowedHosts.trim() || 'None',
    );
  }
  if (!remote) {
    if (overrides.origin) environmentValue('Server address', overrides.origin);
    if (overrides.workspacePath)
      environmentValue('Home directory', overrides.workspacePath);
    if (overrides.credentials) {
      environmentValue(
        'Login credentials',
        `${env.HUABU_BASIC_AUTH_USER}\nPassword configured`,
      );
    }
    return { remote: false };
  }

  const candidates = overrides.origin
    ? []
    : suggestPublicOrigins(resolveServerPort(env));
  if (candidates.length > 1) {
    prompts.log.info(candidates.join('\n'));
  }
  const suggested = previous?.enabled ? previous.publicOrigin : candidates[0];
  const origin =
    overrides.origin ??
    normalizeSetupOrigin(
      (
        await answer(
          prompts.text({
            message: 'Server address',
            placeholder: suggested,
            defaultValue: suggested,
            initialValue: suggested,
            validate(value) {
              const input = value?.trim() || suggested;
              if (!input) return 'Enter a server address.';
              try {
                normalizeSetupOrigin(input);
              } catch (error) {
                if (error instanceof InvalidPublicOriginError)
                  return error.message;
                throw error;
              }
            },
          }),
        )
      ).trim() ||
        suggested ||
        '',
    );
  if (overrides.origin) environmentValue('Server address', origin);
  const allowHttp = new URL(origin).protocol === 'http:';
  if (allowHttp) {
    prompts.log.warn('HTTP sends passwords and data without encryption.');
  }
  let workspacePath: string | undefined;
  if (parseStorageProfile(env).structured.kind === 'disk') {
    if (overrides.workspacePath) {
      environmentValue('Home directory', overrides.workspacePath);
    } else {
      const suggestedHome = suggestWorkspacePath(env);
      workspacePath =
        (
          await answer(
            prompts.text({
              message: 'Home directory',
              placeholder: suggestedHome,
              defaultValue: suggestedHome,
              initialValue: suggestedHome,
              validate(value) {
                if (!isAbsolute(value?.trim() || suggestedHome))
                  return 'Home directory must be an absolute path.';
              },
            }),
          )
        ).trim() || suggestedHome;
    }
  }
  if (overrides.credentials) {
    environmentValue(
      'Login credentials',
      `${env.HUABU_BASIC_AUTH_USER}\nPassword configured`,
    );
    return { remote, origin, allowHttp, workspacePath };
  }
  const login =
    overrides.authentication !== undefined
      ? overrides.authentication === 'basic'
      : await answer(
          prompts.confirm({
            message: 'Require login?',
            initialValue: previous?.enabled
              ? previous.authentication !== 'none'
              : true,
          }),
        );
  if (overrides.authentication !== undefined) {
    environmentValue('Login', login ? 'Required' : 'Disabled');
  }
  if (!login) {
    prompts.log.warn(
      'Anyone who can reach Huabu will have full owner access. Use a trusted network or an authenticated proxy.',
    );
    if (
      overrides.authentication === undefined &&
      !(await answer(
        prompts.confirm({
          message: 'Continue without login?',
          initialValue: false,
        }),
      ))
    ) {
      throw new SetupCancelled();
    }
    return { remote, origin, allowHttp, workspacePath, login: false };
  }
  const suggestedUsername = (previous?.enabled && previous.username) || 'owner';
  const username =
    (
      await answer(
        prompts.text({
          message: 'Login username',
          placeholder: suggestedUsername,
          defaultValue: suggestedUsername,
          initialValue: suggestedUsername,
          validate(value) {
            const parsed = deploymentUsernameSchema.safeParse(
              value || suggestedUsername,
            );
            if (!parsed.success) return parsed.error.issues[0]?.message;
          },
        }),
      )
    ).trim() || suggestedUsername;
  const savedPassword = await readPersistedSecret(
    SECRET_IDS.remoteAccessPassword,
    env,
  );
  if (
    savedPassword &&
    !(await answer(
      prompts.confirm({
        message: 'Change login password?',
        initialValue: false,
      }),
    ))
  ) {
    return { remote, origin, username, allowHttp, workspacePath };
  }
  const password = await answer(
    prompts.password({
      message: 'Set a password for remote login',
      mask: '*',
      validate(value) {
        try {
          validateSetupPassword(value ?? '');
        } catch (error) {
          if (error instanceof Error) return error.message;
          throw error;
        }
      },
    }),
  );
  await answer(
    prompts.password({
      message: 'Confirm password',
      mask: '*',
      validate(value) {
        if (value !== password) return 'Passwords do not match.';
      },
    }),
  );
  return { remote, origin, username, password, allowHttp, workspacePath };
}

export async function configureDeployment(
  input: SetupInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const overrides = readSetupEnvironment(env);
  if (
    input.login !== undefined &&
    overrides.authentication !== undefined &&
    input.login !== (overrides.authentication === 'basic')
  ) {
    throw new Error(
      'Environment overrides control login. Remove them before changing login with setup.',
    );
  }
  const login = overrides.authentication
    ? overrides.authentication === 'basic'
    : input.login !== false;
  if (
    !login &&
    (input.username !== undefined || input.password !== undefined)
  ) {
    throw new Error(
      'Login credentials cannot be supplied when login is disabled.',
    );
  }
  if (overrides.remote !== undefined && overrides.remote !== input.remote) {
    throw new Error(
      'HUABU_BIND_HOST controls the access mode. Remove that override before changing modes with setup.',
    );
  }
  let settings: DeploymentSettings;
  let password = input.password;
  if (input.remote) {
    const origin = overrides.origin ?? input.origin;
    if (!origin)
      throw new Error(
        'Remote access requires an address reachable from your other devices.',
      );
    const publicOrigin = normalizeSetupOrigin(origin);
    if (new URL(publicOrigin).protocol === 'http:' && !input.allowHttp) {
      throw new Error(
        'HTTP exposes credentials and data. Confirm a trusted private network with --allow-http, or use an externally configured HTTPS address.',
      );
    }
    const previous = readDeploymentSettings(env)?.remoteAccess;
    const username = deploymentUsernameSchema.safeParse(
      (!overrides.credentials ? input.username : undefined) ??
        (previous?.enabled ? previous.username : undefined) ??
        'owner',
    );
    if (!username.success) {
      throw new Error(
        username.error.issues.map((issue) => issue.message).join(' '),
      );
    }
    if (login && !overrides.credentials) {
      password ??=
        (await readPersistedSecret(SECRET_IDS.remoteAccessPassword, env)) ??
        undefined;
      if (password === undefined) {
        throw new Error(
          'No saved login password. Run interactive setup or provide --password-stdin with redirected input.',
        );
      }
      validateSetupPassword(password);
    }
    const disk = parseStorageProfile(env).structured.kind === 'disk';
    if (!disk && input.workspacePath) {
      throw new Error(
        'This database backend does not use a Home directory; omit --workspace.',
      );
    }
    if (!disk && env.HUABU_WORKSPACE?.trim()) {
      throw new Error(
        'This database backend does not use HUABU_WORKSPACE. Remove that override before setup.',
      );
    }
    const workspacePath = disk
      ? overrides.workspacePath
        ? previous?.enabled
          ? previous.workspacePath
          : undefined
        : (input.workspacePath ?? suggestWorkspacePath(env))
      : undefined;
    if (workspacePath && !isAbsolute(workspacePath)) {
      throw new Error('Home directory must be an absolute path.');
    }
    const savedAuthentication =
      env.HUABU_AUTH_MODE !== undefined || overrides.credentials
        ? previous?.enabled
          ? previous.authentication
          : undefined
        : login
          ? undefined
          : 'none';
    settings = {
      version: 1,
      remoteAccess: {
        enabled: true,
        ...(savedAuthentication ? { authentication: savedAuthentication } : {}),
        username: username.data,
        publicOrigin:
          overrides.origin && previous?.enabled
            ? previous.publicOrigin
            : publicOrigin,
        ...(workspacePath ? { workspacePath } : {}),
      },
    };
  } else {
    settings = { version: 1, remoteAccess: { enabled: false } };
  }
  const effective = resolveDeploymentEnvironment(
    env,
    settings,
    password ?? null,
  );
  resolveDeploymentConfig(effective);
  if (input.remote && parseStorageProfile(env).structured.kind === 'disk') {
    const workspace = effective.HUABU_WORKSPACE;
    if (!workspace)
      throw new Error('Remote disk access requires a Home directory.');
    mkdirSync(workspace, { recursive: true });
    accessSync(workspace, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  await initializeSecretStore(env);
  if (
    input.remote &&
    login &&
    !overrides.credentials &&
    input.password !== undefined
  ) {
    await setSecret(SECRET_IDS.remoteAccessPassword, input.password);
  }
  saveDeploymentSettings(settings, env);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      local: { type: 'boolean' },
      remote: { type: 'boolean' },
      origin: { type: 'string' },
      username: { type: 'string' },
      workspace: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      'no-login': { type: 'boolean' },
      'allow-http': { type: 'boolean' },
      'reset-connection-token': { type: 'boolean' },
    },
  });
  if (values.help) {
    print(`Usage: pnpm run setup
       pnpm run setup --local
       pnpm run setup --remote [--origin <http(s)://host[:port]>] [--password-stdin | --no-login] [--username <name>] [--workspace <absolute-path>] [--allow-http]
       pnpm run setup --reset-connection-token

Before you begin
  Before setup, stop all Huabu servers and Vite dev servers sharing this instance's credentials.
  Setup does not check for running services. Start them again after setup.
  The same sequence applies to connection-token resets.

Remote access
  Login username is optional: Enter reuses the saved username or owner.
  --username sets it non-interactively; omitting it reuses the saved username or owner.
  Usernames cannot be blank or contain colons or control characters.
  Password input is masked; passwords are never accepted in argv.
  --no-login explicitly allows full owner access without login.
  Use it only on a trusted network or behind an authenticated proxy.
  Environment-managed fields are displayed instead of prompting; passwords are never displayed.
  --origin is required unless managed by the environment.
  Existing login passwords are kept unless you choose to change them.
  --password-stdin sets or replaces the password; omit it to reuse a saved password.
  First-time login requires a password unless credentials are environment-managed.
  HTTPS requires an existing reverse proxy or tunnel.
  --allow-http confirms plaintext transport on a trusted private network.

Home directory
  Disk storage: confirm a Home; automation defaults to <dataDir>/workspace.
  Database backends: no Home directory or --workspace option.

Configuration
  Environment overrides take precedence. Existing .env files are never modified.
  Invalid overrides fail explicitly. HUABU_BIND_HOST fixes the access mode.
  Access mode and editable defaults reuse the saved setup choices.
  HUABU_AUTH_MODE=basic|none controls whether login is required.
  Interactive setup requires a terminal. Normal startup never prompts.`);
    return;
  }
  if (values.local && values.remote)
    throw new Error('Choose either --local or --remote.');
  if (
    !values.remote &&
    (values.origin ||
      values.username !== undefined ||
      values.workspace ||
      values['password-stdin'] ||
      values['no-login'] ||
      values['allow-http'])
  ) {
    throw new Error(
      '--origin, --username, --workspace, --password-stdin, --no-login and --allow-http require --remote.',
    );
  }
  if (
    values['no-login'] &&
    (values.username !== undefined || values['password-stdin'])
  ) {
    throw new Error(
      '--no-login cannot be combined with --username or --password-stdin.',
    );
  }
  const interactive =
    !values.local && !values.remote && !values['reset-connection-token'];
  if (interactive) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Interactive setup needs a terminal. Use --local, or --remote --origin <address> --password-stdin.',
      );
    }
    prompts.intro('Huabu Setup');
    prompts.log.message(
      "Stop this instance's Huabu and Vite services before configuring.",
    );
  } else {
    print(
      "\nStop this instance's Huabu and Vite services before continuing.\n",
    );
  }
  if (values['reset-connection-token']) {
    if (values.local || values.remote)
      throw new Error(
        'Reset the connection token separately from deployment setup.',
      );
    if (process.env.HUABU_CONNECTION_TOKEN?.trim()) {
      throw new Error(
        'HUABU_CONNECTION_TOKEN controls the active token. Change that deployment override instead.',
      );
    }
    await initializeSecretStore();
    await setSecret(
      SECRET_IDS.managedConnectionToken,
      randomBytes(32).toString('hex'),
    );
    print('Connection token reset.\n');
    print('Next: Start Huabu to apply the new token.');
    print('Then copy new connection commands or env files for your Agents.');
    return;
  }
  const overrides = readSetupEnvironment(process.env);
  if (
    overrides.authentication === 'none' &&
    (values['password-stdin'] || values.username !== undefined)
  ) {
    throw new Error(
      'HUABU_AUTH_MODE=none disables login. Remove --username and --password-stdin or change the environment override.',
    );
  }

  let input: SetupInput = {
    remote: values.remote ?? false,
    login: values['no-login'] ? false : undefined,
    origin: values.origin,
    username: values.username,
    allowHttp: values['allow-http'],
    workspacePath: values.workspace,
  };
  let password: string | undefined;
  if (interactive) {
    input = await promptDeployment();
  } else if (
    input.remote &&
    input.login !== false &&
    overrides.authentication !== 'none' &&
    values['password-stdin']
  ) {
    if (process.stdin.isTTY) {
      throw new Error(
        'Non-interactive remote setup requires --password-stdin with redirected input. Run pnpm run setup for hidden interactive input.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
    }
    password = Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  await configureDeployment(interactive ? input : { ...input, password });
  const settings = readDeploymentSettings();
  const savedPassword = getPersistedSecret(SECRET_IDS.remoteAccessPassword);
  if (
    !interactive &&
    resolveAuthenticationMode(
      resolveDeploymentEnvironment(process.env, settings, savedPassword),
    ) === 'none'
  ) {
    printError(
      'Warning: Login is disabled. Anyone who can reach Huabu has full owner access.',
    );
  }
  const summary = buildSetupSummary(process.env, settings, savedPassword);
  if (interactive) {
    prompts.note(summary.join('\n'), 'Configuration saved');
    prompts.outro('Start with pnpm start:web');
    return;
  }
  print('\nConfiguration saved.');
  for (const line of summary) print(`  ${line}`);
  print(`  Configuration: ${getConfigDir()}`);
  print('\nNext: Start Huabu to apply:');
  print('  pnpm start:web');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    if (error instanceof SetupCancelled) {
      prompts.cancel('Setup cancelled. No configuration saved.');
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      prompts.log.error(
        error instanceof Error ? error.message : 'Huabu setup failed',
      );
    } else {
      printError(error instanceof Error ? error.message : 'Huabu setup failed');
    }
    process.exitCode = 1;
  });
}
