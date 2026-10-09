// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { capabilityManifestSchema } from '@huabu/shared';

import { resolveDirectChildPath, safeJoin } from '../../utils/fs.js';

import type { CapabilityManifest } from '@huabu/shared';

const PACKAGE_IDS = [
  'image-gen',
  'web-search',
  'youtube-transcripts',
  'ink-ocr',
] as const;

export interface BundledCapabilityPackage {
  root: string;
  manifest: CapabilityManifest;
}

function packageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(moduleDir, 'capabilities');
  if (existsSync(bundled)) return bundled;
  return resolve(moduleDir, '../../capabilities');
}

function readPackage(packageId: (typeof PACKAGE_IDS)[number]) {
  const root = resolveDirectChildPath(packageRoot(), packageId);
  const manifestPath = resolveDirectChildPath(root, 'capability.yaml');
  const parsed = capabilityManifestSchema.safeParse(
    parse(readFileSync(manifestPath, 'utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid bundled Capability manifest "${packageId}": ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  if (parsed.data.id !== packageId) {
    throw new Error(
      `Capability package directory must match id "${packageId}"`,
    );
  }
  for (const file of [
    parsed.data.agent?.skill,
    parsed.data.agent?.client,
  ].filter((value): value is string => Boolean(value))) {
    const filePath = safeJoin(root, file);
    if (!existsSync(filePath)) {
      throw new Error(`Capability "${packageId}" references missing file`);
    }
  }
  return { root, manifest: parsed.data };
}

let packages: ReadonlyMap<string, BundledCapabilityPackage> | null = null;

export function getBundledCapabilityPackages(): ReadonlyMap<
  string,
  BundledCapabilityPackage
> {
  packages ??= new Map(PACKAGE_IDS.map((id) => [id, readPackage(id)]));
  return packages;
}

export function getBundledCapabilityPackage(
  capabilityId: string,
): BundledCapabilityPackage | undefined {
  return getBundledCapabilityPackages().get(capabilityId);
}

export function readCapabilityPackageFile(
  capabilityId: string,
  file: string,
): string | null {
  const capability = getBundledCapabilityPackage(capabilityId);
  if (!capability) return null;
  const filePath = safeJoin(capability.root, file);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}
