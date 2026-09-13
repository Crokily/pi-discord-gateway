# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- Require Node.js >=22.19.0 and pi >=0.83.0 <0.86.0; develop against pi 0.85.1. Setup and startup diagnose unsupported dependencies before loading the runtime.
- Model discovery is asynchronous, cached by working directory, and bounded in concurrency and duration. CLI failures retain stale data; cold failures await an initialized SDK fallback. Valid empty lists and discovery errors are distinct.
- Restart recovery retains pending work and resumes persisted answer delivery. Tasks interrupted during execution are reported instead of automatically rerun.

### Added

- Per-channel opt-in automatic conversation threads via `/pi threads` or `piscord threads <id> on|off`, with independent sessions and dynamic parent model/thinking/cwd inheritance. User questions and schedules share routing. Thread deletion cancels pending work, disables schedules and archives sessions for retention cleanup.
- `/pi reset-thinking` restores inherited/default thinking settings.
- Persisted answer chunks, bounded delivery retries and reconciliation of uncertain sends. `piscord result <task-id>` reads a saved answer without executing the task again.
- A gateway instance lock and per-invocation process supervision. `AGENT_TIMEOUT_MS` optionally limits task duration; the default remains unlimited.
- Real pi compatibility smoke tests using an isolated configuration and local HTTP model, including CLI discovery, SDK fallback, extension discovery and session continuation.

### Fixed

- New pi releases no longer fail on the removed AuthStorage export or obsolete ModelRegistry initialization.
- Reply metadata no longer hides an explicit bot mention from trigger matching.
- Cancellation, shutdown and timeout clean up process listeners and timers; stopped tasks are not revived on restart.

### Acknowledgements

- @philipstray for the ModelRuntime diagnosis and migration proposal in #15; reporters of #14 and #16.
- @jolo-dev for #12 and @chhotu-claw for the original auto-threading proposal in #7.
- @Malaga82's fork informed the investigation of discovery, process limits, instance locking and delivery failure handling. These changes implement the agreed recovery semantics independently.

## [1.7.0] - 2026-07-17

### Changed

- Discord `/pi model` now reads the model catalog from the configured pi binary (`PI_BIN --list-models`) and honors pi's configured `enabledModels` scope, including glob patterns and configured order. The bundled SDK catalog is used only as a fallback when the command fails.
- Model catalogs are prewarmed at startup for all registered channel working directories. `/pi model` autocomplete responds from the cache to stay inside Discord's response deadline and refreshes expired catalogs in the background.
- `PI_EXTRA_FLAGS` is now passed to model discovery as well, so models registered by pi extensions appear in the catalog.

### Fixed

- Model discovery via `pi --list-models` is bounded by a 15s timeout, so a hung pi install can no longer block gateway startup or slash commands.
- The model list parser now locates the table header instead of assuming it is the first output line, so banners printed by pi extensions no longer result in an empty catalog.
- `/pi model` autocomplete in unregistered channels returns no choices without spawning pi.

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
