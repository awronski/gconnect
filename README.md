# gconnect

`gconnect` is an experimental, read-only command-line client for exporting Garmin Connect data as structured JSON.

It is written in strict TypeScript and keeps authentication, downloads, data processing, output, and individual features behind separate component boundaries. New datasets can be added without changing the CLI framework or existing features.

> [!WARNING]
> This project uses private, undocumented Garmin interfaces. It is not affiliated with or endorsed by Garmin. Garmin may change or block these interfaces at any time. Use it only with an account and data you are authorized to access.

## Features

- Activities: lists, filters, chart details, and optional full-resolution polylines.
- Sleep: score, stages, duration, respiration, Pulse Ox, and other daily fields returned by Garmin.
- Daily health: heart rate, stress, Body Battery, respiration, and Pulse Ox.
- Performance: training status and HRV.
- Inclusive date ranges of up to 366 days.
- Lossless handling of large Garmin identifiers.
- Machine-readable JSON for successes, help, and errors.
- Atomic file output for scripts and scheduled jobs.
- Renewable terminal authentication with MFA support.
- Optional browser-assisted recovery when Garmin requires an interactive challenge.
- A constrained, read-only `api get` escape hatch for other `/gc-api/` endpoints.

The CLI never uploads, edits, or deletes Garmin data.

## Requirements

- Node.js 24 or newer
- npm
- A Garmin Connect account

## Install from source

After cloning the repository:

```sh
npm ci
npm run build
npm link
```

Verify the installation:

```sh
gconnect --version
gconnect --help
```

You can also run the compiled entry point without linking it:

```sh
node dist/bin/gconnect.js --help
```

## Quick start

Authenticate entirely in the terminal:

```sh
gconnect auth login --no-auth-recovery
gconnect auth status --verify
```

The CLI prompts for the username, password, and MFA code when needed. Password input is hidden and is never accepted as a command-line argument.

Download some data:

```sh
gconnect activities list --limit 20
gconnect health sleep --date 2026-07-01
gconnect health heart-rate --from 2026-07-01 --to 2026-07-07
gconnect performance hrv --from 2026-07-01 --to 2026-07-07
```

Write the JSON result atomically to a file:

```sh
gconnect health sleep \
  --from 2026-07-01 \
  --to 2026-07-07 \
  --output sleep.json
```

The file is written to `.gconnect-private/outputs/sleep.json`. `--output` accepts a filename, not an absolute or nested path.

## Commands

| Command | Description |
|---|---|
| `auth login` | Create a renewable terminal session. |
| `auth status --verify` | Inspect the redacted session and verify it against Garmin. |
| `auth recover` | Recover authentication through the optional browser companion. |
| `auth disconnect` | Remove all locally stored Garmin sessions. |
| `activities list` | List and filter activities. |
| `activities get <id>` | Download activity chart details and optionally its polyline. |
| `health sleep` | Download daily sleep data. |
| `health pulse-ox` | Download daily Pulse Ox data. |
| `health respiration` | Download daily respiration data. |
| `health heart-rate` | Download daily heart-rate data. |
| `health stress` | Download daily stress data. |
| `health body-battery` | Download Body Battery series and events. |
| `performance training-status` | Download training status and related factors. |
| `performance hrv` | Download daily or range HRV data. |
| `api get <path>` | Perform an authenticated read-only GET for a `/gc-api/` path. |
| `system describe` | Return the complete command catalogue as JSON. |

Every daily health and performance command requires either:

```text
--date YYYY-MM-DD
```

or an inclusive range:

```text
--from YYYY-MM-DD --to YYYY-MM-DD
```

Use command-specific JSON help to discover every option:

```sh
gconnect activities list --help
gconnect system describe --command health.sleep
```

### Activity examples

```sh
gconnect activities list \
  --from 2026-07-01 \
  --to 2026-07-31 \
  --type walking \
  --limit 50

gconnect activities get 123456789
gconnect activities get 123456789 --include-polyline
```

### Raw data

Activities, health, and performance commands accept `--raw`. Raw mode preserves the validated Garmin payload rather than applying domain normalization:

```sh
gconnect health stress --date 2026-07-01 --raw
```

`api get` is inherently raw and is deliberately constrained to:

- the `GET` method;
- a relative `/gc-api/` path;
- configured Garmin-owned origins;
- managed authentication headers;
- bounded response sizes;
- secret-redacted errors.

It cannot send arbitrary methods, origins, cookies, headers, or request bodies.

## Authentication

### Terminal login

Terminal login is the recommended path and does not require a browser extension:

```sh
gconnect auth login --no-auth-recovery
```

The session uses Garmin's private mobile authentication flow. It supports renewable access tokens and interactive MFA, but Garmin may still require CAPTCHA or another browser challenge.

For non-interactive environments, the CLI also supports `--username`, `--password-stdin`, `GARMIN_USERNAME`, `GARMIN_PASSWORD`, and `GARMIN_MFA_CODE`. Prefer hidden terminal input or a dedicated secret manager. Environment variables may be visible to other processes or diagnostics on shared systems.

### Optional browser recovery

Most users do not need the browser companion. It exists only for cases where Garmin refuses terminal authentication and requires an interactive browser session.

A normal localhost redirect cannot receive Garmin's domain-scoped `HttpOnly` cookies. The companion therefore transfers only the cookies applicable to Garmin Connect into a one-time loopback listener. The CLI verifies the provisional session before storing it.

To install the companion:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `browser-companion` directory.

Start recovery:

```sh
gconnect auth recover
```

The command prints a copyable localhost URL. Open it in Chrome, complete Garmin login or MFA, and explicitly approve the transfer with the **GConnect Browser Companion** extension action.

Data commands support both behaviors explicitly:

- `--no-auth-recovery`: fail without opening or waiting for a browser;
- `--recover-auth`: perform browser recovery once and retry the command once.

See [browser-companion/README.md](browser-companion/README.md) for the complete recovery flow and threat model.

### Disconnect

Remove all saved sessions:

```sh
gconnect auth disconnect
```

## JSON output

Every successful command returns one JSON document:

```json
{
  "meta": {
    "schemaVersion": 1,
    "command": "health.sleep",
    "dataset": "sleep",
    "generatedAt": "2026-07-01T12:00:00.000Z",
    "sourceEndpoints": [
      "/gc-api/sleep-service/sleep/dailySleepData"
    ],
    "warnings": [],
    "appliedOptions": {
      "date": "2026-07-01"
    },
    "raw": false
  },
  "data": {
    "items": []
  }
}
```

Failures are JSON on stderr and return a non-zero exit code:

```json
{
  "error": {
    "schemaVersion": 1,
    "code": "AUTH_REQUIRED",
    "message": "Garmin authentication is required",
    "retryable": false,
    "details": {}
  }
}
```

Range commands are all-or-nothing: if one date fails validation or download, no partial success document is emitted.

## Local state and security

All persistent CLI data is kept in `.gconnect-private/` in the directory where the CLI is run. Authentication files are stored at its root, and downloaded exports are stored in its `outputs/` subdirectory.

Session files and exports can contain sensitive bearer tokens, cookies, health data, or location data. Never commit, copy, log, or share them. The repository ignores the complete `.gconnect-private/` directory.

On Unix, GConnect enforces owner-only permissions (`0700` directories and `0600` files), rejects symlinks and malformed state files, uses atomic replacement, and serializes authentication transitions across processes. Errors are recursively redacted before being written to stderr.

## Architecture

Each feature owns its command contract, Garmin routes, wire validation, and normalization. Shared infrastructure owns authentication, downloads, processing, storage, output, and argument parsing.

```text
CLI parser
    │
Command registry ── feature command
    │                    │
    │             shared processing
    │                    │
Output service     download service
                         │
                  session manager
                         │
                      Garmin
```

This keeps changes local:

- adding a dataset normally adds one feature component;
- changing authentication does not modify health or activity commands;
- changing JSON rendering does not modify download logic;
- all network access goes through shared download ports;
- source-boundary tests reject import cycles and feature bypasses.

Read [GARMIN_CONNECT_PROTOCOL.md](GARMIN_CONNECT_PROTOCOL.md) for the observed transfer protocol and evidence levels.

## Development

```sh
npm run typecheck
npm run test:unit
npm run test:e2e
npm test
```

Unit and end-to-end tests use synthetic payloads and a deterministic local Garmin server. They do not require an account or network access.

Live contract tests are opt-in and require an already authenticated session:

```sh
GCONNECT_LIVE_DATE=2026-07-01 npm run test:live
```

Optional live-test variables:

- `GCONNECT_LIVE_ACTIVITY_ID`
- `GCONNECT_LIVE_ACTIVITY_TYPE`
- `GCONNECT_LIVE_MISSING_DATE`

The live suite always disables browser recovery.

## Known limitations

- Garmin's private interfaces can change without notice.
- CAPTCHA and bot protection may prevent terminal authentication.
- Not every Garmin Connect dataset has a typed command yet.
- Range commands intentionally fail as a whole rather than returning partial data.
- Activity polyline tuple semantics are preserved raw until every value is verified.
- Deterministic tests prove the CLI's contracts, not continued compatibility with Garmin's current servers.

## Responsible use

Keep request ranges reasonable and avoid aggressive polling. You are responsible for complying with Garmin's terms and any laws that apply to your account and data.

For supported commercial integrations, consider Garmin's official [Garmin Health API](https://developer.garmin.com/gc-developer-program/health-api/).

## License

Licensed under the [MIT License](LICENSE).
