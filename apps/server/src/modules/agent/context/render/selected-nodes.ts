/**
 * `<selected_nodes>` section renderer.
 *
 * Turns the turn's selection refs into the block the built-in agent
 * sees. Output shape:
 *
 *   <selected_nodes>
 *   Nodes the user selected. Each <node> is metadata only: …
 *   <node id="n-1" type="note" label="Risks" file="nodes/risks.md" preview="…" />
 *   <node id="n-2" type="image" preview="…" />
 *   </selected_nodes>
 *
 * `includeFile: true` — the built-in agent reads a node's full body by
 * the pre-computed `nodes/<file>.md` path. (The external/ACP backend
 * renders its own `<selected_nodes>` block without `file=` in
 * `acp/preprocessor.ts`, since it reads by id.)
 */

import { renderAgentNodeList } from './node-element.js';

import type { AgentNodePreview } from '../../node-ref.js';

const SELECTED_NODES_INTRO =
  'Nodes the user selected. Each <node> is metadata only: pass `file` straight to read() for the full body, or use `id` with inspect_nodes() for layout / style / spatial relations. `preview` is a short scan hint, not the full content.';

/**
 * Render the `<selected_nodes>` block, or `undefined` when the turn has
 * no selection.
 */
export function renderSelectedNodesSection(
  refs: readonly AgentNodePreview[],
): string | undefined {
  if (refs.length === 0) return undefined;
  return [
    '<selected_nodes>',
    SELECTED_NODES_INTRO,
    renderAgentNodeList(refs, { includeFile: true }),
    '</selected_nodes>',
  ].join('\n');
}
