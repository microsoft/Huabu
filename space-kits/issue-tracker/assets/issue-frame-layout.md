# Issue Frame Layout

Use the **Issues** area until the user confirms project-specific grouping. Do not install the Kit author's project categories. Within an area, keep one horizontal row, newest active unit at the left and completed units at the right. Align Frame tops, keep a consistent gap and never overlap.

Each execution unit has one Frame containing its Execution Note, Fixing Agent and durable outputs. Keep the issue title stable and update displayed status at milestones. Use the Execution Note contract's identity/status format and a distinct Frame suffix.

Start an Issue Frame at width 440: 20px left/right padding with 400px children. Place the fixed-height Execution Note at `(20,64)`, size `400x200`. Place the Fixing Agent below it at `(20,292)`, width 400 and content-driven height. Never pin Question/Text height.

Query the Agent's actual geometry after creation, first prompt and later size changes. Set Frame height to at least `max(child.y + child.height) + 20`; do not reuse an old fixed Frame height. If sizes differ, keep at least 24px between Note and Agent. Preserve Note scrolling rather than expanding long Notes across the layout.

Extend the parent area to contain the row, title inset and padding. Use direct geometry edits, not proportional Frame scaling, to preserve child typography. Query final parent-local and absolute geometry and verify containment, sibling gaps and non-overlap; requested dimensions are not proof of final geometry.

Connect the Execution Note to its Fixing Agent only when useful for navigation. Do not connect Coordinator to Fixing Agents or issue Frames. Prompt targeting uses direct Agent adjacency, not containment or arrow direction; accidental edges can change instruction scope.
