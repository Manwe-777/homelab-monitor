import { useState } from "react";
import { npubEncode } from "tool-db";
import { parsePubkey } from "../lib/db";
import CopyField from "./CopyField";

function AddMonitor({ myPubkey, onAdd, onCancel, onSettings }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    setError("");
    try {
      onAdd(parsePubkey(value));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="page">
      <header className="topbar">
        <h1>Add a monitor</h1>
        <button className="btn btn--ghost btn--small" onClick={onSettings}>Settings</button>
      </header>

      <section className="card">
        <h2>1. Make the monitor yours</h2>
        <p className="muted">Set your npub as the owner in the monitor's <code>config.yaml</code>:</p>
        <CopyField value={npubEncode(myPubkey)} />
        <pre className="snippet">owner: {npubEncode(myPubkey)}</pre>
      </section>

      <section className="card">
        <h2>2. Pair</h2>
        <p className="muted">
          Run <code>homelab-monitor pair</code> on the server and paste the monitor's npub:
        </p>
        <form className="stack" onSubmit={submit}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="npub1..."
            required
          />
          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary" type="submit">Add monitor</button>
          {onCancel && (
            <button className="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
          )}
        </form>
      </section>
    </main>
  );
}

export default AddMonitor;
