import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export const HISTORY_DAYS = 90;
const MAX_INCIDENTS = 100;

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Uptime samples per check and day, and incidents (a check going down until
 * it's back up), kept in a JSON file for the status page.
 *
 *   { checks: { [ref]: { [YYYY-MM-DD]: { up, total } } },
 *     incidents: [{ id, ref, channel, checkName, start, end, message }] }
 */
export class UptimeHistory {
  constructor(path) {
    this.path = path;
    this.data = { checks: {}, incidents: [] };
    if (path && existsSync(path)) {
      try {
        this.data = { ...this.data, ...JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        // A corrupt file starts a new history
      }
    }
  }

  /**
   * The last run a job reported for a heartbeat check: { at, ok, message }
   */
  beat(ref) {
    return this.data.beats?.[ref] || null;
  }

  recordBeat(ref, beat) {
    (this.data.beats ||= {})[ref] = beat;
    this.dirty = true;
    this.save();
  }

  /**
   * The last event a service reported for an event check: { at, title, suppressed }
   */
  lastEvent(ref) {
    return this.data.events?.[ref] || null;
  }

  recordEvent(ref, event) {
    (this.data.events ||= {})[ref] = event;
    this.dirty = true;
  }

  record(ref, ok, ts = Date.now()) {
    const days = (this.data.checks[ref] ||= {});
    const day = (days[dayOf(ts)] ||= { up: 0, total: 0 });
    day.total++;
    if (ok) day.up++;
    this.dirty = true;
  }

  openIncident({ ref, channel, checkName, message }, ts = Date.now()) {
    if (this.openIncidentOf(ref)) return;
    this.data.incidents.unshift({ id: `${ts}-${ref}`, ref, channel, checkName, start: ts, end: null, message });
    this.data.incidents.length = Math.min(this.data.incidents.length, MAX_INCIDENTS);
    this.dirty = true;
  }

  closeIncident(ref, ts = Date.now()) {
    const incident = this.openIncidentOf(ref);
    if (incident) {
      incident.end = ts;
      this.dirty = true;
    }
  }

  openIncidentOf(ref) {
    return this.data.incidents.find((incident) => incident.ref === ref && !incident.end);
  }

  /**
   * The last `HISTORY_DAYS` days of a check, oldest first. Days without
   * samples have `uptime: null`.
   */
  days(ref, now = Date.now()) {
    const days = this.data.checks[ref] || {};
    return Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const date = dayOf(now - (HISTORY_DAYS - 1 - i) * 86400000);
      const day = days[date];
      return { date, uptime: day?.total ? day.up / day.total : null };
    });
  }

  /**
   * Uptime over the last `HISTORY_DAYS` days, or null without samples
   */
  uptime(ref, now = Date.now()) {
    const recent = new Set(this.days(ref, now).map((d) => d.date));
    let up = 0;
    let total = 0;
    for (const [date, day] of Object.entries(this.data.checks[ref] || {})) {
      if (recent.has(date)) {
        up += day.up;
        total += day.total;
      }
    }
    return total ? up / total : null;
  }

  /**
   * The most recent incidents first
   */
  incidents(limit = 20) {
    return [...this.data.incidents].sort((a, b) => b.start - a.start).slice(0, limit);
  }

  /**
   * Drops days older than the history, and writes the file if anything changed
   */
  save(now = Date.now()) {
    const oldest = dayOf(now - (HISTORY_DAYS - 1) * 86400000);
    for (const days of Object.values(this.data.checks)) {
      for (const date of Object.keys(days)) {
        if (date < oldest) delete days[date];
      }
    }

    if (!this.path || !this.dirty) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
