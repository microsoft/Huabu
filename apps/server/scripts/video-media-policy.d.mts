// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const sourceVersion: string;
export const sourceSha256: string;
export const sourceArchive: string;
export const sourceUrl: string;
export function macConfigureArgs(arch: string): string[];
export function macCacheRoot(): string;
export function macBuildDirectory(arch: string): string;
