// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'dotenv';

export function parseConnectionEnvironmentFile(
  text: string,
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (text.includes('\0')) throw new Error('Environment file contains NUL');
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let statement = lines[index] ?? '';
    if (!statement.trim() || statement.trimStart().startsWith('#')) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      statement,
    );
    if (!match)
      throw new Error(`Invalid environment assignment at line ${index + 1}`);
    const key = match[1];
    const value = match[2] ?? '';
    if (!key) throw new Error('Invalid environment key');
    const canonical = platform === 'win32' ? key.toUpperCase() : key;
    if (seen.has(canonical))
      throw new Error(`Duplicate environment key: ${key}`);
    seen.add(canonical);
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let quoted = value;
      let closing = -1;
      while (closing < 0) {
        for (let offset = 1; offset < quoted.length; offset++) {
          if (quoted[offset] !== quote) continue;
          let slashes = 0;
          for (
            let before = offset - 1;
            before >= 0 && quoted[before] === '\\';
            before--
          )
            slashes++;
          if (slashes % 2 === 0) {
            closing = offset;
            break;
          }
        }
        if (closing < 0) {
          index++;
          if (index >= lines.length)
            throw new Error(`Unclosed environment value for ${key}`);
          quoted += `\n${lines[index]}`;
          statement += `\n${lines[index]}`;
        }
      }
      const trailing = quoted.slice(closing + 1).trim();
      if (trailing && !trailing.startsWith('#'))
        throw new Error(`Invalid environment value for ${key}`);
    }
    const parsed = parse(statement);
    if (!Object.hasOwn(parsed, key))
      throw new Error(`Invalid environment value for ${key}`);
    if (keys.includes(canonical)) {
      result[canonical] = parsed[key] ?? '';
    }
  }
  return result;
}

export function readConnectionEnvironment(options: {
  keys: readonly string[];
  repoRoot?: string;
  cwd?: string;
  envFile?: string;
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Record<string, string | undefined> {
  const platform = options.platform ?? process.platform;
  if (options.envFile !== undefined && !options.envFile.trim())
    throw new Error('--env-file requires a non-empty path');
  const path =
    options.envFile !== undefined
      ? resolve(options.cwd ?? process.cwd(), options.envFile)
      : options.repoRoot
        ? resolve(options.repoRoot, '.env')
        : undefined;
  let fileEnv: Record<string, string> = {};
  if (path) {
    try {
      fileEnv = parseConnectionEnvironmentFile(
        readFileSync(path, 'utf8'),
        options.keys,
        platform,
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT' &&
          options.envFile === undefined
        )
      )
        throw error;
    }
  }
  const inherited: Record<string, string | undefined> = {};
  if (options.envFile === undefined) {
    const source = options.inherited ?? process.env;
    for (const key of Object.keys(source)) {
      const canonical = platform === 'win32' ? key.toUpperCase() : key;
      if (!options.keys.includes(canonical)) continue;
      if (Object.hasOwn(inherited, canonical))
        throw new Error(`Duplicate environment key: ${canonical}`);
      inherited[canonical] = source[key];
    }
  }
  return { ...fileEnv, ...inherited };
}
