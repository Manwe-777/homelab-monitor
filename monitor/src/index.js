#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { npubEncode } from "tool-db";
import qrcode from "qrcode-terminal";
import { checkRef } from "@homelab-monitor/shared";
import { loadConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { Monitor } from "./monitor.js";
import { runCheck } from "./checks/index.js";
import { heartbeatVariable } from "./checks/heartbeat.js";
import { eventVariable } from "./checks/event.js";

const USAGE = `Usage: homelab-monitor [command] [--config config.yaml] [--data ./data]

Commands:
  run                  Run the checks and send alerts (default)
  pair                 Show the keys to pair the app with this monitor
  check                Run every check once and print the results
  test-alert [channel] Send a test alert to a channel (the first one by default)
  heartbeats [--base URL] [--env-file PATH]
                       Show how each heartbeat check's job reports its runs
  events [--base URL] [--env-file PATH]
                       Show how services report to each event check
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: process.env.HOMELAB_MONITOR_CONFIG || "config.yaml" },
    data: { type: "string", default: process.env.HOMELAB_MONITOR_DATA || "data" },
    help: { type: "boolean", short: "h" },
    base: { type: "string" },
    "env-file": { type: "string" },
  },
});

const [command = "run", argument] = positionals;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const config = loadConfig(resolve(values.config));
const identity = loadIdentity(resolve(values.data));

switch (command) {
  case "pair": {
    const npub = npubEncode(identity.pubkey);
    const link = new URL(config.appUrl);
    link.searchParams.set("pair", npub);

    console.log(`Pair the app with monitor "${config.name}": scan this with your phone's camera\n`);
    qrcode.generate(link.href, { small: true }, (qr) => console.log(qr));
    console.log(`Or open:      ${link.href}
Or paste:     ${npub}

The app must be signed in with an owner's key:
${config.owners.map((owner) => `              ${npubEncode(owner)}`).join("\n")}`);
    break;
  }

  case "heartbeats": {
    const base = (values.base || `http://127.0.0.1:${config.statusPage?.port ?? 3001}`).replace(/\/$/, "");
    const envFile = values["env-file"] || join(resolve(values.data), "heartbeats.env");
    const heartbeats = config.channels.flatMap((channel) =>
      channel.checks.filter((check) => check.type === "heartbeat").map((check) => ({ channel, check }))
    );
    if (heartbeats.length === 0) console.log("No heartbeat checks in the config.");

    // In Docker, the data dir is a mount: jobs on the host need its host path
    const inContainer = !values["env-file"] && process.env.HOMELAB_MONITOR_DATA;
    console.log(`The tokens are in ${envFile}, written when the monitor starts.${
      inContainer ? `\n${envFile} is the container's path: use your data directory on the host (or pass --env-file).` : ""
    }
Add these to each job's systemd [Service]. $$ is on purpose: the shell expands
the variables, not systemd. For cron and scripts, see Heartbeats in the README.
`);
    for (const { channel, check } of heartbeats) {
      const variable = heartbeatVariable(checkRef(channel.id, check.id));
      console.log(`${check.name}
  EnvironmentFile=${envFile}
  ExecStopPost=-/bin/sh -c 'curl -fsS -m 10 -o /dev/null "${base}/heartbeat/$$${variable}?status=$$SERVICE_RESULT&exit=$$EXIT_STATUS"'
`);
    }
    break;
  }

  case "events": {
    const base = (values.base || `http://127.0.0.1:${config.statusPage?.port ?? 3001}`).replace(/\/$/, "");
    const envFile = values["env-file"] || join(resolve(values.data), "events.env");
    const events = config.channels.flatMap((channel) =>
      channel.checks.filter((check) => check.type === "event").map((check) => ({ channel, check }))
    );
    if (events.length === 0) {
      console.log("No event checks in the config.");
      break;
    }
    const inContainer = !values["env-file"] && process.env.HOMELAB_MONITOR_DATA;
    console.log(`The tokens are in ${envFile}, written when the monitor starts.${
      inContainer ? `\n${envFile} is the container's path: use your data directory on the host (or pass --env-file).` : ""
    }
A service reports an event with a POST; title, message and url are optional.
`);
    for (const { channel, check } of events) {
      const variable = eventVariable(checkRef(channel.id, check.id));
      console.log(`${check.name}
  . ${envFile}; curl -fsS -m 10 -H 'content-type: application/json' \\
    -d '{"title":"...","message":"...","url":"https://..."}' "${base}/event/$${variable}"
`);
    }
    break;
  }

  case "check": {
    for (const channel of config.channels) {
      for (const check of channel.checks) {
        if (check.type === "heartbeat" || check.type === "event") {
          console.log(`---- ${checkRef(channel.id, check.id)}: ${check.type}s are only checked while running`);
          continue;
        }
        const result = await runCheck(check);
        console.log(`${result.ok ? "UP  " : "DOWN"} ${checkRef(channel.id, check.id)}: ${result.message}`);
      }
    }
    break;
  }

  case "test-alert": {
    const channel = argument
      ? config.channels.find((c) => c.id === argument)
      : config.channels[0];
    if (!channel) {
      console.error(`Unknown channel "${argument}", channels: ${config.channels.map((c) => c.id).join(", ")}`);
      process.exit(1);
    }

    const monitor = new Monitor(config, identity);
    await monitor.connect();
    const alert = await monitor.sendAlert(
      channel,
      null,
      "test",
      `🔔 Test alert from ${config.name}`,
      `Notifications from "${channel.name}" work`
    );
    console.log(`Sent test alert ${alert.id} to channel "${channel.id}"`);
    // Give the relays a moment to receive it
    await new Promise((r) => setTimeout(r, 2000));
    await monitor.stop();
    process.exit(0);
  }

  case "run": {
    const monitor = new Monitor(config, identity, {
      historyPath: join(resolve(values.data), "history.json"),
      heartbeatsEnvPath: join(resolve(values.data), "heartbeats.env"),
      eventsEnvPath: join(resolve(values.data), "events.env"),
    });
    const shutdown = async () => {
      await monitor.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await monitor.start();
    console.log(`Monitor npub: ${npubEncode(identity.pubkey)}`);
    break;
  }

  default:
    console.error(USAGE);
    process.exit(1);
}
