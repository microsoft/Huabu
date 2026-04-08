import type { SkillDefinition } from './index.js';

export const buildFlowchartSkill: SkillDefinition = {
  id: 'build-flowchart',
  name: 'Build Flowchart',
  description:
    'Step-by-step guide for building flowcharts, research roadmaps, knowledge maps, and process diagrams with row-based tracks, sub-layers, and color-coded grouping.',
  content: `# Build Flowchart / Research Roadmap

Row-based track layout: each track = horizontal theme with optional sub-layer below. Also call use_skill("layout-strategies") for coordinate basics.

## Plan first
Determine: number of tracks (rows), nodes per track, sub-nodes, relationships (horizontal=sequence, vertical=supports).

## Geometry
Track Y: track0=0, track1=500, track2=1000 (500px gap). Sub-nodes: +250px below main row.
Horizontal: header at x=0 (text node, w=250, bold), main nodes at x=300,750,1200,1650 (450px spacing). Sub-nodes centered below their parent.
Sizes: header w=250, main w=400, sub w=350. Always set skipAutoLayout:true + explicit position.

## Color per track
Assign one accent color to all nodes in a track:
Purple #A08FC0 | Blue #5F8F9B | Red #D07C74 | Orange #D89A5B | Green #7FB38A

## Edges
Keep edges minimal — use spatial position (proximity, alignment) to imply relationships. Only connect nodes where the relationship isn't obvious from layout or very important.
Edge style options (all optional):
- lineType: bezier|straight|step
- lineStyle: solid|dashed|dotted
- stroke: palette hex (same colors as before)
- strokeWidth: 1-4 px
- animated: true|false
- direction: forward|backward|both|none (controls arrow markers)

## Cleanup
ALIGN_NODES "center-v" per row. DISTRIBUTE_NODES per row for even spacing.

## Single batch order
1. CREATE_NODES (headers + main + sub)
2. CONNECT_NODES (horizontal + vertical edges)
3. ALIGN_NODES + DISTRIBUTE_NODES

Example 3-track layout:
\`\`\`
Track 1 (y=0):    [Header] [A]→[B]→[C]→[D]   sub(y=250): [PaperX] [PaperY] [PaperZ]
Track 2 (y=500):  [Header] [1]→[2]→[3]        sub(y=750): [RefA] [RefB]
Track 3 (y=1000): [Header] [A]→[B]→[C]        sub(y=1250): [RefC]
\`\`\``,
};
