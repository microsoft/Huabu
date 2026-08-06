import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CliToolRequirement } from './types.js';

const RECEIPT_SCHEMA = 'agentlet-npm-tools-v1';
const RECEIPT_FILENAME = '.agentlet-tools.json';

interface ToolReceipt {
  package: string;
  executables: string[];
}

interface ToolsReceipt {
  schema: typeof RECEIPT_SCHEMA;
  tools: Record<string, ToolReceipt>;
}

function emptyReceipt(): ToolsReceipt {
  return { schema: RECEIPT_SCHEMA, tools: {} };
}

function readReceipt(root: string): ToolsReceipt {
  const path = join(root, RECEIPT_FILENAME);
  if (!existsSync(path)) return emptyReceipt();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolsReceipt>;
  if (
    parsed.schema !== RECEIPT_SCHEMA ||
    typeof parsed.tools !== 'object' ||
    parsed.tools === null
  ) {
    throw new Error(`Invalid Agentlet tools receipt: ${path}`);
  }
  return parsed as ToolsReceipt;
}

function executableExists(binDir: string, executable: string): boolean {
  return ['', '.cmd', '.exe', '.ps1'].some((extension) =>
    existsSync(join(binDir, `${executable}${extension}`)),
  );
}

export function resolveSharedNpmToolsRoot(): string {
  const override = process.env.AGENTLET_SHARED_NPM_TOOLS_DIR?.trim();
  return override
    ? resolve(override)
    : join(homedir(), '.agentlet', 'tools', 'npm');
}

export function resolveNpmToolsRoot(
  tool: CliToolRequirement,
  workspaceDir: string,
): string {
  return tool.scope === 'shared'
    ? join(
        resolveSharedNpmToolsRoot(),
        'packages',
        createHash('sha256').update(tool.package).digest('hex').slice(0, 16),
      )
    : workspaceDir;
}

export function npmToolsBinDir(root: string): string {
  return join(root, 'node_modules', '.bin');
}

export function cliToolIsReady(
  root: string,
  tool: CliToolRequirement,
): boolean {
  const receipt = readReceipt(root).tools[tool.package];
  if (
    !receipt ||
    receipt.package !== tool.package ||
    receipt.executables.length !== tool.executables.length ||
    receipt.executables.some(
      (executable, index) => executable !== tool.executables[index],
    )
  ) {
    return false;
  }
  return cliToolExecutablesExist(root, tool);
}

export function cliToolExecutablesExist(
  root: string,
  tool: CliToolRequirement,
): boolean {
  const binDir = npmToolsBinDir(root);
  return tool.executables.every((executable) =>
    executableExists(binDir, executable),
  );
}

export function recordCliTool(
  root: string,
  tool: CliToolRequirement,
): void {
  mkdirSync(root, { recursive: true });
  const receipt = readReceipt(root);
  receipt.tools[tool.package] = {
    package: tool.package,
    executables: [...tool.executables],
  };
  const path = join(root, RECEIPT_FILENAME);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}
import { createHash } from 'node:crypto';
