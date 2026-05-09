/**
 * `ingest_content` handler — manually triggers the per-node
 * preprocessing pipeline (extract / enrich / persist).
 */

import { getPreprocessDispatcher } from '../../../preprocessing/index.js';
import { getCanvasStore } from '../../../storage/index.js';

import type { ingestContentParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';
import type { PreprocessableNodeType } from '@sediment/shared';

export type IngestContentArgs = Static<typeof ingestContentParamsSchema> & {
  canvasId: string;
};

export async function handleIngestContent(
  args: IngestContentArgs,
): Promise<string> {
  const canvas = getCanvasStore(args.canvasId).read();
  if (!canvas) {
    return JSON.stringify({ error: `Canvas ${args.canvasId} not found` });
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const node = nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    return JSON.stringify({ error: `Node ${args.nodeId} not found` });
  }

  const data = node.data as Record<string, unknown> | undefined;
  const type = (data?.type as string) ?? (node.type as string);
  const dispatcher = getPreprocessDispatcher();

  const result = await dispatcher.preprocess({
    canvasId: args.canvasId,
    nodeId: args.nodeId,
    nodeType: type as PreprocessableNodeType,
    trigger: 'manual',
    snapshot: {
      title: data?.label as string | undefined,
      content: data?.content as string | undefined,
      src: data?.src as string | undefined,
    },
    options: { allowLLM: false },
  });

  // Surface persistence outcome to the agent so it doesn't misinterpret success.
  const persisted = Boolean(result.persistence);
  const errors = result.diagnostics
    .filter((d) => d.level === 'error')
    .map((d) => `${d.code}: ${d.message}`);
  const errorString = errors.length > 0 ? errors.join('; ') : undefined;

  if (!persisted && result.success) {
    return JSON.stringify({
      success: true,
      title: result.extracted?.title,
      note: `Node type '${type}' does not persist content to the canvas store`,
    });
  }

  return JSON.stringify({
    success: result.success,
    title: result.extracted?.title,
    error: errorString,
  });
}
