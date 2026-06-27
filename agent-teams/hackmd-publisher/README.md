# HackMD Publisher

An agent that syncs Huabu canvas nodes to [HackMD](https://hackmd.io).

## What It Does

Select nodes on your canvas, tell the agent "publish these to HackMD", and it will:

1. Read each node's content via Huabu Reachback
2. Understand the spatial structure (frames → sections, order from edges)
3. Assemble a coherent markdown document
4. Publish to HackMD
5. Write back a status node with the URL

## Prerequisites

- A HackMD account with an API token ([get one here](https://hackmd.io/settings#api))
- One of the supported harnesses installed: `claude` or `copilot`

## Setup

1. Copy `.env.example` to `.env` and fill in your HackMD token:
   ```bash
   cp .env.example .env
   # Edit .env with your token
   ```

2. Unpack the Agent Team package:
   ```bash
   node agent-setup.mjs unpack --harness claude
   ```

3. If the unpack/setup flow reports missing local dependencies, install them as
   directed for your chosen harness. For example:
   ```bash
   npm install -g @hackmd/cli
   ```

For the generic Agent Team packaging/runtime model, see:

- [`external/agentlet/spec/agent-team.md`](../../external/agentlet/spec/agent-team.md)

## Usage

Once connected to Huabu:
- Select the nodes you want to publish
- Open the agent chat and say: **"Publish these notes to HackMD"**
- The agent will assemble and publish, then write back a link node

### Example Prompts

- "Publish these nodes to HackMD as a blog post"
- "Update the HackMD note with the latest changes"
- "Publish this frame as a single document, use the frame label as title"
