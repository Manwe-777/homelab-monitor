import http from "node:http";
import { checkRef } from "@homelab-monitor/shared";
import { HISTORY_DAYS } from "./history.js";
import { CHECK_TYPES } from "./checks/index.js";

const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(ts, now = Date.now()) {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

const formatTime = (ts) =>
  new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const percent = (uptime) => (uptime === null ? "No data" : `${(uptime * 100).toFixed(uptime === 1 ? 0 : 2)}% uptime`);

/**
 * What the status page shows: only public channels, without targets unless
 * `showTargets` is set
 */
export function getPublicStatus(monitor, now = Date.now()) {
  const { config, history } = monitor;
  const page = config.statusPage;

  const channels = config.channels
    .filter((channel) => channel.public !== false)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      checks: channel.checks.map((check) => {
        const ref = checkRef(channel.id, check.id);
        const state = monitor.states[ref] || { state: "unknown" };
        const status =
          state.state === "down" ? "down" : state.state === "up" ? (state.failures > 0 ? "degraded" : "up") : "unknown";
        return {
          id: check.id,
          name: check.name,
          ...(page.showTargets ? { target: String(CHECK_TYPES[check.type].target(check)) } : {}),
          status,
          since: state.since || null,
          checkedAt: state.checkedAt || null,
          uptime: history.uptime(ref, now),
          days: history.days(ref, now),
        };
      }),
    }));

  const checks = channels.flatMap((channel) => channel.checks);
  const down = checks.filter((check) => check.status === "down").length;
  const degraded = checks.filter((check) => check.status === "degraded").length;
  const overall =
    checks.length === 0 || checks.every((check) => check.status === "unknown")
      ? "unknown"
      : down === 0
        ? degraded === 0 ? "operational" : "degraded"
        : down * 2 > checks.length ? "major" : "partial";

  const publicChannels = new Set(channels.map((channel) => channel.id));

  return {
    title: page.title || config.name,
    overall,
    channels,
    incidents: history
      .incidents()
      .filter((incident) => publicChannels.has(incident.channel))
      .slice(0, 10),
    monitor: monitor.health(now),
    updatedAt: now,
  };
}

const OVERALL = {
  operational: ["ok", "All systems operational"],
  degraded: ["warn", "Degraded performance"],
  partial: ["warn", "Partial outage"],
  major: ["bad", "Major outage"],
  unknown: ["none", "Checking systems…"],
};

const CHECK_STATUS = {
  up: ["ok", "Operational"],
  degraded: ["warn", "Degraded"],
  down: ["bad", "Down"],
  unknown: ["none", "No data"],
};

function barClass(uptime) {
  if (uptime === null) return "none";
  if (uptime >= 0.999) return "ok";
  if (uptime >= 0.95) return "warn";
  return "bad";
}

function renderCheck(check) {
  const [tone, label] = CHECK_STATUS[check.status];
  const bars = check.days
    .map(
      (day) =>
        `<span class="bar bar--${barClass(day.uptime)}" title="${escape(day.date)}: ${escape(percent(day.uptime))}"></span>`
    )
    .join("");

  return `
      <div class="check">
        <div class="check__row">
          <span class="check__name">${escape(check.name)}${check.target ? ` <span class="check__target">${escape(check.target)}</span>` : ""}</span>
          <span class="status status--${tone}" title="Since ${escape(check.since ? formatTime(check.since) : "start")}">${label}</span>
        </div>
        <div class="bars" aria-label="Uptime over the last ${HISTORY_DAYS} days">${bars}</div>
        <div class="check__legend">
          <span><span class="legend-long">${HISTORY_DAYS} days ago</span><span class="legend-short">30 days ago</span></span>
          <span class="check__uptime">${escape(percent(check.uptime))}</span>
          <span>Today</span>
        </div>
      </div>`;
}

function renderIncident(incident, now) {
  const ongoing = !incident.end;
  return `
      <li class="incident">
        <div class="incident__title">
          <span class="dot dot--${ongoing ? "bad" : "ok"}"></span>
          ${escape(incident.checkName)} ${ongoing ? "is down" : "was down"}
        </div>
        <div class="incident__meta">
          ${escape(formatTime(incident.start))} ·
          ${ongoing ? `ongoing for ${duration(now - incident.start)}` : `resolved after ${duration(incident.end - incident.start)}`}
          ${incident.message ? ` · ${escape(incident.message)}` : ""}
        </div>
      </li>`;
}

export function renderStatusPage(status) {
  const now = status.updatedAt;
  const [tone, headline] = OVERALL[status.overall];
  const { monitor } = status;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${escape(status.title)} status</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${tone === "ok" ? "#1a7f37" : tone === "bad" ? "#cf222e" : "#bf8700"}"/></svg>`)}">
<style>
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --card: #ffffff;
  --ok: #1a7f37; --warn: #bf8700; --bad: #cf222e; --none: #d1d9e0;
  --ok-bar: #2da44e; --warn-bar: #d4a72c; --bad-bar: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --card: #151b23;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --none: #3d444d;
    --ok-bar: #2ea043; --warn-bar: #bb8009; --bad-bar: #da3633;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
h1 { margin: 0; font-size: 1.5rem; }
h2 { font-size: 1.1rem; margin: 32px 0 12px; }
.updated { color: var(--muted); font-size: 0.85rem; }
.banner { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-radius: 8px; color: #fff; font-size: 1.15rem; font-weight: 600; }
.banner--ok { background: var(--ok); } .banner--warn { background: var(--warn); } .banner--bad { background: var(--bad); } .banner--none { background: var(--muted); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; margin-top: 16px; }
.card__title { padding: 12px 20px; border-bottom: 1px solid var(--border); font-weight: 600; }
.check { padding: 14px 20px; }
.check + .check { border-top: 1px solid var(--border); }
.check__row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.check__name { font-weight: 500; }
.check__target { color: var(--muted); font-size: 0.8rem; font-family: ui-monospace, monospace; margin-left: 6px; }
.status { font-size: 0.85rem; font-weight: 600; white-space: nowrap; }
.status--ok { color: var(--ok); } .status--warn { color: var(--warn); } .status--bad { color: var(--bad); } .status--none { color: var(--muted); }
.bars { display: flex; gap: 2px; height: 32px; margin-top: 10px; }
.bar { flex: 1; border-radius: 2px; min-width: 2px; }
.bar--ok { background: var(--ok-bar); } .bar--warn { background: var(--warn-bar); } .bar--bad { background: var(--bad-bar); } .bar--none { background: var(--none); }
.bar:hover { opacity: 0.7; }
.check__legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.75rem; margin-top: 6px; }
.check__uptime { font-weight: 500; }
.empty { padding: 14px 20px; color: var(--muted); }
.incidents { list-style: none; margin: 0; padding: 0; }
.incident { padding: 12px 20px; }
.incident + .incident { border-top: 1px solid var(--border); }
.incident__title { font-weight: 500; display: flex; align-items: center; gap: 8px; }
.incident__meta { color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.dot--ok { background: var(--ok); } .dot--warn { background: var(--warn); } .dot--bad { background: var(--bad); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.fact { padding: 14px 20px; }
.fact__label { color: var(--muted); font-size: 0.8rem; }
.fact__value { font-weight: 600; display: flex; align-items: center; gap: 8px; }
footer { margin-top: 32px; color: var(--muted); font-size: 0.8rem; text-align: center; }
.legend-short { display: none; }
@media (max-width: 600px) {
  .bars { height: 24px; }
  .bar:nth-child(-n+${HISTORY_DAYS - 30}) { display: none; }
  .legend-long { display: none; }
  .legend-short { display: inline; }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>${escape(status.title)}</h1>
    <span class="updated">Updated ${escape(formatTime(now))}</span>
  </header>

  <div class="banner banner--${tone}">${escape(headline)}</div>

  ${
    status.channels.length
      ? status.channels
          .map(
            (channel) => `
  <section class="card">
    <div class="card__title">${escape(channel.name)}</div>
    ${channel.checks.length ? channel.checks.map(renderCheck).join("") : `<div class="empty">No checks yet</div>`}
  </section>`
          )
          .join("")
      : `<section class="card"><div class="empty">No public channels</div></section>`
  }

  <h2>Past incidents</h2>
  <section class="card">
    ${
      status.incidents.length
        ? `<ul class="incidents">${status.incidents.map((incident) => renderIncident(incident, now)).join("")}</ul>`
        : `<div class="empty">No incidents reported.</div>`
    }
  </section>

  <h2>Monitor</h2>
  <section class="card facts">
    <div class="fact">
      <div class="fact__label">Alert delivery</div>
      <div class="fact__value"><span class="dot dot--${monitor.relaysConnected > 0 ? "ok" : "bad"}"></span>${monitor.relaysConnected}/${monitor.relaysTotal} relays connected</div>
    </div>
    <div class="fact">
      <div class="fact__label">Last check</div>
      <div class="fact__value"><span class="dot dot--${monitor.checksRunning ? "ok" : "bad"}"></span>${escape(ago(monitor.lastCheckAt, now))}</div>
    </div>
    <div class="fact">
      <div class="fact__label">Monitor running</div>
      <div class="fact__value">${escape(duration(now - monitor.startedAt))}</div>
    </div>
  </section>

  <footer>This page refreshes every minute</footer>
</main>
</body>
</html>`;
}

const MAX_EVENT_BYTES = 8192;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`Body over ${limit} bytes`), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Serves the status page, its data as JSON, and a health endpoint for
 * external monitors (Glance, uptime checkers):
 *   GET /             the status page
 *   GET /api/status   the same data as JSON
 *   GET /health       200 when checks run and relays are connected, 503 otherwise
 *   /heartbeat/TOKEN  a job reporting a run (?status=success, or systemd's result)
 *   POST /event/TOKEN a service reporting an event: JSON { title, message, url }
 */
export function createStatusServer(monitor) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
    };

    const heartbeat = path.match(/^\/heartbeat\/([0-9a-f]+)$/);
    if (heartbeat) {
      // ?status= is systemd's $SERVICE_RESULT ("success" when the job worked)
      const params = new URL(req.url, "http://localhost").searchParams;
      const status = params.get("status") || "success";
      const exit = params.get("exit");
      const ok = status === "success";
      const message = ok ? "" : `${status}${exit && exit !== "0" ? ` (exit ${exit})` : ""}`;
      monitor
        .receiveHeartbeat(heartbeat[1], { ok, message })
        .then((found) => send(found ? 200 : 404, "text/plain", found ? "ok\n" : "Unknown heartbeat\n"));
      return;
    }

    const event = path.match(/^\/event\/([0-9a-f]+)$/);
    if (event) {
      if (req.method !== "POST") return send(405, "text/plain", "POST a JSON object: { title, message, url }\n");
      readBody(req, MAX_EVENT_BYTES)
        .then((body) => monitor.receiveEvent(event[1], body ? JSON.parse(body) : {}))
        .then(
          (result) =>
            result.found
              ? send(200, "application/json", JSON.stringify({ sent: result.sent }))
              : send(404, "text/plain", "Unknown event\n"),
          (err) => send(err.status || 400, "text/plain", `${err instanceof SyntaxError ? "Invalid JSON" : err.message}\n`)
        );
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, "text/plain", "Method not allowed");
    } else if (path === "/") {
      send(200, "text/html; charset=utf-8", renderStatusPage(getPublicStatus(monitor)));
    } else if (path === "/api/status") {
      send(200, "application/json", JSON.stringify(getPublicStatus(monitor)));
    } else if (path === "/health") {
      const health = monitor.health();
      send(health.ok ? 200 : 503, "application/json", JSON.stringify(health));
    } else {
      send(404, "text/plain", "Not found");
    }
  });
}
