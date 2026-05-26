---
name: add-amplifier-agent
description: Use amplifier-agent (Microsoft's modular agent runtime — bundled providers, swappable orchestrators, MCP tools) as the full agent provider in place of the Claude Agent SDK. Routes through OneCLI's Authorization-header rewrite path so the host never holds raw API keys. Per-group via agent_provider.
---

# amplifier-agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `amplifier-agent` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the amplifier-agent provider files in from the `providers-amplifier-agent` branch, wires them into the host and container barrels, adds the engine to the Dockerfile, and rebuilds the image.

The amplifier-agent provider runs the [`amplifier-agent`](https://github.com/microsoft/amplifier-agent) Python engine as a per-submit subprocess (Mode A v2) and talks to it through `amplifier-agent-client-ts`. The engine ships its own bundle modules (provider-anthropic, tool-mcp, hooks-approval, etc.) which it activates on first use. Today the bundled provider targets Anthropic; future versions are expected to add OpenAI and Azure.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/amplifier-agent.ts`
- `container/agent-runner/src/providers/amplifier-agent.ts`
- `container/agent-runner/src/providers/amplifier-agent/event-translator.ts`
- `container/agent-runner/src/providers/amplifier-agent/mcp-translator.ts`
- `import './amplifier-agent.js';` line in `src/providers/index.ts`
- `import './amplifier-agent.js';` line in `container/agent-runner/src/providers/index.ts`
- `transport?:` field on `McpServerConfig` in `container/agent-runner/src/providers/types.ts`
- `mcpServers?:` field on `QueryInput` in `container/agent-runner/src/providers/types.ts`
- `amplifier-agent-client-ts` in `container/agent-runner/package.json`
- `ARG AMPLIFIER_AGENT_REF` and `uv tool install "amplifier-agent` in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the source branch

```bash
git rev-parse --verify providers-amplifier-agent >/dev/null 2>&1 \
  || git fetch origin providers-amplifier-agent
```

The fallback lets the skill run against a local-only branch (during development) and against a pushed branch (the production path).

### 2. Copy the amplifier-agent source files

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show providers-amplifier-agent:src/providers/amplifier-agent.ts \
  > src/providers/amplifier-agent.ts

mkdir -p container/agent-runner/src/providers/amplifier-agent

git show providers-amplifier-agent:container/agent-runner/src/providers/amplifier-agent.ts \
  > container/agent-runner/src/providers/amplifier-agent.ts

for f in event-translator.ts event-translator.test.ts \
         mcp-translator.ts   mcp-translator.test.ts \
         buffer.test.ts      e2e-scenarios.test.ts; do
  git show "providers-amplifier-agent:container/agent-runner/src/providers/amplifier-agent/$f" \
    > "container/agent-runner/src/providers/amplifier-agent/$f"
done
```

### 3. Append the self-registration imports

Each barrel gets one line. Skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './amplifier-agent.js';
```

`container/agent-runner/src/providers/index.ts`:

```typescript
import './amplifier-agent.js';
```

### 4. Extend the container types

The amplifier-agent translators rely on two optional fields that aren't on trunk's `McpServerConfig` and `QueryInput`. Both are pure additions — Claude/codex/opencode ignore them.

Edit `container/agent-runner/src/providers/types.ts`. Both edits are idempotent — but the guard MUST be scoped to the specific interface, not file-wide. Trunk's `ProviderOptions` interface already declares `mcpServers?:`; a file-wide `grep -q "mcpServers?:"` would falsely report "already present" and silently skip the QueryInput edit. Scope idempotency checks with `awk '/^export interface QueryInput/,/^}/'` (or equivalent).

**(a)** On `interface McpServerConfig`, add three optional fields before the closing brace. Result should look like:

```typescript
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;

  /**
   * Transport type. Defaults to 'stdio' when absent.
   * Added for amplifier-agent wire compatibility.
   * Existing Claude/mock MCP configs that omit this field are treated as stdio.
   */
  transport?: 'stdio' | 'sse' | 'streamable_http';
  /** URL for sse / streamable_http transports. */
  url?: string;
  /** HTTP headers for sse / streamable_http transports. */
  headers?: Record<string, string>;
}
```

**(b)** On `interface QueryInput`, add one optional field at the end of the interface:

```typescript
  /**
   * Per-query MCP server configs. Providers that don't support MCP ignore this.
   * Added for amplifier-agent.
   */
  mcpServers?: Record<string, McpServerConfig>;
```

### 5. Add the TS client dependency

In `container/agent-runner/package.json`, add to `dependencies`:

```json
"amplifier-agent-client-ts": "github:microsoft/amplifier-agent#main"
```

Then refresh the lockfile inside the container-runner workspace:

```bash
cd container/agent-runner && bun install && cd -
```

The dep resolves to the TypeScript wrapper bundled with the `amplifier-agent` monorepo. The wrapper is committed as built `dist/` so no postinstall build is needed.

### 6. Add the amplifier-agent engine to the container Dockerfile

Three edits to `container/Dockerfile`, all idempotent.

**(a)** Near the "Pin tool versions" ARG block (around line 18, alongside `ARG CLAUDE_CODE_VERSION=...`):

```dockerfile
ARG AMPLIFIER_AGENT_REF=main
```

`AMPLIFIER_AGENT_REF` accepts any git ref the upstream repo serves — `main`, a tag, or a SHA. Production deployments should pin to a SHA; development can ride `main`.

**(b)** After the existing per-CLI install blocks (the `@anthropic-ai/claude-code` block, near line 106), add a new `RUN` block to install the amplifier-agent engine via `uv`:

```dockerfile
RUN UV_TOOL_BIN_DIR=/usr/local/bin uv tool install \
    "amplifier-agent @ git+https://github.com/microsoft/amplifier-agent@${AMPLIFIER_AGENT_REF}" && \
    chmod -R a+rX /opt/uv && \
    mkdir -p /opt/uv/cache && \
    chown -R node:node /opt/uv
```

**(c)** After the existing `USER node` switch and `WORKDIR /workspace/group` (near line 162), and BEFORE the existing `tini`/entrypoint block, add the prepare + doctor steps:

```dockerfile
# Prime the bundle cache as the node user so the cache lands in their home.
# Bundle modules (provider-anthropic, tool-mcp, etc.) are cloned from
# github.com/microsoft/* at this step.
RUN amplifier-agent prepare

# Pre-create runtime state dirs and chmod world-writable. NC's container
# runner spawns the container under the host UID (Docker Desktop on macOS
# maps the host UID into the container), which differs from the build-time
# `node` UID. The engine writes to .local/state, .cache, .config, and
# .amplifier/cache regardless of which UID is actually running.
USER root
RUN mkdir -p \
        /home/node/.local/state/amplifier-agent/sessions \
        /home/node/.cache/amplifier-agent \
        /home/node/.config/amplifier-agent \
        /home/node/.local/share/amplifier-agent \
        /home/node/.amplifier/cache && \
    chown -R node:node /home/node/.local /home/node/.cache /home/node/.config /home/node/.amplifier && \
    chmod -R 0777 \
        /home/node/.local \
        /home/node/.cache \
        /home/node/.config \
        /home/node/.amplifier \
        /opt/uv
USER node

# Image-build gate: doctor must pass before the image ships. Validates the
# provider module loads correctly without requiring a real API key.
RUN ANTHROPIC_API_KEY=placeholder amplifier-agent doctor --strict
```

### 7. Build

```bash
pnpm run build                                                    # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit    # container typecheck
./container/build.sh                                              # agent image (~5–10 min cold)
```

## Configuration

amplifier-agent's bundled `provider-anthropic` reads `ANTHROPIC_API_KEY` and sends it as an `x-api-key` header. NanoClaw's OneCLI gateway rewrites the `Authorization` header. The clean integration relies on OneCLI being configured so the placeholder `ANTHROPIC_AUTH_TOKEN` becomes the real bearer on the wire.

```env
# .env — recommended (OneCLI proxy mode)
ANTHROPIC_BASE_URL=http://127.0.0.1:10254     # your OneCLI gateway URL
```

The host-side provider (see `src/providers/amplifier-agent.ts`) sets `ANTHROPIC_AUTH_TOKEN=placeholder` automatically when `ANTHROPIC_BASE_URL` is present. OneCLI replaces it with the real credential at request time. The container never holds a raw API key.

> **Known upstream gap (tracked, not blocking integration):**
> The upstream `amplifier-module-provider-anthropic` reads `ANTHROPIC_API_KEY` and sends `x-api-key`, but does NOT read `ANTHROPIC_AUTH_TOKEN` and therefore does not send `Authorization: Bearer`. Until either (a) upstream supports `auth_token` mode or (b) OneCLI is configured to rewrite the `x-api-key` header, end-to-end auth through this clean path is incomplete. Address separately.

### Per group / per session

Set `agent_provider = 'amplifier-agent'` on the group's row in the DB. The host-side resolver falls back through session → group → `container_configs.provider` → `'claude'`.

```bash
GROUP_ID=ag-xxxxxxxxxx

sqlite3 data/v2.db "UPDATE container_configs
                    SET provider='amplifier-agent',
                        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                    WHERE agent_group_id='$GROUP_ID';"

sqlite3 data/v2.db "UPDATE agent_groups
                    SET agent_provider='amplifier-agent'
                    WHERE id='$GROUP_ID';"

# Stop running containers so the next message spawns fresh on the new provider
docker ps -q --filter "name=nanoclaw-v2" | xargs -r docker stop
```

Verify the switch landed:

```bash
sqlite3 -header data/v2.db "
  SELECT ag.id, ag.name, ag.agent_provider AS host_side,
         cc.provider AS container_side
  FROM agent_groups ag JOIN container_configs cc ON cc.agent_group_id=ag.id
  WHERE ag.id='$GROUP_ID';"
```

## Operational notes

- **Per-submit subprocess (Mode A v2):** the engine is spawned fresh per `submit()`, matching the Codex/OpenCode pattern. No long-lived daemon to keep healthy across sessions. `init` is emitted once per query; `result` carries the final reply.
- **Bundle module lazy install:** on first activation the engine `git clone`s its bundle modules to `/home/node/.amplifier/cache/`. Requires github.com reachability inside the container. First call adds ~10–20s; subsequent calls hit the prepared cache.
- **B1 buffer chaining (not steering):** the host adapter advertises `supports_steering: false`. Mid-turn `push()` calls queue and drain between turns. CR-4 caps the queue at 256 messages; overflow surfaces a `progress` event.
- **Approvals auto-accepted:** Mode A v2 rejects `approval.onRequest` with `AaaError(approval_not_supported_in_v1)`. The host adapter intentionally does not pass the callback. In-container actions are auto-approved (the container is the sandbox). Host-level approvals (channel registration, unknown-sender policy) run in NanoClaw's router before the provider is invoked — they continue to work unchanged.
- **Per-group transcript persistence:** `$DATA_DIR/amplifier-agent/<group-id>/` is bind-mounted at `/home/node/.local/state/amplifier-agent/` so transcripts and session metadata survive container restarts.
- **Q10 lazy-prepare retry:** if the engine reports `engine_not_primed`, the adapter runs `amplifier-agent prepare` synchronously and retries the spawn once.

## Verify

```bash
grep -q "./amplifier-agent.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./amplifier-agent.js" src/providers/index.ts && echo "host barrel: OK"
awk '/^export interface McpServerConfig/,/^}/' container/agent-runner/src/providers/types.ts | grep -q "transport?:" && echo "McpServerConfig.transport: OK"
awk '/^export interface QueryInput/,/^}/' container/agent-runner/src/providers/types.ts | grep -q "mcpServers?:" && echo "QueryInput.mcpServers: OK"
grep -q "amplifier-agent-client-ts" container/agent-runner/package.json && echo "TS wrapper dep: OK"
grep -q "AMPLIFIER_AGENT_REF" container/Dockerfile && echo "Dockerfile ARG: OK"
grep -q "amplifier-agent prepare" container/Dockerfile && echo "Dockerfile prepare: OK"
grep -q "amplifier-agent doctor" container/Dockerfile && echo "Dockerfile doctor: OK"

cd container/agent-runner && bun test src/providers/amplifier-agent/event-translator.test.ts && cd -
cd container/agent-runner && bun test src/providers/amplifier-agent/mcp-translator.test.ts && cd -
```

After image rebuild, set `agent_provider = 'amplifier-agent'` on a test group and send a message. Successful round-trip looks like:

- Container's first log line: `[agent-runner] Starting v2 agent-runner (provider: amplifier-agent)`
- `init` event with a stable session ID
- One or more activity/progress events during the turn
- `result` event with the model's reply, delivered back through the channel

If the engine errors with `provider-anthropic` activation failures, confirm `git clone` from `github.com/microsoft/*` works inside the container. If approval-related errors appear, confirm the host adapter is NOT passing `approval.onRequest` (Mode A v2 contract).
