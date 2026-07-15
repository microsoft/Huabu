/**
 * Types for the Agent Team runtime.
 */

/** A single file/directory copy declaration (`require.copies` entry). */
export interface CopyEntry {
  /** Source path relative to the package root (where agentlet.yaml lives). */
  from: string;
  /** Destination path relative to the workspace directory. */
  to: string;
}

/** One host-configurable environment field declared by an Agent Team. */
export interface AgentTeamEnvField {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  /** Optional non-secret default. Secret fields must never declare defaults. */
  default?: string;
}

/** One CLI package installed during setup. */
export interface CliToolRequirement {
  /** Package identifier understood by the selected installer. */
  package: string;
  /** Installation backend. Only npm is currently supported. */
  installer: 'npm';
  /** Install into this deployment workspace or the agentlet-managed shared store. */
  scope: 'workspace' | 'shared';
  /** Commands that must exist after installation. */
  executables: string[];
}

/** Parsed agentlet.yaml manifest. */
export interface AgentTeamManifest {
  schema: string;
  name: string;
  description: string;
  command: Record<string, string>;
  /** Declarative requirements to materialize in each workspace. */
  require?: {
    /** Harness-agnostic CLI tools to install and validate. */
    'cli-tools'?: CliToolRequirement[];
    /** Canonical prompt files relative to the package root. */
    prompts?: string[];
    /** Skill paths to install via `npx skills add`. */
    skills?: string[];
    /** Ordered host-configurable environment schema. */
    env?: AgentTeamEnvField[];
    /**
     * Plain file/directory copies from the package root into each
     * workspace, e.g. helper scripts the agent invokes at runtime.
     */
    copies?: CopyEntry[];
  };
  /** Path to a custom setup script (relative to package root), dynamically imported after the declarative pipeline. */
  onInstall?: string;
}

/** Known harness identifiers. */
export type HarnessName = 'claude' | 'copilot' | 'codex' | (string & {});

/** Prompt file target for a given harness. */
export interface HarnessPromptTarget {
  /** Relative directory within the workspace where the prompt file should be placed. */
  dir: string;
  /** Filename for the prompt file. */
  filename: string;
}

/** Extra context passed as the third argument to setup callbacks. */
export interface CallbackContext {
  /** Absolute path to the agent-team package root (where agentlet.yaml lives). */
  packageDir: string;
  /** Parsed manifest from agentlet.yaml. */
  manifest: AgentTeamManifest;
  /** The harness being set up. */
  harness: string;
  /** Absolute path to workspaces/<harness>/. */
  workspaceDir: string;
  /** Logging helpers. */
  log: SetupLogger;
}

/** Logging interface for setup output. */
export interface SetupLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
}

export type ManagedSetupPhase =
  | 'validating_manifest'
  | 'preparing_workspace'
  | 'installing_tools'
  | 'installing_skills'
  | 'placing_prompt'
  | 'copying_files'
  | 'running_custom_setup';

export interface ManagedSetupProgress {
  phase: ManagedSetupPhase;
  status: 'started' | 'completed';
  message: string;
}

export interface ManagedSetupOptions {
  packageDir: string;
  harness: string;
  workingDirPath: string;
  log: SetupLogger;
  signal?: AbortSignal;
  onProgress?(progress: ManagedSetupProgress): void;
}

/** Callbacks that per-package agent-setup.mjs can provide.
 * Each callback is invoked once per harness being processed.
 *
 * Signature: `(harness, workspaceDir, ctx)`
 *   - harness:      the harness name (e.g., "claude", "copilot")
 *   - workspaceDir: absolute path to workspaces/<harness>/
 *   - ctx:          { packageDir, manifest, log }
 */
export interface SetupCallbacks {
  /**
   * Called during `unpack` to install package-specific dependencies.
   * E.g., `npm install hackmd-cli`.
   */
  onInstall?(
    harness: string,
    workspaceDir: string,
    ctx: CallbackContext,
  ): void | Promise<void>;

  /**
   * Called during `unpack` after workspace creation and install.
   * Use to copy extra files, create configs, etc.
   */
  onUnpack?(
    harness: string,
    workspaceDir: string,
    ctx: CallbackContext,
  ): void | Promise<void>;

  /**
   * Called during `validate` to check package-specific assumptions.
   * Return normally if valid, throw if not.
   */
  onValidate?(
    harness: string,
    workspaceDir: string,
    ctx: CallbackContext,
  ): void | Promise<void>;

  /**
   * Called during `doctor` to emit package-specific diagnostics.
   */
  onDoctor?(
    harness: string,
    workspaceDir: string,
    ctx: CallbackContext,
  ): void | Promise<void>;
}
