/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra volume mounts, env var
 * passthrough, per-session directories) register a function here. The
 * container-runner resolves the session's effective provider name, looks up
 * the registered config fn, and merges the returned mounts/env into the spawn
 * args.
 *
 * Providers without host-side needs (e.g. `claude`, `mock`) don't appear in
 * this registry at all — the lookup returns `undefined` and the spawn path
 * proceeds with only the default mounts and env.
 *
 * Skills add a new provider's host config by creating `src/providers/<name>.ts`
 * with a top-level `registerProviderContainerConfig(...)` call, then appending
 * `import './<name>.js';` to `src/providers/index.ts` (the barrel).
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<session_id>`. */
  sessionDir: string;
  /** Agent group ID, for any per-group logic. */
  agentGroupId: string;
  /** `process.env` at spawn time — pull passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
  /**
   * Model override from container.json (or DB `container_configs.model`).
   * Provider-specific identifier (e.g. `claude-sonnet-4-5`, `gpt-5`,
   * `llama3.2`). Provider container-config functions decide whether to
   * honor it; some forward it to a config file (amplifier-agent's
   * `host_config.provider.config.default_model`), others may use env
   * vars or simply ignore it. `undefined` means "use provider default".
   */
  model?: string;
  /**
   * Reasoning effort override from container.json (or DB
   * `container_configs.effort`). Free-form string; providers that
   * understand it interpret it on their own. For amplifier-agent it's
   * forwarded as `host_config.provider.config.effort` and each provider
   * module decides what values it accepts (e.g. `high`/`medium`/`low`).
   * `undefined` means "use provider default".
   */
  effort?: string;
}

export interface ProviderContainerContribution {
  /** Extra volume mounts (merged with the default session/group/agent-runner mounts). */
  mounts?: VolumeMount[];
  /** Extra env vars to pass to the container (`-e KEY=VALUE`). */
  env?: Record<string, string>;

  /**
   * Provider opt-out of the OneCLI credential-injection proxy.
   * Default: false (gateway always applied; standard NanoClaw model).
   * Set true when the provider holds credentials directly in the container env
   * (e.g. amplifier-agent direct-key dogfooding mode). Bypasses OneCLI's
   * Authorization-header rewrite, rate limits, and audit trail — use sparingly
   * and document the security trade-off at the call site.
   */
  skipOneCliGateway?: boolean;
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;

const registry = new Map<string, ProviderContainerConfigFn>();

export function registerProviderContainerConfig(name: string, fn: ProviderContainerConfigFn): void {
  if (registry.has(name)) {
    throw new Error(`Provider container config already registered: ${name}`);
  }
  registry.set(name, fn);
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name);
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}
