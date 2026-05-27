/**
 * mcp-translator.ts — pure function helper.
 *
 * Validates and normalises NC's McpServerConfig map into the wire format
 * expected by SpawnAgentParams.mcpServers (amplifier-agent-client-ts@0.2.0).
 *
 * NC's McpServerConfig.transport is optional (defaults to 'stdio').
 * The wire requires transport as a discriminant field.
 * This function validates the value and fills in the default.
 *
 * Identity passthrough for all other fields.
 *
 * Design reference: §4.3 of 2026-05-22-aaa-v2-amplifier-agent-nc-provider.md
 */

import type { McpServerConfig as NcMcpServerConfig } from '../types.js';

/**
 * Wire-level McpServerConfig shape.
 * Mirrors SpawnAgentParams.mcpServers from amplifier-agent-client-ts@0.2.0.
 * Defined inline so this module compiles before the package is installed.
 * When the package is available, use: import type { McpServerConfig } from 'amplifier-agent-client-ts'
 */
export interface WireMcpServerConfig {
  transport: 'stdio' | 'sse' | 'streamable_http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const VALID_TRANSPORTS = new Set<string>(['stdio', 'sse', 'streamable_http']);

/**
 * Translate NC MCP server configs to wire format.
 * Returns undefined when input is undefined (no MCP configured).
 * Throws synchronously with a descriptive message on invalid transport.
 */
export function translateMcp(
  input: Record<string, NcMcpServerConfig> | undefined,
): Record<string, WireMcpServerConfig> | undefined {
  if (!input) return undefined;

  const result: Record<string, WireMcpServerConfig> = {};

  for (const [name, cfg] of Object.entries(input)) {
    const transport = (cfg.transport ?? 'stdio') as string;
    if (!VALID_TRANSPORTS.has(transport)) {
      throw new Error(
        `mcp-translator: server '${name}' has unknown transport '${transport}'. ` +
          `Valid: ${[...VALID_TRANSPORTS].join(', ')}`,
      );
    }
    result[name] = {
      transport: transport as WireMcpServerConfig['transport'],
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      ...(cfg.url != null ? { url: cfg.url } : {}),
      ...(cfg.headers != null ? { headers: cfg.headers } : {}),
    };
  }

  return result;
}
