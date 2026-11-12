# Issue Frame Layout

Use the **Issues** area until the user confirms project-specific grouping. Do not install the Kit author's project categories. Within an area, keep one horizontal row, newest active unit at the left and completed units at the right. Align Frame tops, keep a consistent gap and never overlap.

Each execution unit has one Frame containing its Execution Note, Fixing Agent and durable outputs. Layer-facing labels follow this contract:

- Frame: `<status emoji> <issue identity> · <stable issue title>`
- Agent: `<status emoji> <issue identity> · <stable issue title> · Agent`

The emoji alone carries lifecycle state: 🛠 in progress, 🟣 approval needed, ⛔ blocked, 🚀 PR prepared, ✅ completed. Do not spell out status words, use a `Fixing Agent` or `Issue Frame` suffix, or omit the issue title. Keep the complete Agent label at most 80 characters, including emoji, separators and ` · Agent`. If necessary, choose one concise, unambiguous shortened stable title for both Frame and Agent; preserve the full audit title in the Execution Note. Frame and Agent labels must differ so Huabu does not append `(2)`.

| State           | Frame label                     | Agent label                             |
| --------------- | ------------------------------- | --------------------------------------- |
| Approval needed | `🟣 #12 · Slow history loading` | `🟣 #12 · Slow history loading · Agent` |
| PR prepared     | `🚀 #12 · Slow history loading` | `🚀 #12 · Slow history loading · Agent` |

The Coordinator establishes these labels before dispatch. At each later milestone the Fixing Agent synchronizes both labels with the Execution Note before ending its turn. The Execution Note retains full status words under its own contract; Layer labels do not.

Start an Issue Frame at width 440: 20px left/right padding with 400px children. Place the fixed-height Execution Note at `(20,64)`, size `400x200`. Place the Fixing Agent below it at `(20,292)`, width 400 and content-driven height. Never pin Question/Text height.

Query the Agent's actual geometry after creation, first prompt and later size changes. Set Frame height to at least `max(child.y + child.height) + 20`; do not reuse an old fixed Frame height. If sizes differ, keep at least 24px between Note and Agent. Preserve Note scrolling rather than expanding long Notes across the layout.

Extend the parent area to contain the row, title inset and padding. Use direct geometry edits, not proportional Frame scaling, to preserve child typography. Query final parent-local and absolute geometry and verify containment, sibling gaps and non-overlap; requested dimensions are not proof of final geometry.

Connect the Execution Note to its Fixing Agent only when useful for navigation. Do not connect Coordinator to Fixing Agents or issue Frames. Prompt targeting uses direct Agent adjacency, not containment or arrow direction; accidental edges can change instruction scope.
