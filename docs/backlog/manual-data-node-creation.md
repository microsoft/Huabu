# Manual UI Creation & File Drop for Data Nodes

Status: Backlog
Last reviewed: 2026-04-20

## Idea

Milestone 1 of [#463](https://github.com/microsoft/Huabu/issues/463) ships `data` (`type: 'data'`) as an Agent-created first-class Canvas node (mirroring local-HTML Interactive Views), while humans inspect and safely edit existing Data Nodes through `DataPreview` or bound HTML forms. A future iteration could expose manual user creation entry points:

- Adding a `Data` item to the Canvas creation toolbar (`NodeToolbar`) that places a default `{}` Data Node without opening raw editing automatically.
- Supporting `.json` file drag-and-drop or paste onto the Canvas to create a `data` node after validating size bounds and the prohibited secret-key rule.
- Optional UI affordances in `DataPreview` for viewing or authoring `dataSchema` directly without an Agent command.

## Unvalidated assumptions

- Whether everyday Canvas users want a top-level toolbar slot for raw JSON Data Nodes or prefer Data Nodes to be provisioned by Space Kits and Agents alongside HTML forms.
- When dropping a `.json` file onto the Canvas, whether users expect a structured `data` node (64 KiB cap, no secret keys) or an external `fileReference` / uploaded artifact for larger datasets.

## Constraining architecture

- [data-node.md](../architecture/data-node.md) — current Data Node invariants, 64 KiB and secret-key validation rules, and protected `DataPreview` lifecycle.
- [canvas-command-architecture.md](../architecture/canvas-command-architecture.md) — `ADD_NODES` UI intent and `CREATE_NODES` command pipeline.
