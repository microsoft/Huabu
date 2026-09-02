import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ensureResourceLayout, resourceSubdirPath } from './resource-dir.js';
import { readReceipt, removeReceipt, writeReceipt, type ResourceReceipt } from './receipts.js';

const SKILL_MANIFEST = 'SKILL.md';
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_CONTENT_BYTES = 100_000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillImportCandidate {
  id: string;
  name: string;
  sourcePath: string;
  sourceContent: string;
  sourceRevision: string;
}

export interface SkillScanDiagnostic {
  path: string;
  code: 'skill_unreadable' | 'skill_invalid';
  message: string;
}

export interface SkillScanResult {
  rootPath: string;
  candidates: SkillImportCandidate[];
  diagnostics: SkillScanDiagnostic[];
}

export interface ImportSkillInput {
  id: string;
  sourcePath: string;
  expectedRevision: string;
}

export interface ImportSkillResult {
  receipt: ResourceReceipt;
  created: boolean;
}

interface SkillInstallTransaction {
  targetRevision: string;
}

function recoverInterruptedSkill(root: string, id: string): void {
  if (!KEBAB_CASE.test(id)) return;
  const skillsDir = resourceSubdirPath(root, 'skills');
  const destination = join(skillsDir, id);
  const importing = join(skillsDir, `.${id}.importing`);
  const previous = join(skillsDir, `.${id}.previous`);
  const transaction = join(skillsDir, `.${id}.transaction`);
  const transactionTemporary = `${transaction}.tmp`;
  rmSync(importing, { recursive: true, force: true });
  rmSync(transactionTemporary, { force: true });
  if (existsSync(transaction)) {
    let state: SkillInstallTransaction;
    try {
      const parsed: unknown = JSON.parse(readFileSync(transaction, 'utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('targetRevision' in parsed) ||
        typeof parsed.targetRevision !== 'string'
      ) {
        throw new Error('invalid transaction state');
      }
      state = { targetRevision: parsed.targetRevision };
    } catch (error) {
      throw new Error(
        `Cannot recover interrupted Skill installation ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const committed =
      existsSync(destination) &&
      readReceipt(root, id)?.sourceRevision === state.targetRevision;
    if (!committed) {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(previous)) renameSync(previous, destination);
    }
    rmSync(transaction, { force: true });
    if (committed) rmSync(previous, { recursive: true, force: true });
    return;
  }
  if (!existsSync(destination) && existsSync(previous)) {
    renameSync(previous, destination);
  } else if (existsSync(destination)) {
    rmSync(previous, { recursive: true, force: true });
  }
}

function toResourceId(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseFrontmatterName(content: string): string | undefined {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return undefined;
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return undefined;
  const frontmatter = normalized.slice(4, end);
  const match = /^name:\s*(.+?)\s*$/m.exec(frontmatter);
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim() || undefined;
  }
  return value || undefined;
}

function collectSkillFiles(skillDir: string): Array<{ absolutePath: string; relativePath: string }> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error('Skill packages must not contain symbolic links');
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({ absolutePath, relativePath: relative(skillDir, absolutePath) });
      totalBytes += stats.size;
      if (files.length > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
        throw new Error('Skill package exceeds the supported file or size limit');
      }
    }
  };

  visit(skillDir);
  return files;
}

function readSkillCandidate(sourcePath: string): SkillImportCandidate {
  if (!isAbsolute(sourcePath)) {
    throw new Error('Skill source path must be absolute');
  }
  const resolvedSource = realpathSync(resolve(sourcePath));
  if (!statSync(resolvedSource).isDirectory()) {
    throw new Error('Skill source path must be a directory');
  }
  const manifestPath = join(resolvedSource, SKILL_MANIFEST);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`Skill source must contain ${SKILL_MANIFEST}`);
  }
  const manifestStats = statSync(manifestPath);
  if (manifestStats.size > MAX_SOURCE_CONTENT_BYTES) {
    throw new Error(`${SKILL_MANIFEST} exceeds the supported size limit`);
  }
  const sourceContent = readFileSync(manifestPath, 'utf8').trim();
  if (!sourceContent) throw new Error(`${SKILL_MANIFEST} must not be empty`);

  const files = collectSkillFiles(resolvedSource);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(readFileSync(file.absolutePath));
    hash.update('\0');
  }

  const name = parseFrontmatterName(sourceContent) ?? basename(resolvedSource);
  const id = toResourceId(name) || toResourceId(basename(resolvedSource));
  if (!id || !KEBAB_CASE.test(id)) {
    throw new Error('Skill name cannot be converted to a valid resource id');
  }
  return {
    id,
    name,
    sourcePath: resolvedSource,
    sourceContent,
    sourceRevision: hash.digest('hex'),
  };
}

export function scanSkillFolder(rootPath: string): SkillScanResult {
  if (!isAbsolute(rootPath)) throw new Error('Skill scan root must be absolute');
  const resolvedRoot = realpathSync(resolve(rootPath));
  if (!statSync(resolvedRoot).isDirectory()) {
    throw new Error('Skill scan root must be a directory');
  }

  const candidates: SkillImportCandidate[] = [];
  const diagnostics: SkillScanDiagnostic[] = [];
  let entryCount = 0;

  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      diagnostics.push({
        path: directory,
        code: 'skill_unreadable',
        message: 'Directory cannot be read',
      });
      return;
    }
    entryCount += entries.length;
    if (entryCount > MAX_SCAN_ENTRIES) {
      throw new Error('Skill scan exceeds the supported entry limit');
    }

    if (entries.some((entry) => entry.isFile() && entry.name === SKILL_MANIFEST)) {
      try {
        candidates.push(readSkillCandidate(directory));
      } catch (error) {
        diagnostics.push({
          path: join(directory, SKILL_MANIFEST),
          code: 'skill_invalid',
          message: error instanceof Error ? error.message : 'Skill failed validation',
        });
      }
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      visit(join(directory, entry.name), depth + 1);
    }
  };

  visit(resolvedRoot, 0);
  return {
    rootPath: resolvedRoot,
    candidates: candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    diagnostics,
  };
}

export function scanSkillSource(sourcePath: string): SkillImportCandidate {
  return readSkillCandidate(sourcePath);
}

function installSkill(
  root: string,
  provider: string,
  input: ImportSkillInput,
  replaceExisting: boolean,
): ImportSkillResult {
  if (!KEBAB_CASE.test(input.id)) throw new Error('Resource id must be lowercase kebab-case');
  const candidate = readSkillCandidate(input.sourcePath);
  if (candidate.sourceRevision !== input.expectedRevision) {
    throw new Error('Skill source changed after preview; scan it again');
  }

  ensureResourceLayout(root);
  const skillsDir = resourceSubdirPath(root, 'skills');
  const destination = join(skillsDir, input.id);
  recoverInterruptedSkill(root, input.id);
  const existingReceipt = readReceipt(root, input.id);
  if (
    !replaceExisting &&
    existingReceipt?.kind === 'skill' &&
    existingReceipt.provider === provider &&
    existingReceipt.source === candidate.sourcePath &&
    existingReceipt.sourceRevision === candidate.sourceRevision &&
    existingReceipt.entrypoint === join('skills', input.id, SKILL_MANIFEST) &&
    existsSync(destination)
  ) {
    return { receipt: existingReceipt, created: false };
  }
  const temporary = join(skillsDir, `.${input.id}.importing`);
  const backup = join(skillsDir, `.${input.id}.previous`);
  const transaction = join(skillsDir, `.${input.id}.transaction`);
  const transactionTemporary = `${transaction}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  rmSync(transaction, { force: true });
  rmSync(transactionTemporary, { force: true });
  if (existsSync(destination) && !replaceExisting) {
    throw new Error(`Managed Skill already exists: ${input.id}`);
  }

  cpSync(candidate.sourcePath, temporary, {
    recursive: true,
    errorOnExist: true,
    filter: (source) => {
      const rel = relative(candidate.sourcePath, source);
      if (
        rel &&
        rel.split(sep).some((segment) => IGNORED_DIRECTORIES.has(segment))
      ) {
        return false;
      }
      if (lstatSync(source).isSymbolicLink()) {
        throw new Error('Skill packages must not contain symbolic links');
      }
      return true;
    },
  });
  const copiedCandidate = readSkillCandidate(temporary);
  if (copiedCandidate.sourceRevision !== input.expectedRevision) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error('Skill source changed while it was being copied; scan it again');
  }
  let movedExisting = false;
  let promoted = false;
  let receipt: ResourceReceipt;
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedExisting = true;
    }
    writeFileSync(
      transactionTemporary,
      `${JSON.stringify({ targetRevision: candidate.sourceRevision })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(transactionTemporary, transaction);
    renameSync(temporary, destination);
    promoted = true;
    receipt = writeReceipt(root, {
      id: input.id,
      kind: 'skill',
      name: candidate.name,
      provider,
      sourceContent: candidate.sourceContent,
      entrypoint: join('skills', input.id, SKILL_MANIFEST),
      source: candidate.sourcePath,
      sourceRevision: candidate.sourceRevision,
      installedAt: new Date().toISOString(),
    });
    rmSync(transaction, { force: true });
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (promoted) rmSync(destination, { recursive: true, force: true });
    if (movedExisting && existsSync(backup)) renameSync(backup, destination);
    rmSync(transaction, { force: true });
    rmSync(transactionTemporary, { force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
  return { receipt, created: true };
}

export function importSkill(
  root: string,
  provider: string,
  input: ImportSkillInput,
): ImportSkillResult {
  return installSkill(root, provider, input, false);
}

export function refreshSkill(
  root: string,
  provider: string,
  id: string,
  expectedRevision: string,
): ResourceReceipt {
  recoverInterruptedSkill(root, id);
  const receipt = readReceipt(root, id);
  if (!receipt || receipt.kind !== 'skill' || !receipt.source) {
    throw new Error(`Imported Skill not found: ${id}`);
  }
  if (receipt.provider !== provider) throw new Error('Resource provider does not match this Agentlet');
  return installSkill(
    root,
    provider,
    { id, sourcePath: receipt.source, expectedRevision },
    true,
  ).receipt;
}

export function listImportedSkillIds(root: string, provider: string): string[] {
  const skillsDir = resourceSubdirPath(root, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const match = entry.isFile()
        ? /^\.([a-z0-9]+(?:-[a-z0-9]+)*)\.transaction$/.exec(entry.name)
        : null;
      if (match) recoverInterruptedSkill(root, match[1]);
    }
  }
  const receiptsDir = resourceSubdirPath(root, 'receipts');
  if (!existsSync(receiptsDir)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(receiptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!KEBAB_CASE.test(id)) continue;
    try {
      recoverInterruptedSkill(root, id);
      const receipt = readReceipt(root, id);
      if (
        receipt?.kind === 'skill' &&
        receipt.provider === provider &&
        receipt.source !== undefined &&
        isAbsolute(receipt.source) &&
        receipt.sourceRevision !== undefined &&
        receipt.entrypoint === join('skills', id, SKILL_MANIFEST)
      ) {
        ids.push(id);
      }
    } catch {
      // Invalid receipts are omitted from the manageable set.
    }
  }
  return ids.sort();
}

export function removeImportedSkill(root: string, provider: string, id: string): boolean {
  recoverInterruptedSkill(root, id);
  const receipt = readReceipt(root, id);
  if (!receipt) return false;
  if (receipt.kind !== 'skill') throw new Error('Resource is not an imported Skill');
  if (receipt.provider !== provider) throw new Error('Resource provider does not match this Agentlet');
  if (!receipt.source || !isAbsolute(receipt.source) || !receipt.sourceRevision) {
    throw new Error('Resource was not installed through the Skill import flow');
  }
  const expectedEntrypoint = join('skills', id, SKILL_MANIFEST);
  if (receipt.entrypoint !== expectedEntrypoint) {
    throw new Error('Imported Skill receipt has an unexpected entrypoint');
  }
  const destination = join(resourceSubdirPath(root, 'skills'), id);
  const removing = join(resourceSubdirPath(root, 'skills'), `.${id}.removing`);
  rmSync(removing, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, removing);
  try {
    removeReceipt(root, id);
    rmSync(removing, { recursive: true, force: true });
  } catch (error) {
    try {
      if (existsSync(removing) && !existsSync(destination)) {
        renameSync(removing, destination);
      }
      if (!readReceipt(root, id) && existsSync(destination)) {
        const { schemaVersion: _schemaVersion, ...input } = receipt;
        writeReceipt(root, input);
      }
    } catch (rollbackError) {
      throw new Error(
        `Failed to delete or restore imported Skill ${id}: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
      );
    }
    throw error;
  }
  return true;
}
