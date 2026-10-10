# Cross-Frame Multi-Layer Dragging

Status: Backlog
Last reviewed: 2026-10-09

## Scope

Shipped: Layers can move a same-parent multi-selection into another Frame or out to a root-level slot in one atomic, undoable execution, retaining relative order and Frame subtrees. Canvas undo/redo remains available with non-editable Layers tree focus. Expanded destinations use only an insertion caret and collapsed destinations use a solid outline. Neither single- nor multi-node dragging automatically expands a Frame, and dropping into a collapsed destination keeps it collapsed. The multi-layer gesture has no moving-item-count badge.

TODO: Support multi-selections spanning different source parents.

## Open Decisions

- Define how a selection spanning different parents is normalized, including selections containing both a Frame and its descendants.
- Preserve world-space geometry when changing parents and retain the relative order of the moved roots.
- Reject descendant cycles, locked destination Frames, stale nodes, and invalid members without partially moving the group.
- Apply structured Frame layout rules consistently for all moved nodes.
- Keep the drop indicator consistent with the actual destination and cover mouse dragging, long-press touch dragging, cancellation, persistence, and one-step undo/redo.

The shipped same-parent Frame entry and root-exit paths are covered by command, interaction, and mouse/touch browser tests, including one-step undo/redo with Layers focus; the remaining mixed-parent interactions are not yet validated. Current contracts are documented in [web architecture](../architecture/web-architecture.md) and [Canvas command architecture](../architecture/canvas-command-architecture.md).
