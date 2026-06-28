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

  if (doc.supported_harnesses !== undefined) {
    if (
      !Array.isArray(doc.supported_harnesses) ||
      !doc.supported_harnesses.every((h: unknown) => typeof h === 'string')
    ) {
      errors.push('`supported_harnesses` must be an array of strings');
    }
  }

  if (doc.command === undefined) {
    errors.push('`command` is required');
  } else if (typeof doc.command !== 'string' && typeof doc.command !== 'object') {
    errors.push('`command` must be a string or a map of harness → command');
  } else if (
    typeof doc.command === 'object' &&
    !Object.values(doc.command as Record<string, unknown>).every(
      (v) => typeof v === 'string',
    )
  ) {
    errors.push('`command` map values must all be strings');
  }

  // Declarative setup fields
  if (doc.tools !== undefined) {
    if (
      !Array.isArray(doc.tools) ||
      !doc.tools.every((t: unknown) => typeof t === 'string')
    ) {
      errors.push('`tools` must be an array of strings');
    }
  }

  if (doc.skills !== undefined) {
    if (
      !Array.isArray(doc.skills) ||
      !doc.skills.every((s: unknown) => typeof s === 'string')
    ) {
      errors.push('`skills` must be an array of strings');
    }
  }

  if (doc.system_prompt !== undefined) {
    if (typeof doc.system_prompt !== 'string') {
      errors.push('`system_prompt` must be a string');
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
