import { describe, it, expect } from 'bun:test';
import { translateMcp } from './mcp-translator.js';

describe('translateMcp', () => {
  it('returns undefined when input is undefined', () => {
    expect(translateMcp(undefined)).toBeUndefined();
  });

  it('passes through empty object (no servers to validate)', () => {
    const result = translateMcp({});
    expect(result).toBeDefined();
    expect(Object.keys(result!).length).toBe(0);
  });

  it('defaults missing transport to "stdio"', () => {
    const result = translateMcp({
      'my-server': { command: 'bun', args: ['server.ts'], env: {} },
    });
    expect(result!['my-server'].transport).toBe('stdio');
  });

  it('preserves an explicit stdio transport', () => {
    const result = translateMcp({
      'nc-mcp': { command: 'npx', args: ['-y', 'my-mcp'], env: { KEY: 'val' }, transport: 'stdio' },
    });
    expect(result!['nc-mcp'].transport).toBe('stdio');
    expect(result!['nc-mcp'].command).toBe('npx');
    expect(result!['nc-mcp'].env).toEqual({ KEY: 'val' });
  });

  it('preserves sse transport with url and headers', () => {
    const result = translateMcp({
      'sse-srv': {
        command: '',
        args: [],
        env: {},
        transport: 'sse',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer tok' },
      },
    });
    expect(result!['sse-srv'].transport).toBe('sse');
    expect(result!['sse-srv'].url).toBe('https://example.com/mcp');
    expect(result!['sse-srv'].headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('throws with the server name when transport is unknown', () => {
    expect(() =>
      translateMcp({
        'my-bad-server': {
          command: 'x',
          args: [],
          env: {},
          transport: 'grpc' as unknown as 'stdio',
        },
      }),
    ).toThrow(/my-bad-server.*unknown transport 'grpc'/);
  });
});
