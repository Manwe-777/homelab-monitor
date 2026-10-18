import net from "node:net";

/**
 * TCP check: a port accepts connections.
 *   host: 127.0.0.1
 *   port: 22
 */
export function checkTcp(check) {
  const started = Date.now();

  return new Promise((resolve) => {
    const socket = net.connect({ host: check.host, port: check.port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(check.timeoutMs);
    socket.on("connect", () => done({ ok: true, message: `Port open in ${Date.now() - started} ms` }));
    socket.on("timeout", () => done({ ok: false, message: `Timed out after ${check.timeoutMs} ms` }));
    socket.on("error", (err) => done({ ok: false, message: err.code || err.message }));
  });
}
