import { describe, expect, it } from 'vitest';

import { resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config and agent group', () => {
    expect(resolveProviderName('codex', 'claude', 'amplifier-agent')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode', 'amplifier-agent')).toBe('opencode');
  });

  it('falls back to agent group when session and container config are null', () => {
    expect(resolveProviderName(null, null, 'amplifier-agent')).toBe('amplifier-agent');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined, null)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude', null)).toBe('claude');
    expect(resolveProviderName(null, null, 'AMPLIFIER-AGENT')).toBe('amplifier-agent');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode', null)).toBe('opencode');
    expect(resolveProviderName(null, '', 'amplifier-agent')).toBe('amplifier-agent');
    expect(resolveProviderName(null, '', '')).toBe('claude');
  });
});
