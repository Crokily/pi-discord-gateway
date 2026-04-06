# Changelog

All notable changes to this project will be documented in this file.

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