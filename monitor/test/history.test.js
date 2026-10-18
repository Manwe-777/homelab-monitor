import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UptimeHistory, HISTORY_DAYS } from "../src/history.js";

const DAY = 86400000;
const now = Date.UTC(2026, 9, 18, 12);

test("uptime per day and overall", () => {
  const history = new UptimeHistory(null);
  history.record("a/web", true, now);
  history.record("a/web", true, now);
  history.record("a/web", false, now);
  history.record("a/web", true, now - DAY);

  const days = history.days("a/web", now);
  assert.equal(days.length, HISTORY_DAYS);
  assert.deepEqual(days.at(-1), { date: "2026-10-18", uptime: 2 / 3 });
  assert.deepEqual(days.at(-2), { date: "2026-10-17", uptime: 1 });
  assert.equal(days.at(-3).uptime, null);
  assert.equal(history.uptime("a/web", now), 3 / 4);
  assert.equal(history.uptime("other", now), null);
});

test("incidents open once and close", () => {
  const history = new UptimeHistory(null);
  history.openIncident({ ref: "a/web", channel: "a", checkName: "Web", message: "HTTP 502" }, now);
  history.openIncident({ ref: "a/web", channel: "a", checkName: "Web", message: "HTTP 502" }, now + 1000);
  assert.equal(history.incidents().length, 1);
  history.closeIncident("a/web", now + 60000);
  assert.equal(history.incidents()[0].end, now + 60000);
});

test("persists and prunes old days", () => {
  const path = join(mkdtempSync(join(tmpdir(), "history-")), "history.json");
  const history = new UptimeHistory(path);
  history.record("a/web", true, now - 200 * DAY);
  history.record("a/web", false, now);
  history.save(now);

  const loaded = new UptimeHistory(path);
  assert.deepEqual(Object.keys(loaded.data.checks["a/web"]), ["2026-10-18"]);
  assert.equal(loaded.uptime("a/web", now), 0);
});
