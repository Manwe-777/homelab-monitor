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

### Docker

```bash
docker build -t homelab-monitor .
```

See [`deploy/docker-compose.yml`](deploy/docker-compose.yml) for a service to
add to your homelab's compose file. In the container:

- config is `/config/config.yaml`, data is the `/data` volume;
- services on the host are at `http://host.docker.internal:PORT`, services in
  the same compose network by their name (`http://glance:8080`);
- `docker` checks need the Docker socket mounted;
- `docker compose exec homelab-monitor homelab-monitor pair` shows the npub.

### Status page

A public page like [githubstatus.com](https://www.githubstatus.com/): overall
status, each public channel with 90 days of uptime, past incidents, and the
monitor's own health (relays connected, last check). Check targets (URLs,
hosts) are hidden unless `statusPage.showTargets` is set, and channels with
`public: false` are left out.

- `GET /` the page, `GET /api/status` the same as JSON
- `GET /health` 200 when checks run and relays are connected, 503 otherwise:
  point Glance or an external uptime checker at it to know if the monitor itself
  is down

Serve it through your reverse proxy, e.g. `status.example.com` →
`http://127.0.0.1:3001`.

## App

```bash
npm run app        # dev server
npm run build      # app/dist, static files to host anywhere
```

Notifications need the app served over **HTTPS** (or `localhost`). On Android,
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
