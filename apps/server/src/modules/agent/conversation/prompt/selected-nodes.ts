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
 * Built-in agents receive `file=` paths for `read()`, while external/ACP
 * agents omit `file=` and download nodes by `id` over the RFS.
 */

import { renderNodes } from './node-element.js';

import type { RenderProfile } from './profile.js';
import type { AgentNodePreview } from '../../node-ref.js';

const READ_INTRO = (origin: string) =>
  `Nodes the user ${origin}. Each <node> is metadata only: pass \`file\` straight to read() for the full body, or use \`id\` with inspect_nodes() for layout / style / spatial relations. \`summary\` / \`preview\` are short scan hints, not the full content.`;
const READ_NODE_INTRO = (origin: string) =>
  `The user ${origin} the canvas nodes below. Each <node> is metadata only: download any you need by \`id\` (\`download <id>\` via the Space CLI or \`GET \${HUABU_RFS_URL}/download/<id>\`). Use the direct Space operations from the Space guide to query, create, edit, move, or link nodes. \`summary\` / \`preview\` are short scan hints, not the full content.`;

/**
 * Render the `<selected_nodes>` block, or `undefined` when the turn has
 * no selection. The intro + `file=` emission follow the backend
 * {@link RenderProfile}.
 */
export function renderSelectedNodesSection(
  refs: readonly AgentNodePreview[],
  profile: RenderProfile,
  source: 'selected' | 'referenced' = 'selected',
): string | undefined {
  if (refs.length === 0) return undefined;
  const origin = source === 'referenced' ? 'explicitly referenced' : 'selected';
  const isReachback = profile.toolset === 'reachback';
  const intro = isReachback ? READ_NODE_INTRO(origin) : READ_INTRO(origin);
  const tag = source === 'referenced' ? 'referenced_nodes' : 'selected_nodes';
  return [
    `<${tag}>`,
    intro,
    renderNodes(refs, { includeFile: !isReachback }),
    `</${tag}>`,
  ].join('\n');
}
