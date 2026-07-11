# Huabu

> A canvas-based framework for human–AI collaboration.

Huabu provides a shared two-dimensional workspace where ideas, notes, documents,
questions, and AI outputs live side by side as **persistent nodes**. Instead of
treating AI as a chat window detached from your work, Huabu places the human and
the AI inside the same canvas so they can build on each other's contributions
over time.

---

## Two Principles

### 1. Externalize Thinking

Huabu makes the intermediate structure of thought visible on the canvas.
Ideas can be organized, revised, and revisited outside of working memory.
The canvas captures not only **content**, but also **structure** — spatial
arrangement reflects relationships, priorities, uncertainty, and the emerging
clusters of thought that usually stay implicit in a linear document or chat.

### 2. Share Cognitive Space

Because the AI operates in the same workspace as the human, it can access the broader context of the work rather than only the latest instruction. This lets
it:

- help organize materials,
- synthesize across nodes,
- identify what remains unresolved,
- and support the development of ideas into more structured and actionable
  outputs.

The canvas is the shared memory; both sides read from it and write to it.

---

## What's in a Canvas

A Huabu canvas is an infinite 2D surface composed of typed, persistent nodes
that the user and the AI can both create, modify, link, and group.

| Node type   | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| Note        | Rich-text / Markdown notes for ideas and drafts               |
| Text        | Lightweight text blocks for labels and annotations            |
| Web         | Embedded web pages as living references                       |
| PDF         | PDF reader with highlighting that flows back into the canvas  |
| Image/Video | Visual material kept next to the thinking it informs          |
| Frame       | Grouping container that gives a region of the canvas identity |
| Edge        | Explicit relationships between nodes                          |

Around these primitives Huabu adds:

- **Intent system** — press `Ctrl/Cmd+I` and the AI proposes the next useful
  moves based on what is currently on the canvas.
- **Per-canvas node content storage** — each canvas owns its node content
  locally, so the AI can read and write directly against the same material
  the user is working on without a separate indexing step.
- **AI chat side panel** — a conversational surface whose actions land back
  on the canvas as nodes and edges, not just as text replies.

See the user guide in [docs/user-guide](./docs/user-guide/README.md) for
details.

---

## Getting Started

Requirements: Node.js 20+ and pnpm 10+.

```bash
pnpm install
```

The source development server needs a stable encryption key before credentials can be saved through the Settings UI. Copy `.env.example` to `.env`, generate a key with the following command, and paste its output into `HUABU_SECRET_KEY=`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep that key unchanged: existing encrypted credentials cannot be opened with a different key. The `.env` file is git-ignored. Packaged Electron releases use the operating system's secure storage and do not require `HUABU_SECRET_KEY`.

Then launch the desktop development environment:

```bash
pnpm run dev:desktop
```

This launches the desktop app (recommended), starting the server, the web client, and the shared package in watch mode, then opening Huabu in its own desktop window.

### Local quality checks (optional)

The repository ships opt-in git hooks that give you fast feedback before
you commit or push. Enable them once per clone:

```bash
pnpm run hooks:install
```

This generates the hooks into your local `.git/hooks` directory (they are
not tracked in the repository), wiring up:

- **pre-commit** — `lint-staged` (ESLint `--fix` + Prettier on staged files)
- **pre-push** — `pnpm run typecheck`

Skip a single run with `--no-verify`, or disable the hooks again with
`pnpm run hooks:uninstall`. These hooks are purely a local convenience —
the authoritative gate is CI (`.github/workflows/ci.yml`), which runs lint,
format, and typecheck on every pull request regardless of local setup.

---

## Configuring an LLM

Huabu needs an LLM to drive chat, intent suggestions, and other
in-canvas AI features. Open the Settings button → **LLM Provider**.

1. Pick a **Provider** (OpenAI, Anthropic, Google Gemini, OpenRouter,
   GitHub Copilot, and more).
2. Pick a **Model**. If the provider doesn't expose a model list,
   type one in (e.g. `gpt-4o`) and click **Save**.
3. Authenticate:
   - **API key** providers — click **Set key**, paste, save.
   - **GitHub Copilot** (OAuth) — click **Login**, then enter the shown user code at the opened GitHub page.

The config is persisted on the server side, so you only need to do this once per machine. Source development uses the `HUABU_SECRET_KEY` configured during setup; packaged Electron releases use OS-protected storage instead.

> Coding agents you connect through **External Agents** (below) bring
> their own auth and don't use this provider setting.

---

## Connecting external coding agents

Huabu can talk to AI coding agents running on your machine — **GitHub Copilot**, **Claude Agent**, **Gemini**, **Codex**, **Qwen Code**, **Kimi Code CLI**, **OpenCode**, **Cursor**, and others that speak the [Agent Client Protocol](https://agentclientprotocol.com).

First install the agent CLI(s) you want and complete their sign-in flow.
Then open **Settings → External Agents**, create a profile for the agent
and the project folder it should work in, and activate it. The agent
appears in the chat panel and can read and modify files under that folder.

---

## License

See [LICENSE](./LICENSE).
