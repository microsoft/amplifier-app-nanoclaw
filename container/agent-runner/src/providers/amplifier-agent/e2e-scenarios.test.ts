/**
 * Task 14 (N6) acceptance — deterministic unit tests for the B1 chain
 * (Scenario A) and the buffer-overflow turn-boundary signal (Scenario B).
 *
 * The Task 14 plan itself is a live integration runbook (Docker + NC + a
 * published amplifier-agent v0.2.0). These tests do NOT replace that runbook,
 * but they DO exercise the exact code paths the runbook would observe in a
 * live container, so the underlying mechanism (B1 chaining and overflow
 * accounting) is regression-protected on every test run.
 *
 * Acceptance gate (N6, from the Phase 3 plan):
 *   A) Steering: second message processed as a new turn within the same session
 *   B) Transcript: JSONL file has entries from both turns
 *   C) Overflow: either verified in live test OR confirmed via the exported
 *      constant (256) — see buffer.test.ts for the constant check.
 *
 * What these tests prove (Scenario A):
 *   - The provider drives two `handle.submit(...)` calls when a push() arrives
 *     during the first turn, with the SAME sessionId on both calls and
 *     `resume:true` on the second (==> same continuation, second turn = a
 *     resumed session — "no new continuation issued").
 *   - The buffered push becomes the prompt of the second turn (==> the user's
 *     "Only include files larger than 2KB." steering message reaches the
 *     agent as a real turn, which is what produces the second
 *     `transcript.jsonl` line in the live runbook).
 *   - The `{type:'init', continuation}` event is emitted exactly once across
 *     both turns.
 *
 * What these tests prove (Scenario B):
 *   - When >256 pushes land during a single turn, the turn boundary emits
 *     `{type:'progress', message:'buffer overflow: N messages dropped'}`
 *     with N>0.
 *   - `AMPLIFIER_AGENT_BUFFER_CAP === 256` (the documented fallback path).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Types mirroring the provider's expected wire shape.
// ---------------------------------------------------------------------------

type DisplayEvent =
  | { type: 'message'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown }
  | { type: 'progress'; message: string }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// Shared mutable state used by the mocked `spawnAgent`. Reset in beforeEach.
// ---------------------------------------------------------------------------

interface SpawnCall {
  sessionId: string;
  resume: boolean;
  capabilities: unknown;
}

let spawnAgentCalls: SpawnCall[] = [];
let submitPrompts: string[] = [];
let scriptedTurns: DisplayEvent[][] = [];
const turnIndex = { i: 0 };
// Hook invoked between turns so a test can push() or abort() during the
// B1 chain transition.
let onTurnEnd: undefined | (() => Promise<void> | void) = undefined;

class FakeAaaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mock the wire client BEFORE importing the provider.
// ---------------------------------------------------------------------------

mock.module('amplifier-agent-client-ts', () => ({
  AaaError: FakeAaaError,
  spawnAgent: async (args: {
    sessionId: string;
    resume: boolean;
    host?: { capabilities?: unknown };
  }) => {
    spawnAgentCalls.push({
      sessionId: args.sessionId,
      resume: args.resume,
      capabilities: args.host?.capabilities,
    });
    return {
      submit(prompt: string): AsyncIterable<DisplayEvent> {
        submitPrompts.push(prompt);
        const turn = turnIndex.i;
        const events = scriptedTurns[turn] ?? [];
        return {
          [Symbol.asyncIterator]() {
            let idx = 0;
            return {
              async next(): Promise<IteratorResult<DisplayEvent>> {
                if (idx < events.length) {
                  return { value: events[idx++]!, done: false };
                }
                // End-of-turn hook fires BEFORE the loop rolls forward —
                // lets tests inject pushes/aborts that the provider sees
                // as it decides whether to chain a second turn.
                if (onTurnEnd) await onTurnEnd();
                turnIndex.i += 1;
                return { value: undefined as unknown as DisplayEvent, done: true };
              },
            };
          },
        };
      },
      async cancel() {
        /* no-op */
      },
    };
  },
}));

// IMPORTANT: import AFTER mock.module().
const { AmplifierAgentProvider, AMPLIFIER_AGENT_BUFFER_CAP } = await import(
  '../amplifier-agent.js'
);

type AnyEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'progress'; message: string }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'activity' };

async function drain(iter: AsyncIterable<AnyEvent>, max = 10_000): Promise<AnyEvent[]> {
  const out: AnyEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario A — B1 chain steering during a long turn.
// ---------------------------------------------------------------------------

describe('Task 14 / N6 — Scenario A: B1 chain steering during a long turn', () => {
  beforeEach(() => {
    spawnAgentCalls = [];
    submitPrompts = [];
    scriptedTurns = [];
    turnIndex.i = 0;
    onTurnEnd = undefined;
  });

  it('processes a follow-up push as a SECOND turn on the SAME session (resume:true)', async () => {
    scriptedTurns = [
      [{ type: 'message', text: 'first result' }],
      [{ type: 'message', text: 'second result' }],
    ];

    const provider = new AmplifierAgentProvider();
    const query = provider.query({
      prompt: 'Read all TypeScript files in /app/src/ and summarize their exports.',
      cwd: '/app',
    });

    // Inject the steering push exactly between turn 1 and turn 2.
    onTurnEnd = () => {
      if (turnIndex.i === 0) {
        query.push('Only include files larger than 2KB.');
      }
    };

    const events = await drain(query.events);

    // Two real turns, same session, second turn resumed.
    expect(spawnAgentCalls.length).toBe(2);
    expect(spawnAgentCalls[0]!.resume).toBe(false);
    expect(spawnAgentCalls[0]!.sessionId).toMatch(/^nc_/);
    expect(spawnAgentCalls[1]!.resume).toBe(true);
    expect(spawnAgentCalls[1]!.sessionId).toBe(spawnAgentCalls[0]!.sessionId);

    // Two `result` events on the same continuation.
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBe(2);
    expect((resultEvents[0] as { text: string }).text).toBe('first result');
    expect((resultEvents[1] as { text: string }).text).toBe('second result');

    // Exactly one `init` event across both turns (no new continuation).
    const initEvents = events.filter((e) => e.type === 'init');
    expect(initEvents.length).toBe(1);
    expect((initEvents[0] as { continuation: string }).continuation).toBe(
      spawnAgentCalls[0]!.sessionId,
    );

    // NC host capabilities: supports_steering must be false (D12).
    expect(spawnAgentCalls[0]!.capabilities).toMatchObject({
      supports_steering: false,
      supports_structured_errors: true,
    });
  });

  it('does NOT chain a second turn when no push arrives during the first', async () => {
    scriptedTurns = [[{ type: 'message', text: 'only result' }]];

    const provider = new AmplifierAgentProvider();
    const query = provider.query({ prompt: 'hello', cwd: '/app' });
    const events = await drain(query.events);

    expect(spawnAgentCalls.length).toBe(1);
    expect(events.filter((e) => e.type === 'result').length).toBe(1);
    expect(events.filter((e) => e.type === 'init').length).toBe(1);
  });

  it("joins multiple buffered pushes with '\\n\\n' as the second-turn prompt", async () => {
    scriptedTurns = [
      [{ type: 'message', text: 'r1' }],
      [{ type: 'message', text: 'r2' }],
    ];

    const provider = new AmplifierAgentProvider();
    const query = provider.query({ prompt: 'INITIAL', cwd: '/app' });
    onTurnEnd = () => {
      if (turnIndex.i === 0) {
        query.push('Only include files larger than 2KB.');
        query.push('Also skip generated files.');
      }
    };
    await drain(query.events);

    expect(submitPrompts.length).toBe(2);
    expect(submitPrompts[0]).toBe('INITIAL');
    expect(submitPrompts[1]).toBe(
      'Only include files larger than 2KB.\n\nAlso skip generated files.',
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario B — buffer overflow signal.
// ---------------------------------------------------------------------------

describe('Task 14 / N6 — Scenario B: buffer overflow signal (cap=256)', () => {
  beforeEach(() => {
    spawnAgentCalls = [];
    submitPrompts = [];
    scriptedTurns = [];
    turnIndex.i = 0;
    onTurnEnd = undefined;
  });

  it('emits {type:"progress", message:"buffer overflow: N messages dropped"} with N>0 at turn boundary', async () => {
    // One turn — pile 257 messages into the buffer BEFORE the turn ends.
    scriptedTurns = [[{ type: 'message', text: 'done' }]];

    const provider = new AmplifierAgentProvider();
    const query = provider.query({ prompt: 'long-running task', cwd: '/app' });

    // Push before iterating so the buffer fills before the turn boundary.
    const totalPushes = AMPLIFIER_AGENT_BUFFER_CAP + 1; // 257
    for (let i = 0; i < totalPushes; i++) {
      query.push(`msg-${i}`);
    }
    const expectedDropped = totalPushes - AMPLIFIER_AGENT_BUFFER_CAP;
    expect(expectedDropped).toBeGreaterThan(0);

    // After turn 1, the provider should emit the overflow progress event
    // (256 messages remain buffered, so it will chain a turn-2 — abort once
    // we see the progress to keep the test bounded).
    let progressEvent: { type: 'progress'; message: string } | undefined;
    let resultCount = 0;
    const iter = query.events[Symbol.asyncIterator]();
    for (let i = 0; i < 5000; i++) {
      const { value, done } = await iter.next();
      if (done) break;
      const ev = value as AnyEvent;
      if (ev.type === 'result') resultCount += 1;
      if (ev.type === 'progress') {
        progressEvent = ev;
        query.abort();
        break;
      }
    }
    // Drain remaining events post-abort (bounded).
    try {
      for (let i = 0; i < 100; i++) {
        const { done } = await iter.next();
        if (done) break;
      }
    } catch {
      /* aborted iteration */
    }

    expect(resultCount).toBe(1);
    expect(progressEvent).toBeDefined();
    const match = progressEvent!.message.match(/^buffer overflow: (\d+) messages dropped$/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(expectedDropped);
  });

  it('exports AMPLIFIER_AGENT_BUFFER_CAP === 256 (Scenario B documented fallback path)', () => {
    expect(AMPLIFIER_AGENT_BUFFER_CAP).toBe(256);
  });
});
