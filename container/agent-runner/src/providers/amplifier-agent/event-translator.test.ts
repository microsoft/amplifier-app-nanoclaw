import { describe, it, expect } from 'bun:test';
import { translate, classifyError } from './event-translator.js';
import type { DisplayEvent, TranslateCtx } from './event-translator.js';

const NO_MCP: TranslateCtx = { mcpServersProvided: false, sessionId: 's_test' };
const WITH_MCP: TranslateCtx = { mcpServersProvided: true, sessionId: 's_test' };

describe('translate', () => {
  describe('known event types', () => {
    it('(a) message → [activity, result] with text', () => {
      const ev: DisplayEvent = { type: 'message', text: 'Hello from agent' };
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([
        { type: 'activity' },
        { type: 'result', text: 'Hello from agent' },
      ]);
    });

    it('(b) tool_use → [activity]', () => {
      const ev: DisplayEvent = { type: 'tool_use', name: 'Read', input: { path: '/x' } };
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([{ type: 'activity' }]);
    });

    it('(c) tool_result → [activity]', () => {
      const ev: DisplayEvent = { type: 'tool_result', toolUseId: 'tu_1', content: 'ok' };
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([{ type: 'activity' }]);
    });

    it('(d) progress → forwards message as-is', () => {
      const ev: DisplayEvent = { type: 'progress', message: 'thinking…' };
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([{ type: 'progress', message: 'thinking…' }]);
    });

    it('(e) subagent_progress → [activity] (SC-5 deferral)', () => {
      const ev: DisplayEvent = { type: 'subagent_progress', subagent: 'planner', message: 'starting' };
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([{ type: 'activity' }]);
    });

    it('(f) unknown future event type → [activity] (forward-compat catch-all)', () => {
      const ev = { type: 'future_event_xyz', payload: 42 } as unknown as DisplayEvent;
      const out = translate(ev, NO_MCP);
      expect(out).toEqual([{ type: 'activity' }]);
    });
  });

  describe('(g) error classification table', () => {
    it('engine_not_primed → engine, retryable: true', () => {
      const out = translate({ type: 'error', code: 'engine_not_primed', message: 'not primed' }, NO_MCP);
      expect(out.length).toBe(1);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'engine', retryable: true });
    });

    it('spawn_failed → transport, retryable: true', () => {
      const out = translate({ type: 'error', code: 'spawn_failed', message: 'no binary' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'transport', retryable: true });
    });

    it('stdio_closed → transport, retryable: true', () => {
      const out = translate({ type: 'error', code: 'stdio_closed', message: 'pipe gone' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'transport', retryable: true });
    });

    it('transport_* (prefix) → transport, retryable: true', () => {
      const out = translate(
        { type: 'error', code: 'transport_framing_error', message: 'bad frame' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'transport', retryable: true });
    });

    it('protocol_mismatch → protocol, retryable: false', () => {
      const out = translate({ type: 'error', code: 'protocol_mismatch', message: 'v skew' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'protocol', retryable: false });
    });

    it('unsupported_method → protocol, retryable: false', () => {
      const out = translate({ type: 'error', code: 'unsupported_method', message: 'no such' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'protocol', retryable: false });
    });

    it('schema_violation → protocol, retryable: false', () => {
      const out = translate({ type: 'error', code: 'schema_violation', message: 'bad shape' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'protocol', retryable: false });
    });

    it('wire_protocol_violation → protocol, retryable: false', () => {
      const out = translate(
        { type: 'error', code: 'wire_protocol_violation', message: 'wire' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'protocol', retryable: false });
    });

    it('approval_translation_failed → approval, retryable: false', () => {
      const out = translate(
        { type: 'error', code: 'approval_translation_failed', message: 'bad' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'approval', retryable: false });
    });

    it('approval_timeout → approval, retryable: false', () => {
      const out = translate({ type: 'error', code: 'approval_timeout', message: 't' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'approval', retryable: false });
    });

    it('approval_protocol_violation → approval, retryable: false', () => {
      const out = translate(
        { type: 'error', code: 'approval_protocol_violation', message: 'v' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'approval', retryable: false });
    });

    it('engine_crashed → engine, retryable: false', () => {
      const out = translate({ type: 'error', code: 'engine_crashed', message: 'crashed' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'engine', retryable: false });
    });

    it('bundle_failed → engine, retryable: false', () => {
      const out = translate({ type: 'error', code: 'bundle_failed', message: 'bf' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'engine', retryable: false });
    });

    it('module_failed → engine, retryable: false', () => {
      const out = translate({ type: 'error', code: 'module_failed', message: 'mf' }, NO_MCP);
      expect(out[0]).toMatchObject({ type: 'error', classification: 'engine', retryable: false });
    });

    it('bundle_load_failed → engine, retryable: false', () => {
      const out = translate(
        { type: 'error', code: 'bundle_load_failed', message: 'load' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'engine', retryable: false });
    });

    it('unknown code → unknown, retryable: false', () => {
      const out = translate(
        { type: 'error', code: 'mystery_meat_error', message: 'm' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ type: 'error', classification: 'unknown', retryable: false });
    });

    it('classifyError directly returns rule for known code', () => {
      expect(classifyError('engine_not_primed')).toEqual({
        classification: 'engine',
        retryable: true,
      });
    });

    it('classifyError directly returns unknown for unknown code', () => {
      expect(classifyError('totally_made_up')).toEqual({
        classification: 'unknown',
        retryable: false,
      });
    });

    it('error event forwards message text', () => {
      const out = translate(
        { type: 'error', code: 'engine_crashed', message: 'segfault at line 42' },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ message: 'segfault at line 42' });
    });

    it('error event forwards correlationId when present', () => {
      const out = translate(
        {
          type: 'error',
          code: 'engine_crashed',
          message: 'x',
          correlationId: 'corr-1',
        },
        NO_MCP,
      );
      expect(out[0]).toMatchObject({ correlationId: 'corr-1' });
    });

    it('error event omits correlationId when absent', () => {
      const out = translate({ type: 'error', code: 'engine_crashed', message: 'x' }, NO_MCP);
      expect((out[0] as { correlationId?: string }).correlationId).toBeUndefined();
    });
  });

  describe('(h) CR-3 stderrTail redaction', () => {
    it('preserves stderrTail when mcpServersProvided: false', () => {
      const out = translate(
        {
          type: 'error',
          code: 'engine_crashed',
          message: 'crash',
          stderrTail: 'Traceback: API_KEY=sk-secret-leak',
        },
        NO_MCP,
      );
      expect((out[0] as { stderrTail?: string }).stderrTail).toBe(
        'Traceback: API_KEY=sk-secret-leak',
      );
    });

    it('replaces stderrTail with "[REDACTED]" when mcpServersProvided: true', () => {
      const out = translate(
        {
          type: 'error',
          code: 'engine_crashed',
          message: 'crash',
          stderrTail: 'Traceback: API_KEY=sk-secret-leak',
        },
        WITH_MCP,
      );
      expect((out[0] as { stderrTail?: string }).stderrTail).toBe('[REDACTED]');
    });

    it('omits stderrTail entirely when absent (NO_MCP)', () => {
      const out = translate(
        { type: 'error', code: 'engine_crashed', message: 'crash' },
        NO_MCP,
      );
      expect('stderrTail' in (out[0] as object)).toBe(false);
    });

    it('omits stderrTail entirely when absent (WITH_MCP)', () => {
      const out = translate(
        { type: 'error', code: 'engine_crashed', message: 'crash' },
        WITH_MCP,
      );
      expect('stderrTail' in (out[0] as object)).toBe(false);
    });
  });
});
