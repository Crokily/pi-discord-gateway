# pi-discord-gw

A lightweight Discord gateway for [pi coding agent](https://github.com/badlogic/pi-mono). It receives Discord messages, queues them in SQLite, invokes `pi` as a subprocess, and sends responses back — keeping a persistent session per channel.

```
Discord ──discord.js──→ Gateway ──pi subprocess──→ Pi Agent
                           │                          │
                         SQLite                  Session dirs
                      (message queue)           (per channel)
```

## Features

- **Bridges to your existing `pi`** — shells out to the `pi` binary and reuses your login + model access
- **Per-channel sessions** — each Discord channel gets its own persistent conversation history
- **SQLite message queue** — survives crashes, auto-recovers stuck messages
- **Concurrency control** — per-channel serial processing + configurable global limit
- **@mention trigger** — responds only when @mentioned, or set channels to always-on
- **DM auto-registration** — direct messages work out of the box
- **Discord slash commands** — `/pi status`, `/pi model`, `/pi thinking`, `/pi new`
- **Attachment relay** — Discord file uploads are downloaded and passed to `pi` via `@file`
- **Typing indicators** — shows "bot is typing" while `pi` processes
- **Message splitting** — handles Discord's 2000-character limit automatically
- **systemd integration** — `pi-discord daemon install` generates a user service
- **XDG-compliant paths** — config in `~/.config/`, data in `~/.local/share/`

## Quick Start

```bash
# 1. Install (requires pi to be installed and logged in)
npm install -g pi-discord-gw

# 2. Setup — walks you through config
pi-discord setup

# 3. Register a channel
pi-discord register 123456789012345678 "my-server #general" --no-trigger

# 4. Start
pi-discord start
```

## Prerequisites

- **Node.js** ≥ 20
- **[pi](https://github.com/badlogic/pi-mono)** installed and on `PATH`
- **pi login** completed (`~/.pi/agent/auth.json` must exist)
- **Discord bot token** — [create one here](https://discord.com/developers/applications)
  - Enable **Message Content Intent** under Privileged Gateway Intents
  - Bot permissions: `Send Messages`, `Read Message History`, `View Channels`

## Installation

### npm (recommended)

```bash
npm install -g pi-discord-gw
```

### npx (quick trial)

```bash
npx pi-discord-gw@latest setup
```

### From source

```bash
git clone https://github.com/Crokily/pi-discord-gateway.git
cd pi-discord-gateway
npm install
npm run build
node dist/cli.js help
```

### Docker

```bash
git clone https://github.com/Crokily/pi-discord-gateway.git
cd pi-discord-gateway
cp .env.example .env
# Edit .env — set DISCORD_BOT_TOKEN at minimum

docker compose up -d
docker compose logs -f
```

The container expects your `pi` auth at `~/.pi/agent/auth.json` — it is mounted read-only by default.

## How It Connects to `pi`

The gateway **does not embed or replace `pi`**. It finds and runs your installed `pi`:

1. **Binary discovery** — uses `PI_BIN` config or finds `pi` in `PATH`
2. **Auth reuse** — `pi` reads its own `~/.pi/agent/auth.json` when invoked
3. **Model catalog** — the gateway imports `AuthStorage` + `ModelRegistry` from the pi SDK to populate slash command autocomplete
4. **Invocation** — each message is processed as `pi --session-dir <dir> --continue -p <message>`

If `pi-discord setup` finds `pi` in your PATH, it tells you. If not, set `PI_BIN=/full/path/to/pi` in your config.

## Configuration

Config file: `~/.config/pi-discord-gateway/config.env`
Override path: `export PIDG_CONFIG=/path/to/config.env`

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | *(required)* | Discord bot token |
| `PI_BIN` | `pi` | Path to pi binary |
| `PI_MODEL` | *(none)* | Default model override |
| `PI_THINKING` | *(none)* | Default thinking level |
| `PI_CWD` | `$HOME` | Working directory for pi |
| `PI_EXTRA_FLAGS` | *(none)* | Extra flags passed to pi |
| `TRIGGER_NAME` | `Andy` | Bot trigger name for @mentions |
| `MAX_CONCURRENCY` | `3` | Max parallel pi invocations |
| `POLL_INTERVAL_MS` | `1000` | Queue poll interval (ms) |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown timeout (ms) |
| `AUTO_REGISTER_DMS` | `true` | Auto-register DM channels |
| `MAX_ATTACHMENT_BYTES` | `26214400` | Max size per attachment (0 = no limit) |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800` | Max combined attachment size (0 = no limit) |
| `SESSIONS_DIR` | `~/.local/share/pi-discord-gateway/sessions` | Session storage directory |
| `DB_PATH` | `~/.local/share/pi-discord-gateway/gateway.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level: debug/info/warn/error |

## CLI Reference

```
pi-discord setup [token]                         Interactive setup wizard
pi-discord start                                 Start gateway (foreground)
pi-discord status                                Show diagnostics
pi-discord channels                              List registered channels
pi-discord register <id> <name> [options]        Register a channel
pi-discord unregister <id>                       Unregister a channel
pi-discord daemon install                        Install systemd user service
pi-discord daemon uninstall                      Remove systemd user service
pi-discord daemon start|stop|status|logs         Control the service
pi-discord help                                  Show help
```

Register options:
- `--no-trigger` — respond to all messages (not just @mentions)
- `--main` — main channel (implies `--no-trigger`)
- `--folder <name>` — custom session folder name

## Slash Commands

The gateway registers a global `/pi` command on Discord:

| Subcommand | Description |
|------------|-------------|
| `/pi status` | Show model, thinking, session info, token usage |
| `/pi model` | Set channel model (autocomplete from pi's available models) |
| `/pi reset-model` | Clear channel model override |
| `/pi thinking` | Set thinking level: off / minimal / low / medium / high / xhigh |
| `/pi new` | Start a fresh session for this channel |

## systemd Service

```bash
pi-discord daemon install   # Generate + enable user service
pi-discord daemon start     # Start
pi-discord daemon status    # Check
pi-discord daemon logs      # Tail journal
pi-discord daemon stop      # Stop
pi-discord daemon uninstall # Remove
```

The generated service uses the same config file from `pi-discord setup`.

## Docker

### docker-compose.yml

```yaml
services:
  gateway:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - gateway-data:/data
      - ${HOME}/.pi/agent/auth.json:/home/node/.pi/agent/auth.json:ro
    environment:
      - SESSIONS_DIR=/data/sessions
      - DB_PATH=/data/gateway.db

volumes:
  gateway-data:
```

### Standalone

```bash
docker build -t pi-discord-gw .
docker run -d \
  --env-file .env \
  -v pi-discord-data:/data \
  -v ~/.pi/agent/auth.json:/home/node/.pi/agent/auth.json:ro \
  -e SESSIONS_DIR=/data/sessions \
  -e DB_PATH=/data/gateway.db \
  pi-discord-gw
```

## Data Locations

| Item | Default path |
|------|-------------|
| Config | `~/.config/pi-discord-gateway/config.env` |
| Database | `~/.local/share/pi-discord-gateway/gateway.db` |
| Sessions | `~/.local/share/pi-discord-gateway/sessions/` |
| pi auth | `~/.pi/agent/auth.json` |

## Troubleshooting

<details>
<summary><strong>pi not found in PATH</strong></summary>

`pi-discord status` shows "Pi binary: not found".

- Check `pi --version` works in the same shell
- Set `PI_BIN=/full/path/to/pi` in config.env
- After changing config: `pi-discord daemon stop && pi-discord daemon start`
</details>

<details>
<summary><strong>Missing auth.json</strong></summary>

`pi-discord status` shows "Pi auth: missing".

- Run `pi login`
- Confirm `~/.pi/agent/auth.json` exists for the same user running the gateway
</details>

<details>
<summary><strong>systemd service won't start</strong></summary>

- `pi-discord daemon status` — check for errors
- `pi-discord daemon logs` — see journal output
- Ensure `systemctl --user` works in your environment
- For headless servers: enable user lingering (`loginctl enable-linger $USER`)
</details>

<details>
<summary><strong>Bot is online but doesn't respond</strong></summary>

- Run `pi-discord channels` — at least one channel must be registered
- For mention-only channels: mention the bot or use `@TriggerName`
- DMs auto-register when `AUTO_REGISTER_DMS=true`
</details>

## Architecture

```
src/
├── cli.ts              CLI entrypoint and command dispatch
├── setup.ts            Interactive setup wizard
├── status.ts           Local diagnostics
├── daemon.ts           systemd user service management
├── index.ts            Gateway startup orchestration
├── discord.ts          Discord.js client, message handling, slash commands
├── db.ts               SQLite schema, channel registry, message queue
├── queue.ts            Polling loop, concurrency control
├── agent.ts            pi subprocess execution and session stats
├── config.ts           Environment + config file loading with precedence
├── model-catalog.ts    pi model discovery via SDK
├── channel-settings.ts Per-channel model/thinking resolution
├── session-path.ts     Session folder validation and resolution
├── attachments.ts      Attachment selection within size limits
├── media.ts            Attachment download and cleanup
├── logger.ts           Pino logger
└── types.ts            Shared type definitions

test/
├── attachments.test.ts
├── cli.test.ts
├── config.test.ts
├── session-path.test.ts
└── setup.test.ts
```

## Development

```bash
npm install
npm run dev          # Start with tsx (no build needed)
npm run build        # Compile TypeScript
npm test             # Run Vitest suite
npm run test:watch   # Watch mode
```

## Security

- Protect `config.env` — it contains your Discord bot token
- Anyone who can message a registered channel can spend your pi usage
- Review attachment size limits before exposing the bot
- Run the service as a normal user, not root
- The gateway stores conversation history on disk as pi session files

## License

MIT

## Acknowledgments

- Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) — the lightweight, container-isolated Claude agent assistant
- Built for [pi-mono](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic)
