import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { readManifest } from './setup/manifest.js';
import type { AgentTeamEnvField } from './setup/types.js';

export interface AgentTeamScanMember {
  name: string;
  manifestPath: string;
  description: string;
  harnesses: string[];
  env: AgentTeamEnvField[];
}

export interface AgentTeamScanDiagnostic {
  manifestPath: string;
  code: 'invalid_manifest' | 'manifest_unreadable';
  message: string;
}

export interface AgentTeamScanResult {
  rootPath: string;
  members: AgentTeamScanMember[];
  diagnostics: AgentTeamScanDiagnostic[];
}

/** Discover immediate child Agent Team manifests below one absolute root. */
export function scanAgentTeamRoot(rootPath: string): AgentTeamScanResult {
  if (!isAbsolute(rootPath)) {
    throw new Error('Agent Team root path must be absolute');
  }

  const normalizedRoot = resolve(rootPath);
  let entries;
  try {
    if (!statSync(normalizedRoot).isDirectory()) {
      throw new Error('path is not a directory');
    }
    entries = readdirSync(normalizedRoot, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot scan Agent Team root ${normalizedRoot}: ${message}`);
  }

  const members: AgentTeamScanMember[] = [];
  const diagnostics: AgentTeamScanDiagnostic[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const packageDir = join(normalizedRoot, entry.name);
    const manifestPath = join(packageDir, 'agentlet.yaml');
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = readManifest(packageDir);
      members.push({
        name: manifest.name,
        manifestPath,
        description: manifest.description,
        harnesses: Object.keys(manifest.command),
        env: manifest.require?.env ?? [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        manifestPath,
        code: message.startsWith('Cannot read manifest:')
          ? 'manifest_unreadable'
          : 'invalid_manifest',
        message,
      });
    }
  }

  return { rootPath: normalizedRoot, members, diagnostics };
}
