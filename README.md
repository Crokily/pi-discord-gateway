# piscord

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
- **Channel access policy** — `open` (all channels), `open-trigger` (all channels, @mention required), or `allowlist` (manual registration)
- **SQLite message queue** — survives crashes, auto-recovers stuck messages
- **Concurrency control** — per-channel serial processing + configurable global limit
- **DM auto-registration** — direct messages work out of the box
- **Discord slash commands** — `/pi status`, `/pi model`, `/pi thinking`, `/pi new`, `/pi stop`
- **Abort command** — `/pi stop` terminates the running task and clears queued messages
- **Attachment relay** — Discord file uploads are downloaded and passed to `pi` via `@file`
- **File sending** — `piscord send` lets pi send files to any Discord channel
- **Scheduled tasks** — cron or one-time tasks that trigger pi sessions on schedule
- **Archive auto-cleanup** — archived sessions are cleaned up after a configurable retention period
- **Typing indicators** — shows "bot is typing" while `pi` processes
- **Message splitting** — handles Discord's 2000-character limit automatically
- **systemd integration** — `piscord daemon install` generates a user service
- **XDG-compliant paths** — config in `~/.config/`, data in `~/.local/share/`

## Quick Start

```bash
# 1. Install (requires pi to be installed and logged in)
npm install -g piscord

# 2. Setup — walks you through config (including channel policy)
piscord setup

# 3. Start (if you chose "open" policy, channels auto-register — no step 3 needed)
piscord start
```

If you chose `allowlist` policy during setup, register channels manually:

```bash
piscord register 123456789012345678 "my-server #general" --no-trigger
```

## Prerequisites

- **Node.js** ≥ 20
- **[pi](https://github.com/badlogic/pi-mono)** installed and on `PATH`
- **pi login** completed (`~/.pi/agent/auth.json` must exist)
- **Discord bot token** — [create one here](https://discord.com/developers/applications)
  - Enable **Message Content Intent** under Privileged Gateway Intents
  - Bot permissions: `Send Messages`, `Read Message History`, `View Channels`, `Attach Files`

## Installation

### npm (recommended)

```bash
npm install -g piscord
```

### npx (quick trial)

```bash
npx piscord@latest setup
```

### From source

```bash
git clone https://github.com/Crokily/pi-discord-gateway.git
cd pi-discord-gateway
npm install
npm run build
node dist/cli/index.js help
```

## How It Connects to `pi`

The gateway **does not embed or replace `pi`**. It finds and runs your installed `pi`:

1. **Binary discovery** — uses `PI_BIN` config or finds `pi` in `PATH`
2. **Auth reuse** — `pi` reads its own `~/.pi/agent/auth.json` when invoked
3. **Model catalog** — the gateway imports `AuthStorage` + `ModelRegistry` from the pi SDK to populate slash command autocomplete
4. **Invocation** — each message is processed as `pi --session-dir <dir> --continue -p <message>`

If `piscord setup` finds `pi` in your PATH, it tells you. If not, set `PI_BIN=/full/path/to/pi` in your config.

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
| `TRIGGER_NAME` | `pi` | Bot trigger name for @mentions |
| `CHANNEL_POLICY` | `allowlist` | Channel access: `open`, `open-trigger`, or `allowlist` |
| `EXCLUDED_CHANNELS` | *(none)* | Comma-separated channel IDs to exclude from auto-registration |
| `MAX_CONCURRENCY` | `3` | Max parallel pi invocations |
| `MAX_SCHEDULED_CONCURRENCY` | `1` | Max scheduled tasks enqueued per tick |
| `POLL_INTERVAL_MS` | `1000` | Queue poll interval (ms) |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown timeout (ms) |
| `AUTO_REGISTER_DMS` | `true` | Auto-register DM channels |
| `ARCHIVE_RETENTION_DAYS` | `30` | Days to keep archived sessions (0 = never clean) |
| `MAX_ATTACHMENT_BYTES` | `26214400` | Max size per attachment (0 = no limit) |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800` | Max combined attachment size (0 = no limit) |
| `SESSIONS_DIR` | `~/.local/share/pi-discord-gateway/sessions` | Session storage directory |
| `DB_PATH` | `~/.local/share/pi-discord-gateway/gateway.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level: debug/info/warn/error |

### Channel Policy

| Policy | Behavior |
|--------|----------|
| `open` | All guild channels auto-register on first message. No @mention needed. |
| `open-trigger` | All guild channels auto-register, but require @mention to respond. |
| `allowlist` | Only manually registered channels are active (legacy default). |

Use `EXCLUDED_CHANNELS` to block specific channels from auto-registration in `open` / `open-trigger` mode.

## CLI Reference

```
piscord setup [token]                         Interactive setup wizard
piscord start                                 Start gateway (foreground)
piscord status                                Show diagnostics

piscord channels                              List registered channels
piscord register <id> <name> [options]        Register a channel
piscord unregister <id>                       Unregister a channel

piscord send --channel <jid> --file <path> [--file <path> ...] [--text <msg>]
                                              Send files to a Discord channel

piscord task add --name <n> --schedule <cron|iso> --channel <jid> --prompt <text> [--once]
piscord task list                             List scheduled tasks
piscord task remove <id>                      Remove a scheduled task
piscord task enable <id>                      Enable a scheduled task
piscord task disable <id>                     Disable a scheduled task

piscord archive list                          List archived sessions
piscord archive cleanup [--dry-run]           Clean up expired archived sessions

piscord daemon install                        Install systemd user service
piscord daemon uninstall                      Remove systemd user service
piscord daemon start|stop|status|logs         Control the service
piscord help                                  Show help
```

### Register options

- `--no-trigger` — respond to all messages (not just @mentions)
- `--main` — main channel (implies `--no-trigger`)
- `--folder <name>` — custom session folder name

### Task options

- `--once` — treat `--schedule` as a one-time ISO datetime instead of cron

## Slash Commands

The gateway registers a global `/pi` command on Discord:

| Subcommand | Description |
|------------|-------------|
| `/pi status` | Show model, thinking, session info, token usage |
| `/pi model` | Set channel model (autocomplete from pi's available models) |
| `/pi reset-model` | Clear channel model override |
| `/pi thinking` | Set thinking level: off / minimal / low / medium / high / xhigh |
| `/pi new` | Start a fresh session for this channel |
| `/pi stop` | Abort the current task and clear queued messages |

## Scheduled Tasks

The gateway includes a scheduler that executes tasks by injecting prompts into the message queue:

```bash
# Run a prompt every day at 9am UTC
piscord task add --name "daily-report" \
  --schedule "0 9 * * *" \
  --channel dc:123456789 \
  --prompt "Generate today's summary report"

# Run a one-time reminder
piscord task add --name "meeting-reminder" \
  --schedule "2026-04-05T14:00:00Z" \
  --channel dc:123456789 \
  --prompt "Remind Colin about the 2pm meeting" \
  --once

# Manage tasks
piscord task list
piscord task disable 1
piscord task enable 1
piscord task remove 1
```

Tasks share the normal message queue — they are processed by the same pi agent with the channel's configured model and thinking level.

## File Sending

Pi can send files to Discord channels via the built-in `piscord send` tool:

```bash
piscord send --channel dc:123456789 --file /path/to/report.pdf --text "Here's the report"
piscord send --channel dc:123456789 --file chart.png --file data.csv
```

- Max 10 files per message (Discord limit)
- Respects `MAX_ATTACHMENT_BYTES` per file
- Uses the bot token from config — no running daemon required

## systemd Service

```bash
piscord daemon install   # Generate + enable user service
piscord daemon start     # Start
piscord daemon status    # Check
piscord daemon logs      # Tail journal
piscord daemon stop      # Stop
piscord daemon uninstall # Remove
```

The generated service uses the same config file from `piscord setup`.

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
docker build -t piscord .
docker run -d \
  --env-file .env \
  -v pi-discord-data:/data \
  -v ~/.pi/agent/auth.json:/home/node/.pi/agent/auth.json:ro \
  -e SESSIONS_DIR=/data/sessions \
  -e DB_PATH=/data/gateway.db \
  piscord
```

## Data Locations

| Item | Default path |
|------|-------------|
| Config | `~/.config/pi-discord-gateway/config.env` |
| Database | `~/.local/share/pi-discord-gateway/gateway.db` |
| Sessions | `~/.local/share/pi-discord-gateway/sessions/` |
| pi auth | `~/.pi/agent/auth.json` |

## Architecture

```
src/
├── index.ts                  Gateway startup orchestration
├── config.ts                 Environment + config loading
├── db.ts                     SQLite schema, channels, queue, scheduled tasks
├── types.ts                  Shared type definitions
├── logger.ts                 Pino logger
│
├── discord/
│   ├── client.ts             Discord.js client, message handling
│   ├── slash-commands.ts     /pi command and subcommands
│   ├── attachments.ts        Attachment selection within size limits
│   └── send.ts               Direct file sending via Discord REST
│
├── agent/
│   ├── invoke.ts             pi subprocess execution and session stats
│   ├── queue.ts              Polling loop, concurrency control, abort
│   ├── channel-settings.ts   Per-channel model/thinking resolution
│   ├── model-catalog.ts      pi model discovery via SDK
│   └── scheduler.ts          Cron/one-time task scheduling engine
│
├── session/
│   ├── path.ts               Session folder validation and resolution
│   ├── media.ts              Attachment download and periodic cleanup
│   └── archive-cleanup.ts    Archived session retention and cleanup
│
└── cli/
    ├── index.ts              CLI entrypoint and command dispatch
    ├── daemon.ts             systemd user service management
    ├── setup.ts              Interactive setup wizard
    └── status.ts             Local diagnostics
```

## Troubleshooting

<details>
<summary><strong>pi not found in PATH</strong></summary>

`piscord status` shows "Pi binary: not found".

- Check `pi --version` works in the same shell
- Set `PI_BIN=/full/path/to/pi` in config.env
- After changing config: `piscord daemon stop && piscord daemon start`
</details>

<details>
<summary><strong>Missing auth.json</strong></summary>

`piscord status` shows "Pi auth: missing".

- Run `pi login`
- Confirm `~/.pi/agent/auth.json` exists for the same user running the gateway
</details>

<details>
<summary><strong>systemd service won't start</strong></summary>

- `piscord daemon status` — check for errors
- `piscord daemon logs` — see journal output
- Ensure `systemctl --user` works in your environment
- For headless servers: enable user lingering (`loginctl enable-linger $USER`)
</details>

<details>
<summary><strong>Bot is online but doesn't respond</strong></summary>

- If using `allowlist` policy: run `piscord channels` — at least one channel must be registered
- If using `open` policy: check `EXCLUDED_CHANNELS` doesn't include your channel
- For mention-only channels: mention the bot or use `@TriggerName`
- DMs auto-register when `AUTO_REGISTER_DMS=true`
</details>

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
