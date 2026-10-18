import { useState } from "react";
import { npubEncode } from "tool-db";
import { parsePubkey } from "../lib/db";
import CopyField from "./CopyField";

// Keys are case sensitive to keyboards: no capitals, corrections or suggestions
export const keyInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
};

function AddMonitor({ myPubkey, initialError = "", onAdd, onCancel, onSettings }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(initialError);

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
        <h1>Pair a monitor</h1>
        <button className="btn btn--ghost btn--small" onClick={onSettings}>Settings</button>
      </header>

      <section className="card">
        <p>
          On the server, run <code>homelab-monitor pair</code> and scan its QR code with your
          camera. Or paste the monitor's npub here:
        </p>
        <form className="stack" onSubmit={submit}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="npub1..."
            aria-label="Monitor npub"
            required
            {...keyInputProps}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary" type="submit">Pair</button>
          {onCancel && (
            <button className="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
          )}
        </form>
      </section>

      <section className="card">
        <p className="muted small">This device's key. The monitor's <code>owner</code> must be this npub:</p>
        <CopyField value={npubEncode(myPubkey)} />
        <details className="details">
          <summary>Setting up a new monitor?</summary>
          <p className="muted">Put this in its <code>config.yaml</code>, then pair:</p>
          <pre className="snippet">owner: {npubEncode(myPubkey)}</pre>
        </details>
      </section>
    </main>
  );
}

export default AddMonitor;
