# Configuration Reference

Edit Guard settings are managed by `ConfigManager` from `@k0valik/pi-base`.
The config file is `edit-guard-config.json`, loaded with layered resolution:

```
defaults <- global (~/.pi/agent/extensions/) <- project (<cwd>/.pi/) <- env
```

Settings can also be changed at runtime with `/edit-guard:config`.

## Schema

| Key                         | Default    | Description                                                                                                                                                                                          |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editOverrideEnabled`       | `true`     | Killswitch — when false, the built-in `edit` tool is not overridden.                                                                                                                                 |
| `repairEnabled`             | `true`     | Argument repair pipeline (native-compat subset always runs).                                                                                                                                         |
| `repairPolicy`              | `adaptive` | `conservative`, `adaptive`, or `recover`.                                                                                                                                                            |
| `staleReadEnabled`          | `true`     | Stale-read protection.                                                                                                                                                                               |
| `staleReadToleranceMs`      | `500`      | Mtime tolerance (>= 0).                                                                                                                                                                              |
| `stormbreakerEnabled`       | `true`     | Error enhancement + loop breaking.                                                                                                                                                                   |
| `stormbreakerThreshold`     | `3`        | Same-signature failures within the sliding window before breaking (clamped 1-10).                                                                                                                    |
| `stormbreakerAutoContinue`  | `true`     | Auto-resume with a corrective retry prompt after a loop break.                                                                                                                                       |
| `stormbreakerRetryDelayMs`  | `3000`     | Pause before the automatic retry turn (clamped 1000-10000).                                                                                                                                          |
| `preflightEnabled`          | `true`     | Path preflight.                                                                                                                                                                                      |
| `overwriteGuardEnabled`     | `false`    | Block first `write` overwrite of an existing non-empty file per session. Useful for small local models that silently drop code by overwriting from memory — enable this to force them toward `edit`. |
| `warningsEnabled`           | `true`     | TUI notifications for edit warnings.                                                                                                                                                                 |
| `coherenceCheckEnabled`     | `false`    | Post-edit coherence checker (indentation jumps).                                                                                                                                                     |
| `undoEnabled`               | `true`     | Per-file undo history.                                                                                                                                                                               |
| `undoMaxBytes`              | `5000000`  | Byte budget for the JSONL undo dump, FIFO eviction (clamped 64 KB - 50 MB).                                                                                                                          |
| `outsideCwdAdvisoryEnabled` | `true`     | Emit a one-line advisory when a tool accesses a path outside the current working directory.                                                                                                          |
| `telemetryEnabled`          | `true`     | Local audit trail — records what was fixed and which passes fired. Stays on your machine, never sent anywhere.                                                                                       |

## Example

```jsonc
// Global: ~/.pi/agent/extensions/edit-guard-config.json
// Project: <cwd>/.pi/edit-guard-config.json
{
  "editOverrideEnabled": true,
  "repairEnabled": true,
  "repairPolicy": "adaptive",
  "staleReadEnabled": true,
  "staleReadToleranceMs": 500,
  "stormbreakerEnabled": true,
  "stormbreakerThreshold": 3,
  "stormbreakerAutoContinue": true,
  "stormbreakerRetryDelayMs": 3000,
  "preflightEnabled": true,
  "overwriteGuardEnabled": false,
  "warningsEnabled": true,
  "coherenceCheckEnabled": false,
  "undoEnabled": true,
  "undoMaxBytes": 5000000,
  "outsideCwdAdvisoryEnabled": true,
  "telemetryEnabled": true,
}
```

## Environment variables

Environment variables override file config. Boolean vars accept `1/0`, `true/false`, `on/off`, `yes/no`.

| Variable                                  | Default    | Description                                                          |
| ----------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `EDIT_GUARD_EDIT_OVERRIDE_ENABLED`        | `true`     | Killswitch — override `edit` (when false, native edit remains)       |
| `EDIT_GUARD_REPAIR_ENABLED`               | `true`     | Enable argument repair                                               |
| `EDIT_GUARD_REPAIR_POLICY`                | `adaptive` | Repair policy: `conservative`, `adaptive`, or `recover`              |
| `EDIT_GUARD_STALE_READ_ENABLED`           | `true`     | Enable stale-read protection                                         |
| `EDIT_GUARD_STALE_READ_TOLERANCE_MS`      | `500`      | Mtime tolerance in milliseconds                                      |
| `EDIT_GUARD_STORMBREAKER_ENABLED`         | `true`     | Enable error enhancement + loop breaking                             |
| `EDIT_GUARD_STORMBREAKER_THRESHOLD`       | `3`        | Same-signature failures before breaking the loop                     |
| `EDIT_GUARD_STORMBREAKER_AUTO_CONTINUE`   | `true`     | Auto-resume after loop break                                         |
| `EDIT_GUARD_STORMBREAKER_RETRY_DELAY_MS`  | `3000`     | Pause before automatic retry turn (clamped 1000-10000)               |
| `EDIT_GUARD_PREFLIGHT_ENABLED`            | `true`     | Enable path preflight                                                |
| `EDIT_GUARD_OVERWRITE_GUARD_ENABLED`      | `false`    | Enable write guard for non-empty file overwrites                     |
| `EDIT_GUARD_WARNINGS_ENABLED`             | `true`     | TUI notifications for edit warnings                                  |
| `EDIT_GUARD_COHERENCE_CHECK_ENABLED`      | `false`    | Post-edit coherence checker                                          |
| `EDIT_GUARD_UNDO_ENABLED`                 | `true`     | Enable per-file undo history                                         |
| `EDIT_GUARD_UNDO_MAX_BYTES`               | `5000000`  | Byte budget for undo store (clamped 64 KB - 50 MB)                   |
| `EDIT_GUARD_OUTSIDE_CWD_ADVISORY_ENABLED` | `true`     | Emit advisory when a tool accesses a path outside cwd                |
| `EDIT_GUARD_TELEMETRY_ENABLED`            | `true`     | Forward guard events to the session audit trail (`edit-guard:event`) |

## Repair policy profiles

| Profile        | Truncated-envelope completion | Valid-value transforms | Grammar mode |
| -------------- | ----------------------------- | ---------------------- | ------------ |
| `conservative` | off                           | off                    | observe      |
| `adaptive`     | on                            | on                     | strip        |
| `recover`      | on                            | on                     | recover      |

Default: `adaptive`.
