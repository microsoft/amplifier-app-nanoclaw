/**
 * event-translator.ts — Pure function helper for the amplifier-agent NC provider.
 *
 * Translates one `DisplayEvent` from the amplifier-agent wire (see design
 * `docs/designs/2026-05-20-aaa-v2-wrapper-and-wire.md` §6.1) into zero or more
 * `ProviderEvent`s consumed by NC's poll-loop.
 *
 * Stateless. The caller (provider adapter) is responsible for enforcing
 * invariant SC-1: `{ type: 'init' }` MUST be yielded before any `{ type: 'activity' }`.
 *
 * Design ref: `docs/designs/2026-05-22-aaa-v2-amplifier-agent-nc-provider.md` §4.2.
 */

import type { ProviderEvent } from '../types.js';

// ---------------------------------------------------------------------------
// DisplayEvent (wire input)
//
// Inlined here for v1. When `amplifier-agent-client-ts` ships a public type
// surface for `DisplayEvent`, this should be replaced with an import from
// that package. Keep the shape in sync with the wire spec.
// ---------------------------------------------------------------------------

export type DisplayEvent =
  | { type: 'message'; text: string }
  | { type: 'result'; text: string }
  | { type: 'tool_use'; name?: string; input?: unknown; [key: string]: unknown }
  | {
      type: 'tool_result';
      toolUseId?: string;
      content?: unknown;
      [key: string]: unknown;
    }
  | { type: 'progress'; message: string }
  | {
      type: 'subagent_progress';
      subagent?: string;
      message?: string;
      [key: string]: unknown;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      correlationId?: string;
      stderrTail?: string;
      [key: string]: unknown;
    }
  // Forward-compatibility catch-all for unknown future wire event types.
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// TranslateCtx — caller-supplied context.
// ---------------------------------------------------------------------------

export interface TranslateCtx {
  /**
   * True iff NC supplied at least one MCP server to the engine for this
   * session. Used by CR-3 stderrTail redaction.
   */
  mcpServersProvided: boolean;
  /** Wire-level session id (echo from `agent/initialize`). */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Error classification table (design §4.2).
//
// A rule key ending in `_` is treated as a prefix match (e.g. `transport_`
// matches `transport_framing_error`). Otherwise the key is exact-matched.
// ---------------------------------------------------------------------------

export type ErrorClassification =
  | 'engine'
  | 'transport'
  | 'protocol'
  | 'approval'
  | 'unknown';

export interface ClassifiedError {
  classification: ErrorClassification;
  retryable: boolean;
}

const ERROR_RULES: ReadonlyArray<readonly [string, ClassifiedError]> = [
  // engine, retryable
  ['engine_not_primed', { classification: 'engine', retryable: true }],

  // transport, retryable
  ['spawn_failed', { classification: 'transport', retryable: true }],
  ['stdio_closed', { classification: 'transport', retryable: true }],
  ['transport_', { classification: 'transport', retryable: true }], // prefix

  // protocol, non-retryable
  ['protocol_mismatch', { classification: 'protocol', retryable: false }],
  ['unsupported_method', { classification: 'protocol', retryable: false }],
  ['schema_violation', { classification: 'protocol', retryable: false }],
  ['wire_protocol_violation', { classification: 'protocol', retryable: false }],

  // approval, non-retryable
  ['approval_translation_failed', { classification: 'approval', retryable: false }],
  ['approval_timeout', { classification: 'approval', retryable: false }],
  ['approval_protocol_violation', { classification: 'approval', retryable: false }],

  // engine, non-retryable
  ['engine_crashed', { classification: 'engine', retryable: false }],
  ['bundle_failed', { classification: 'engine', retryable: false }],
  ['module_failed', { classification: 'engine', retryable: false }],
  ['bundle_load_failed', { classification: 'engine', retryable: false }],
];

const UNKNOWN_ERROR: ClassifiedError = {
  classification: 'unknown',
  retryable: false,
};

/**
 * Classify an `AaaError.code` against the rules table.
 *
 * Returns `{classification: 'unknown', retryable: false}` if no rule matches.
 */
export function classifyError(code: string): ClassifiedError {
  for (const [key, rule] of ERROR_RULES) {
    if (key.endsWith('_')) {
      if (code.startsWith(key)) return rule;
    } else if (code === key) {
      return rule;
    }
  }
  return UNKNOWN_ERROR;
}

// ---------------------------------------------------------------------------
// translateError — builds a ProviderEvent { type: 'error', ... }
//
// Applies CR-3 stderrTail redaction: when MCP servers were supplied for this
// session, any non-nullish `stderrTail` is replaced with the literal string
// `'[REDACTED]'`. When `stderrTail` is absent from the input it is omitted
// from the output entirely.
// ---------------------------------------------------------------------------

interface ErrorProviderEvent {
  type: 'error';
  message: string;
  retryable: boolean;
  classification: ErrorClassification;
  correlationId?: string;
  stderrTail?: string;
}

function translateError(
  ev: Extract<DisplayEvent, { type: 'error' }>,
  ctx: TranslateCtx,
): ErrorProviderEvent {
  const { classification, retryable } = classifyError(ev.code);

  // CR-3: redact stderrTail if and only if it is present AND mcpServersProvided.
  // If absent, omit the field from the emitted event entirely.
  const stderrTail =
    ev.stderrTail != null
      ? ctx.mcpServersProvided
        ? '[REDACTED]'
        : ev.stderrTail
      : undefined;

  const out: ErrorProviderEvent = {
    type: 'error',
    message: ev.message,
    retryable,
    classification,
  };

  if (ev.correlationId !== undefined) {
    out.correlationId = ev.correlationId;
  }
  if (stderrTail !== undefined) {
    out.stderrTail = stderrTail;
  }

  return out;
}

// ---------------------------------------------------------------------------
// translate — main entry point.
//
// SC-1 invariant: callers MUST yield `{ type: 'init' }` before any
// `{ type: 'activity' }`. The translator is stateless; the init-emit gate
// lives in the caller (§4.1.4 of the design).
// ---------------------------------------------------------------------------

export function translate(ev: DisplayEvent, ctx: TranslateCtx): ProviderEvent[] {
  switch (ev.type) {
    case 'message':
    case 'result':
      return [
        { type: 'activity' },
        { type: 'result', text: (ev as { text: string }).text },
      ];
    case 'tool_use':
    case 'tool_result':
      return [{ type: 'activity' }];
    case 'progress':
      return [
        {
          type: 'progress',
          message: (ev as { message: string }).message,
        },
      ];
    case 'subagent_progress':
      // SC-5: sub-agent progress collapsed to activity in v1. Surfacing
      // deferred to v1.x (D-v1.x-09).
      return [{ type: 'activity' }];
    case 'error':
      return [translateError(ev as Extract<DisplayEvent, { type: 'error' }>, ctx)];
    default:
      // Forward-compatibility: unknown future event types still keep the
      // NC poll-loop's idle timer honest via an activity tick.
      return [{ type: 'activity' }];
  }
}
