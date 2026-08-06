#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const DEFAULT_LOCALE = 'en';
const RESOURCES_DIR = join(
  process.cwd(),
  'apps',
  'web',
  'src',
  'i18n',
  'resources',
);

function listDirectories(path) {
  return readdirSync(path).filter((entry) =>
    statSync(join(path, entry)).isDirectory(),
  );
}

function listJsonFiles(path) {
  return readdirSync(path).filter((entry) => extname(entry) === '.json');
}

function flattenMessages(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    flattenMessages(child, prefix ? `${prefix}.${key}` : key),
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compareKeySets(referenceKeys, candidateKeys) {
  return {
    missing: [...referenceKeys].filter((key) => !candidateKeys.has(key)).sort(),
    extra: [...candidateKeys].filter((key) => !referenceKeys.has(key)).sort(),
  };
}

const localeDirs = listDirectories(RESOURCES_DIR);
if (!localeDirs.includes(DEFAULT_LOCALE)) {
  throw new Error(
    `Default locale "${DEFAULT_LOCALE}" not found in ${RESOURCES_DIR}`,
  );
}

const defaultLocaleDir = join(RESOURCES_DIR, DEFAULT_LOCALE);
const namespaces = listJsonFiles(defaultLocaleDir);
const failures = [];

for (const locale of localeDirs) {
  if (locale === DEFAULT_LOCALE) continue;

  const localeDir = join(RESOURCES_DIR, locale);
  const localeNamespaces = new Set(listJsonFiles(localeDir));

  for (const namespace of namespaces) {
    const referencePath = join(defaultLocaleDir, namespace);
    const candidatePath = join(localeDir, namespace);

    if (!localeNamespaces.has(namespace)) {
      failures.push(
        `${relative(process.cwd(), localeDir)} is missing namespace file ${namespace}`,
      );
      continue;
    }

    const referenceKeys = new Set(flattenMessages(readJson(referencePath)));
    const candidateKeys = new Set(flattenMessages(readJson(candidatePath)));
    const { missing, extra } = compareKeySets(referenceKeys, candidateKeys);

    if (missing.length > 0) {
      failures.push(
        `${relative(process.cwd(), candidatePath)} is missing keys:\n${missing
          .map((key) => `  - ${key}`)
          .join('\n')}`,
      );
    }

    if (extra.length > 0) {
      failures.push(
        `${relative(process.cwd(), candidatePath)} has extra keys:\n${extra
          .map((key) => `  - ${key}`)
          .join('\n')}`,
      );
    }
  }

  const extraNamespaces = [...localeNamespaces]
    .filter((namespace) => !namespaces.includes(namespace))
    .sort();
  if (extraNamespaces.length > 0) {
    failures.push(
      `${relative(process.cwd(), localeDir)} has extra namespace files:\n${extraNamespaces
        .map((namespace) => `  - ${basename(namespace)}`)
        .join('\n')}`,
    );
  }
}

if (failures.length > 0) {
  console.error('i18n parity check failed:\n');
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(
  `i18n parity check passed for ${localeDirs.length} locales across ${namespaces.length} namespace file(s).`,
);
