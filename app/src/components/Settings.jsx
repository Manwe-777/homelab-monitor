import { useState, useEffect } from "react";
import { getPublicKey, npubEncode } from "tool-db";
import { readConfig } from "../lib/db";
import { exportSecretKey, getRelays, saveRelays, getDevice, saveDeviceName } from "../lib/session";
import CopyField from "./CopyField";

function Settings({ db, secretKey, monitors, onRemoveMonitor, onSignOut, onBack }) {
  const [showKey, setShowKey] = useState(false);
  const [deviceName, setDeviceName] = useState(getDevice().name);
  const [relays, setRelays] = useState(getRelays().join("\n"));
  const [names, setNames] = useState({});
  const [saved, setSaved] = useState("");

  useEffect(() => {
    monitors.forEach(({ pubkey }) =>
      readConfig(db, pubkey).then((c) => c && setNames((n) => ({ ...n, [pubkey]: c.name })))
    );
  }, [db, monitors]);

  const saveDevice = (e) => {
    e.preventDefault();
    saveDeviceName(deviceName.trim() || getDevice().name);
    setSaved("device");
  };

  const applyRelays = (e) => {
    e.preventDefault();
    const list = relays.split(/\s+/).map((r) => r.trim()).filter((r) => /^wss?:\/\//.test(r));
    if (list.length === 0) return;
    saveRelays(list);
    location.reload();
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="btn btn--ghost btn--small" onClick={onBack}>← Back</button>
        <h1>Settings</h1>
        <span />
      </header>

      <section className="card">
        <h2>Your key</h2>
        <p className="muted">Monitors send alerts to this npub (their <code>owner</code>).</p>
        <CopyField value={npubEncode(getPublicKey(secretKey))} />
        {showKey ? (
          <>
            <p className="muted">Your secret key. Keep it safe, anyone with it can read your alerts.</p>
            <CopyField value={exportSecretKey(secretKey)} />
          </>
        ) : (
          <button className="btn btn--small" onClick={() => setShowKey(true)}>Show secret key (backup)</button>
        )}
      </section>

      <section className="card">
        <h2>Monitors</h2>
        <ul className="list">
          {monitors.map(({ pubkey }) => (
            <li key={pubkey} className="list__item">
              <div>
                <div>{names[pubkey] || "Unknown monitor"}</div>
                <code className="muted small">{npubEncode(pubkey).slice(0, 24)}…</code>
              </div>
              <button
                className="btn btn--small btn--danger"
                onClick={() => confirm("Remove this monitor from the app?") && onRemoveMonitor(pubkey)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>This device</h2>
        <form className="row" onSubmit={saveDevice}>
          <input value={deviceName} onChange={(e) => { setDeviceName(e.target.value); setSaved(""); }} />
          <button className="btn btn--small" type="submit">{saved === "device" ? "Saved" : "Save"}</button>
        </form>
        <p className="hint">Shown in the monitor's logs. Applies the next time you change notifications.</p>
      </section>

      <section className="card">
        <h2>Relays</h2>
        <form className="stack" onSubmit={applyRelays}>
          <textarea rows={4} value={relays} onChange={(e) => setRelays(e.target.value)} />
          <p className="hint">One per line. Use at least one relay your monitors use.</p>
          <button className="btn btn--small" type="submit">Save and reconnect</button>
        </form>
      </section>

      <button className="btn btn--danger" onClick={() => confirm("Sign out? You'll need your secret key to sign in again.") && onSignOut()}>
        Sign out
      </button>
    </main>
  );
}

export default Settings;
