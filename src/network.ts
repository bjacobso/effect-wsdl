import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
export interface NetworkPolicy {
  /** Exact URL hosts, including nondefault ports; no wildcards. */
  readonly allowHosts?: readonly string[];
  /** Explicit opt-in for internal enterprise endpoints; still requires allowHosts. */
  readonly allowPrivateAddresses?: boolean;
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export async function readRemote(
  url: URL,
  limit: number,
  policy: NetworkPolicy,
  signal: AbortSignal,
): Promise<string> {
  if (!policy.allowHosts?.length)
    throw new Error("Remote loading is disabled; configure allowHosts explicitly");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !policy.allowHosts.includes(url.host)
  )
    throw new Error("Remote source is not allowed by host/protocol policy");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (
    !addresses.length ||
    (!policy.allowPrivateAddresses && addresses.some((a) => !publicAddress(a.address)))
  )
    throw new Error("Remote source resolves to a blocked network address");
  const pinned = addresses[0]!;
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  return new Promise((resolve, reject) => {
    // A fresh socket and a pinned lookup prevent DNS rebinding between validation and connection.
    // Redirects are rejected rather than transferring credentials/policy to another origin.
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        agent: false,
        lookup: pinnedLookup,
        headers: { accept: "application/xml, text/xml", "accept-encoding": "identity" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error("Remote source must return HTTP 200; redirects are disabled"));
          return;
        }
        if (
          response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity"
        ) {
          response.destroy();
          reject(new Error("Compressed sources are unsupported"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > limit) {
            response.destroy();
            reject(new Error("Document byte limit exceeded"));
          } else chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("Remote source stream failed")));
        response.on("end", () => {
          try {
            resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            reject(new Error("Remote source is not UTF-8"));
          }
        });
      },
    );
    request.on("error", () => reject(new Error("Remote source request failed")));
    request.end();
  });
}
