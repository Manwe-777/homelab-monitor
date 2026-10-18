import { useState } from "react";
import { saveSecretKey } from "../lib/session";

function Setup({ onDone }) {
  const [mode, setMode] = useState("choose");
  const [nsec, setNsec] = useState("");
  const [error, setError] = useState("");

  const useKey = (key) => {
    setError("");
    try {
      onDone(saveSecretKey(key));
    } catch {
      setError("That's not a valid secret key");
    }
  };

  return (
    <main className="center setup">
      <img src="./icon.svg" alt="" className="setup__logo" />
      <h1>Homelab Monitor</h1>
      <p className="muted">
        Alerts from your homelab, end to end encrypted with your Nostr key.
      </p>

      {mode === "choose" ? (
        <div className="stack">
          <button className="btn btn--primary" onClick={() => useKey()}>
            Create a new key
          </button>
          <button className="btn" onClick={() => setMode("import")}>
            I have a key (nsec)
          </button>
          <p className="hint">
            A key just for your homelab is safest. Your key stays on this device.
          </p>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            useKey(nsec);
          }}
        >
          <input
            type="password"
            value={nsec}
            onChange={(e) => setNsec(e.target.value)}
            placeholder="nsec1..."
            autoFocus
            required
          />
          {error && <p className="error">{error}</p>}
          <button className="btn btn--primary" type="submit">Continue</button>
          <button className="btn btn--ghost" type="button" onClick={() => setMode("choose")}>
            Back
          </button>
        </form>
      )}
    </main>
  );
}

export default Setup;
