// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `<canvas_neighbourhood>` section renderer — the anchor node's
 * surroundings.
 *
 * Wraps the structured {@link NodeNeighbourhoodContext} the envelope
 * carries for an anchored request (e.g. a question node) in the
 * `<canvas_neighbourhood>` tag; every neighbour is addressable by its
 * `file=` path.
 *
 * Output shape:
 *
 *   <canvas_neighbourhood>
 *   The user started this turn from a specific node on the canvas. …
 *   <group direction="above" arrangement="horizontal row" frame="Strategy">
 *   <node id="n-d" type="note" label="Assumptions" file="nodes/assumptions.md" preview="…" />
 *   </group>
 *   <connections>
 *   <edge from="n-a" from-label="Risks" to="n-e" to-label="Open Questions" />
 *   </connections>
 *   </canvas_neighbourhood>
 *
 * Returns `undefined` when there is no anchor, or when the anchor has no
 * useful neighbours (the serialized body is empty). Built-in agents receive
 * `file=` paths while external/ACP agents address neighbours by `id`.
 */

import { escapeXmlAttr } from './node-element.js';
import { serializeNodeNeighbourhood } from '../../../canvas/node-neighbourhood.js';

import type { RenderProfile } from './profile.js';
import type { NodeNeighbourhoodContext } from '../../../canvas/node-neighbourhood.js';

const READ_INTRO =
  'The user started this turn from a specific node on the canvas, and its surroundings are included so you can ground vague references. When they say "this", "the one above", or use an implicit pronoun, resolve it against this neighbourhood before answering. Every <node> is addressable — pass `file` to read() for the full body.';
const READ_NODE_INTRO =
  'The user started this turn from a specific node on the canvas, and its surroundings are included so you can ground vague references. When they say "this", "the one above", or use an implicit pronoun, resolve it against this neighbourhood before answering. Every <node> is addressable by `id` — download any via the Space CLI `download <id>` or `GET ${HUABU_RFS_URL}/download/<id>`.';

/**
 * Render the `<canvas_neighbourhood>` block, or `undefined` when the
 * turn carries no anchor / no useful neighbourhood. Intro + `file=`
 * follow the backend {@link RenderProfile}.
 */
export function renderNeighbourhoodSection(
  anchor:
    | {
        nodeId: string;
        label?: string;
        neighbourhood?: NodeNeighbourhoodContext;
      }
    | undefined,
  profile: RenderProfile,
): string | undefined {
  if (!anchor) return undefined;
  const isReachback = profile.toolset === 'reachback';
  const body = anchor.neighbourhood
    ? serializeNodeNeighbourhood(anchor.neighbourhood, {
        includeFile: !isReachback,
      })
    : '';
  if (!body) return undefined;
  const intro = isReachback ? READ_NODE_INTRO : READ_INTRO;
  const anchorAttrs = [
    `id="${escapeXmlAttr(anchor.nodeId)}"`,
    anchor.label ? `label="${escapeXmlAttr(anchor.label)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return [
    '<canvas_neighbourhood>',
    intro,
    `Request anchored at: <node ${anchorAttrs} />.`,
    body,
    '</canvas_neighbourhood>',
  ].join('\n');
}
