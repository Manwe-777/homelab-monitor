import http from "node:http";
import https from "node:https";

/**
 * HTTP(S) check: the URL answers with an expected status, and optionally
 * contains some text.
 *   url: http://localhost:8080
 *   expectStatus: 200        (or a list, default any 2xx/3xx)
 *   contains: "Glance"       (optional)
 *   insecure: true           (accept self-signed certificates)
 */
export function checkHttp(check) {
  const url = new URL(check.url);
  const client = url.protocol === "https:" ? https : http;
  const started = Date.now();

  return new Promise((resolve) => {
    const req = client.request(
      url,
      {
        method: check.method || "GET",
        timeout: check.timeoutMs,
        rejectUnauthorized: !check.insecure,
        headers: { "user-agent": "homelab-monitor" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          // Only keep what we need to look for text
          if (check.contains && body.length < 1_000_000) body += chunk;
        });
        res.on("end", () => {
          const latency = Date.now() - started;
          if (!statusMatches(res.statusCode, check.expectStatus)) {
            resolve({ ok: false, message: `HTTP ${res.statusCode}` });
          } else if (check.contains && !body.includes(check.contains)) {
            resolve({ ok: false, message: `Response doesn't contain "${check.contains}"` });
          } else {
            resolve({ ok: true, message: `HTTP ${res.statusCode} in ${latency} ms` });
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timed out after ${check.timeoutMs} ms`)));
    req.on("error", (err) => resolve({ ok: false, message: err.message || err.code }));
    req.end();
  });
}

function statusMatches(status, expected) {
  if (expected === undefined) return status >= 200 && status < 400;
  return [].concat(expected).includes(status);
}
