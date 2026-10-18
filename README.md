# Homelab Monitor

Watches your homelab and sends alerts to your phone, end to end encrypted,
over [Nostr](https://nostr.com/) relays with [tool-db](https://github.com/Manwe-777/tool-db).
No accounts, no messaging apps, nothing of yours exposed to the internet.

```
 homelab                       Nostr relays                 your phone
┌────────────────────┐       ┌──────────────┐       ┌──────────────────────┐
│ monitor            │       │ only see     │       │ app (installed PWA)  │
│  http, tcp, dns,   │──────►│ ciphertext   │◄─────►│  status, history,    │
│  disk, heartbeats  │       └──────────────┘       │  per channel toggles │
│  status page       │                              │                      │
│                    │── Web Push (encrypted) ─────►│  notifications       │
└────────────────────┘                              └──────────────────────┘
```

- Checks your services, disks, DNS and scheduled jobs, and alerts when one
  goes down and when it's back.
- The phone app shows live status and past alerts, and you choose which
  channels notify each device.
- An optional status page, in the style of [githubstatus.com](https://www.githubstatus.com/),
  with 90 days of uptime per check.

## Set up your own

You need a machine with Docker, and an Android phone with Chrome or Firefox.
Everyone runs their own monitor with their own key: you don't need anything
from anyone else's setup.

### 1. Get a key on your phone

Open **https://manwe-777.github.io/homelab-monitor/** on your phone, and add it
to the home screen (browser menu → *Add to Home screen*). Open it from there and
tap **Create a new key**.

The next screen shows your **npub**, your public key. Copy it: the monitor will
only talk to this key. (Already have a Nostr key? Tap *I have a key* instead.)

### 2. Configure the monitor

On the machine that will run it:

```bash
mkdir homelab-monitor && cd homelab-monitor
mkdir data   # its keys and history; the container runs as uid 1000
curl -fsSLo config.yaml https://raw.githubusercontent.com/Manwe-777/homelab-monitor/main/monitor/config.example.yaml
```

Edit `config.yaml`: set `owner` to your npub, and replace the example checks
with yours (see [Check types](#check-types)). Then create `docker-compose.yml`:

```yaml
services:
  monitor:
    image: ghcr.io/manwe-777/homelab-monitor:latest
    container_name: homelab-monitor
    restart: unless-stopped
    volumes:
      - ./config.yaml:/config/config.yaml:ro
      - ./data:/data
    ports:
      - "3001:3001"   # status page and heartbeats
    extra_hosts:
      # Services published on this machine: http://host.docker.internal:PORT
      - "host.docker.internal:host-gateway"
```

From inside the container, `localhost` is the container itself: reach services
on the machine at `host.docker.internal`, and other machines by their LAN address.

### 3. Start it and pair

```bash
docker compose up -d
docker compose exec monitor homelab-monitor check   # runs every check once
docker compose exec monitor homelab-monitor pair    # shows a QR code
```

Scan the QR code with your phone's camera: the app opens and pairs with the
monitor. Your channels appear with the state of every check.

### 4. Turn on notifications

In the app, tap **Enable notifications**, then use the bell on each channel to
choose what notifies this phone. To try it:

```bash
docker compose exec monitor homelab-monitor test-alert
```

Every phone or browser signed in with your key can pair and enable
notifications the same way, each with its own channels.

### 5. Optional extras

- **Status page:** `http://THIS-MACHINE:3001`. Put it behind your reverse proxy
  (e.g. `status.example.com`). It shows check names, never URLs or hosts, and
  leaves out channels with `public: false`. `/health` answers 503 when checks
  stop or no relay is connected: point another monitor (or Glance, or an uptime
  service) at it to know if this one stops.
- **Scheduled jobs:** see [Heartbeats](#heartbeats).
- **Keep `data/` in your backups.** Lose it and you'll pair again and re-enable
  notifications.

### Trusting the hosted app

The app at `manwe-777.github.io` is built from this repo by GitHub Actions, and
it keeps your key on your phone. But whoever controls the site controls the code
your phone runs. To depend on no one: fork this repo, enable GitHub Pages
(Settings → Pages → *GitHub Actions*), and set `appUrl` in `config.yaml` to your
copy, so the pairing QR code opens it.

## Reference

### Check types

| Type | Checks | Fields |
| --- | --- | --- |
| `http` | a URL answers with an expected status | `url`, `expectStatus`, `contains`, `insecure` |
| `tcp` | a port accepts connections | `host`, `port` |
| `dns` | a DNS server resolves a domain | `server`, `domain`, `expect` |
| `disk` | free space on the filesystem of a path | `path`, `maxUsedPercent`, `minFreeGb`, `marker` |
| `heartbeat` | a scheduled job reported in time | `every`, `grace` |
| `docker` | a container runs and is healthy | `container` |

Every check also takes `interval`, `timeout` and `failuresBeforeAlert`, and
[`config.example.yaml`](monitor/config.example.yaml) shows them all.

- **disk** sees the filesystems of the container. `/data` is on the machine's
  disk; for another one, mount a path from it (read-only). For a network share,
  put a marker file on it and set `marker`: if the share isn't mounted, the
  check says so instead of measuring the disk under it.
- **docker** needs the Docker socket mounted
  (`/var/run/docker.sock:/var/run/docker.sock:ro`), which gives the container
  control of the machine. Prefer `http` and `tcp` checks when you can.

### Heartbeats

A heartbeat check alerts when a scheduled job fails, or doesn't run in time:

```yaml
  - name: Jobs
    checks:
      - name: Nightly backup
        type: heartbeat
        every: 1d    # how often it runs (30m, 6h, 1d, 7d...)
        grace: 3h    # how late it may be (default 1h)
```

The job reports each run to a secret URL. The monitor writes the tokens to
`data/heartbeats.env` when it starts, so jobs read them from there:
`docker compose exec monitor homelab-monitor heartbeats` lists them.

With **systemd**, add to the job's `[Service]`:

```ini
EnvironmentFile=/path/to/homelab-monitor/data/heartbeats.env
ExecStopPost=-/bin/sh -c 'curl -fsS -m 10 -o /dev/null "http://127.0.0.1:3001/heartbeat/$$HEARTBEAT_JOBS_NIGHTLY_BACKUP?status=$$SERVICE_RESULT&exit=$$EXIT_STATUS"'
```

It runs when the job ends, successful or not. Keep the `$$`: systemd turns it
into `$` and leaves the variables to the shell, which has the job's real result.

With **cron**, or in any script:

```bash
0 3 * * * . /path/to/homelab-monitor/data/heartbeats.env; /usr/local/bin/backup.sh; s=$?; curl -fsS -m 10 -o /dev/null "http://127.0.0.1:3001/heartbeat/$HEARTBEAT_JOBS_NIGHTLY_BACKUP?status=$([ $s = 0 ] && echo success || echo failed)&exit=$s"
```

A failed run alerts right away, a missing one once it's overdue. The job must
be able to read `heartbeats.env` (it's `0600`, owned by uid 1000). To rotate
every token, delete `data/heartbeat.key` and restart the monitor.

### Commands

`docker compose exec monitor homelab-monitor <command>`:

| Command | Does |
| --- | --- |
| `run` | runs the checks and sends alerts (what the container does) |
| `check` | runs every check once and prints the results |
| `pair` | shows the QR code and npub to pair the app |
| `test-alert [channel]` | sends a test alert |
| `heartbeats [--base URL] [--env-file PATH]` | shows how jobs report to heartbeat checks |

### How it works

- The monitor has its own Nostr key, created on first run in `data/`. Your npub
  is its `owner`: it encrypts everything for you (NIP-44) and only reads
  settings you wrote.
- The app holds your key, and pairs with a monitor by its npub.
- When you enable notifications, the app gives the monitor this phone's push
  subscription (encrypted) and the channels you want. Alerts are sent with Web
  Push: on Android it goes through Google's push service, which only sees that
  a push happened, not what it says.
- Relays store the data. They can't read it, and every client checks the
  signatures, so any public relay works. The monitor and the app use the same
  default relays; set `relays` in the config (and in the app's settings) to
  use others.

Data on the relays, under the `homelab-monitor` topic (M = monitor, U = you):

| Key | Written by | Contents |
| --- | --- | --- |
| `:M.config` | monitor | name, channels, checks, Web Push public key |
| `:M.status` | monitor | state of every check, heartbeat |
| `:M.alerts-YYYY-MM` | monitor | the month's alerts (CRDT map) |
| `:U.devices-M` | you | each device's push subscription and channels (CRDT map) |
| `:U.monitors` | you | the monitors you paired, synced between your devices |

## Development

```bash
npm install
npm test             # all tests
npm run app          # the app's dev server
npm run monitor -- check --config path/to/config.yaml --data path/to/data
```

- **monitor/**: the Node service (checks, alerts, status page).
- **app/**: the phone app, a static PWA (`npm run build` → `app/dist`).
- **shared/**: data model and encryption helpers used by both.

The monitor tests run a local relay, a fake push service that decrypts what it
gets, a fake DNS server, and services that go down and up.

Pushing to `main` runs the tests, then publishes the app to GitHub Pages and the
monitor image to `ghcr.io/manwe-777/homelab-monitor` (amd64 and arm64).
