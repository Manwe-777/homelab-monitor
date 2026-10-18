/**
 * Web Push, one service worker registration per monitor: a registration
 * can only subscribe with one VAPID key, and each monitor has its own.
 */
const scopeOf = (monitor) => new URL(`./m/${monitor.slice(0, 16)}/`, document.baseURI).href;

export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/**
 * This monitor's registration, once its worker is active (push needs an
 * active worker). Not `navigator.serviceWorker.ready`: that waits for a
 * worker controlling this page, and ours are scoped to ./m/<monitor>/.
 */
async function registration(monitor) {
  const swUrl = new URL("./sw.js", document.baseURI).href;
  const reg = await navigator.serviceWorker.register(swUrl, { scope: scopeOf(monitor) });
  const worker = reg.installing || reg.waiting || reg.active;

  if (worker && worker.state !== "activated") {
    await new Promise((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("The notifications worker failed to install"));
      });
    });
  }
  return reg;
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Asks for permission (must come from a click) and subscribes to a monitor
 * @returns the subscription as JSON, to give to the monitor
 */
export function subscribe(monitor, vapidPublicKey) {
  return withTimeout(
    subscribeNow(monitor, vapidPublicKey),
    30000,
    "Enabling notifications timed out, try again"
  );
}

async function subscribeNow(monitor, vapidPublicKey) {
  if (!pushSupported()) throw new Error("This browser doesn't support push notifications");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site");

  const reg = await registration(monitor);
  const key = urlBase64ToUint8Array(vapidPublicKey);

  let subscription = await reg.pushManager.getSubscription();
  // Resubscribe if the monitor's key changed
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return subscription.toJSON();
}

export async function unsubscribe(monitor) {
  const reg = await navigator.serviceWorker?.getRegistration(scopeOf(monitor));
  const subscription = await reg?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

/**
 * Our current subscription to a monitor, if notifications are still allowed
 */
export async function currentSubscription(monitor) {
  if (!pushSupported() || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration(scopeOf(monitor));
  return (await reg?.pushManager.getSubscription())?.toJSON() || null;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sameKey(a, b) {
  if (!a) return false;
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((value, i) => value === b[i]);
}
