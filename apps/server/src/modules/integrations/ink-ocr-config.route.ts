// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { inkOcrConfigUpdateSchema } from '@huabu/shared';

import { getInkOcrConfig, setInkOcrConfig } from './ink-ocr-config.js';
import { isSecretStoreWritable } from '../../security/secret-store.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  ApiResult,
  InkOcrConfig,
  InkOcrConfigUpdate,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const inkOcrConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<InkOcrConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.code(403).send({
          message:
            'Forbidden: Ink OCR configuration requires owner authorization',
        });
      }
      try {
        return getInkOcrConfig();
      } catch {
        request.log.error(
          { operation: 'read' },
          '[ink-ocr] configuration access failed',
        );
        return reply.code(500).send({
          message: 'Unable to load Ink OCR configuration',
          code: 'ink_ocr_config_read_failed',
        });
      }
    },
  );

  app.put<{
    Body: InkOcrConfigUpdate;
    Reply: ApiResult<InkOcrConfig>;
  }>('/config', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.code(403).send({
        message:
          'Forbidden: Ink OCR configuration requires owner authorization',
      });
    }
    if (!isSecretStoreWritable()) {
      return reply.code(409).send({
        message:
          'Credential storage is read-only. Configure secure credential storage before saving Ink OCR settings.',
        code: 'credential_store_read_only',
      });
    }
    const parsed = inkOcrConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      // Unknown-key messages echo caller-controlled property names.
      const issue = parsed.error.issues.find(
        (item) => item.code !== 'unrecognized_keys',
      );
      return reply.code(400).send({
        message: issue?.message ?? 'Invalid Ink OCR configuration',
        code: 'validation_failed',
      });
    }
    try {
      return await setInkOcrConfig(parsed.data);
    } catch {
      request.log.error(
        { operation: 'write' },
        '[ink-ocr] configuration access failed',
      );
      return reply.code(500).send({
        message:
          'Unable to save Ink OCR configuration. Reload settings before retrying.',
        code: 'ink_ocr_config_write_failed',
      });
    }
  });
};

export default inkOcrConfigRoutes;
