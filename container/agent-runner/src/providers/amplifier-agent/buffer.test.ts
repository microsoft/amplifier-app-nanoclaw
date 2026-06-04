/**
 * Buffer cap verification.
 * The full buffer behavior (overflow signal, chain-drain) is verified in the
 * E2E scenarios (Tasks 13-14). This test confirms the exported cap constant.
 */
import { describe, it, expect } from 'bun:test';

describe('AMPLIFIER_AGENT_BUFFER_CAP', () => {
  it('is exported from the provider module and equals 256', async () => {
    // Lazy import avoids module-load failures when spawnAgent is unavailable
    const mod = await import('../amplifier-agent.js');
    expect(mod.AMPLIFIER_AGENT_BUFFER_CAP).toBe(256);
  });
});
