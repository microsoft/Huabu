// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
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
  manifestPath: string;
  files: readonly ServicePackageFile[];
  contentHash: string;
}

export interface ServicePackageFile {
  relativePath: string;
  absolutePath: string;
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
  const manifestSource = readFileSync(manifestPath, 'utf8');
  const parsed = serviceManifestSchema.safeParse(parse(manifestSource));
  if (!parsed.success) {
    throw new Error(
      `Invalid bundled Service manifest "${packageId}": ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  if (parsed.data.id !== packageId) {
    throw new Error(`Service package directory must match id "${packageId}"`);
  }
  const files = parsed.data.package.files.map((relativePath) => {
    const absolutePath = safeJoin(root, relativePath);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      throw new Error(
        `Service "${packageId}" references missing or non-regular file "${relativePath}"`,
      );
    }
    return { relativePath, absolutePath };
  });
  const hash = createHash('sha256');
  hash.update('service.yaml\0').update(manifestSource).update('\0');
  for (const file of files) {
    hash
      .update(file.relativePath)
      .update('\0')
      .update(readFileSync(file.absolutePath))
      .update('\0');
  }
  return {
    root,
    manifest: parsed.data,
    manifestPath,
    files,
    contentHash: hash.digest('hex'),
  };
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
  const packageFile = service.files.find(
    (candidate) => candidate.relativePath === file,
  );
  return packageFile ? readFileSync(packageFile.absolutePath, 'utf8') : null;
}

export function isAgentFacingService(manifest: ServiceManifest): boolean {
  return manifest.package.files.includes('SKILL.md');
}
