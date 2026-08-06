// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 * Every node carries its pre-computed `file=` path; both backends address
 * a node by it (the built-in agent `read()`s it, the external/ACP agent
 * downloads it over the RFS).
 */

import { renderNodes } from './node-element.js';

import type { RenderProfile } from './profile.js';
import type { AgentNodePreview } from '../../node-ref.js';

const READ_INTRO =
  'Nodes the user selected. Each <node> is metadata only: pass `file` straight to read() for the full body, or use `id` with inspect_nodes() for layout / style / spatial relations. `summary` / `preview` are short scan hints, not the full content.';
const READ_NODE_INTRO =
  "The user selected the canvas nodes below. Each <node> is metadata only: download any you need at `GET ${HUABU_RFS_URL}/download/<file>` (use the node's `file` path). Use the direct Space operations from `GET ${HUABU_RFS_URL}/skill` to query, create, edit, move, or link nodes. `summary` / `preview` are short scan hints, not the full content.";

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
    renderNodes(refs),
    '</selected_nodes>',
  ].join('\n');
}
