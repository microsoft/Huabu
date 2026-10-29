// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { isDeviceFilePath } from '../../utils/file-reference.js';

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isDeviceFilePath, 'Expected an absolute path');
const cursorSchema = z.string().min(1).max(16_384);
export const fileReferenceSchema = z
  .object({
    agentletId: z.string().min(1).max(255),
    path: absolutePathSchema,
    deviceName: z.string().max(512).optional(),
  })
  .strict();
export type FileReference = z.infer<typeof fileReferenceSchema>;

const listArgsSchema = z
  .object({
    path: absolutePathSchema,
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    showHidden: z.boolean().optional(),
  })
  .strict();
const readArgsSchema = z
  .object({
    path: absolutePathSchema,
    cursor: cursorSchema.optional(),
    limitBytes: z.number().int().min(4).max(65_536).optional(),
  })
  .strict();
export const deviceFilesBodySchema = z.discriminatedUnion('operation', [
  z
    .object({
      agentletId: fileReferenceSchema.shape.agentletId,
      operation: z.literal('fs-list'),
      args: listArgsSchema,
    })
    .strict(),
  z
    .object({
      agentletId: fileReferenceSchema.shape.agentletId,
      operation: z.literal('fs-read'),
      args: readArgsSchema,
    })
    .strict(),
]);
export type DeviceFilesBody = z.infer<typeof deviceFilesBodySchema>;

export const fileListResultSchema = z
  .object({
    path: absolutePathSchema,
    parentPath: absolutePathSchema,
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1).max(4096),
            path: absolutePathSchema,
            kind: z.enum(['directory', 'file', 'symlink', 'other']),
          })
          .strict(),
      )
      .max(100),
    nextCursor: cursorSchema.optional(),
  })
  .strict();
export type FileListResult = z.infer<typeof fileListResultSchema>;
export const fileReadResultSchema = z
  .object({
    path: absolutePathSchema,
    encoding: z.literal('utf-8'),
    text: z.string().max(65_536),
    byteLength: z.number().int().min(0).max(65_536),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentVersion: z.string().regex(/^[a-f0-9]{64}$/),
    nextCursor: cursorSchema.optional(),
  })
  .strict();
export type FileReadResult = z.infer<typeof fileReadResultSchema>;
export const deviceFilesResponseSchema = z.discriminatedUnion('operation', [
  z
    .object({ operation: z.literal('fs-list'), result: fileListResultSchema })
    .strict(),
  z
    .object({ operation: z.literal('fs-read'), result: fileReadResultSchema })
    .strict(),
]);
export type DeviceFilesResponse = z.infer<typeof deviceFilesResponseSchema>;
export const proxyFsResponseSchema = z.union([
  z
    .object({
      version: z.literal(1),
      operation: z.literal('fs-list'),
      ok: z.literal(true),
      result: fileListResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      operation: z.literal('fs-read'),
      ok: z.literal(true),
      result: fileReadResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      operation: z.enum(['fs-list', 'fs-read']),
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum([
            'invalid_request',
            'permission_denied',
            'not_found',
            'not_directory',
            'unsupported_file',
            'unsupported_encoding',
            'directory_too_large',
            'stale_cursor',
            'cancelled',
            'busy',
            'io_error',
          ]),
          message: z.string().max(512),
        })
        .strict(),
    })
    .strict(),
]);
