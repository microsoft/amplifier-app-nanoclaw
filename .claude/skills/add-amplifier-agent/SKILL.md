---
name: add-amplifier-agent
description: Use amplifier-agent (Microsoft's modular agent runtime — bundled providers, swappable orchestrators, MCP tools) as the full agent provider in place of the Claude Agent SDK. Routes through OneCLI's Authorization-header rewrite path so the host never holds raw API keys. Per-group via agent_provider.
---

# amplifier-agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `amplifier-agent` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the amplifier-agent provider files in from the `providers-amplifier-agent` branch, wires them into the host and container barrels, adds the engine to the Dockerfile, and rebuilds the image.

The amplifier-agent provider runs the [`amplifier-agent`](https://github.com/microsoft/amplifier-agent) Python engine as a per-submit subprocess (Mode A v2) and talks to it through `amplifier-agent-ts`. The engine ships its own bundle modules (provider-anthropic, tool-mcp, hooks-approval, etc.) which it activates on first use. Today the bundled provider targets Anthropic; future versions are expected to add OpenAI and Azure.

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
- `amplifier-agent-ts` in `container/agent-runner/package.json`
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
"amplifier-agent-ts": "^0.6.1"
```

Then refresh the lockfile inside the container-runner workspace:

```bash
cd container/agent-runner && bun install && cd -
```

The dep resolves to [`amplifier-agent-ts`](https://www.npmjs.com/package/amplifier-agent-ts) on npm, the TypeScript SDK published from the `amplifier-agent` monorepo via OIDC trusted publishing (provenance attested).

### 6. Add the amplifier-agent engine to the container Dockerfile

Five edits to `container/Dockerfile`, all idempotent.

**(a)** Near the "Pin tool versions" ARG block (around line 18, alongside `ARG CLAUDE_CODE_VERSION=...`):

```dockerfile
ARG AMPLIFIER_AGENT_REF=main
```

`AMPLIFIER_AGENT_REF` accepts any git ref the upstream repo serves — `main`, a tag, or a SHA. Production deployments should pin to a SHA; development can ride `main`.

**(b)** After the Bun installation (around line 72), add UV installation:

```dockerfile
# ---- UV (Python package manager) for amplifier-agent -------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/ && \
    mv /root/.local/bin/uvx /usr/local/bin/ && \
    rm -rf /root/.local/bin
```

**(c)** After the existing per-CLI install blocks (the `@anthropic-ai/claude-code` block, near line 120), add a new `RUN` block to install the amplifier-agent engine via `uv`:

```dockerfile
# ---- amplifier-agent engine --------------------------------------------------
RUN mkdir -p /opt/uv/cache && \
    UV_TOOL_BIN_DIR=/usr/local/bin UV_CACHE_DIR=/opt/uv/cache \
        GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt \
        uv tool install \
        "amplifier-agent @ git+https://github.com/microsoft/amplifier-agent@${AMPLIFIER_AGENT_REF}" && \
    chmod -R a+x /root/.local/share/uv/tools/amplifier-agent/bin && \
    chmod -R a+rX /opt/uv && \
    chown -R node:node /opt/uv
```

**Key differences from upstream docs:**
- `UV_CACHE_DIR=/opt/uv/cache` ensures the cache is in a known location (avoids permission issues with the default `~/.cache`)
- `GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt` is required during `uv tool install` because uv shells out to `git clone`, and inside the container git can't find the CA bundle on its own. Without this, the install fails with `server certificate verification failed. CAfile: none CRLfile: none`.
- `chmod -R a+x /root/.local/share/uv/tools/amplifier-agent/bin` makes the actual binaries executable. `uv tool install` symlinks `/usr/local/bin/amplifier-agent` → `/root/.local/share/uv/tools/amplifier-agent/bin/amplifier-agent`; chmodding the symlink in `/usr/local/bin/` is a no-op — the real file under `/root/.local/share/uv/tools/.../bin/` is what needs the executable bit.
- Bundle cache prepopulation (`amplifier-agent prepare`) is deferred to runtime to avoid permission constraints during build

**(d)** After the existing `USER node` switch (around line 150), and BEFORE the existing `tini`/entrypoint block, create the runtime state directories:

```dockerfile
USER node

# Bundle cache will be populated on first run. Pre-create the directories
# so the amplifier-agent engine can write to them with any UID.

USER root

# Pre-create runtime state dirs and chmod world-writable. NC's container
# runner spawns the container under the host UID (Docker Desktop on macOS
# maps the host UID into the container), which differs from the build-time
# `node` UID. The engine writes to .local/state, .cache, .config, and
# .amplifier/cache regardless of which UID is actually running.
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
```

**(e)** (Optional) Add a validation comment. The `amplifier-agent prepare` and `amplifier-agent doctor` steps are skipped during image build to avoid permission issues. They run lazily on first container startup instead:

```dockerfile
# Image-build gate: doctor validates the provider at container startup.
# Skipped at build time due to permission constraints; will run on first use.
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
- **Bundle module lazy install:** the `amplifier-agent prepare` step is deferred from image build to first container startup. The engine `git clone`s its bundle modules to `/home/node/.amplifier/cache/` on first activation. Requires github.com reachability inside the container. First call adds ~10–20s; subsequent calls hit the cached modules.
- **Bundle cache population:** containers skip the expensive `amplifier-agent prepare` during image build (to avoid permission issues with the `node` user). The prepare step runs automatically on first message to a group, or can be triggered explicitly via `amplifier-agent prepare` inside the container. Caching is per-group at `$DATA_DIR/amplifier-agent/<group-id>/`, so hot starts avoid the clone penalty.
- **B1 buffer chaining (not steering):** the host adapter advertises `supports_steering: false`. Mid-turn `push()` calls queue and drain between turns. CR-4 caps the queue at 256 messages; overflow surfaces a `progress` event.
- **Approvals auto-accepted:** Mode A v2 rejects `approval.onRequest` with `AaaError(approval_not_supported_in_v1)`. The host adapter intentionally does not pass the callback. In-container actions are auto-approved (the container is the sandbox). Host-level approvals (channel registration, unknown-sender policy) run in NanoClaw's router before the provider is invoked — they continue to work unchanged.
- **Per-group transcript persistence:** `$DATA_DIR/amplifier-agent/<group-id>/` is bind-mounted at `/home/node/.local/state/amplifier-agent/` so transcripts and session metadata survive container restarts.
- **Q10 lazy-prepare retry:** if the engine reports `engine_not_primed`, the adapter runs `amplifier-agent prepare` synchronously and retries the spawn once. This handles any cache misses from previous restarts.

## Verify

```bash
grep -q "./amplifier-agent.js" container/agent-runner/src/providers/index.ts && echo "✓ container barrel"
grep -q "./amplifier-agent.js" src/providers/index.ts && echo "✓ host barrel"
awk '/^export interface McpServerConfig/,/^}/' container/agent-runner/src/providers/types.ts | grep -q "transport?:" && echo "✓ McpServerConfig.transport"
awk '/^export interface QueryInput/,/^}/' container/agent-runner/src/providers/types.ts | grep -q "mcpServers?:" && echo "✓ QueryInput.mcpServers"
grep -q "amplifier-agent-ts" container/agent-runner/package.json && echo "✓ TS wrapper dep"
grep -q "AMPLIFIER_AGENT_REF" container/Dockerfile && echo "✓ Dockerfile ARG"
grep -q "uv tool install" container/Dockerfile && echo "✓ UV tool install"
grep -q "GIT_SSL_CAINFO" container/Dockerfile && echo "✓ Git SSL CA for install-time clone"
grep -q "chmod -R a+x /root/.local/share/uv/tools/amplifier-agent/bin" container/Dockerfile && echo "✓ Binary executable"
grep -q "UV_CACHE_DIR=/opt/uv/cache" container/Dockerfile && echo "✓ Cache directory"

cd container/agent-runner && bun test src/providers/amplifier-agent/event-translator.test.ts && cd -
cd container/agent-runner && bun test src/providers/amplifier-agent/mcp-translator.test.ts && cd -
```

After image rebuild, set `agent_provider = 'amplifier-agent'` on a test group and send a message. Successful round-trip looks like:

- Container's first log line: `[agent-runner] Starting v2 agent-runner (provider: amplifier-agent)`
- First container message may include bundle cache population (if running `amplifier-agent prepare` for the first time)
- `init` event with a stable session ID
- One or more activity/progress events during the turn
- `result` event with the model's reply, delivered back through the channel

**First startup notes:** The first message to a group will trigger `amplifier-agent prepare` to populate the bundle cache from github.com/microsoft/*. This adds ~10–20s to the first call; subsequent messages are fast. Caches are per-group, so first calls in new groups always populate.

**Troubleshooting:**
- If the engine errors with `provider-anthropic` activation failures, confirm `git clone` from `github.com/microsoft/*` works inside the container.
- If bundle cache fails to populate, check that containers have outbound HTTPS access to github.com.
- If approval-related errors appear, confirm the host adapter is NOT passing `approval.onRequest` (Mode A v2 contract).
- If the binary is not executable (`/bin/sh: amplifier-agent: Permission denied`), the symlink at `/usr/local/bin/amplifier-agent` chmod is a no-op — chmod the real binaries directory: `chmod -R a+x /root/.local/share/uv/tools/amplifier-agent/bin`. Re-run `./container/build.sh` if needed.
- If the build fails with `server certificate verification failed. CAfile: none CRLfile: none`, the `uv tool install` step is missing `GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt` on its RUN line. uv shells out to `git clone`, which can't find the CA bundle without that env var inside the container.
