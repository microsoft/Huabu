/**
 * GenerateImageToolDisplay — inline preview for the `generate_image`
 * internal tool.
 *
 * Renders one thumbnail per successful call so the user always sees
 * the generated image in chat, even when the assistant text doesn't
 * embed an `![](src)` markdown reference. Errors fall back to a
 * compact inline error card; pending calls render nothing
 * (the streaming indicator + tool-call status are surfaced
 * elsewhere by `AIMessage`).
 *
 * The image is rendered against the bare artifact key returned by
 * the tool. `resolveArtifactUrl(canvasId, src)` rebases it onto the
 * current API origin so it works in dev, packaged Electron, and
 * cross-origin web hosting alike.
 */

import { resolveArtifactUrl } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore';

import type { GenerateImageToolPart } from '@sediment/shared';

interface GenerateImageToolDisplayProps {
  part: GenerateImageToolPart;
}

export function GenerateImageToolDisplay({
  part,
}: GenerateImageToolDisplayProps) {
  const canvasId = useCanvasStore((s) => s.canvasId);
  const response = part.data ?? null;

  if (!response) return null;

  if (response.status === 'error') {
    return (
      <div className="flex justify-start">
        <div className="text-danger border-edge-default bg-surface max-w-md rounded-2xl border px-3 py-2 text-xs">
          Image generation failed — {response.error}
          {response.hint ? ` (${response.hint})` : ''}
        </div>
      </div>
    );
  }

  const { src, width, height, revisedPrompt } = response.data;
  const url = resolveArtifactUrl(src, canvasId ?? undefined);

  return (
    <div className="flex justify-start">
      <figure className="border-edge-default bg-surface flex max-w-md flex-col gap-1 overflow-hidden rounded-2xl border">
        <img
          src={url}
          alt={revisedPrompt ?? 'Generated image'}
          width={width || undefined}
          height={height || undefined}
          className="block h-auto max-h-96 w-full object-contain"
          loading="lazy"
        />
        {revisedPrompt ? (
          <figcaption className="text-fg-subtle px-3 py-2 text-xs italic">
            {revisedPrompt}
          </figcaption>
        ) : null}
      </figure>
    </div>
  );
}
