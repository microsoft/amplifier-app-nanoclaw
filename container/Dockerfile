# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.128
# Pinned to v0.6.0 (engine) / wrapper v0.7.0 by SHA. Both tags point at the
# same commit (the release bump in #55).
# dc535ac corresponds to "chore(release): bump engine to 0.6.0 and TS wrapper
# to 0.7.0 (#55)". Major v0.6.0 changes: XDG storage layout dropped in favor
# of unified ~/.amplifier-agent/{state,cache,config}/; --provider CLI flag
# removed (provider selection moves to host_config.json); auto-migration
# replaced by user-invoked `amplifier-agent migrate`; --output default flipped
# from json to text (irrelevant here since the wrapper hardcodes --output
# json). See amplifier-agent docs/designs/2026-06-11-drop-xdg-and-flag-cleanup.md.
ARG AMPLIFIER_AGENT_REF=dc535ac04948a4b4804b0c2bd7ec29e920b0dd68
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=52.2.1
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"


# ---- uv (installs amplifier-agent in the next block) -------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/ && \
    mv /root/.local/bin/uvx /usr/local/bin/ && \
    rm -rf /root/.local/bin

# ---- amplifier-agent engine --------------------------------------------------
RUN mkdir -p /opt/uv/cache && \
    UV_TOOL_BIN_DIR=/usr/local/bin UV_CACHE_DIR=/opt/uv/cache \
        GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt \
        uv tool install \
        "amplifier-agent @ git+https://github.com/microsoft/amplifier-agent@${AMPLIFIER_AGENT_REF}" && \
    chmod 755 /root && \
    chmod -R a+rwX /root/.local/share/uv/tools/amplifier-agent && \
    chmod -R a+x /root/.local/share/uv/tools/amplifier-agent/bin && \
    chmod -R a+rX /opt/uv && \
    chown -R node:node /opt/uv

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.

# Pre-create runtime state dirs and chmod world-writable. NC's container
# runner spawns the container under the host UID (Docker Desktop on macOS
# maps the host UID into the container), which differs from the build-time
# `node` UID.
#
# Engine v0.6.0 dropped XDG paths. State now lives under a single root:
#   ~/.amplifier-agent/state/    sessions, transcripts, workspaces
#   ~/.amplifier-agent/cache/    prepared bundle cache
#   ~/.amplifier-agent/config/   host_config.json
# Override via AMPLIFIER_AGENT_HOME=<path> (single env var; old XDG_* vars
# are no longer consulted). See amplifier-agent design doc
# `docs/designs/2026-06-11-drop-xdg-and-flag-cleanup.md`.
#
# The HOST-side amplifier-agent provider bind-mounts a per-agent-group host
# dir at /home/node/.amplifier-agent/, so once running these pre-created
# subdirs are masked by the mount. The mkdir+chmod still matters for:
#   (a) image-only runs with no bind mount,
#   (b) ensuring parent ownership/perms when Docker creates the mount.
# /home/node/.amplifier/cache is retained for bundle install machinery that
# still lives under the legacy .amplifier path during `amplifier-agent prepare`.
USER root
RUN mkdir -p \
        /home/node/.amplifier-agent/state/workspaces \
        /home/node/.amplifier-agent/cache \
        /home/node/.amplifier-agent/config \
        /home/node/.amplifier/cache && \
    chown -R node:node /home/node/.amplifier-agent /home/node/.amplifier && \
    chmod -R 0777 \
        /home/node/.amplifier-agent \
        /home/node/.amplifier \
        /opt/uv
USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
