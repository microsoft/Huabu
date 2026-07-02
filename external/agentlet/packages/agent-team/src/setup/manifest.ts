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
        ['cli-tools', requireDoc['cli-tools']],
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
