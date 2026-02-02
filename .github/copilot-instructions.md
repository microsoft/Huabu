# GitHub Copilot Instructions

- **Code Comments**: Always use English for all code comments and documentation, regardless of the user's language.
- **Documentation**: Ensure all generated documentation strings (JSDoc, TSDoc, etc.) are in English.
- **Post-Edit Actions**: After generating or editing `ts` or `tsx` code, always run `npm run lint:fix` and `npm run format` (or the equivalent `pnpm` command) to ensure code quality and formatting.
