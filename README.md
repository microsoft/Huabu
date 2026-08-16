<h1 align="center">
	<img src="assets/huabu-logo.svg" alt="Huabu logo" width="64" align="center" />
	Huabu
</h1>

<p align="center"><strong>Where you and your agents think together.</strong></p>

<p align="center">
	<img src="assets/huabu-collaboration.svg" alt="A blue human and three colorful agents organizing connected materials together in a shared Space" width="800" />
</p>

<p align="center">
	<a href="https://microsoft.github.io/Huabu/docs/">User Handbook</a> ·
	<a href="https://github.com/microsoft/Huabu/releases/latest">Download</a> ·
	<a href="https://github.com/microsoft/Huabu/issues">Feedback</a>
</p>

Huabu gives you an infinite work surface where you and your agents think together. Bring ideas, files, open questions, and agents into one living surface, where they stay visible and connected across sessions—and turn clearer thinking into work that ships.

## Core Features

- **Bring scattered information together** — drag ideas, notes, documents, and outputs from different chat sessions and sources into one Space, so everything relevant stays visible and connected.
- **Organize your thinking with AI** — work with AI to arrange information, uncover relationships, and clarify ideas while reviewing and controlling every proposed change.
- **Let your agents work with richer context** — bring your own agents into a Space, where they can understand not only the materials you provide, but also how those materials relate to one another—helping them better grasp your intent and do more relevant work.

## Download and Install

Packaged desktop applications are published through [GitHub Releases](https://github.com/microsoft/Huabu/releases/latest). You can also [build from source](#building-from-source).

1. Download the latest package for your platform from the Releases page.
2. On macOS, open the `.dmg`; on Windows, run the `.exe` installer.
3. Launch Huabu and choose a local folder as your **Home**.

The current desktop packages target macOS on Apple silicon and Windows on x64. Available packages may vary by release; consult the release notes before installing.

## Quick Start

Follow the [Huabu User Handbook](https://microsoft.github.io/Huabu/docs/) for setup instructions, model configuration, core concepts, and guidance on creating and working in your first Space. The handbook is the canonical source for product usage instructions.

Huabu does not provide an LLM service as part of the application. Use of a model or external capability may require a separate account, credentials, subscription, or usage charges from its provider.

## Building from source

### Getting Started

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

### Standalone web access

`pnpm start:web` serves the compiled web application and API from one Fastify process. It remains loopback-only by default. To make the single-owner application reachable on a network, configure the bind address, every hostname or IP used in the browser, and complete Basic Auth:

```dotenv
HUABU_BIND_HOST=0.0.0.0
HUABU_ALLOWED_HOSTS=huabu.example.com
HUABU_BASIC_AUTH_USER=owner
HUABU_BASIC_AUTH_PASS=<strong-password>
```

Then run `pnpm start:web`. Huabu rejects a non-loopback bind when allowed hosts or either Basic Auth value is missing. The authenticated owner can use all features, including Settings, OAuth, and External Agents. `pnpm dev` applies the same requirement to non-loopback browser clients while preserving zero-configuration local development.

Huabu currently serves HTTP. Use a trusted private network or terminate HTTPS with deployment infrastructure such as Caddy, Nginx, Tailscale Serve, or a cloud load balancer. Do not put a Basic Auth deployment on an untrusted network without transport encryption.

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

Configuring a model provider and connecting external coding agents work the same way as in a packaged build, so they are covered in the handbook: [Models and capabilities](https://microsoft.github.io/Huabu/docs/ai/models-and-capabilities) and [External agents](https://microsoft.github.io/Huabu/docs/ai/external-agents). A source build reads its encryption key from `HUABU_SECRET_KEY`, whereas packaged releases use operating-system-protected storage.

## Data, Credentials, and Connected Services

Huabu stores Spaces and their materials in the Home folder selected by the user. Credentials saved in the packaged desktop application are encrypted at rest using operating-system-protected storage.

Huabu does not send telemetry, crash reports, diagnostic logs, or usage data to Microsoft.

When an AI feature is used, the configured model provider or connected service may receive the prompt and relevant Space content needed to fulfill the request. External agents may also read or modify files within the working directory configured for them. Review the terms, privacy practices, data-handling controls, and permissions of every provider or agent before connecting it, and do not provide sensitive material unless its use is authorized.

## Research Status and Responsible Use

Huabu is released for research and experimental use. AI-generated output may be inaccurate, incomplete, biased, or unsafe, and Huabu has not been evaluated for every language, model, or downstream scenario. Do not use it for high-risk or time-critical decisions, or in workflows where output is acted upon without qualified human review.

For the complete intended-use statement, evaluation summary, limitations, and responsible-use guidance, read [RAI_README.md](RAI_README.md).

## Support and Feedback

Community support is available on a best-effort basis through the [Huabu issue tracker](https://github.com/microsoft/Huabu/issues). See [SUPPORT.md](SUPPORT.md) for support guidance. Report security vulnerabilities privately by following [SECURITY.md](SECURITY.md).

## Contributing

We welcome bug reports, documentation feedback, and research feedback. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and Contributor License Agreement requirements. This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third parties' policies.

## License

The materials included directly in this repository are licensed under the [MIT License](LICENSE), except where otherwise noted. The packaged Huabu application distributed through GitHub Releases is provided under the license terms included with that release.
