# Space Kits

A Space Kit is a repository-local installer Skill plus portable assets and, where useful, a small initialization script. The user supplies a trusted GitHub repository/revision and Kit path to an Agent in a blank Huabu Space. The Agent clones the repository, reads the selected `SKILL.md`, and uses existing authenticated RFS operations. There is no Kit registry, discovery endpoint, desktop bundle, Profile provisioning or generic Kit runtime.

The first Kit is [Issue Tracker](./issue-tracker/SKILL.md). It installs one Space's native instruction/configuration/issue-area nodes and a fresh idle Coordinator, using current Execution Note/direct Agent conventions. It does not create Tasks, Runs or Views.

```text
space-kits/
  issue-tracker/
    SKILL.md           # Installation procedure and precise trigger
    kit.json           # Kit ID and version
    assets/            # Installed bytes and editable configuration template/schema
    scripts/           # Dependency-free initialization helper
    tests/             # Focused checks, not installed content
```

Keep installer procedure in `SKILL.md`, installed content under `assets/`, and optional installer-only reading under `references/` only when needed. Runtime Coordinator instructions must not duplicate installation procedure. Project configuration is editable and separate from static Prompt/Skill bytes. Do not copy the Kit author's paths, Profiles, issue categories, protected branch names, repository toolchain or IDs into another user's Space.

Version identity is `kit.json` plus the installer's digest over its exact runtime inputs. Record the cloned commit for provenance; the installer refuses version/digest changes in an existing installation. This is not a signed package, an automatic upgrade protocol or a general declarative blueprint.

Run the dependency-free content/configuration tests with:

```bash
node --test space-kits/issue-tracker/tests/*.test.mjs
```

The real RFS/storage/topology integration suite uses the repository's existing development dependencies:

```bash
pnpm --filter @huabu/server exec vitest run --config ../../space-kits/issue-tracker/vitest.config.mjs
```

See [Space Kits architecture](../docs/architecture/space-kits.md) for boundaries and code entry points.
