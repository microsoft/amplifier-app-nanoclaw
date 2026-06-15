# Setting up NanoClaw with amplifier-agent

A step-by-step guide to standing up NanoClaw with [amplifier-agent](https://github.com/microsoft/amplifier-agent) as the agent backend in place of the default Claude Agent SDK.

You'll run `bash nanoclaw.sh` once, answer a handful of prompts, and end up with an assistant you can chat with from your terminal — backed by amplifier-agent's Python engine and whichever model provider (Anthropic, OpenAI, Azure OpenAI, Ollama) you have an API key for.

> If you just want NanoClaw with the default Claude backend, follow the [main README](../README.md) — that flow is shorter and skips the provider-choice steps documented here.

---

## What you get with amplifier-agent

| | Default (Claude SDK) | With amplifier-agent |
|---|---|---|
| Agent runtime | Claude Agent SDK in Node | amplifier-agent Python engine in the sandbox |
| Model choice | Claude only | Anthropic, OpenAI, Azure OpenAI, Ollama — swappable per agent group |
| MCP tools | SDK-mediated | First-class via amplifier-agent's tool-mcp module |
| Bundle composition | n/a | Swappable orchestrators, hooks, providers, contexts |
| Same sandboxing | ✓ | ✓ — agents still run in their own Docker container |

The sandbox model, channel adapters (Telegram, Discord, WhatsApp, CLI), and security boundary are identical. Only the agent runtime inside the container changes.

---

## What you'll need

Same prerequisites as the main NanoClaw setup, plus an API key for whichever provider you plan to use:

- **macOS or Linux** — Apple Silicon, Intel, or x86-64 Linux
- **4 GB+ RAM** — NanoClaw warns under 4 GB; 8 GB is comfortable
- **Docker** — installed automatically on macOS if missing (via Homebrew); on Linux, install per your distro before running setup
- **An API key for your provider of choice**:
  - **Anthropic** — `sk-ant-api...` from https://console.anthropic.com
  - **OpenAI** — `sk-proj-...` from https://platform.openai.com/api-keys
  - **Azure OpenAI** — your resource key + endpoint URL + API version
  - **Ollama** — local server URL (e.g. `http://localhost:11434`)

> An Anthropic credential is still recommended even if you're using a different provider for amplifier-agent — the setup script uses Claude to help diagnose errors. You can skip it, but with a warning.

---

## The flow at a glance

```
bash nanoclaw.sh
    │
    ├─ Phase 1 — bash bootstrap
    │   ├─ Splash screen
    │   ├─ Install Node + pnpm + native modules
    │   └─ Hand off to TypeScript setup
    │
    └─ Phase 2 — interactive setup (pnpm run setup:auto)
        ├─ Standard / Advanced choice
        ├─ System check
        ├─ Docker sandbox build      (~3–10 min, first run only)
        ├─ OneCLI vault
        ├─ Connect a Claude account  (optional but recommended)
        ├─ Service registration
        │
        ├─ Display name              ┐
        ├─ ★ Choose agent provider   │
        ├─ ★ Choose internal provider│ ← amplifier-agent enters here
        ├─ ★ Add API key             │
        ├─ Provision your agent      ┘
        │
        ├─ Ping test (first chat)
        ├─ Timezone
        ├─ Connect a messaging channel  (optional)
        ├─ Verify
        └─ Done
```

The three steps marked ★ are amplifier-agent-specific. Everything else is the standard NanoClaw flow.

---

## Step-by-step walkthrough

### 1. Clone and run

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

The bash script handles environment basics (Node, pnpm, optional Homebrew install on macOS), then hands off to `pnpm run setup:auto` which drives the rest interactively.

> **Bypass the prompt:** to skip the agent-provider menu later, prefix the command with `NANOCLAW_PROVIDER=amplifier-agent bash nanoclaw.sh`.

> **First screen:** the NanoClaw splash with the lobster mascot and the wordmark.

<!--
  TODO Screenshot 1: Splash screen
  Suggested filename: assets/setup-screenshots/01-splash.png
  Caption: "Splash screen on first run — confirms you're in the right place."
-->

---

### 2. Choose your start path

```
How would you like to begin?

  ● Standard setup
  ○ Advanced
```

Pick **Standard setup** unless you're connecting to a remote OneCLI vault or using a proxy. Advanced lets you override OneCLI host, Anthropic base URL, and similar knobs — none of which are amplifier-agent-specific.

<!--
  TODO Screenshot 2 (optional): "How would you like to begin?" menu
  Suggested filename: assets/setup-screenshots/02-start.png
  Caption: "Default the choice; Advanced is for self-hosted vault setups."
-->

---

### 3. System + sandbox

Two automated spinners:

```
⏳ Checking your system…           → "Your system looks good."

⏳ Preparing your assistant's sandbox…
   (first build pulls a base image; 3–10 min on a fresh machine)
                                    → "Sandbox ready."
```

You won't need to interact with these. The sandbox is the Docker container your agent will run in — sandbox build is the longest single step on first run.

---

### 4. OneCLI vault + Claude account

NanoClaw uses [OneCLI](https://github.com/onecli/onecli) as a local credential vault so API keys never sit in your shell environment.

```
⏳ Setting up OneCLI, your agent's vault…   → "OneCLI vault ready."

How would you like to connect to Claude?

  ● Sign in with my Claude subscription   (recommended if you have Pro or Max)
  ○ Paste an OAuth token I already have
  ○ Paste an Anthropic API key
  ○ Skip — I'll connect later
```

If you're using amplifier-agent with the Anthropic internal provider, this Claude account is the SAME credential — pick whichever sign-in method you prefer. If you're using OpenAI/Azure/Ollama, you can skip this with the warning (Claude is used for setup-time error diagnosis only).

After auth, two more automated steps:

```
⏳ Setting your assistant's access rules…   → "Access rules set."
⏳ Starting NanoClaw in the background…     → "NanoClaw is running."
```

The service is now registered with systemd (Linux) or launchd (macOS).

---

### 5. Name your assistant

```
What should your assistant call you?
> Manoj
```

Defaults to `$USER`. Whatever you type here, your agent uses to address you.

---

### 6. ★ Choose amplifier-agent as the agent provider

This is the first amplifier-agent–specific step.

```
Which agent provider for your assistant?

  ● Claude (default)        recommended
  ○ Amplifier Agent
```

Arrow down to **Amplifier Agent** and press Enter.

<!--
  TODO Screenshot 3: Provider selection menu (PRIORITY — this is the headline screen)
  Suggested filename: assets/setup-screenshots/03-provider-selection.png
  Caption: "Pick Amplifier Agent here. The next two prompts will collect your model choice and credentials."
-->

> Behind the scenes this sets `NANOCLAW_DEFAULT_PROVIDER=amplifier-agent` in your project's `.env` file. The same .env is read by both the host and the agent container.

---

### 7. ★ Choose your internal provider

amplifier-agent ships with four built-in model backends. Pick whichever matches your API key:

```
Which internal provider for amplifier-agent?

  ● Anthropic               recommended
  ○ OpenAI
  ○ Azure OpenAI
  ○ Ollama (local)
```

| If you pick… | You'll need |
|---|---|
| **Anthropic** | `sk-ant-api...` key, gives you Claude 4.5 Opus by default |
| **OpenAI** | `sk-proj-...` key, gives you `gpt-5.5` by default with reasoning enabled |
| **Azure OpenAI** | Resource key + endpoint URL + API version |
| **Ollama** | Base URL of a running Ollama server (default `http://localhost:11434`) |

<!--
  TODO Screenshot 4 (optional): Internal provider menu
  Suggested filename: assets/setup-screenshots/04-internal-provider.png
  Caption: "Four built-in providers ship with amplifier-agent. You can switch later per agent group."
-->

---

### 8. ★ Add your API key

The next prompt(s) depend on which internal provider you picked.

**Anthropic:**
```
Paste your Anthropic API key
> ****************************************
```
Input is masked. Written to `.env` as `ANTHROPIC_API_KEY`.

**OpenAI:**
```
Paste your OpenAI API key
> ****************************************
```
Written as `OPENAI_API_KEY`.

**Azure OpenAI:**
```
Paste your Azure OpenAI API key
> ****************************************

Enter your Azure OpenAI endpoint URL
> https://my-resource.openai.azure.com/

Enter your Azure OpenAI API version
> 2024-10-21
```
Written as `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`.

**Ollama:**
```
Enter your Ollama base URL
> http://localhost:11434
```
Written as `OLLAMA_BASE_URL`.

When done:
```
✓ Credentials written to .env for <internalProvider>
```

<!--
  TODO Screenshot 5: Credential entry (any one provider — Anthropic recommended)
  Suggested filename: assets/setup-screenshots/05-credentials.png
  Caption: "Keys are masked. They're written to .env in the project root and read by the agent container at runtime."
-->

> **Where the .env lives:** the project root of your nanoclaw clone — same file you'd `cat` to see what's configured. Don't commit this file — it's in `.gitignore`.

---

### 9. Provision your assistant

Automatic; no input.

```
⏳ Bringing your assistant online…   → "Assistant wired up."
```

Behind the scenes:
- An agent group is created in `data/v2.db` with `agent_provider = "amplifier-agent"`
- A messaging group of type `cli` is wired to it
- A `groups/cli-with-<name>/CLAUDE.md` system prompt is written

---

### 10. First chat — the ping test

```
ℹ  Your assistant runs in an isolated sandbox. I'm going to send it a
   quick test message (ping) and wait for a reply (pong) to confirm it's
   responding. First startup typically takes 30–60 seconds while the
   sandbox warms up.

⏳ Waking your assistant… (47s)     → "Your assistant is ready."
```

The first run is slow because the container is cold — amplifier-agent's engine has to install its bundle modules (provider-anthropic / provider-openai / tool-mcp / etc.) on first use. Subsequent turns are fast.

<!--
  TODO Screenshot 6 (optional): "Waking your assistant…" → "Your assistant is ready."
  Suggested filename: assets/setup-screenshots/06-first-ping.png
  Caption: "First-chat verification. The 30–60s cold start is one-time; later turns are fast."
-->

After the ping succeeds:

```
What next?

  ● Continue with setup       recommended
  ○ Pause here and chat with your agent from the terminal
```

If you pick the second option, you get a free-text loop where you can talk to your new assistant immediately. Empty Enter returns to setup.

---

### 11. Timezone

Auto-detected from your system; confirm with Enter.

```
I detected America/Los_Angeles from your computer settings. Is that right?
[Y/n] _
```

Falls back to free-text input if detection fails or you say no.

---

### 12. (Optional) Connect a messaging channel

```
Want to chat with your assistant from your phone?

  ● Yes, connect Telegram     recommended
  ○ Yes, connect Discord
  ○ Yes, connect WhatsApp
  ○ Yes, connect Signal       needs signal-cli installed
  ○ Yes, connect iMessage (experimental)
  ○ Yes, connect Slack (experimental)
  ○ Yes, connect Microsoft Teams
  ○ Other…
  ○ Skip for now              I'll just use the terminal
```

If you pick a real channel, **the provider-selection prompts repeat for that channel's agent** (steps 6–8 above) — each messaging group gets its own provider choice. You can run Telegram on amplifier-agent and Discord on Claude SDK from the same NanoClaw if you want.

Each channel runs its own sub-flow (e.g. Telegram bot token + QR pairing). See the channel-specific guides for details.

---

### 13. Verify

```
⏳ Making sure everything works together…   → "Everything's connected."
```

Soft-fail notes appear here if something's missing (Claude account not connected, NanoClaw service running from a stale folder, etc.). Follow the printed instructions to fix.

---

### 14. Done

```
Try these:
  • Chat in the terminal:    pnpm run chat hi
  • See what's happening:    tail -f logs/nanoclaw.log
  • Open Claude Code:        claude

Heads up:
  NanoClaw runs on this machine. It's only reachable while this computer
  is on and connected to the internet.

✓ You're set.
```

<!--
  TODO Screenshot 7 (optional): "You're set." final screen
  Suggested filename: assets/setup-screenshots/07-done.png
  Caption: "Setup complete. Run `pnpm run chat hi` to talk to your assistant from the terminal."
-->

---

## What just got installed

| Component | Version | Where |
|---|---|---|
| amplifier-agent (engine) | `0c69c88` (v0.5.1) | Container image — SHA pin: `0c69c88b36217cd395e937fc97f5ce246bc02887` (no `engine-v*` tag published) |
| amplifier-agent-ts (wrapper) | `^0.6.1` | `container/agent-runner/node_modules/amplifier-agent-ts` (from npm) |
| Wire protocol | `0.2.0` | engine ↔ wrapper handshake |
| Built-in bundle | `amplifier-agent-builtin@1.2.1` | Vendored in the engine |

Your `.env` after setup looks roughly like this:

```bash
NANOCLAW_DEFAULT_PROVIDER=amplifier-agent
AMPLIFIER_AGENT_MODEL=anthropic:claude-sonnet-4-6   # <provider>:<model> — provider is one of anthropic / openai / azure-openai / ollama
ANTHROPIC_API_KEY=sk-ant-api...                     # or whichever provider key
```

`AMPLIFIER_AGENT_MODEL` is the single install-wide knob for amplifier-agent: backend and model travel together as `<provider>:<model>`, so they can never come from two different settings and disagree. Both parts are required (there is no backend-only / bare-model form). A per-agent-group `--model` (same format) overrides it.

Your `data/v2.db` has an `agent_groups` row for the CLI agent with `agent_provider = "amplifier-agent"`. Each future agent group (added via channel setup or `pnpm run ncl agent add`) inherits this default and can override.

---

## Switching providers later

### Change the default for new agents

Edit `.env`:

```bash
AMPLIFIER_AGENT_MODEL=openai:gpt-5
OPENAI_API_KEY=sk-proj-...
```

Restart the NanoClaw service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-<install-slug>   # macOS
systemctl --user restart nanoclaw-v2-<install-slug>                  # Linux
```

New agents created from this point on use the new provider. Existing agents keep their stored `agent_provider` until you change it explicitly.

### Per-agent override

You can target a different provider per agent group via the `agent_provider` column in `data/v2.db` — or by recreating the group with `pnpm run ncl agent add` and answering the provider prompt differently.

---

## Troubleshooting

### "Engine exited 1 without emitting a parseable §4.1 envelope"

The agent-runner couldn't get a clean response back from the engine subprocess. Most common causes:

| Cause | Fix |
|---|---|
| Container started before the latest engine landed | Send a follow-up message — the container's lifecycle picks up changes per-spawn |
| `OPENAI_API_KEY` (or similar) missing | Check `.env` has the right key for the provider named in `AMPLIFIER_AGENT_MODEL` (`<provider>:<model>`) |
| Container was built before a tag move | Rebuild with `--no-cache`: `cd container && docker build --no-cache -t nanoclaw-agent-v2-$(node -e "import('./dist/install-slug.js').then(m=>console.log(m.getInstallSlug(process.cwd().replace('/container','')))) ").latest .` |

### `"Unsupported parameter: 'reasoning.effort' is not supported with this model"`

A known interaction between the bundle's `extended_thinking: true` default and the OpenAI provider's parameter handling. **Resolved since `engine-v0.3.0`** by switching the catalog's OpenAI default to `gpt-5.5` (a reasoning-capable model). The current pin (v0.5.1) is well past this fix. If you're still seeing the bug, your container image is stale — rebuild with `--no-cache`.

If you want to use a different OpenAI model that's NOT reasoning-capable (e.g. `gpt-4o`), set `OPENAI_DEFAULT_MODEL=gpt-4o` in `.env` AND override the bundle's `extended_thinking` to `false` in a custom bundle profile.

### Container respawns without my latest hot-patch

NanoClaw spawns one container per agent group, and may recreate it after idle. If you've been hot-patching files via `docker cp`, those changes die with the container. The fix is to bake your change into the image — either update the upstream pin (`AMPLIFIER_AGENT_REF` in `container/Dockerfile`) or rebuild from local source.

### Where to look when something goes wrong

```bash
# Host-side service logs
tail -f logs/nanoclaw.log
tail -f logs/nanoclaw.error.log

# Container logs (the running agent)
docker logs -f $(docker ps --filter "name=nanoclaw" -q | head -1)

# Setup logs (per step verbatim output)
ls logs/setup-steps/
tail -50 logs/setup-steps/01-bootstrap.log
```

---

## References

- amplifier-agent engine: https://github.com/microsoft/amplifier-agent (pinned at SHA `0c69c88`, equivalent to v0.5.1)
- amplifier-agent-ts wrapper: https://www.npmjs.com/package/amplifier-agent-ts (`0.6.1`, OIDC trusted-published with provenance)
- Built-in bundle: vendored at `src/amplifier_agent_lib/bundle/bundle.md` (`amplifier-agent-builtin@1.2.1`)
- Bundled module catalog: `src/amplifier_agent_cli/provider_sources.py` in the engine repo
- NanoClaw main README: [../README.md](../README.md)
- NanoClaw architecture: [./architecture.md](./architecture.md)
- Agent-runner details: [./agent-runner-details.md](./agent-runner-details.md)
