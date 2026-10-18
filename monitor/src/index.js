#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { npubEncode } from "tool-db";
import { checkRef } from "@homelab-monitor/shared";
import { loadConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { Monitor } from "./monitor.js";
import { runCheck } from "./checks/index.js";

const USAGE = `Usage: homelab-monitor [command] [--config config.yaml] [--data ./data]

Commands:
  run                  Run the checks and send alerts (default)
  pair                 Show the keys to pair the app with this monitor
  check                Run every check once and print the results
  test-alert [channel] Send a test alert to a channel (the first one by default)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: process.env.HOMELAB_MONITOR_CONFIG || "config.yaml" },
    data: { type: "string", default: process.env.HOMELAB_MONITOR_DATA || "data" },
    help: { type: "boolean", short: "h" },
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
    console.log(`Monitor "${config.name}"

  Monitor npub (paste it in the app): ${npubEncode(identity.pubkey)}
  Owner npub (from config):           ${npubEncode(config.owner)}

Only the owner can read this monitor's data and receive its alerts.`);
    break;
  }

  case "check": {
    for (const channel of config.channels) {
      for (const check of channel.checks) {
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
    const monitor = new Monitor(config, identity, { historyPath: join(resolve(values.data), "history.json") });
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
