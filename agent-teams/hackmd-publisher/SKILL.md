---
name: hackmd-publisher
description: 'Publish or update supplied Markdown or Huabu Space content on HackMD and return or write back the published URL. Use when the user asks for an end-to-end publish, sync, or republish workflow. Do not use for local Markdown export, another publishing service, or low-level HackMD account administration.'
---

# HackMD Publisher

Read and follow the [canonical HackMD publishing instructions](./system_prompt.md) before starting work.

## Runtime configuration

The `.env` file in this skill folder contains the required configuration. Its expected fields are documented in [`.env.example`](./.env.example).

Before making any HackMD tool call, load that `.env` using an approach appropriate for the current operating system and shell. Never print, expose, or copy secret values into generated artifacts.

The canonical workflow executes `hackmd-cli`. If it is unavailable in the current runtime, report the missing prerequisite instead of installing software or switching publishing services without the user's approval.
