import { checkHttp } from "./http.js";
import { checkTcp } from "./tcp.js";
import { checkDocker } from "./docker.js";
import { checkDisk } from "./disk.js";
import { checkDns } from "./dns.js";
import { checkHeartbeat } from "./heartbeat.js";

export const CHECK_TYPES = {
  http: { run: checkHttp, target: (c) => c.url, required: ["url"] },
  tcp: { run: checkTcp, target: (c) => `${c.host}:${c.port}`, required: ["host", "port"] },
  docker: { run: checkDocker, target: (c) => c.container, required: ["container"] },
  disk: { run: checkDisk, target: (c) => c.path, required: ["path"] },
  dns: { run: checkDns, target: (c) => `${c.domain} @ ${c.server}`, required: ["server", "domain"] },
  heartbeat: { run: checkHeartbeat, target: (c) => `every ${c.every}`, required: ["every"] },
};

/**
 * Runs a check, never throws, and gives up after its timeout even if the
 * check itself doesn't (a hung network share can block a disk check)
 * @param context what some checks need from the monitor (heartbeats)
 * @returns {Promise<{ ok: boolean, message: string, pending?: boolean }>}
 */
export async function runCheck(check, context) {
  const limitMs = (check.timeoutMs ?? 10000) + 1000;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, message: `No answer after ${limitMs} ms` }), limitMs);
  });

  try {
    return await Promise.race([CHECK_TYPES[check.type].run(check, context), timeout]);
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}
