import { checkHttp } from "./http.js";
import { checkTcp } from "./tcp.js";
import { checkDocker } from "./docker.js";

export const CHECK_TYPES = {
  http: { run: checkHttp, target: (c) => c.url, required: ["url"] },
  tcp: { run: checkTcp, target: (c) => `${c.host}:${c.port}`, required: ["host", "port"] },
  docker: { run: checkDocker, target: (c) => c.container, required: ["container"] },
};

/**
 * Runs a check, never throws
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runCheck(check) {
  try {
    return await CHECK_TYPES[check.type].run(check);
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
