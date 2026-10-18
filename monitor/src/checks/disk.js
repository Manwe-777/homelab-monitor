import { statfs, access } from "node:fs/promises";
import { join } from "node:path";

const GB = 1024 ** 3;

const formatSize = (bytes) =>
  bytes >= 1024 * GB ? `${(bytes / 1024 / GB).toFixed(1)} TB` : `${(bytes / GB).toFixed(1)} GB`;

/**
 * Disk check: the filesystem holding a path has room left.
 *   path: /data                (any path on the filesystem to watch)
 *   maxUsedPercent: 90         (default 90)
 *   minFreeGb: 10              (optional)
 *   marker: MOUNTED            (optional: a file that must exist in `path`, so
 *                               an unmounted share isn't measured as the disk under it)
 */
export async function checkDisk(check) {
  if (check.marker) {
    try {
      await access(join(check.path, check.marker));
    } catch {
      return { ok: false, message: `Not mounted (${check.marker} is missing)` };
    }
  }

  const stats = await statfs(check.path);
  // Like df: what's used, out of what non-root users can use
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const free = stats.bavail * stats.bsize;
  const percent = (used / (used + free)) * 100;
  const message = `${Math.round(percent)}% used, ${formatSize(free)} free`;

  const maxUsed = check.maxUsedPercent ?? 90;
  if (percent > maxUsed) return { ok: false, message: `${message} (over ${maxUsed}%)` };
  if (check.minFreeGb !== undefined && free < check.minFreeGb * GB) {
    return { ok: false, message: `${message} (under ${check.minFreeGb} GB)` };
  }
  return { ok: true, message };
}
