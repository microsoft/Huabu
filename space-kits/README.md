# Space Kits

A Space Kit is a repository-local installer Skill plus portable assets and, where useful, a small initialization script. The user supplies a trusted GitHub repository/revision and Kit path to an Agent in a blank Huabu Space. The Agent clones the repository, reads the selected `SKILL.md`, and uses existing authenticated RFS operations. There is no Kit registry, discovery endpoint, desktop bundle, Profile provisioning or generic Kit runtime.

The first Kit is [Issue Tracker](./issue-tracker-setup/SKILL.md), installed by the `issue-tracker-setup` Skill. It creates native instruction/configuration/issue-area nodes, then a fresh idle Coordinator after configuration is confirmed, keeping setup state in the installer Agent's conversation context without placing any ledger Note on the canvas. Prompt/Skill Frames use their final recognized titles from creation. The single editable configuration source is a Markdown table Note inside an amber Prompt Frame; onboarding guidance is a Text node outside all instruction Frames. The Frame turns green when ready. Each issue uses a single Fixing Agent node inside the `Issues` Frame, without Execution Notes, per-issue Frames, Tasks, Runs or Views.

```text
space-kits/
  issue-tracker-setup/
    SKILL.md           # Installation procedure and precise trigger
    assets/            # Installed bytes and editable configuration template/schema
    scripts/           # Dependency-free initialization helper
    tests/             # Focused checks, not installed content
```

The [Paper Reviewer](./paper-reviewer-setup/SKILL.md) and [Paper Scout](./paper-scout-setup/SKILL.md) Kits independently install idle Agents, dedicated Prompt Frames, lazy runtime Skill Notes, and empty paper work areas. Paper Scout also installs its helper source as a separate lazy Note, so it remains usable without the original clone. These lightweight installers follow direct RFS guidance rather than adding a generic runtime.

HackMD lives under [`apps/server/src/services/hackmd/`](../apps/server/src/services/hackmd/) as a third-party Service. The outdated DeepV and HTML Slides Maker packages were removed; `agent-teams/` is retired. No user credentials, working directories, or conversation records are migrated or removed.

Keep installer procedure in `SKILL.md`, installed content under `assets/`, and optional installer-only reading under `references/` only when needed. Runtime Coordinator instructions must not duplicate installation procedure. Project configuration is editable and separate from static Prompt/Skill bytes. Do not copy the Kit author's paths, Profiles, issue categories, protected branch names, repository toolchain or IDs into another user's Space.

Run the dependency-free content/configuration tests with:

```bash
node --test space-kits/issue-tracker-setup/tests/content.test.mjs
```

`pnpm run test:space-kits` also checks every installation Skill's metadata, package-local references and tracked-file hygiene, plus the real Issue Tracker RFS/storage/topology tests.

The real RFS/storage/topology integration suite uses the repository's existing development dependencies:

```bash
pnpm --filter @huabu/server exec vitest run --config ../../space-kits/issue-tracker-setup/vitest.config.mjs
```

See [Space Kits architecture](../docs/architecture/space-kits.md) for boundaries and code entry points.
