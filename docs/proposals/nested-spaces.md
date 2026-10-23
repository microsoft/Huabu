# Nested Spaces

Status: In progress (implemented on `feat/nested-spaces`, pending integration)
Last updated: 2026-10-20

## Accepted decisions

A Space has at most one real parent in the same Workspace, with arbitrary depth and no cycles. Ownership is distinct from shortcuts: several links may reference the same Space without changing its parent. Existing Spaces remain top-level; historical shortcuts never imply ownership. Frames remain same-canvas spatial containers.

Each owned child records its canonical entry node ID. Copying that card creates an ordinary reference, while changing its position or Frame placement does not change ownership. Explicit reparenting creates an entry in the new parent and leaves the previous entry as a shortcut. Promoting a Space to the top level clears ownership without moving its contents.

Canonical breadcrumbs follow ownership rather than navigation history and are integrated with the existing editable Space title/menu, not a separate toolbar. They retain the root Space and current title, folding middle ancestors into an overflow menu as available width decreases, then folding the direct parent if necessary. Stable `/canvas/:canvasId` routes and existing per-Space viewport persistence remain unchanged. Creation belongs in the canvas toolbar: the `5` tool supports click-to-create and Frame-style rectangle collection without a naming dialog, staying in the parent afterward. Selected-node toolbars and `Cmd+Option+S` / `Ctrl+Alt+S` collect selected content directly. Move to another Space uses an existing-destination search and stays in the source afterward; entering and focusing the destination is an explicit toast action. Parent changes and deletion belong in the Space menu. No child listing is added beside the breadcrumb. Home offers remembered Top level / All modes and name-only search across all levels, with ancestry shown in results. See [the current interaction contract](../architecture/space-preview.md) for details.

World displays only top-level Spaces. Hidden nested entries retain their IDs and geometry in persisted World topology; promotion restores the original placement. This is presentation filtering, not deletion or a new authorization boundary.

Deletion requires explicit confirmation of the owned subtree. A changed subtree requires renewed confirmation. Running/busy Agents block deletion before any member is removed. Linked-but-not-owned Spaces survive. Storage failures report completed and remaining members rather than pretending the entire deletion succeeded.

## Implementation sequence

1. Persist parent and canonical-entry metadata in Disk, SQLite, and PostgreSQL; append SQL v2 migrations without changing v1. Preserve hierarchy during ordinary saves and import bundles as independent top-level Spaces.
2. Serialize ownership operations under a Workspace operation lease, reuse canvas mutexes and existing storage deletion fences, and expose validated child-create, reparent, deletion-preview, and confirmed-delete endpoints.
3. Extend the existing selection move transaction with an opt-in child destination, including its existing artifact/conversation checks and compensation.
4. Extend the existing workspace metadata cache, Common controls, shortcut renderer, and canvas navigation. Protect canonical entries from generic topology deletion and route single-entry UI deletion through confirmation.
5. Cover hierarchy invariants, concurrent opposing moves, deletion confirmation changes, busy conversations, partial deletion, entry protection, backend persistence, and frontend root filtering. Update the architecture contract in the same change.

## Boundaries

No Folder node, separate task workspace, content projection, automatic cross-Space Prompt/Memory inheritance, or physical directory nesting is introduced. Reparenting and subtree deletion are process-coordinated operations, not distributed transactions or crash-atomic multi-Space commits. Bundles export one Space, not a recursive subtree. Metadata freshness retains the existing entry/focus/explicit-mutation refresh model.

The shipped implementation contract belongs in [space-preview.md](../architecture/space-preview.md) and [canvas-storage.md](../architecture/canvas-storage.md).
