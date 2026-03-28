# pi-discord-gateway

Lightweight Discord gateway for [pi coding agent](https://github.com/badlogic/pi-mono). Receives Discord messages, queues them, invokes pi as a subprocess, and sends responses back.

Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) — the same "channels → SQLite → polling loop → agent subprocess → response" pattern, stripped down to ~500 lines of TypeScript focused purely on the Discord ↔ pi bridge.

```
Discord ──discord.js──→ Gateway ──pi subprocess──→ Pi Agent
                           │                          │
                         SQLite                  Session dirs
                      (message queue)           (per channel)
```

## Features

- **Per-channel pi sessions** — each Discord channel gets its own persistent conversation history
- **Message queue** — SQLite-backed, survives crashes, auto-recovers stuck messages
- **Concurrency control** — per-channel serial processing + configurable global limit
- **@mention trigger** — bot responds only when @mentioned (configurable per channel)
- **DM auto-registration** — direct messages work out of the box
- **Typing indicators** — shows "bot is typing" while pi processes
- **Message splitting** — handles Discord's 2000-character limit
- **Attachments & replies** — attachment placeholders and reply context forwarded to pi
- **CLI channel management** — register/unregister channels from the command line

## Quick Start

### 1. Prerequisites

- Node.js 20+
- [pi](https://github.com/badlogic/pi-mono) installed and configured
- A Discord bot token ([create one here](https://discord.com/developers/applications))

### 2. Install

```bash
git clone https://github.com/patchfx/pi-discord-gateway.git
cd pi-discord-gateway
npm install
npm run build
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set DISCORD_BOT_TOKEN
```

### 4. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → name it
3. **Bot** tab → **Reset Token** → copy it to `.env`
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. **OAuth2 → URL Generator**: scope `bot`, permissions: `Send Messages`, `Read Message History`, `View Channels`
6. Open the generated URL to invite the bot to your server

### 5. Register a Channel

```bash
# Get the channel ID: Discord → User Settings → Advanced → Developer Mode
# Then right-click a channel → Copy Channel ID

node dist/index.js register 1234567890 "my-server #general" --no-trigger
```

Options:
- `--no-trigger` — respond to all messages (not just @mentions)
- `--main` — mark as main/admin channel (implies `--no-trigger`)
- `--folder <name>` — custom session folder name

### 6. Start

```bash
node dist/index.js
```

### Development

```bash
npm run dev   # run with tsx (no build needed)
```

## CLI Reference

```bash
node dist/index.js                              # Start gateway
node dist/index.js register <id> <name> [opts]  # Register channel
node dist/index.js unregister <id>              # Unregister channel
node dist/index.js channels                     # List channels
node dist/index.js help                         # Show help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | *(required)* | Discord bot token |
| `PI_BIN` | `pi` | Path to pi binary |
| `PI_MODEL` | *(none)* | Model for pi (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `PI_THINKING` | *(none)* | Thinking level |
| `TRIGGER_NAME` | `Andy` | Name used in trigger pattern (`@Andy`) |
| `MAX_CONCURRENCY` | `3` | Max parallel pi invocations |
| `AUTO_REGISTER_DMS` | `true` | Auto-register DM channels |
| `SESSIONS_DIR` | `./sessions` | Per-channel session storage |
| `DB_PATH` | `./gateway.db` | SQLite database path |
| `PI_CWD` | `$HOME` | Working directory for pi |
| `PI_EXTRA_FLAGS` | *(none)* | Extra flags passed to pi |
| `LOG_LEVEL` | `info` | Log level: debug/info/warn/error |

## systemd Service

```bash
# Install as user service
cp pi-discord-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable pi-discord-gateway
systemctl --user start pi-discord-gateway

# View logs
journalctl --user -u pi-discord-gateway -f
```

## Architecture

- **`src/discord.ts`** — Discord.js client: receives messages, sends responses, typing indicators
- **`src/db.ts`** — SQLite: channel registry, message queue, message log
- **`src/queue.ts`** — Polling loop: claims messages, enforces concurrency, dispatches to agent
- **`src/agent.ts`** — Spawns `pi --session <dir> -p <message>` subprocesses
- **`src/config.ts`** — Environment-based configuration
- **`src/index.ts`** — Entry point: CLI commands + gateway startup

Each channel gets its own pi session directory (`sessions/<folder>/`), so conversation history is fully isolated and persistent.

## Acknowledgments

- Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) by [@gavrielc](https://github.com/gavrielc) — the lightweight, container-isolated Claude agent assistant. NanoClaw's clean "channels → SQLite → agent" pattern and Discord channel implementation ([`nanoclaw-discord`](https://github.com/qwibitai/nanoclaw-discord)) were the primary reference for this project.
- Built for [pi-mono](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic).

## License

MIT
