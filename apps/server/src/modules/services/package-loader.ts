// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { serviceManifestSchema } from '@huabu/shared';

import { resolveDirectChildPath, safeJoin } from '../../utils/fs.js';

import type { ServiceManifest } from '@huabu/shared';

const PACKAGE_IDS = [
  'image-gen',
  'web-search',
  'youtube-transcripts',
  'ink-ocr',
] as const;

export interface BundledServicePackage {
  root: string;
  manifest: ServiceManifest;
}

function packageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(moduleDir, 'services');
  if (existsSync(bundled)) return bundled;
  return resolve(moduleDir, '../../services');
}

function readPackage(packageId: (typeof PACKAGE_IDS)[number]) {
  const root = resolveDirectChildPath(packageRoot(), packageId);
  const manifestPath = resolveDirectChildPath(root, 'service.yaml');
  const parsed = serviceManifestSchema.safeParse(
    parse(readFileSync(manifestPath, 'utf8')),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid bundled Service manifest "${packageId}": ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  if (parsed.data.id !== packageId) {
    throw new Error(`Service package directory must match id "${packageId}"`);
  }
  for (const file of [
    parsed.data.agent?.skill,
    parsed.data.agent?.client,
  ].filter((value): value is string => Boolean(value))) {
    const filePath = safeJoin(root, file);
    if (!existsSync(filePath)) {
      throw new Error(`Service "${packageId}" references missing file`);
    }
  }
  return { root, manifest: parsed.data };
}

let packages: ReadonlyMap<string, BundledServicePackage> | null = null;

export function getBundledServicePackages(): ReadonlyMap<
  string,
  BundledServicePackage
> {
  packages ??= new Map(PACKAGE_IDS.map((id) => [id, readPackage(id)]));
  return packages;
}

export function getBundledServicePackage(
  serviceId: string,
): BundledServicePackage | undefined {
  return getBundledServicePackages().get(serviceId);
}

export function readServicePackageFile(
  serviceId: string,
  file: string,
): string | null {
  const service = getBundledServicePackage(serviceId);
  if (!service) return null;
  const filePath = safeJoin(service.root, file);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}
