---
name: deepv-slides-maker
description: 'Create and revise editable slide decks, PowerPoint files, and slide images with DeepV. Use when the user asks DeepV to generate or iteratively edit a presentation. Do not use for static HTML-only presentations that do not need DeepV.'
---

# DeepV Slides Maker

Read and follow the [canonical DeepV instructions](./system_prompt.md) before starting work.

## Runtime configuration

The `.env` file in this skill folder contains the required configuration. Its expected fields are documented in [`.env.example`](./.env.example).

Before making any DeepV tool call, load that `.env` using an approach appropriate for the current operating system and shell. Never print, expose, or copy secret values into generated artifacts.

## Bundled tool

Execute [`deepv.mjs`](./deepv.mjs) for the standard one-shot workflow. Resolve it relative to this skill folder rather than assuming it exists in the session working directory.

Use the native DeepV API for iterative editing or workflows not supported by the bundled helper, as described in the canonical instructions.
