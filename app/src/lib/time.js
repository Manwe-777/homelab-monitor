export function ago(ts, now = Date.now()) {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/**
 * A YYYY-MM month as "September", with the year if it's not this year
 */
export function formatMonth(month) {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(year, m - 1, 1);
  return date.toLocaleDateString([], {
    month: "long",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}
