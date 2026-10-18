import { useEffect, useState } from "react";
import { checkRef } from "@homelab-monitor/shared";
import { ago } from "../lib/time";
import { BellIcon, BellOffIcon } from "./Icons";

const STATE_LABEL = { up: "Up", down: "Down", unknown: "Waiting" };

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Heartbeat({ status, now }) {
  if (!status) return <div className="heartbeat heartbeat--unknown">No status from the monitor yet</div>;

  // Stale after two missed heartbeats
  const stale = now - status.heartbeatAt > 2 * (status.heartbeatMs || 300000) + 60000;
  return (
    <div className={`heartbeat ${stale ? "heartbeat--bad" : "heartbeat--ok"}`}>
      <span className="dot" />
      {stale ? "Monitor seems offline" : "Monitor online"} · last seen {ago(status.heartbeatAt, now)}
    </div>
  );
}

function StatusTab({
  config,
  status,
  enabledChannels,
  pushSupported,
  pushBroken,
  notifyError,
  busy,
  onToggleChannel,
  onEnableAll,
  onTurnOff,
}) {
  const now = useNow();
  const anyEnabled = enabledChannels.length > 0;

  return (
    <>
      <Heartbeat status={status} now={now} />

      {!pushSupported ? (
        <div className="notice">
          This browser can't receive push notifications. On Android, open this app in Chrome or
          Firefox and install it to the home screen.
        </div>
      ) : pushBroken ? (
        <div className="notice notice--bad">
          Notifications stopped working on this device.
          <button className="btn btn--small" onClick={onEnableAll} disabled={busy}>Enable again</button>
        </div>
      ) : (
        !anyEnabled && (
          <div className="notice">
            Get notified on this device when something goes down.
            <button className="btn btn--primary btn--small" onClick={onEnableAll} disabled={busy}>
              Enable notifications
            </button>
          </div>
        )
      )}
      {notifyError && <p className="error">{notifyError}</p>}

      {config.channels.map((channel) => {
        const notifying = enabledChannels.includes(channel.id);
        return (
          <section key={channel.id} className="card channel">
            <div className="channel__header">
              <h2>{channel.name}</h2>
              {pushSupported && (
                <button
                  className={`icon-btn ${notifying ? "icon-btn--on" : ""}`}
                  onClick={() => onToggleChannel(channel.id)}
                  disabled={busy}
                  aria-pressed={notifying}
                  aria-label={notifying ? `Mute ${channel.name}` : `Notify me about ${channel.name}`}
                  title={notifying ? "Notifications on" : "Notifications off"}
                >
                  {notifying ? <BellIcon /> : <BellOffIcon />}
                </button>
              )}
            </div>

            {channel.checks.length === 0 && <p className="muted">No checks in this channel</p>}
            <ul className="checks">
              {channel.checks.map((check) => {
                const state = status?.checks?.[checkRef(channel.id, check.id)];
                const value = state?.state || "unknown";
                return (
                  <li key={check.id} className="check">
                    <span className={`dot dot--${value}`} />
                    <div className="check__text">
                      <div className="check__name">{check.name}</div>
                      <div className="check__detail">
                        {state?.message || check.target}
                        {state?.since && value !== "unknown" ? ` · since ${ago(state.since, now)}` : ""}
                      </div>
                    </div>
                    <span className={`check__state check__state--${value}`}>{STATE_LABEL[value]}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {anyEnabled && !pushBroken && (
        <button className="btn btn--ghost btn--small turn-off" onClick={onTurnOff} disabled={busy}>
          Turn off notifications on this device
        </button>
      )}
    </>
  );
}

export default StatusTab;
