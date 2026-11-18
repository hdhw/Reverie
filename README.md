# Reverie

Self-hosted Rec Room revival server. Download it, open it, set it up, run your server.

Reverie wraps the [Mocha](https://github.com/hdhw/Mocha) server (a 2023 Rec Room server, itself based on
[FemRec-2023](https://github.com/nito9999/FemRec-2023) by nito9999, MIT) with a desktop app, a setup wizard,
a managed database and a browser panel. Inspired by [RebornRec](https://github.com/aqquad/RebornRec), whose 2016-2020
catalogs are included as an alternative data set. The goal is to support Rec Room clients from 2016 to 2023.

## Running it

Release zip (Windows): unzip `reverie-<version>-win-x64.zip` and open `Start Reverie.cmd`. It ships Node.js and a
self-contained server build, so nothing else needs installing; the wizard downloads PostgreSQL if you don't have it.

From source:

Requirements: Windows 10/11 (Linux/macOS paths exist but are untested), [Node.js 20+](https://nodejs.org), and either the
.NET 8 SDK (to build) or a release build. PostgreSQL is found automatically or downloaded by the wizard.

```
npm run build        # self-contained server build (no .NET needed to run it)
npm run package      # Windows release zip in dist/ (server build + bundled Node)
"Start Reverie.cmd"  # or: npm start
```

The app opens in its own window (Edge or Chrome app mode) and walks you through setup:
administrator name (generated as `Reverie User#12345`, editable), panel password, server name,
database, ports, Photon App IDs. After setup the same window is the web panel, also reachable from any browser at
`http://127.0.0.1:5481` (or your LAN if you allow it).

On a server with no screen: `npm run headless`. It prints a one-time sign-in link for setup.

## Layout

| Path | What |
| --- | --- |
| `server/` | Mocha (C#/.NET 8), imported with full git history. Reverie patches are listed below. |
| `app/main.mjs` | Entry point: panel HTTP server and app window. |
| `app/lib/supervisor.mjs` | Runs PostgreSQL and the game server, captures logs, explains failures in plain words. |
| `app/lib/deps.mjs` | Finds .NET, PostgreSQL, free ports; downloads portable PostgreSQL on Windows. |
| `app/lib/catalog.mjs` | Installs game data into `server/Data` and renders `ConfigV2.json` for this host. |
| `app/lib/ops.mjs` | Backups (`pg_dump`/`pg_restore`) and diagnostics. |
| `app/lib/http.mjs` | Panel API. Player actions run Mocha's own console commands. |
| `app/ui/` | Wizard and panel (plain HTML/CSS/JS, no build step). |
| `app/compat/clients.json` | Client-version compatibility table shown in the panel. |
| `vendor/mocha-2023/` | Mocha's 2023 item catalogs, game configs and the 45 base rooms. Default data source. |
| `vendor/rebornrec/` | RebornRec's 2016-2020 catalogs (see its NOTICE). `npm run import-catalog -- --source=rebornrec --force` |
| `data/` | Your config, secrets, private database and backups. Not in git. Back this folder up. |

No npm dependencies. The app uses only Node built-ins.

## Changes to Mocha

- **Schema bootstrap.** Mocha's Postgres tables had been created by hand on its production box, so a fresh database
  could not start. `PostgresCollection` now creates its table, columns and sequences, deriving column types from
  the selector expressions.
- **Empty-table IDs.** `NextId` called `setval(seq, 0)` on an empty table (invalid). Player IDs now start at 2,
  because 1 is the virtual Coach account that owns the base rooms.
- **Configuration.** Base URL, Photon App IDs, region and app version come from settings instead of Mocha's own values.
- **Security.** Removed the hardcoded default bot-bridge secret. Added `/reverie/status` and `/reverie/players`
  (loopback only, keyed, constant-time compare) for the panel.
- Cloudflared only starts when its binary exists.

## Client compatibility

Only the April 2023 client (Mocha's target) has a server module. Its status is "worked on Mocha, not yet
re-tested on Reverie". Players need the Mocha client patch: the server rejects clients without its
`X-Mocha-Build` header, and the patch currently points at `playmocha.xyz`, so a Reverie build of the patch
with a configurable address is required before anyone can join. That work lives in
[ReveriePatcher](https://github.com/hdhw/ReveriePatcher). 2016-2022 clients are planned. See the Clients page.

## Next milestones

1. Client patch with a configurable server address (ReveriePatcher), plus an in-game join test.
2. Legacy client module (2016-2020) using RebornRec's data, as a separate server profile.
3. Panel: room management, announcements, Mocha's feature toggles (account creation, Steam verification, VPN blocking).

## Development

```
npm run build:dev    # framework-dependent build, faster
npm test             # unit tests (config, passwords, error explanations)
REVERIE_DATA=/some/dir npm run headless   # isolated data folder for testing
```

Ports: game 5480, panel 5481, managed database 5482 (all changeable).
