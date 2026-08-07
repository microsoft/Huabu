import { statSync } from 'node:fs';

import { readManifest } from './setup/manifest.js';
import { isManagedSetupReady } from './managed-workspace.js';
import {
  cliToolIsReady,
  resolveNpmToolsRoot,
} from './setup/npm-tools.js';

export interface ManagedAgentTeamValidationIssue {
  code:
    | 'manifest_invalid'
    | 'harness_unsupported'
    | 'workspace_missing'
    | 'workspace_not_ready'
    | 'tools_missing';
  message: string;
}

export interface ManagedAgentTeamValidationResult {
  valid: boolean;
  issues: ManagedAgentTeamValidationIssue[];
}

/** Validate one prepared deployment without mutating package or workspace files. */
export function validateManagedAgentTeam(options: {
  packageDir: string;
  harness: string;
  workingDirPath: string;
}): ManagedAgentTeamValidationResult {
  const issues: ManagedAgentTeamValidationIssue[] = [];
  let manifest;
  try {
    manifest = readManifest(options.packageDir);
  } catch (error) {
    issues.push({
      code: 'manifest_invalid',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (manifest && !(options.harness in manifest.command)) {
    issues.push({
      code: 'harness_unsupported',
      message: `Harness "${options.harness}" is not defined in agentlet.yaml`,
    });
  }

  try {
    if (!statSync(options.workingDirPath).isDirectory()) {
      throw new Error('path is not a directory');
    }
  } catch {
    issues.push({
      code: 'workspace_missing',
      message: `Workspace is missing or not a directory: ${options.workingDirPath}`,
    });
  }
  if (
    !issues.some((issue) => issue.code === 'workspace_missing') &&
    !isManagedSetupReady(options.workingDirPath, options.harness)
  ) {
    issues.push({
      code: 'workspace_not_ready',
      message: `Workspace has no valid completed-setup marker: ${options.workingDirPath}`,
    });
  }
  if (manifest) {
    for (const tool of manifest.require?.['cli-tools'] ?? []) {
      const root = resolveNpmToolsRoot(tool, options.workingDirPath);
      try {
        if (!cliToolIsReady(root, tool)) {
          issues.push({
            code: 'tools_missing',
            message: `CLI tool is missing or incomplete: ${tool.package}`,
          });
        }
      } catch (error) {
        issues.push({
          code: 'tools_missing',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
