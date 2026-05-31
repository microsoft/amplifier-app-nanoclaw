<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

---

## About NanoClaw

NanoClaw is a small, auditable AI-assistant harness. A single Node host routes messages from your channels (CLI, Telegram, Discord, WhatsApp, ...) into per-agent Docker containers, runs the agent inside, and delivers responses back. Filesystem and credential isolation are real — agents only see what you mount, and API keys are vaulted by [OneCLI](https://github.com/onecli/onecli) so they never enter the container environment.

By default NanoClaw runs agents on the Claude Agent SDK. This README walks you through running NanoClaw with **[amplifier-agent](https://github.com/microsoft/amplifier-agent)** as the agent backend instead — which lets you swap between Anthropic, OpenAI, Azure OpenAI, and Ollama per agent group while keeping the same sandbox, channels, and security model.

---

## Setting up NanoClaw with amplifier-agent

### Prerequisites

- macOS or Linux (Windows via WSL2), 4 GB+ RAM
- Docker — installed automatically on macOS if missing
- An API key for your provider of choice:
  - **Anthropic** — `sk-ant-api...` from [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI** — `sk-proj-...` from [platform.openai.com](https://platform.openai.com/api-keys)
  - **Azure OpenAI** — resource key + endpoint URL + API version
  - **Ollama** — base URL of a running server (e.g. `http://localhost:11434`)

> An Anthropic credential is recommended even if you plan to use a different provider — the setup script uses Claude to help diagnose errors. You can skip it with a warning.

### 1. Clone and run

```bash
git clone https://github.com/manojp99/amplifier-app-nanoclaw.git
cd amplifier-app-nanoclaw
bash nanoclaw.sh
```

The script installs Node, pnpm, and (on macOS) Docker if missing, then hands off to an interactive setup that drives the rest.

> **Skip the agent-provider prompt:** prefix the command with `NANOCLAW_PROVIDER=amplifier-agent`.

### 2. Walk through the standard steps

Press Enter through these — they're the same regardless of agent backend:

- **Start path** — pick *Standard setup*
- **System check + sandbox build** — automated (first build is 3–10 min)
- **OneCLI vault + Claude account** — sign in with your Claude subscription, paste a token/key, or skip with a warning
- **Display name** — what your assistant should call you

### 3. Choose `Amplifier Agent` as the agent provider

```
Which agent provider for your assistant?

  ● Claude (default)        recommended
  ○ Amplifier Agent
```

Arrow down and select **Amplifier Agent**. This writes `NANOCLAW_DEFAULT_PROVIDER=amplifier-agent` to your `.env`.

### 4. Choose an internal provider

amplifier-agent ships with four built-in model backends:

```
Which internal provider for amplifier-agent?

  ● Anthropic               recommended
  ○ OpenAI
  ○ Azure OpenAI
  ○ Ollama (local)
```

### 5. Add your API key

The next prompts depend on your choice:

| Provider | Prompts | `.env` keys written |
|---|---|---|
| Anthropic | API key | `ANTHROPIC_API_KEY` |
| OpenAI | API key | `OPENAI_API_KEY` |
| Azure OpenAI | API key, endpoint URL, API version | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` |
| Ollama | Base URL | `OLLAMA_BASE_URL` |

Input is masked. Credentials land in `.env` at the project root (gitignored).

### 6. Finish the flow

The remaining steps are automated or simple confirmations:

- **Provision** — agent group created, CLI channel wired up
- **First chat (ping test)** — first turn takes 30–60s while the container warms up; subsequent turns are fast
- **Timezone** — confirm the auto-detected zone
- **Connect a messaging channel** (optional) — Telegram, Discord, WhatsApp, etc. Each channel re-prompts for a provider, so you can mix backends per channel
- **Verify** — sanity check

When done:

```bash
pnpm run chat hi          # Chat from the terminal
tail -f logs/nanoclaw.log # Watch what's happening
```

### Switching providers later

Edit `.env`:

```bash
AMPLIFIER_AGENT_INTERNAL_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
```

Then restart the NanoClaw service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-<install-slug>
# Linux
systemctl --user restart nanoclaw-v2-<install-slug>
```

New agents pick up the new provider. Existing agents keep their stored `agent_provider` until you change it explicitly (per-agent override lives in `data/v2.db`).

### Full guide

For the verbose walkthrough — every screen, screenshot hooks, troubleshooting, and a breakdown of what gets installed — see [docs/SETUP-AMPLIFIER-AGENT.md](docs/SETUP-AMPLIFIER-AGENT.md).

---

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes. The codebase is small enough that Claude can safely modify it.

## Architecture

```
messaging apps → host process (router) → inbound.db → container (agent-runner) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. When a message arrives, the host writes it to the session's `inbound.db` and wakes the container. The agent-runner — Claude Agent SDK by default, or amplifier-agent's Python engine — polls `inbound.db`, runs the model, and writes responses to `outbound.db`. The host polls `outbound.db` and delivers back through the channel adapter.

Full writeup in [docs/architecture.md](docs/architecture.md); isolation model in [docs/isolation-model.md](docs/isolation-model.md).

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## License

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
