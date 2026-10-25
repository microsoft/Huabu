# Contributing to Huabu

Thank you for your interest in Huabu.

## Current contribution scope

The current contribution scope focuses on bug reports, documentation feedback, and research feedback submitted through the [Huabu issue tracker](https://github.com/microsoft/Huabu/issues).

Before opening an issue, search existing issues, use the latest available release, and follow the guidance in [SUPPORT.md](SUPPORT.md). Do not include API keys, access tokens, private documents, personal information, or other sensitive data in public issues, logs, or screenshots.

Security vulnerabilities must not be reported through public GitHub issues. Follow [SECURITY.md](SECURITY.md) to report them privately.

## Local development

Install the prerequisites and dependencies described in [Building from source](README.md#building-from-source), then start the desktop development environment:

```bash
pnpm run dev:desktop
```

This starts the server and web client in watch mode and opens the desktop application with hot reload.

HMR requires no `HUABU_PUBLIC_ORIGIN` in its selected connection source. Source Desktop reads repository-root `.env` with inherited process overrides, or only an explicit `--env-file`. Remove remote configuration, or pass a file without an origin to `pnpm dev:desktop --env-file /absolute/path/local.env`. To connect to a remote deployment instead of starting HMR services, use `HUABU_PUBLIC_ORIGIN=https://huabu.example.com pnpm start:desktop`. The old `--server` option is no longer supported.

### Optional Git hooks

Enable local checks once per clone:

```bash
pnpm run hooks:install
```

This installs untracked hooks in `.git/hooks`:

- **pre-commit** runs `lint-staged` with ESLint fixes and Prettier on staged files.
- **pre-push** runs `pnpm run typecheck`.

Use Git's `--no-verify` option to skip a hook for an individual operation, or run `pnpm run hooks:uninstall` to remove the hooks. These checks are a local convenience; CI remains authoritative and runs lint, format, and typecheck regardless of local hook configuration.

## Contributor License Agreement

Most contributions require agreement to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use the contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com). When a pull request is submitted, a CLA bot will determine whether the agreement is required and provide instructions.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), review the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/), or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with additional questions or comments.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](LICENSE), unless explicitly stated otherwise.
