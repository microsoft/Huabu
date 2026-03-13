# GitHub Copilot Instructions

- **Code Comments**: Always use English for all code comments and documentation, regardless of the user's language.
- **Documentation**: Ensure all generated documentation strings (JSDoc, TSDoc, etc.) are in English.
- **Post-Edit Actions**: After generating or editing `ts` or `tsx` code, always run `npm run lint:fix` and `npm run format` (or the equivalent `pnpm` command) to ensure code quality and formatting.
- **Changelog Updates**: When a change affects user-facing interactions (e.g., new features, UI changes, shortcut modifications, workflow adjustments), add an entry to `docs/user-guide/CHANGELOG.md`. Each entry should include two parts: **What Changed** (a concise description of the change) and **Notes** (any caveats, migration steps, or things the user should be aware of).
