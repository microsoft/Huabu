/**
 * Parse and validate agentlet.yaml manifests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentTeamManifest } from './types.js';

const CURRENT_SCHEMA = 'agentlet-agent-schema-v1';

/** Read and parse agentlet.yaml from the given package directory. */
export function readManifest(packageDir: string): AgentTeamManifest {
  const manifestPath = join(packageDir, 'agentlet.yaml');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`Cannot read manifest: ${manifestPath}`);
  }

  const doc = parseYaml(raw) as Record<string, unknown>;
  return validateManifest(doc, manifestPath);
}

/** Validate a parsed YAML document against the manifest schema. */
function validateManifest(
  doc: Record<string, unknown>,
  sourcePath: string,
): AgentTeamManifest {
  const errors: string[] = [];

  if (typeof doc.schema !== 'string') {
    errors.push('`schema` is required and must be a string');
  } else if (doc.schema !== CURRENT_SCHEMA) {
    errors.push(
      `unsupported schema "${doc.schema}" (expected "${CURRENT_SCHEMA}")`,
    );
  }

  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    errors.push('`name` is required and must be a non-empty string');
  }

  if (typeof doc.description !== 'string' || doc.description.trim() === '') {
    errors.push('`description` is required and must be a non-empty string');
  }

  if (doc.command === undefined) {
    errors.push('`command` is required');
  } else if (
    typeof doc.command !== 'object' ||
    doc.command === null ||
    Array.isArray(doc.command)
  ) {
    errors.push('`command` must be a map of harness → command');
  } else {
    const commandEntries = Object.entries(doc.command as Record<string, unknown>);
    if (commandEntries.length === 0) {
      errors.push('`command` must define at least one harness');
    }
    if (
      commandEntries.some(
        ([key, value]) => key.trim() === '' || typeof value !== 'string',
      )
    ) {
      errors.push(
        '`command` map keys must be non-empty strings and values must all be strings',
      );
    }
  }

  if (doc.require !== undefined) {
    if (
      typeof doc.require !== 'object' ||
      doc.require === null ||
      Array.isArray(doc.require)
    ) {
      errors.push('`require` must be an object');
    } else {
      const requireDoc = doc.require as Record<string, unknown>;
      const requireArrays = [
        ['prompts', requireDoc.prompts],
        ['skills', requireDoc.skills],
      ] as const;

      for (const [field, value] of requireArrays) {
        if (
          value !== undefined &&
          (!Array.isArray(value) ||
            !value.every((entry: unknown) => typeof entry === 'string'))
        ) {
          errors.push(`\`require.${field}\` must be an array of strings`);
        }
      }

      const cliTools = requireDoc['cli-tools'];
      if (cliTools !== undefined) {
        if (!Array.isArray(cliTools)) {
          errors.push('`require.cli-tools` must be an array');
        } else {
          cliTools.forEach((entry: unknown, i) => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              Array.isArray(entry)
            ) {
              errors.push(`\`require.cli-tools[${i}]\` must be an object`);
              return;
            }
            const tool = entry as Record<string, unknown>;
            const unknownKeys = Object.keys(tool).filter(
              (key) =>
                !['package', 'installer', 'scope', 'executables'].includes(key),
            );
            if (unknownKeys.length > 0) {
              errors.push(
                `\`require.cli-tools[${i}]\` has unknown field(s): ${unknownKeys.join(', ')}`,
              );
            }
            if (
              typeof tool.package !== 'string' ||
              tool.package.trim() === '' ||
              tool.package.trim() !== tool.package ||
              tool.package.startsWith('-')
            ) {
              errors.push(
                `\`require.cli-tools[${i}].package\` must be a non-empty package identifier without surrounding whitespace or a leading dash`,
              );
            }
            if (tool.installer !== 'npm') {
              errors.push(
                `\`require.cli-tools[${i}].installer\` must be "npm"`,
              );
            }
            if (tool.scope !== 'workspace' && tool.scope !== 'shared') {
              errors.push(
                `\`require.cli-tools[${i}].scope\` must be "workspace" or "shared"`,
              );
            }
            if (
              !Array.isArray(tool.executables) ||
              tool.executables.length === 0 ||
              !tool.executables.every(
                (executable) =>
                  typeof executable === 'string' &&
                  executable.trim() !== '' &&
                  executable.trim() === executable &&
                  executable !== '.' &&
                  executable !== '..' &&
                  !executable.includes('/') &&
                  !executable.includes('\\'),
              )
            ) {
              errors.push(
                `\`require.cli-tools[${i}].executables\` must be a non-empty array of command basenames`,
              );
            }
          });
        }
      }

      const copies = requireDoc.copies;
      if (copies !== undefined) {
        if (!Array.isArray(copies)) {
          errors.push('`require.copies` must be an array of { from, to } objects');
        } else {
          copies.forEach((entry: unknown, i) => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              Array.isArray(entry) ||
              typeof (entry as Record<string, unknown>).from !== 'string' ||
              typeof (entry as Record<string, unknown>).to !== 'string'
            ) {
              errors.push(
                `\`require.copies[${i}]\` must be an object with string \`from\` and \`to\` fields`,
              );
            }
          });
        }
      }

      const env = requireDoc.env;
      if (env !== undefined) {
        if (!Array.isArray(env)) {
          errors.push('`require.env` must be an array');
        } else {
          env.forEach((entry: unknown, i) => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              Array.isArray(entry)
            ) {
              errors.push(`\`require.env[${i}]\` must be an object`);
              return;
            }

            const field = entry as Record<string, unknown>;
            if (typeof field.name !== 'string' || field.name.trim() === '') {
              errors.push(
                `\`require.env[${i}].name\` must be a non-empty string`,
              );
            }
            if (
              typeof field.description !== 'string' ||
              field.description.trim() === ''
            ) {
              errors.push(
                `\`require.env[${i}].description\` must be a non-empty string`,
              );
            }
            if (typeof field.required !== 'boolean') {
              errors.push(`\`require.env[${i}].required\` must be a boolean`);
            }
            if (typeof field.secret !== 'boolean') {
              errors.push(`\`require.env[${i}].secret\` must be a boolean`);
            }
            if (
              field.default !== undefined &&
              typeof field.default !== 'string'
            ) {
              errors.push(`\`require.env[${i}].default\` must be a string`);
            }
            if (field.secret === true && field.default !== undefined) {
              errors.push(
                `\`require.env[${i}].default\` is not allowed for secret fields`,
              );
            }
          });
        }
      }
    }
  }

  for (const deprecatedField of [
    'tools',
    'skills',
    'system_prompt',
    'supported_harnesses',
  ] as const) {
    if (deprecatedField in doc) {
      errors.push(
        `\`${deprecatedField}\` is no longer supported; use \`require\` and \`command\` keys instead`,
      );
    }
  }

  if (doc.onInstall !== undefined) {
    if (typeof doc.onInstall !== 'string') {
      errors.push('`onInstall` must be a string (path to setup script)');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid manifest (${sourcePath}):\n  - ${errors.join('\n  - ')}`,
    );
  }

  return doc as unknown as AgentTeamManifest;
}
