# Changelog

All notable changes to this project will be documented in this file.

## [1.6.1] - 2026-06-15

### Fixed

- Remove stale hardcoded README current-version text so npm/GitHub documentation does not show an outdated release number.

## [1.6.0] - 2026-06-15

### Changed

- Discord attachments are now passed to `pi` by local file path instead of being injected with `@file`. This keeps binary and structured files such as DOCX, XLSX, PDFs, and images out of the model context while still letting the agent inspect or convert them with tools.
- Downloaded attachment media is retained for a configurable period so path-based agent workflows can continue after the initial message. New config: `MEDIA_RETENTION_HOURS` (default: `168`, one week).

### Fixed

- Empty stdout from `pi` no longer becomes an unhelpful `(empty response)` Discord reply. piscord now reports the recorded agent/session error when available, including context-window errors such as `context_length_exceeded`.
- Prevent large or binary attachments from flooding the model context and causing repeated empty responses in the affected channel session.

## [1.5.3] - 2026-05-19

### Fixed

- Fix false `Required peer dependency @earendil-works/pi-ai is not installed` startup error when resolving ESM-only pi packages — thanks @kojira (#10), @hritique (#8)
- Fix cross-platform test failures: config path assertions now use platform-aware defaults instead of hardcoded Linux/XDG paths — thanks @hritique (#9)

## [1.5.2] - 2026-05-16

### Changed

- Refresh README presentation for npm/GitHub with banner, badges, and updated project summary

## [1.5.1] - 2026-05-15

### Added

- Startup check for legacy `@mariozechner/pi-ai` — users on the old package now get a clear upgrade message instead of a module-not-found crash

## [1.5.0] - 2026-05-15

### Added

- macOS launchd support for `piscord daemon` commands — thanks @that-yolanda (#6)
- Windows compatibility for pi subprocess spawning (dynamic .cmd shim resolution)
- Windows `SIGBREAK` signal handling for graceful shutdown
- Cross-platform executable lookup (`where` on Windows, `which` on Linux/macOS)

### Changed

- Migrate pi dependencies from `@mariozechner/*` to `@earendil-works/*` scope (pi v0.74.0+)
- Platform-aware default paths: XDG on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows
- Build script now works cross-platform (replaced `rm -rf` with Node.js `fs.rmSync`)
- Help text uses platform-neutral wording for daemon commands

### Fixed

- `piscord status` no longer crashes on macOS/Windows (removed unconditional systemctl dependency)
- `which` command replaced with cross-platform executable lookup in setup and status

## [1.4.3] - 2026-05-03

### Fixed

- Restore startup compatibility with @mariozechner/pi-ai 0.72.x thinking level APIs
- Keep legacy @mariozechner/pi-ai compatibility by falling back to the older `supportsXhigh` helper when available

## [1.4.2] - 2026-04-06

### Fixed

- Align default runtime XDG data directory with setup and docs to use `~/.local/share/piscord-gateway`
- Add regression coverage for default `DB_PATH` and `SESSIONS_DIR` resolution

## [1.4.1] - 2026-04-06

### Fixed

- Support text-only sends via `piscord send` without requiring file attachment

## [1.4.0] - 2026-04-06

### Added

- Per-channel working directories - override `PI_CWD` for specific channels without changing the global default

### Changed

- Group task and file relay tools documentation for pi users

## [1.3.0] - 2026-04-04

### Added

- Improved setup UX with faster install and default trigger

### Fixed

- Remove JSON.stringify quoting in systemd service file

## [1.2.0] - 2026-04-04

### Added

- Channel access policy (open / open-trigger / allowlist)
- `/pi stop` command to abort active task and clear queue
- Archived session auto-cleanup with configurable retention
- Scheduled tasks via CLI and scheduler engine
- Direct send-file CLI tool for Discord channels
- Per-channel model override via `/pi model`
- Thinking level control via `/pi thinking`
- Fresh session via `/pi new`

## [1.1.0] - 2026-03-31

### Changed

- Renamed package and CLI to piscord

## [1.0.0] - 2026-03-28

### Added

- Initial release
- Discord message to pi subprocess bridging
- Per-channel persistent sessions
- SQLite message queue
- Discord slash commands
- Attachment relay
- systemd integration
