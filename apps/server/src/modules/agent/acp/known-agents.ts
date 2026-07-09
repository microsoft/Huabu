/**
 * Data catalogue of the ACP-capable agents the Settings UI knows how to
 * launch. Kept separate from the host probing logic in
 * {@link ./agent-cli-detect} so adding / editing an agent is a pure data
 * change with no need to touch the detection machinery.
 *
 * Each entry is a launch *recipe*: what binary to look for on PATH and
 * what to spawn. There is no way to infer this from the binary alone —
 * some agents speak ACP natively (`<binary> --acp`), others are driven
 * through an adapter whose bin *is* the ACP agent (empty `acpArgs`).
 *
 * This is intentionally a local module (no remote fetch): it ships with
 * the app and is signed/trusted. A future iteration may layer a
 * remotely-refreshable overlay on top, but detection must always fall
 * back to this built-in list and never execute an arbitrary
 * remotely-supplied command.
 */

/** One known external agent's detection + launch recipe. */
export interface KnownCli {
  /** Stable short id surfaced to the UI (`copilot` / `claude` / …). */
  id: string;
  /** Display name shown in the Profile Editor dropdown. */
  displayName: string;
  /** Binary name resolved against PATH and launched by the daemon. */
  binary: string;
  /** Args after the binary to enter ACP mode (typically `['--acp']`). */
  acpArgs: string[];
  /**
   * Recognized auto-approve flag for this CLI, or `null` if none is
   * exposed as a simple toggle. Claude has `--dangerously-skip-permissions`
   * but we intentionally do NOT surface it as a one-click toggle — users
   * who want it can build the command manually.
   */
  allowAllFlag: string | null;
  /**
   * When true, skip the `<binary> --version` probe during detection.
   * Used for agents whose bin starts an interactive / stdio server on
   * any invocation (e.g. ACP adapters that speak the protocol over
   * stdin/stdout) and would otherwise block until the probe timeout
   * instead of printing a version.
   */
  skipVersionProbe?: boolean;
  /** One-line `npm install -g …` hint used in error / help text. */
  installHint: string;
}

/**
 * Canonical catalogue of ACP-capable CLIs the Settings UI knows how to
 * launch via agentlet. Order is the order shown in the UI.
 */
export const KNOWN_CLIS: readonly KnownCli[] = [
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binary: 'copilot',
    acpArgs: ['--acp'],
    allowAllFlag: '--allow-all',
    installHint: 'npm install -g @github/copilot',
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    // Claude Code has no native ACP mode; it's driven through the
    // official ACP adapter (backed by the Claude Agent SDK). Users
    // install the adapter globally and we detect + launch its
    // `claude-agent-acp` bin directly — the bin *is* the ACP agent, so
    // there is no `--acp` argument. Auth is via ANTHROPIC_API_KEY or an
    // existing `claude login` session; the adapter does NOT depend on
    // the `claude` binary being on PATH.
    binary: 'claude-agent-acp',
    acpArgs: [],
    allowAllFlag: null,
    // The adapter bin starts the stdio ACP server on any invocation and
    // would block on stdin rather than print a version, so skip the
    // probe to avoid burning the full timeout on the happy path.
    skipVersionProbe: true,
    installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    binary: 'gemini',
    acpArgs: ['--acp'],
    allowAllFlag: null,
    installHint: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    // Codex has no native ACP mode; it's driven through the Codex ACP
    // adapter (a Rust binary named `codex-acp`). Users install it via
    // the adapter's npm package or a GitHub release, and we detect +
    // launch the `codex-acp` bin directly — the bin *is* the ACP agent,
    // so there is no `--acp` argument. Auth is via OPENAI_API_KEY /
    // CODEX_API_KEY or a ChatGPT-subscription login; the adapter does
    // NOT require the `codex` binary on PATH.
    binary: 'codex-acp',
    acpArgs: [],
    allowAllFlag: null,
    // Skip the version probe: like other ACP adapters the bin may start
    // the stdio ACP server and block on stdin rather than print a
    // version, which would burn the full probe timeout.
    skipVersionProbe: true,
    installHint: 'npm install -g @agentclientprotocol/codex-acp',
  },
];
