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

**Bring your own agents.** Huabu is a shared visual interface for the agents you already use. Connect a supported agent harness, keep its model access, authentication, tools, and permissions, and work with it in a Space. You do not need to configure Huabu's built-in model provider to get started.

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

1. Install and sign in to a supported ACP-compatible agent or adapter on the device where it will run.
2. Open **Settings > Agent**. Huabu automatically creates Profiles for supported agents discovered on connected devices; use **Add device** or **Add agent** when needed.
3. Create a Space, add your materials, and select an Agent Profile in Chat to start working.

Built-In Pi is an optional alternative, not a setup requirement. Some capabilities depend on the connected agent and model; optional Huabu services such as OCR, image generation, and web search have separate configuration. See the [Huabu User Handbook](https://microsoft.github.io/Huabu/docs/) for connection instructions, capability limits, and guidance on your first Space. The handbook is the canonical source for product usage instructions.

Huabu does not provide an LLM service as part of the application. Use of a model or external capability may require a separate account, credentials, subscription, or usage charges from its provider.

## Building from source

### Getting Started

Requirements: Node.js 24.16.0+ and pnpm 10+. Use the version pinned in `.nvmrc` for development and CI.

```bash
pnpm install
pnpm start:desktop
```

This builds and launches the desktop application. Choose your Home folder, then follow the [Quick Start](#quick-start) to connect your agents and create a Space.

For development with hot reload and local quality checks, see [Contributing](CONTRIBUTING.md#local-development).

### Standalone web access

To use Huabu in a browser, start the web application:

```bash
pnpm start:web
```

Open the server address printed in the terminal, choose your Home folder, and configure your agents or models in Settings. The web application and API share one server, accessible only from the same machine by default.

### Remote access

To use Huabu from another device, first stop any Huabu server and Vite development server using this instance's credential storage. Then run setup on the hosting machine, either directly or over SSH, and start the server:

```bash
pnpm run setup
pnpm start:web
```

Setup configures the standalone server (`pnpm start:web`). The desktop's built-in server uses separate instance storage and remains local-only.

Open the configured address on another device. Use HTTPS outside trusted networks; disabling login grants full access to anyone who can reach Huabu.

Or connect the desktop client:

```bash
pnpm start:desktop --server https://huabu.example.com
```

Use the server's root URL. The desktop connects without starting a local server.

Before rerunning setup, stop the instance's Huabu and Vite servers; restart them afterward. To reset the connection token, use `pnpm run setup --reset-connection-token`.

### Advanced deployment

Environment variables and `.env` override setup choices and are never rewritten by setup. See [`.env.example`](.env.example) and [Deployment security](docs/architecture/deployment-security.md).

Back up and persist both server data and private credential configuration. See [Credential storage](docs/architecture/credential-storage.md).

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
