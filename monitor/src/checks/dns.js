import { Resolver, lookup } from "node:dns/promises";
import net from "node:net";

/**
 * DNS check: a DNS server answers for a name.
 *   server: 192.0.2.53         (IP or host name of the DNS server)
 *   domain: dashboard.example.com
 *   expect: 192.0.2.10         (optional: an address the answer must include)
 *   port: 53                   (default)
 */
export async function checkDns(check) {
  const server = net.isIP(check.server) ? check.server : (await lookup(check.server)).address;
  const resolver = new Resolver({ timeout: check.timeoutMs, tries: 1 });
  resolver.setServers([net.isIPv6(server) ? `[${server}]:${check.port || 53}` : `${server}:${check.port || 53}`]);

  const started = Date.now();
  try {
    const addresses = await resolver.resolve4(check.domain);
    if (check.expect && !addresses.includes(check.expect)) {
      return { ok: false, message: `${check.domain} resolved to ${addresses.join(", ")}, expected ${check.expect}` };
    }
    return { ok: true, message: `${check.domain} → ${addresses[0]} in ${Date.now() - started} ms` };
  } catch (err) {
    return { ok: false, message: `${check.domain}: ${err.code || err.message}` };
  }
}
