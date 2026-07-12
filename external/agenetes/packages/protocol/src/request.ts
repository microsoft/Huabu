// The `AgentSubmission` contract — the durable per-turn source payload plus
// its optional host-rendered canonical input. Rendering is complete before
// `AgentHandle.run()`; drivers receive data, never host render functions.

import { z } from 'zod';

export const agentInputPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  }),
]);

export type AgentInputPart = z.infer<typeof agentInputPartSchema>;

export const agentTextInputSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export type AgentTextInput = z.infer<typeof agentTextInputSchema>;

export const agentPartsInputSchema = z.object({
  type: z.literal('parts'),
  parts: z.array(agentInputPartSchema).readonly(),
});

export type AgentPartsInput = z.infer<typeof agentPartsInputSchema>;

export const agentCommandInputSchema = z.object({
  type: z.literal('command'),
  text: z.string(),
  context: z.array(agentInputPartSchema).readonly(),
});

export type AgentCommandInput = z.infer<typeof agentCommandInputSchema>;

export const agentInputSchema = z.discriminatedUnion('type', [
  agentTextInputSchema,
  agentPartsInputSchema,
  agentCommandInputSchema,
]);

export type AgentInput = z.infer<typeof agentInputSchema>;

export interface AgentSubmission<
  TSource = unknown,
  TType extends string = string,
> {
  readonly type: TType;
  readonly content: TSource;
  readonly rendered?: readonly AgentInput[];
}

export const agentSubmissionSchema: z.ZodType<AgentSubmission> = z
  .object({
    type: z.string(),
    content: z.unknown(),
    rendered: z.array(agentInputSchema).readonly().optional(),
  })
  .superRefine((submission, ctx) => {
    const rendered = submission.rendered;
    if (
      rendered !== undefined &&
      rendered.some((input) => input.type === 'command') &&
      (rendered.length !== 1 || rendered[0]?.type !== 'command')
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'An AgentCommandInput must be the only top-level rendered input.',
        path: ['rendered'],
      });
    }
  });

export function resolveAgentInputs(
  submission: AgentSubmission,
): readonly AgentInput[] {
  if (submission.rendered !== undefined) {
    return submission.rendered;
  }

  if (typeof submission.content === 'string') {
    return [{ type: 'text', text: submission.content }];
  }

  let text: string | undefined;
  try {
    text = JSON.stringify(submission.content);
  } catch (error) {
    throw new TypeError('Agent submission content is not JSON serializable', {
      cause: error,
    });
  }
  if (text === undefined) {
    throw new TypeError('Agent submission content is not JSON serializable');
  }

  return [{ type: 'text', text }];
}
