/**
 * Web Push, one service worker registration per monitor: a registration
 * can only subscribe with one VAPID key, and each monitor has its own.
 */
const scopeOf = (monitor) => new URL(`./m/${monitor.slice(0, 16)}/`, document.baseURI).href;

export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(monitor) {
  const swUrl = new URL("./sw.js", document.baseURI).href;
  return navigator.serviceWorker.register(swUrl, { scope: scopeOf(monitor) });
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Asks for permission (must come from a click) and subscribes to a monitor
 * @returns the subscription as JSON, to give to the monitor
 */
export async function subscribe(monitor, vapidPublicKey) {
  if (!pushSupported()) throw new Error("This browser doesn't support push notifications");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site");

  const reg = await registration(monitor);
  await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(vapidPublicKey);

  let subscription = await reg.pushManager.getSubscription();
  // Resubscribe if the monitor's key changed
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ||= await withTimeout(
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
    20000,
    "Couldn't reach this browser's push service, try again later"
  );
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
