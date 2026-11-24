# Advanced Space Layout

Load this guide when you need a structured diagram, multi-frame composition, aligned grid, flowchart, roadmap, or another layout that goes beyond the basics in the root RFS skill.

The shared recipes below use Huabu operation names directly. Obtain geometry with `huabu-rfs query` using `type: "INSPECT_NODES"` and submit commands with `huabu-rfs execute`. Run `query --help TYPE` or `execute --help TYPE` before constructing an unfamiliar operation.

## Default node geometry

`CREATE_NODES.position` is always required; when `size` is omitted, Huabu starts from these canonical defaults:

| Node type              | Default geometry                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `text`                 | 400px wide; content-driven height                                                    |
| `note`                 | 400 × 300px; fixed height by default                                                 |
| `web`, `pdf`, `office` | 400 × 400px                                                                          |
| `video`                | 400 × 300px                                                                          |
| `image`                | 400px wide; height follows the source aspect ratio (300px nominal before resolution) |
| `audio`                | 400 × 56px                                                                           |
| `frame`                | 400 × 300px                                                                          |
| `question`             | 400px wide; content-driven height (80px nominal layout height)                       |

Never pin top-level height on `text` or `question` (`data.style.fontSize` defaults to 16px for Text and 24px for Question). Notes default to fixed height (`SET_NODE_GEOMETRY` with `size.height: "auto"` fits a short Note to its text). For free-form root or Frame layouts, start with ~50px between nodes, 28px side/bottom Frame padding, and an 80px top inset for a Regular internal Frame title, then re-query `INSPECT_NODES` when exact final geometry matters.

{{include:skills/space/references/layout-recipes.md}}
