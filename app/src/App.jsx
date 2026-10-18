import { useEffect, useState, useCallback } from "react";
import { getPublicKey } from "tool-db";
import { getSecretKey, forgetSecretKey } from "./lib/session";
import { connect, getMonitors, saveMonitors, parsePubkey } from "./lib/db";
import { unsubscribe } from "./lib/push";
import Setup from "./components/Setup";
import AddMonitor from "./components/AddMonitor";
import MonitorView from "./components/MonitorView";
import Settings from "./components/Settings";

// Where a notification asked us to go: ?monitor=...&tab=history
function readLink() {
  const params = new URLSearchParams(location.search);
  return { monitor: params.get("monitor"), tab: params.get("tab") };
}

// A pairing link from `homelab-monitor pair`: ?pair=npub1...
const pairParam = new URLSearchParams(location.search).get("pair");

function App() {
  const [secretKey, setSecretKey] = useState(getSecretKey);
  const [db, setDb] = useState(null);
  const [error, setError] = useState("");
  const [monitors, setMonitors] = useState(null);
  const [screen, setScreen] = useState({ name: "monitor", ...readLink() });
  const [pairError, setPairError] = useState("");

  useEffect(() => {
    if (!secretKey) return;
    let cancelled = false;
    let instance;

    connect(secretKey)
      .then(async (connected) => {
        instance = connected;
        const list = await getMonitors(connected);
        if (cancelled) return;
        setDb(connected);

        // Pair from the link once, then drop it from the address
        if (pairParam) {
          history.replaceState(null, "", location.pathname);
          try {
            const pubkey = parsePubkey(pairParam);
            if (!list.some((m) => m.pubkey === pubkey)) {
              list.push({ pubkey, addedAt: Date.now() });
              await saveMonitors(connected, list);
            }
            setScreen({ name: "monitor", monitor: pubkey });
          } catch (err) {
            setPairError(err.message);
            setScreen({ name: "add" });
          }
        }
        setMonitors(list);
      })
      .catch((err) => setError(err.message));

    return () => {
      cancelled = true;
      instance?.close();
    };
  }, [secretKey]);

  // Notification clicks while the app is open
  useEffect(() => {
    const onMessage = (event) => {
      if (event.data?.type !== "open") return;
      const params = new URL(event.data.url).searchParams;
      setScreen({ name: "monitor", monitor: params.get("monitor"), tab: params.get("tab") });
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  const updateMonitors = useCallback(
    async (list) => {
      setMonitors(list);
      await saveMonitors(db, list);
    },
    [db]
  );

  const addMonitor = async (pubkey) => {
    if (!monitors.some((m) => m.pubkey === pubkey)) {
      await updateMonitors([...monitors, { pubkey, addedAt: Date.now() }]);
    }
    setScreen({ name: "monitor", monitor: pubkey });
  };

  const removeMonitor = async (pubkey) => {
    await unsubscribe(pubkey).catch(() => {});
    await updateMonitors(monitors.filter((m) => m.pubkey !== pubkey));
  };

  const signOut = () => {
    forgetSecretKey();
    setDb(null);
    setMonitors(null);
    setSecretKey(null);
  };

  if (!secretKey) return <Setup onDone={setSecretKey} />;

  if (error) {
    return (
      <main className="center">
        <p className="error">Could not connect: {error}</p>
        <button className="btn" onClick={() => location.reload()}>Retry</button>
      </main>
    );
  }

  if (!db || !monitors) {
    return (
      <main className="center">
        <div className="spinner" />
        <p className="muted">Connecting to relays…</p>
      </main>
    );
  }

  const myPubkey = getPublicKey(secretKey);

  if (screen.name === "settings") {
    return (
      <Settings
        db={db}
        secretKey={secretKey}
        monitors={monitors}
        onRemoveMonitor={removeMonitor}
        onSignOut={signOut}
        onBack={() => setScreen({ name: "monitor" })}
      />
    );
  }

  if (screen.name === "add" || monitors.length === 0) {
    return (
      <AddMonitor
        myPubkey={myPubkey}
        initialError={pairError}
        onAdd={addMonitor}
        onCancel={monitors.length ? () => setScreen({ name: "monitor" }) : null}
        onSettings={() => setScreen({ name: "settings" })}
      />
    );
  }

  const current = monitors.find((m) => m.pubkey === screen.monitor) || monitors[0];

  return (
    <MonitorView
      key={current.pubkey}
      db={db}
      monitor={current.pubkey}
      monitors={monitors}
      initialTab={screen.tab}
      onSelect={(pubkey) => setScreen({ name: "monitor", monitor: pubkey })}
      onAdd={() => setScreen({ name: "add" })}
      onSettings={() => setScreen({ name: "settings" })}
    />
  );
}

export default App;
