import { useEffect, useState, useCallback } from "react";
import { monthOf, previousMonth } from "@homelab-monitor/shared";
import { loadAlerts, watchAlerts } from "../lib/db";
import { formatDay, formatTime, formatMonth } from "../lib/time";

const MAX_MONTHS = 12;

function AlertsTab({ db, monitor, config }) {
  const [months, setMonths] = useState([monthOf(Date.now())]);
  const [alerts, setAlerts] = useState({});
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState("all");

  const loadMonth = useCallback(
    async (month) => {
      const list = await loadAlerts(db, monitor, month);
      setAlerts((current) => ({ ...current, [month]: list }));
    },
    [db, monitor]
  );

  useEffect(() => {
    const current = monthOf(Date.now());
    loadMonth(current).finally(() => setLoading(false));
    return watchAlerts(db, monitor, current, () => loadMonth(current));
  }, [db, monitor, loadMonth]);

  const loadOlder = async () => {
    const older = previousMonth(months.at(-1));
    setLoading(true);
    setMonths((list) => [...list, older]);
    await loadMonth(older);
    setLoading(false);
  };

  const channelName = (id) => config.channels.find((c) => c.id === id)?.name || id;
  const list = months
    .flatMap((month) => alerts[month] || [])
    .filter((alert) => channel === "all" || alert.channel === channel);

  // Group by day, newest first
  const days = [];
  for (const alert of list) {
    const day = formatDay(alert.ts);
    if (days.at(-1)?.day !== day) days.push({ day, alerts: [] });
    days.at(-1).alerts.push(alert);
  }

  return (
    <>
      <div className="chips">
        {[{ id: "all", name: "All" }, ...config.channels].map((c) => (
          <button
            key={c.id}
            className={channel === c.id ? "chip chip--active" : "chip"}
            onClick={() => setChannel(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      {days.length === 0 && !loading && <p className="muted empty">No alerts in this period. All quiet.</p>}

      {days.map(({ day, alerts: dayAlerts }) => (
        <section key={day} className="day">
          <h3 className="day__title">{day}</h3>
          <ul className="card alerts">
            {dayAlerts.map((alert) => (
              <li key={alert.id} className="alert">
                <span className={`dot dot--${alert.state}`} />
                <div className="alert__text">
                  <div className="alert__title">{alert.title}</div>
                  <div className="alert__detail">
                    {[alert.body, channelName(alert.channel)].filter(Boolean).join(" · ")}
                  </div>
                  {alert.url && /^https?:\/\//.test(alert.url) && (
                    <a className="alert__link" href={alert.url} target="_blank" rel="noopener noreferrer">
                      Open
                    </a>
                  )}
                </div>
                <time className="alert__time" dateTime={new Date(alert.ts).toISOString()}>
                  {formatTime(alert.ts)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {loading ? (
        <div className="center"><div className="spinner" /></div>
      ) : (
        months.length < MAX_MONTHS && (
          <button className="btn btn--ghost load-more" onClick={loadOlder}>
            Load {formatMonth(previousMonth(months.at(-1)))}
          </button>
        )
      )}
    </>
  );
}

export default AlertsTab;
