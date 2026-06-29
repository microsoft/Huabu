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
 * `includeFileName: true` — the built-in agent reads a node's full body by
 * the pre-computed `nodes/<file>.md` path. (The external/ACP backend
 * renders its own `<selected_nodes>` block without `file=` in
 * `acp/preprocessor.ts`, since it reads by id.)
 */

import { renderAgentNodeList } from './node-element.js';

import type { RenderProfile } from './profile.js';
import type { AgentNodePreview } from '../../node-ref.js';

const READ_INTRO =
  'Nodes the user selected. Each <node> is metadata only: pass `file` straight to read() for the full body, or use `id` with inspect_nodes() for layout / style / spatial relations. `preview` is a short scan hint, not the full content.';
const READ_NODE_INTRO =
  'The user selected the canvas nodes below. Each <node> is metadata only: read any you need with the Huabu Reachback Tool (`read-node <node-id>`); update them with `write-node --id <node-id>`. `preview` is a short scan hint, not the full content.';

/**
 * Render the `<selected_nodes>` block, or `undefined` when the turn has
 * no selection. The intro + `file=` emission follow the backend
 * {@link RenderProfile}.
 */
export function renderSelectedNodesSection(
  refs: readonly AgentNodePreview[],
  profile: RenderProfile,
): string | undefined {
  if (refs.length === 0) return undefined;
  const intro = profile.toolset === 'reachback' ? READ_NODE_INTRO : READ_INTRO;
  return [
    '<selected_nodes>',
    intro,
    renderAgentNodeList(refs, { includeFileName: profile.includeFileName }),
    '</selected_nodes>',
  ].join('\n');
}
