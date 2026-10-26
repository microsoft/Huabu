// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import {
  agentInputKindSchema,
  chatAttachmentSchema,
  quotedCommentSchema,
  visibleCanvasGroundingSchema,
  wireNodeRefSchema,
} from './agent.js';
import { inkResourceReferencesSchema } from './ink-sigil.js';

const envelopeNodeSchema = wireNodeRefSchema.extend({
  filename: z.string(),
  summary: z.string().optional(),
  preview: z.string().optional(),
  rev: z.string().optional(),
});

const resolvedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
});

const neighbourhoodSchema = z.object({
  layers: z.array(
    z.object({
      frameId: z.string().optional(),
      frameLabel: z.string().optional(),
      groups: z.array(
        z.object({
          dx: z.number(),
          dy: z.number(),
          arrangement: z.string(),
          frameId: z.string().optional(),
          frameLabel: z.string().optional(),
          nodes: z.array(envelopeNodeSchema),
          _minEdgeDist: z.number(),
        }),
      ),
    }),
  ),
  relevantEdges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      sourceLabel: z.string().optional(),
      targetLabel: z.string().optional(),
    }),
  ),
});

export const inkRecognitionSchema = z
  .object({
    provider: z.literal('azure-vision'),
    apiVersion: z.string().min(1).max(40),
    originNodeIds: z.array(z.string().min(1)).min(1).max(100),
    lines: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(2000),
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (recognition) =>
      recognition.lines.reduce(
        (length, line) => length + line.text.length,
        0,
      ) <= 12000,
    'Ink recognition exceeds the text budget',
  );

export type InkRecognition = z.infer<typeof inkRecognitionSchema>;

export const chatEnvelopeSchema = z.object({
  user: z.object({
    text: z.string(),
    quotedComments: z.array(quotedCommentSchema).optional(),
    inputKind: agentInputKindSchema.optional(),
    attachments: z.array(chatAttachmentSchema),
  }),
  skills: z.object({
    invokedIds: z.array(z.string()),
    resolved: z.array(resolvedSkillSchema),
  }),
  focus: z.object({
    resources: z
      .object({
        bindings: inkResourceReferencesSchema,
        refs: z.array(envelopeNodeSchema),
        imageAttachments: z.array(chatAttachmentSchema),
      })
      .optional(),
    groundingVisual: visibleCanvasGroundingSchema.optional(),
    selection: z.object({
      refs: z.array(envelopeNodeSchema),
      selectedIds: z.array(z.string()),
      imageAttachments: z.array(chatAttachmentSchema),
      snapshotAttachments: z.array(chatAttachmentSchema),
      textContents: z
        .array(z.object({ nodeId: z.string(), content: z.string() }))
        .optional(),
      inkRecognition: inkRecognitionSchema.optional(),
      inkGeometry: z
        .array(
          z.object({
            nodeId: z.string().min(1),
            strokeIds: z.array(z.string().min(1)).min(1),
            bounds: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number().nonnegative(),
              height: z.number().nonnegative(),
            }),
          }),
        )
        .optional(),
      strokeSubsets: z
        .array(
          z.object({
            nodeId: z.string(),
            strokeIds: z.array(z.string()),
          }),
        )
        .optional(),
    }),
    anchor: z
      .object({
        nodeId: z.string(),
        label: z.string().optional(),
        neighbourhood: neighbourhoodSchema.optional(),
      })
      .optional(),
  }),
});

export type ChatEnvelope = z.infer<typeof chatEnvelopeSchema>;
export type ResolvedSkill = z.infer<typeof resolvedSkillSchema>;
