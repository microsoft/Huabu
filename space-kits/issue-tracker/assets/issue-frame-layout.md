# Issue Frame Layout

Use the **Issues** area until the user confirms project-specific grouping. Do not install the Kit author's project categories. Within an area Frame, each issue execution unit is a **single Fixing Agent node**—do not create a per-issue Frame or a separate Execution Note node. Keep one horizontal row inside the area Frame, newest active unit at the left and completed units at the right. Align Agent node tops, keep a consistent gap (at least 24px) and never overlap.

Each Fixing Agent node label follows this compact contract:

- Agent: `<status emoji> <issue identity> · <stable issue title>`

The emoji alone carries lifecycle state: 🛠 in progress, 🟣 approval needed, ⛔ blocked, 🚀 PR prepared, ✅ completed. Do not spell out status words (`In Progress`, `Approval Needed`, `PR Prepared`), do not append `Fixing Agent`, `Agent` or `Issue Frame` suffixes, and do not omit the issue title. Keep the complete Agent label at most 80 characters, including emoji and separators, by choosing a concise, unambiguous stable title.

| State           | Agent label                     |
| --------------- | ------------------------------- |
| In progress     | `🛠 #12 · Slow history loading` |
| Approval needed | `🟣 #12 · Slow history loading` |
| PR prepared     | `🚀 #12 · Slow history loading` |

The Coordinator establishes the initial `🛠` label on the Fixing Agent node before dispatch. At each later milestone (`🟣`, `🛠`, `⛔`, `🚀`), the Fixing Agent updates its own Agent node label before ending its turn. Only the Coordinator sets `✅` after verifying completion.

Place each Fixing Agent directly inside the **Issues** Frame at width 400 with content-driven height (`y: 64` for the row). Never pin Question/Text height. Query the Agent's actual geometry after creation, first prompt and later size changes. Extend the parent area Frame (`SET_NODE_GEOMETRY`) to contain the row, title inset and at least 20px padding without proportional Frame scaling. Query final parent-local and absolute geometry to verify containment, sibling gaps and non-overlap; requested dimensions are not proof of final geometry.

Do not connect the Coordinator to Fixing Agents or create Execution Note edges. Prompt targeting uses direct Agent adjacency, not containment or arrow direction; accidental edges can change instruction scope.
