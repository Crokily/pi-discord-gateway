# Maintenance validation

Validated on 2026-09-14 before PR submission. Live Discord regression exercised runtime revision `72c4d72`. Subsequent CI fixes resolve Windows npm command shims and make test paths/checkouts portable.

## Automated checks

- 92 tests across 21 files pass on the minimum supported Node.js version, 22.19.0.
- ESLint, Prettier, source/test type checking, build, and `git diff --check` pass.
- Real pi 0.83.0, 0.84.2 and 0.85.1 package fixtures were exercised during implementation, including SDK fallback, CLI discovery, extension models and session continuation. Node 24 and mixed SDK/CLI versions were also exercised. The final runtime revision was smoke-tested with pi 0.85.1 again.
- New queue integration tests use real supervised processes and SQLite. They cover active cancellation, pending cancellation, independent conversations, bounded shutdown, restart without replay, timeout despite ignored SIGTERM, and resuming long-answer delivery without invoking pi again.
- POSIX fault injection kills a gateway fixture with SIGKILL, verifies its owned child exits, and recovers the abandoned lock after advancing that lock's modification time past the stale threshold.
- Delivery tests cover lost acknowledgements, nonce reconciliation, expiry of the safe resend window, permanent rejection, rate-limit backoff, ordering, progress-based retry budgets and late failure after cancellation.
- Slash command tests cover user/bot permissions, invalid thread targets, disabling after permission removal, and resetting thread overrides without modifying parent defaults.

## Real Discord regression

The existing Linux deployment was backed up and upgraded in an independent release directory. Tests used an existing dedicated test channel and disposable threads.

| Area                                                                                                 | Result           |
| ---------------------------------------------------------------------------------------------------- | ---------------- |
| Existing database migration, startup, model discovery and slash registration                         | Passed           |
| Model autocomplete and channel override                                                              | Passed           |
| Ordinary response and persisted delivery                                                             | Passed           |
| Automatic thread opt-in, original-message anchor and no-mention continuation                         | Passed           |
| Independent thread history and inherited parent model                                                | Passed           |
| Disabling automatic threads while existing conversations remain usable                               | Passed           |
| Session status, new-session rotation and cleared conversation history                                | Passed           |
| Thinking override and reset                                                                          | Passed           |
| Uploaded text attachment downloaded and read by pi                                                   | Passed           |
| 2,969-character response split into two confirmed Discord messages                                   | Passed           |
| CLI file upload                                                                                      | Passed           |
| One-time schedule routed through a parent thread and into an existing thread                         | Passed           |
| Manual thread ignored under allowlist until separately registered                                    | Passed after fix |
| Active task and queued task cancelled with `/pi stop`                                                | Passed           |
| Scheduled response to an archived thread                                                             | Passed           |
| Thread deletion disables its schedule; startup cleanup archives its session and removes registration | Passed           |
| Restart retains cancellation and does not rerun completed tasks                                      | Passed           |
| Saved-answer retrieval with `piscord result`                                                         | Passed           |

## Issues found and fixed

1. A Discord ThreadCreated system notice was treated as a user prompt in a parent with automatic threads enabled. It could cause a manually created thread to be adopted and bypass separate allowlist registration. System notices are now ignored before registration or enqueueing; the failure was reproduced in a test and the fix was verified in a new real Discord thread.
2. Windows real-package CI exposed a configured npm `.cmd` path being passed directly to `spawn`, producing EINVAL while cold discovery could fall back to the SDK. Explicit shim paths now resolve to their Node entry point; the smoke test asserts CLI discovery independently of SDK fallback.
3. A Discord request that failed after `/pi stop` could overwrite cancellation with a delivery failure and create an unwanted notice. Delivery now rechecks cancellation/current state after asynchronous operations. A failing regression test demonstrated the original race.

The deployment also had two configuration issues: the service PATH omitted an installed CLI required by a pi extension, and its global model referenced a model no longer available to that account. PATH was corrected and only the test channel's model was changed to the already configured pi default. These were environment changes, not gateway code fixes.

## Scope and remaining limits

This is sufficient for PR review, not a claim that every operating system, Discord permission combination or external provider failure has been exercised live. CI includes Windows/macOS jobs; see the PR checks for results on each commit. Real Discord testing remains Linux-only. Rate limits, ambiguous delivery and hard crashes were tested with isolated transports/processes rather than fault injection against the live bot. Open/open-trigger access policies, exclusions, attachment limits, retention and CLI validation also have automated coverage.

After testing, temporary schedules were removed, the test channel's automatic threads were switched off, and the upgraded service was left running. The original installation and pre-upgrade data/configuration backups remain available.
