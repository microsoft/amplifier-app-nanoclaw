/**
 * Amplifier-agent host-side provider container config.
 *
 * DOGFOOD-WORKAROUND VERSION: reads ANTHROPIC_API_KEY from .env directly
 * and sets `skipOneCliGateway: true` so the container holds the real key
 * and talks to api.anthropic.com without going through OneCLI's proxy.
 *
 * This exists because the upstream `amplifier-module-provider-anthropic`
 * uses the Anthropic SDK's `api_key` parameter, which sends the credential
 * as `x-api-key`. NanoClaw's OneCLI gateway is configured to rewrite
 * `Authorization: Bearer`, not `x-api-key`. Until upstream supports
 * `ANTHROPIC_AUTH_TOKEN` (Bearer mode) — or OneCLI grows an x-api-key
 * rewrite rule — the only working path on a developer install is to
 * bypass OneCLI entirely for this provider.
 *
 * SECURITY TRADE-OFF: the raw key sits in the container's process.env.
 * Acceptable for local dogfooding; NOT acceptable for production or
 * shared installs. See SKILL.md "Known upstream gap" callout.
 *
 * Volume layout: per-agent-group bind mount of $DATA_DIR/amplifier-agent/<id>/
 * at /home/node/.amplifier-agent/ so transcripts, host config, and bundle
 * cache survive container restarts. Engine v0.6.0 unified its storage tree
 * under this single root (replacing the XDG layout from v0.5.x); see
 * amplifier-agent `docs/designs/2026-06-11-drop-xdg-and-flag-cleanup.md`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  registerProviderContainerConfig,
  type ProviderContainerContext,
  type ProviderContainerContribution,
} from './provider-container-registry.js';

/**
 * The set of amplifier-agent "internal providers" (LLM backends). Used to
 * recognize a `provider:` prefix on the `--model` field. Keep this in sync
 * with the credentialsMap in container/agent-runner/src/providers/
 * amplifier-agent.ts -- if amplifier-agent adds a fifth provider module,
 * update both.
 */
const VALID_INTERNAL_PROVIDERS = new Set(['anthropic', 'openai', 'azure-openai', 'ollama']);

/**
 * Parse the `model` field from container.json into an optional provider
 * prefix and a model name.
 *
 *   "claude-sonnet-4-5"             -> { model: "claude-sonnet-4-5" }
 *   "anthropic:claude-sonnet-4-5"   -> { provider: "anthropic", model: "claude-sonnet-4-5" }
 *   "ollama:llama3.2:latest"        -> { provider: "ollama",    model: "llama3.2:latest" }
 *                                       (first-colon split lets ollama tags survive)
 *   "claud:foo"                     -> throws (strict: unknown prefix)
 *   "anthropic:"                    -> throws (empty model name)
 *
 * Bare strings (no colon) are returned verbatim as the model name, letting
 * the caller fall back to the install-wide AMPLIFIER_AGENT_INTERNAL_PROVIDER
 * for provider selection. A prefix is only recognized when it matches a
 * known internal provider; anything else fails fast so typos can't silently
 * be treated as model names.
 */
function parseModel(raw: string | undefined): { provider?: string; model?: string } {
  if (!raw) return {};
  const idx = raw.indexOf(':');
  if (idx === -1) return { model: raw };
  const prefix = raw.slice(0, idx);
  const rest = raw.slice(idx + 1);
  if (!VALID_INTERNAL_PROVIDERS.has(prefix)) {
    throw new Error(
      `Invalid --model value "${raw}": unknown internal-provider prefix "${prefix}". ` +
        `Valid prefixes: ${[...VALID_INTERNAL_PROVIDERS].join(', ')}. ` +
        `Use a bare model name (no colon) to fall back to AMPLIFIER_AGENT_INTERNAL_PROVIDER from .env.`,
    );
  }
  if (!rest) {
    throw new Error(`Invalid --model value "${raw}": empty model name after "${prefix}:".`);
  }
  return { provider: prefix, model: rest };
}

export function buildAmplifierAgentContainerConfig(ctx: ProviderContainerContext): ProviderContainerContribution {
  const hostPath = path.join(DATA_DIR, 'amplifier-agent', ctx.agentGroupId);
  // Pre-create the host dir so the bind mount is owned by the host user, not
  // by root (which is what Docker does when the source path doesn't exist).
  fs.mkdirSync(hostPath, { recursive: true });

  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_VERSION',
    'OLLAMA_BASE_URL',
    'AMPLIFIER_AGENT_INTERNAL_PROVIDER',
  ]);

  const env: Record<string, string> = {
    AMPLIFIER_AGENT_LOG_LEVEL: 'info',
    // Runtime git-clone of bundle modules through OneCLI's HTTPS proxy needs
    // the CA bundle pointer. Without these the engine crashes on first
    // module activation with "server certificate verification failed".
    GIT_SSL_CAINFO: '/etc/ssl/certs/ca-certificates.crt',
    GIT_SSL_NO_VERIFY: '1',
  };

  // Resolve the effective LLM backend for THIS agent group.
  //
  // Two sources, in priority order:
  //   1. A `<provider>:` prefix on the `--model` field in container.json.
  //      Lets a user run `--model anthropic:claude-sonnet-4-5` to opt
  //      this group onto Anthropic, independently of any other group.
  //   2. AMPLIFIER_AGENT_INTERNAL_PROVIDER from .env -- the install-wide
  //      fallback for groups that haven't overridden their model with a
  //      prefix. (Read from .env because the service process does not
  //      load .env into process.env; see src/env.ts header comment.)
  //
  // If neither source provides a provider, we pass nothing to the container
  // and the engine will fail at first turn with a clear "no provider
  // selected" error. That's louder than silently picking a default, which
  // matches the rest of nanoclaw's strict-config posture.
  const parsedModel = parseModel(ctx.model);
  const effectiveInternalProvider = parsedModel.provider ?? dotenv.AMPLIFIER_AGENT_INTERNAL_PROVIDER;
  if (effectiveInternalProvider) {
    env.AMPLIFIER_AGENT_INTERNAL_PROVIDER = effectiveInternalProvider;
  }

  // Write host_config.json (turn-key host policy file). The amplifier-agent
  // wrapper (amplifier-agent-ts >= 0.7.0) forwards this file to the engine
  // via `--config <path>`; the engine reads `provider.module`,
  // `provider.config`, `approval.mode`, and `allowProtocolSkew` from it.
  // The container-side provider
  // (container/agent-runner/src/providers/amplifier-agent.ts) sets
  // `approval: { mode: 'prompt' }` in spawnConfig so the engine's
  // host_config.approval.mode actually governs the headless turn -- the
  // wrapper's default `-y` flag would otherwise outrank the file.
  //
  // PATH: Engine v0.6.0 unified storage under ~/.amplifier-agent/, with
  // host config living at ~/.amplifier-agent/config/host_config.json. The
  // bind mount surfaces $DATA_DIR/amplifier-agent/<id>/ as the container's
  // ~/.amplifier-agent/, so we write the file at <hostPath>/config/
  // host_config.json. NO new mount needed. NO credentials in this file --
  // the engine's host_config schema doesn't accept them; provider keys
  // stay in env (above).
  //
  // PROVIDER SELECTION (v0.6.0): The `--provider` CLI flag and the
  // wrapper's `providerOverride` field were both removed (PR #49). Provider
  // selection now lives EXCLUSIVELY in host_config.provider.module -- this
  // file is the single source of truth, not a fallback. `provider.config`
  // is the seam for model/effort/temperature tuning; the engine forwards
  // it verbatim into the provider module's mount plan.
  if (effectiveInternalProvider) {
    // Forward container.json's model / effort fields into the engine via
    // host_config.provider.config. The engine's single_turn.py reads this
    // dict and folds it into the provider module's mount-plan config
    // (key names are `default_model` and `effort` -- see amplifier-agent
    // src/amplifier_agent_cli/provider_sources.py:build_provider_entry).
    // Provider modules then decide what to do with each key; an unknown
    // key is silently ignored at the module level.
    //
    // `parsedModel.model` is the model name WITH any `<provider>:` prefix
    // already stripped (see parseModel above). If --model was bare, this
    // is the raw user input; if it had a prefix, the prefix has been
    // promoted into `effectiveInternalProvider` and is not duplicated
    // into `default_model`.
    //
    // We only include keys that are actually set so the file stays minimal
    // (provider modules fall back to their own catalog defaults otherwise).
    const providerConfig: Record<string, string> = {};
    if (parsedModel.model) providerConfig.default_model = parsedModel.model;
    if (ctx.effort) providerConfig.effort = ctx.effort;

    const hostConfig = {
      provider: {
        module: effectiveInternalProvider,
        ...(Object.keys(providerConfig).length > 0 ? { config: providerConfig } : {}),
      },
      approval: { mode: 'yes' as const },
      allowProtocolSkew: false,
    };
    const configDir = path.join(hostPath, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'host_config.json'), JSON.stringify(hostConfig, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o644,
    });
  }

  let skipOneCliGateway = false;

  // Pass through all provider credentials to the container.
  // OpenAI / Azure OpenAI use standard `Authorization: Bearer` headers, which
  // OneCLI rewrites cleanly, so they go through the gateway like everything
  // else. Only the Anthropic direct-key path bypasses OneCLI (see below).
  if (dotenv.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = dotenv.OPENAI_API_KEY;
  }
  if (dotenv.AZURE_OPENAI_API_KEY) {
    env.AZURE_OPENAI_API_KEY = dotenv.AZURE_OPENAI_API_KEY;
  }
  if (dotenv.AZURE_OPENAI_ENDPOINT) {
    env.AZURE_OPENAI_ENDPOINT = dotenv.AZURE_OPENAI_ENDPOINT;
  }
  if (dotenv.AZURE_OPENAI_API_VERSION) {
    env.AZURE_OPENAI_API_VERSION = dotenv.AZURE_OPENAI_API_VERSION;
  }
  if (dotenv.OLLAMA_BASE_URL) {
    env.OLLAMA_BASE_URL = dotenv.OLLAMA_BASE_URL;
  }

  if (dotenv.ANTHROPIC_BASE_URL) {
    // OneCLI proxy mode (production / clean integration).
    // OneCLI rewrites Authorization Bearer header on outbound calls.
    // Currently incomplete end-to-end due to upstream AUTH_TOKEN gap; see file header.
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  } else if (dotenv.ANTHROPIC_API_KEY) {
    // Direct-key dogfood mode. Real key into container; OneCLI bypassed.
    env.ANTHROPIC_API_KEY = dotenv.ANTHROPIC_API_KEY;
    skipOneCliGateway = true;
  }

  return {
    env,
    skipOneCliGateway,
    mounts: [
      {
        hostPath,
        containerPath: '/home/node/.amplifier-agent',
        readonly: false,
      },
    ],
  };
}

registerProviderContainerConfig('amplifier-agent', buildAmplifierAgentContainerConfig);
