# Homelab Monitor

Watches your homelab and sends alerts to your phone, end to end encrypted,
over [Nostr](https://nostr.com/) relays with [tool-db](https://github.com/Manwe-777/tool-db).
No accounts, no messaging apps, no server of yours exposed to the internet
(except the optional public status page).

```
 homelab                       Nostr relays                 your phone
┌────────────────────┐       ┌──────────────┐       ┌──────────────────────┐
│ monitor            │       │ only see     │       │ PWA (installed)      │
│  checks (http,     │──────►│ ciphertext   │◄─────►│  status, history,    │
│  tcp, docker)      │       └──────────────┘       │  per channel toggles │
│  status page :3001 │                              │                      │
│                    │── Web Push (encrypted) ─────►│  service worker      │
└────────────────────┘                              └──────────────────────┘
```

- **monitor/**: Node service. Runs the checks, publishes config, status and
  alert history (NIP-44 encrypted for you), sends Web Push notifications, and
  serves a public status page.
- **app/**: the phone app, a PWA. Pair with monitors, see status and past
  alerts, choose which channels notify this device.
- **shared/**: data model and encryption helpers used by both.

## How it fits together

- The monitor has its own Nostr key (created on first run). Your npub goes in
  its config as `owner`: only you can read its data and get its alerts.
- The app holds your key. You pair it with a monitor by pasting the monitor's npub.
- When you enable notifications, the app gives the monitor its push
  subscription through tool-db (encrypted), with the channels you want.
- Alerts are pushed with Web Push. On Android it goes through Google's push
  service, but the payload is encrypted end to end, they only see that a push
  happened.

Data on the relays, under the `homelab-monitor` topic (M = monitor, U = you):

| Key | Written by | Contents |
| --- | --- | --- |
| `:M.config` | monitor | name, channels, checks, Web Push public key |
| `:M.status` | monitor | state of every check, heartbeat |
| `:M.alerts-YYYY-MM` | monitor | the month's alerts (CRDT map) |
| `:U.devices-M` | you | each device's push subscription and channels (CRDT map) |
| `:U.monitors` | you | the monitors you paired, synced between your devices |

## Monitor

```bash
npm install
cp monitor/config.example.yaml monitor/config.yaml   # set `owner` to your npub
cd monitor
node src/index.js check        # run every check once
node src/index.js pair         # shows the monitor's npub, for the app
node src/index.js              # run
node src/index.js test-alert   # send a test alert
```

Its key, Web Push keys and uptime history are kept in `monitor/data/` (keep it,
or you'll need to pair again).

### Check types

| Type | Checks | Fields |
| --- | --- | --- |
| `http` | a URL answers with an expected status | `url`, `expectStatus`, `contains`, `insecure` |
| `tcp` | a port accepts connections | `host`, `port` |
| `dns` | a DNS server resolves a domain | `server`, `domain`, `expect` |
| `disk` | free space on the filesystem of a path | `path`, `maxUsedPercent`, `minFreeGb`, `marker` |
| `heartbeat` | a scheduled job reported in time | `every`, `grace` |
| `docker` | a container runs and is healthy (needs the Docker socket) | `container` |

Every check also takes `interval`, `timeout` and `failuresBeforeAlert`.

**Heartbeats:** each heartbeat check has a secret URL. On start, the monitor
writes their tokens to `heartbeats.env` in its data directory (0600), so jobs
read them from there instead of keeping them in their own config.
`homelab-monitor heartbeats --base http://HOST:PORT --env-file PATH` prints
the lines to add to each job's systemd service:

```ini
EnvironmentFile=/path/to/data/heartbeats.env
ExecStopPost=-/bin/sh -c 'curl -fsS -m 10 -o /dev/null "http://HOST:PORT/heartbeat/$HEARTBEAT_JOBS_NIGHTLY_BACKUP?status=$SERVICE_RESULT&exit=$EXIT_STATUS"'
```

systemd runs it when the job ends, successful or not, so a failed run alerts
right away. To rotate every heartbeat URL, delete `heartbeat.key` from the data
directory and restart the monitor: the jobs read the new tokens on their next run.

## App

```bash
npm run app        # dev server
npm run build      # app/dist, static files to host anywhere
```

The app is published to GitHub Pages on every push to `main`
([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). Notifications
need it served over **HTTPS** (or `localhost`). On Android,
open it in Chrome or Firefox, install it to the home screen, then:

1. Create a key (or paste your nsec), and put the shown npub as the monitor's `owner`.
2. Paste the monitor's npub (`homelab-monitor pair`).
3. Enable notifications, and use the bell on each channel to choose what notifies this device.

## Tests

```bash
npm test
```

The monitor tests run a local relay, a fake push service that decrypts what it
gets, and services that go down and up.
