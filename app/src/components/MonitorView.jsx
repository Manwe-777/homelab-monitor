import { useEffect, useState, useCallback } from "react";
import { STATUS_KEY, CONFIG_KEY } from "@homelab-monitor/shared";
import { readConfig, readStatus, watchMonitorValue, getDeviceEntry, saveDeviceEntry } from "../lib/db";
import { getDevice } from "../lib/session";
import { subscribe, unsubscribe, currentSubscription, pushSupported } from "../lib/push";
import StatusTab from "./StatusTab";
import AlertsTab from "./AlertsTab";
import { SettingsIcon } from "./Icons";

function MonitorView({ db, monitor, monitors, initialTab, onSelect, onAdd, onSettings }) {
  const [config, setConfig] = useState(undefined);
  const [status, setStatus] = useState(null);
  const [device, setDevice] = useState(null);
  const [subscribed, setSubscribed] = useState(false);
  const [tab, setTab] = useState(initialTab === "history" ? "alerts" : "status");
  const [notifyError, setNotifyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState({});
  const { id: deviceId, name: deviceName } = getDevice();

  const load = useCallback(async () => {
    const [nextConfig, nextStatus, entry, subscription] = await Promise.all([
      readConfig(db, monitor),
      readStatus(db, monitor),
      getDeviceEntry(db, monitor, deviceId),
      currentSubscription(monitor),
    ]);
    setConfig(nextConfig);
    setStatus(nextStatus);
    setDevice(entry);
    setSubscribed(!!subscription && subscription.endpoint === entry?.subscription?.endpoint);
  }, [db, monitor, deviceId]);

  useEffect(() => {
    load();
    const stopConfig = watchMonitorValue(db, monitor, CONFIG_KEY, setConfig);
    const stopStatus = watchMonitorValue(db, monitor, STATUS_KEY, setStatus);
    return () => {
      stopConfig();
      stopStatus();
    };
  }, [db, monitor, load]);

  // Names of the other monitors, for the switcher
  useEffect(() => {
    monitors.forEach(({ pubkey }) =>
      readConfig(db, pubkey).then((c) => c && setNames((n) => ({ ...n, [pubkey]: c.name })))
    );
  }, [db, monitors]);

  const saveChannels = async (channels) => {
    setNotifyError("");
    setBusy(true);
    try {
      // Subscribing needs a click, which is where this is called from
      const subscription = channels.length
        ? await subscribe(monitor, config.vapidPublicKey)
        : device?.subscription || null;
      const entry = { name: deviceName, subscription, channels };
      await saveDeviceEntry(db, monitor, deviceId, entry);
      setDevice(entry);
      setSubscribed(!!subscription);
    } catch (err) {
      setNotifyError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = (channelId) => {
    const current = subscribed ? device?.channels || [] : [];
    saveChannels(
      current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]
    );
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await unsubscribe(monitor);
      const entry = { name: deviceName, subscription: null, channels: [] };
      await saveDeviceEntry(db, monitor, deviceId, entry);
      setDevice(entry);
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  };

  const enabledChannels = subscribed ? device?.channels || [] : [];
  const pushBroken = subscribed && status?.deadDevices?.includes(deviceId);

  return (
    <main className="page">
      <header className="topbar">
        {monitors.length > 1 ? (
          <select
            className="monitor-select"
            value={monitor}
            onChange={(e) => (e.target.value === "add" ? onAdd() : onSelect(e.target.value))}
          >
            {monitors.map(({ pubkey }) => (
              <option key={pubkey} value={pubkey}>
                {names[pubkey] || `${pubkey.slice(0, 8)}…`}
              </option>
            ))}
            <option value="add">+ Add a monitor</option>
          </select>
        ) : (
          <h1>{config?.name || "Monitor"}</h1>
        )}
        <button className="icon-btn" onClick={onSettings} aria-label="Settings">
          <SettingsIcon />
        </button>
      </header>

      {config === undefined ? (
        <div className="center"><div className="spinner" /></div>
      ) : config === null ? (
        <section className="card">
          <h2>Waiting for this monitor</h2>
          <p className="muted">
            Nothing from it yet. Check that it's running, that its <code>owner</code> is your npub,
            and that it uses at least one of your relays.
          </p>
          <button className="btn" onClick={load}>Check again</button>
        </section>
      ) : (
        <>
          <nav className="tabs">
            <button className={tab === "status" ? "tab tab--active" : "tab"} onClick={() => setTab("status")}>Status</button>
            <button className={tab === "alerts" ? "tab tab--active" : "tab"} onClick={() => setTab("alerts")}>Alerts</button>
          </nav>

          {tab === "status" ? (
            <StatusTab
              config={config}
              status={status}
              enabledChannels={enabledChannels}
              pushSupported={pushSupported()}
              pushBroken={pushBroken}
              notifyError={notifyError}
              busy={busy}
              onToggleChannel={toggleChannel}
              onEnableAll={() => saveChannels(config.channels.map((c) => c.id))}
              onTurnOff={turnOff}
            />
          ) : (
            <AlertsTab db={db} monitor={monitor} config={config} />
          )}
        </>
      )}
    </main>
  );
}

export default MonitorView;
