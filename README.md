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

Huabu is a spatial workspace for thinking with AI. It keeps ideas and AI work persistent, visible, and connected, so collaboration can continue across sessions instead of disappearing into isolated chat threads.

## Core Features

- **Bring scattered information together** — drag ideas, notes, documents, and outputs from different chat sessions and sources into one Space, so everything relevant stays visible and connected.
- **Organize your thinking with AI** — work with AI to arrange information, uncover relationships, and clarify ideas while reviewing and controlling every proposed change.
- **Let your agents work with richer context** — bring your own agents into a Space, where they can understand not only the materials you provide, but also how those materials relate to one another—helping them better grasp your intent and do more relevant work.

  > Source code will be released in a future update.

## Download and Install

This initial release distributes packaged desktop applications through [GitHub Releases](https://github.com/microsoft/Huabu/releases/latest).

1. Download the latest package for your platform from the Releases page.
2. On macOS, open the `.dmg`; on Windows, run the `.exe` installer.
3. Launch Huabu and choose a local folder as your **Home**.

The current desktop packages target macOS on Apple silicon and Windows on x64. Available packages may vary by release; consult the release notes before installing.

## Quick Start

Follow the [Huabu User Handbook](https://microsoft.github.io/Huabu/docs/) for setup instructions, model configuration, core concepts, and guidance on creating and working in your first Space. The handbook is the canonical source for product usage instructions.

Huabu does not provide an LLM service as part of the application. Use of a model or external capability may require a separate account, credentials, subscription, or usage charges from its provider.

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
