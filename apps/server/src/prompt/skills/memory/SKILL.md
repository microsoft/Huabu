---
id: memory
name: Memory
description: Rules for writing the three memory tiers (workspace / canvas / skill). Load skills/memory/write.md when the user asks you to record / remember / save / update something.
appliesTo: [ask, operate, sketch, external]
---

This skill is a pointer. The actual writing rules and per-tier semantics live in `skills/memory/write.md` — open that file the moment the user asks you to record / remember / save / update anything.

Reading memory needs no skill — call `read("memory/workspace.md")` or `read("memory/canvas.md")` directly.
