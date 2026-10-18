import http from "node:http";

/**
 * Docker check: a container is running, and healthy if it has a health check.
 *   container: jellyfin
 *   socket: /var/run/docker.sock   (default)
 */
export function checkDocker(check) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: check.socket || "/var/run/docker.sock",
        path: `/containers/${encodeURIComponent(check.container)}/json`,
        timeout: check.timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 404) {
            resolve({ ok: false, message: "Container not found" });
            return;
          }
          try {
            const { State } = JSON.parse(body);
            const health = State.Health?.Status;
            if (!State.Running) {
              resolve({ ok: false, message: `Container ${State.Status}` });
            } else if (health === "unhealthy") {
              resolve({ ok: false, message: "Container unhealthy" });
            } else {
              resolve({ ok: true, message: health ? `Running, ${health}` : "Running" });
            }
          } catch {
            resolve({ ok: false, message: `Docker API error (HTTP ${res.statusCode})` });
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timed out after ${check.timeoutMs} ms`)));
    req.on("error", (err) => resolve({ ok: false, message: `Docker: ${err.code || err.message}` }));
    req.end();
  });
}
