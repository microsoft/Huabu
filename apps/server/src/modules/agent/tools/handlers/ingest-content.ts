/**
 * `ingest_content` handler — manually triggers the per-node
 * preprocessing pipeline.
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
    throw new Error(`Canvas ${args.canvasId} not found`);
  }

  const nodes = (canvas.state.nodes ?? []) as Array<Record<string, unknown>>;
  const node = nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    throw new Error(`Node ${args.nodeId} not found`);
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

  // Failure → throw so pi-agent-core flags the tool result as `isError: true`.
  if (!result.success) {
    throw new Error(
      errorString ??
        `Ingestion failed for node ${args.nodeId} (type '${type}')`,
    );
  }

  if (!persisted) {
    return JSON.stringify({
      success: true,
      title: result.extracted?.title,
      note: `Node type '${type}' does not persist content to the canvas store`,
    });
  }

  return JSON.stringify({
    success: true,
    title: result.extracted?.title,
  });
}
