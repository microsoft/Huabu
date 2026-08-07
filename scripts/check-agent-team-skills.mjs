#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const FRONTMATTER_DELIMITER = '---';
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXTERNAL_LINK_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const NON_PORTABLE_TEXT_PATTERN =
  /(?:file:\/\/|\/home\/|\/Users\/|[A-Za-z]:[\\/]|~\/)/;

function parseYamlObject(content, label) {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${label} contains invalid YAML: ${document.errors[0].message}`,
    );
  }
  const value = document.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a YAML mapping`);
  }
  return value;
}

export function parseSkillFrontmatter(content) {
  const normalized = content.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }

  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closingIndex === -1) {
    throw new Error('SKILL.md frontmatter is missing its closing delimiter');
  }

  return parseYamlObject(
    lines.slice(1, closingIndex).join('\n'),
    'SKILL.md frontmatter',
  );
}

function readManifestName(manifestContent) {
  const manifest = parseYamlObject(manifestContent, 'agentlet.yaml');
  return typeof manifest.name === 'string' ? manifest.name : null;
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]*]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map(
    (match) => match[1],
  );
}

function localLinkPath(target) {
  if (
    target.startsWith('#') ||
    target.startsWith('//') ||
    EXTERNAL_LINK_PATTERN.test(target)
  ) {
    return null;
  }
  return target.split(/[?#]/, 1)[0];
}

function isPathInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}

export function validateSkillPackage(packageDir, options = {}) {
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const fileExists = options.fileExists ?? existsSync;
  const resolveRealPath = options.realpath ?? realpathSync;
  const errors = [];
  const packageName = packageDir.split(/[\\/]/).at(-1);
  const manifestPath = join(packageDir, 'agentlet.yaml');
  const skillPath = join(packageDir, 'SKILL.md');

  if (!fileExists(skillPath)) {
    return [`${packageName}: missing SKILL.md`];
  }

  const manifestContent = readFile(manifestPath);
  const skillContent = readFile(skillPath);
  let frontmatter;
  try {
    frontmatter = parseSkillFrontmatter(skillContent);
  } catch (error) {
    return [`${packageName}: ${error.message}`];
  }

  if (!frontmatter.name) {
    errors.push(`${packageName}: frontmatter is missing name`);
  } else {
    if (!SKILL_NAME_PATTERN.test(frontmatter.name)) {
      errors.push(
        `${packageName}: frontmatter name must be lowercase kebab-case`,
      );
    }
    if (frontmatter.name !== packageName) {
      errors.push(
        `${packageName}: frontmatter name must match the package folder`,
      );
    }
    const manifestName = readManifestName(manifestContent);
    if (frontmatter.name !== manifestName) {
      errors.push(
        `${packageName}: frontmatter name must match agentlet.yaml name`,
      );
    }
  }

  if (!frontmatter.description) {
    errors.push(`${packageName}: frontmatter is missing description`);
  } else {
    if (!/\bUse when\b/.test(frontmatter.description)) {
      errors.push(`${packageName}: description must include "Use when"`);
    }
    if (!/\bDo not use\b/.test(frontmatter.description)) {
      errors.push(`${packageName}: description must include "Do not use"`);
    }
  }

  if (!manifestContent.includes('- system_prompt.md')) {
    errors.push(
      `${packageName}: agentlet.yaml must use system_prompt.md as its canonical prompt`,
    );
  }

  const links = markdownLinks(skillContent);
  if (!links.includes('./system_prompt.md')) {
    errors.push(
      `${packageName}: SKILL.md must link to the canonical ./system_prompt.md`,
    );
  }

  if (NON_PORTABLE_TEXT_PATTERN.test(skillContent)) {
    errors.push(`${packageName}: SKILL.md contains a non-portable path`);
  }

  const packageRealPath = resolveRealPath(packageDir);
  for (const target of links) {
    const localPath = localLinkPath(target);
    if (!localPath) continue;

    if (
      isAbsolute(localPath) ||
      /^[A-Za-z]:[\\/]/.test(localPath) ||
      localPath.startsWith('~')
    ) {
      errors.push(`${packageName}: non-portable link target ${target}`);
      continue;
    }

    const resolvedPath = resolve(packageDir, localPath);
    if (!isPathInside(packageDir, resolvedPath)) {
      errors.push(`${packageName}: link escapes the skill folder: ${target}`);
      continue;
    }
    if (!fileExists(resolvedPath)) {
      errors.push(`${packageName}: referenced file does not exist: ${target}`);
      continue;
    }
    if (!isPathInside(packageRealPath, resolveRealPath(resolvedPath))) {
      errors.push(
        `${packageName}: referenced file resolves outside the skill folder: ${target}`,
      );
    }
  }

  return errors;
}

function listPackageDirectories(collectionDir) {
  return readdirSync(collectionDir)
    .map((entry) => join(collectionDir, entry))
    .filter(
      (path) =>
        statSync(path).isDirectory() && existsSync(join(path, 'agentlet.yaml')),
    )
    .sort();
}

function validateTrackedPackageState(repoRoot) {
  const trackedFiles = execFileSync('git', ['ls-files', '--', 'agent-teams'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  return trackedFiles
    .filter(
      (path) =>
        /(^|\/)workspaces(\/|$)/.test(path) || /(^|\/)\.env$/.test(path),
    )
    .map((path) => `tracked generated runtime or secret file: ${path}`);
}

export function validateAgentTeamSkills(repoRoot) {
  const collectionDir = join(repoRoot, 'agent-teams');
  const packageDirs = listPackageDirectories(collectionDir);
  const errors = packageDirs.flatMap((packageDir) =>
    validateSkillPackage(packageDir),
  );
  errors.push(...validateTrackedPackageState(repoRoot));
  return { errors, packageCount: packageDirs.length };
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  const repoRoot = dirname(dirname(scriptPath));
  const { errors, packageCount } = validateAgentTeamSkills(repoRoot);
  if (errors.length > 0) {
    console.error('Agent Team skill validation failed:\n');
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exit(1);
  }
  console.log(`Validated ${packageCount} Agent Team skill package(s).`);
}
