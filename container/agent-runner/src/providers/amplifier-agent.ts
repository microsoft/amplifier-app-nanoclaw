/**
 * amplifier-agent.ts — NC provider adapter for the amplifier-agent engine.
 *
 * Wraps `amplifier-agent-ts` (the v0.2.0 wire wrapper) and exposes it
 * via NC's AgentProvider/AgentQuery contract.
 *
 * Key invariants:
 *   - SC-1: `{type: 'init'}` MUST be yielded before the first `{type:'activity'}`.
 *   - CR-4: B1 buffer cap is 256 messages; overflow drops are visible at turn
 *     boundary via a `progress` event.
 *   - D12: NC uses B1 buffer chaining, not wire-level steering. Host
 *     capabilities advertise `supports_steering: false`.
 *   - Q10: engine_not_primed triggers a lazy `amplifier-agent prepare` then
 *     retries spawn (one retry per turn).
 *
 * Design ref: docs/designs/2026-05-22-aaa-v2-amplifier-agent-nc-provider.md
 */

import { execSync } from 'child_process';

import { spawnAgent, AaaError, type SessionHandle } from 'amplifier-agent-ts';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';
import { translate, type DisplayEvent, type TranslateCtx } from './amplifier-agent/event-translator.js';
import { translateMcp } from './amplifier-agent/mcp-translator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CR-4: B1 buffer cap (raised from 32 to 256). */
export const AMPLIFIER_AGENT_BUFFER_CAP = 256;

/** D12: NC uses B1 buffer chaining, NOT wire-level steering. */
const NC_HOST_CAPABILITIES = {
  supports_steering: false,
  supports_structured_errors: true,
} as const;

/** Stale-session detection. AaaError codes OR plain-text fallback. */
const STALE_SESSION_RE = /session_not_found|stale_session|invalid_session|session.*not found/i;

const STALE_SESSION_CODES = new Set(['session_not_found', 'stale_session', 'invalid_session']);

/** Ticker interval (§4.1.4). */
const TICKER_INTERVAL_MS = 2000;

/** Approval auto-allow timeout (A10). */
const APPROVAL_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  console.error(`[amplifier-agent-provider] ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `amplifier-agent prepare` synchronously (Q10 lazy-prepare fallback). */
function runPrepare(): void {
  try {
    execSync('amplifier-agent prepare', { stdio: 'pipe' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`runPrepare failed: ${msg}`);
    throw err;
  }
}

/** Build a ProviderEvent {type:'error'} from a thrown error. */
function translateError(err: unknown): ProviderEvent {
  // Duck-type so we work with both real AaaError and plain Error.
  const code =
    err instanceof AaaError ? err.code : (err as { code?: unknown })?.code != null ? String((err as { code?: unknown }).code) : 'unknown';
  const message = err instanceof Error ? err.message : String(err);

  // Re-use the event-translator's classification table by routing through a
  // synthetic wire-level error event.
  const classified = translate(
    {
      type: 'error',
      code,
      message,
    } as DisplayEvent,
    { mcpServersProvided: false, sessionId: '' },
  );
  // The translator returns exactly one event for `type: 'error'`.
  return classified[0];
}

/**
 * Activity ticker — pushes a `{type:'activity'}` into the supplied queue every
 * TICKER_INTERVAL_MS until stopped.
 *
 * INVARIANT (SC-1): the caller MUST NOT start the ticker until after the
 * `{type:'init'}` event has been yielded.
 */
function startTicker(push: (ev: ProviderEvent) => void): () => void {
  const handle = setInterval(() => {
    push({ type: 'activity' });
  }, TICKER_INTERVAL_MS);
  return () => clearInterval(handle);
}

// ---------------------------------------------------------------------------
// AmplifierAgentQuery — implements AgentQuery with B1 buffer chaining.
// ---------------------------------------------------------------------------

class AmplifierAgentQuery implements AgentQuery {
  private readonly buffer: string[] = [];
  private overflowDropped = 0;
  private aborted = false;
  private active: SessionHandle | null = null;
  private initEmitted = false;
  private sessionId: string | undefined;
  private readonly mergedMcp: Record<string, McpServerConfig> | undefined;
  private readonly mcpServersProvided: boolean;

  constructor(
    private readonly input: QueryInput,
    ctorMcpServers: Record<string, McpServerConfig> | undefined,
  ) {
    this.sessionId = input.continuation;

    // §4.1.4: merge constructor + per-query MCP, query-level wins on collision.
    const merged: Record<string, McpServerConfig> = {};
    if (ctorMcpServers) {
      for (const [k, v] of Object.entries(ctorMcpServers)) merged[k] = v;
    }
    if (input.mcpServers) {
      for (const [k, v] of Object.entries(input.mcpServers)) merged[k] = v;
    }
    this.mergedMcp = Object.keys(merged).length > 0 ? merged : undefined;
    this.mcpServersProvided = this.mergedMcp !== undefined;
  }

  push(message: string): void {
    if (this.aborted) return;
    if (this.buffer.length >= AMPLIFIER_AGENT_BUFFER_CAP) {
      this.overflowDropped++;
      return;
    }
    this.buffer.push(message);
  }

  end(): void {
    this.aborted = true;
    this.buffer.length = 0;
  }

  abort(): void {
    this.aborted = true;
    // Fire-and-forget cancel; cancel() is async but we don't block here.
    void this.active?.cancel();
    this.buffer.length = 0;
  }

  get events(): AsyncIterable<ProviderEvent> {
    return this.makeEvents();
  }

  private async *makeEvents(): AsyncGenerator<ProviderEvent> {
    const wireMcp = translateMcp(this.mergedMcp);

    let prompt = this.input.prompt;
    let firstTurn = true;

    while (!this.aborted) {
      // Prepend system instructions on the first turn only (not on resume
      // or follow-ups). amplifier-agent-ts doesn't expose a
      // systemPrompt parameter like the Claude SDK does, so we embed the
      // instructions in the initial prompt. The host (NC) builds
      // systemContext.instructions from the per-group CLAUDE.md.
      if (firstTurn && this.input.systemContext?.instructions) {
        prompt = `${this.input.systemContext.instructions}\n\n${prompt}`;
      }
      firstTurn = false;
      // ── Generate or reuse the sessionId for this turn. ──
      // Installed @0.2.0 SessionHandle does not expose `sessionId`; the engine
      // echoes whatever we pass in. We track our own copy here and use it as
      // the continuation identifier (§4.1.4).
      const turnSessionId = this.sessionId ?? `nc_${Date.now()}`;

      // ── Spawn (with one engine_not_primed retry for lazy-prepare). ──
      let handle: SessionHandle;
      let spawnAttempts = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        spawnAttempts++;
        try {
          const internalProvider = process.env.AMPLIFIER_AGENT_INTERNAL_PROVIDER;
          // A10: NC auto-allows all approvals. In v0.3.x Mode A v2, the wire
          // has no mid-turn host channel and the wrapper rejects any
          // approval.onRequest callback (AaaError: approval_not_supported_in_v1).
          // The bundle's hooks-approval mount is the v1 policy point and
          // auto-allows by default, which matches NC's intent — so we omit
          // the approval field entirely. When mid-turn callbacks return in
          // v1.x (WG-4 in amendment §6), wire them back here.
          const spawnConfig: Parameters<typeof spawnAgent>[0] = {
            lifecycle: 'one-shot',
            sessionId: turnSessionId,
            resume: this.sessionId != null,
            cwd: this.input.cwd,
            mcpServers: wireMcp,
            host: { capabilities: NC_HOST_CAPABILITIES },
          };

          // Set provider override and env allowlist based on internal provider.
          // The wrapper's DEFAULT_ALLOWLIST (PATH/HOME/USER/LANG/TERM/TMPDIR) is
          // not exported and gets replaced — not extended — when env.allowlist
          // is set, so we inline those names alongside the credential vars.
          // Without HOME the Python engine throws RuntimeError from Path.home()
          // and exits before emitting a §4.1 envelope.
          if (internalProvider) {
            spawnConfig.providerOverride = internalProvider;
            const credentialsMap: Record<string, string[]> = {
              anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
              openai: ['OPENAI_API_KEY'],
              'azure-openai': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
              ollama: ['OLLAMA_BASE_URL'],
            };
            const credentials = credentialsMap[internalProvider];
            if (credentials) {
              spawnConfig.env = {
                allowlist: ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', ...credentials],
              };
            }
          }

          handle = await spawnAgent(spawnConfig);
          break;
        } catch (err) {
          const code = err instanceof AaaError ? err.code : undefined;
          if (code === 'engine_not_primed' && spawnAttempts === 1) {
            // Q10: lazy-prepare fallback. One retry only.
            try {
              runPrepare();
            } catch (prepErr) {
              yield translateError(prepErr);
              return;
            }
            continue;
          }
          yield translateError(err);
          return;
        }
      }

      this.active = handle;

      // ── SC-1: emit init BEFORE starting the ticker. ──
      if (!this.initEmitted) {
        yield { type: 'init', continuation: turnSessionId };
        this.initEmitted = true;
      }
      this.sessionId = turnSessionId;

      const ctx: TranslateCtx = {
        mcpServersProvided: this.mcpServersProvided,
        sessionId: turnSessionId,
      };

      // ── Ticker queue; drained on each real DisplayEvent. ──
      const tickerQueue: ProviderEvent[] = [];
      const stopTicker = startTicker((ev) => {
        if (this.aborted) return;
        tickerQueue.push(ev);
      });

      try {
        for await (const ev of handle.submit(prompt) as AsyncIterable<DisplayEvent>) {
          if (this.aborted) break;
          // Flush queued activity ticks first.
          while (tickerQueue.length > 0) {
            yield tickerQueue.shift()!;
          }
          // Yield translated events.
          for (const out of translate(ev, ctx)) {
            yield out;
          }
        }
      } catch (err) {
        const errEvent = translateError(err);
        yield errEvent;
        // Signal turn completion even though it ended in error. Without this,
        // the host's stream never sees a `result` event and the turn hangs
        // until the host watchdog kills the container (~2 min, exit 137).
        yield { type: 'result', text: '' };
        stopTicker();
        this.active = null;
        return;
      } finally {
        stopTicker();
        this.active = null;
      }

      // ── CR-4: visible overflow signal at turn boundary. ──
      if (this.overflowDropped > 0) {
        yield {
          type: 'progress',
          message: `buffer overflow: ${this.overflowDropped} messages dropped`,
        };
        this.overflowDropped = 0;
      }

      // ── B1 chain: if buffered messages remain, resume with them. ──
      if (this.buffer.length === 0) return;
      prompt = this.buffer.join('\n\n');
      this.buffer.length = 0;
      // Loop continues with same sessionId + resume:true (via this.sessionId).
    }
  }
}

// ---------------------------------------------------------------------------
// AmplifierAgentProvider — implements AgentProvider.
// ---------------------------------------------------------------------------

export class AmplifierAgentProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, McpServerConfig> | undefined;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers;
  }

  isSessionInvalid(err: unknown): boolean {
    if (err instanceof AaaError && STALE_SESSION_CODES.has(err.code)) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    return new AmplifierAgentQuery(input, this.mcpServers);
  }
}

registerProvider('amplifier-agent', (opts) => new AmplifierAgentProvider(opts));
