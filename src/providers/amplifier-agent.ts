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
 * at /home/node/.local/state/amplifier-agent/ so transcripts survive
 * container restarts.
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

  // Pass the internal provider selection to the container so it knows which
  // provider (openai, anthropic, etc.) to use with amplifier-agent. Read from
  // the .env file -- the service process does not load .env into process.env
  // (see src/env.ts header comment), so process.env is empty here.
  const internalProvider = dotenv.AMPLIFIER_AGENT_INTERNAL_PROVIDER;
  if (internalProvider) {
    env.AMPLIFIER_AGENT_INTERNAL_PROVIDER = internalProvider;
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
        containerPath: '/home/node/.local/state/amplifier-agent',
        readonly: false,
      },
    ],
  };
}

registerProviderContainerConfig('amplifier-agent', buildAmplifierAgentContainerConfig);
