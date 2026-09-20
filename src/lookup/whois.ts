import { connect } from 'cloudflare:sockets';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BYTES = 64_000;

/**
 * 通过 TCP 43 端口执行一次 WHOIS 查询。
 *
 * 注意：写完 payload 后必须用 writer.releaseLock() 而不是 writer.close()。
 * close() 会同时关闭底层 socket 的读方向，导致服务端响应还没到就被丢弃、读回 0 字节。
 */
export async function whoisQuery(server: string, query: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const socket = connect({ hostname: server, port: 43 });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`whois timeout after ${timeoutMs}ms (${server})`)), timeoutMs);
  });

  try {
    return await Promise.race([readWhois(socket, server, query), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      socket.close();
    } catch {
      /* socket 可能已被服务端关闭 */
    }
  }
}

async function readWhois(socket: ReturnType<typeof connect>, server: string, query: string): Promise<string> {
  await socket.opened;

  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(query + '\r\n'));
  writer.releaseLock();

  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= MAX_BYTES) break;
  }
  if (!out.trim()) throw new Error(`empty response from whois server ${server}`);
  return out;
}

/**
 * 向 IANA 查询某个 TLD 的权威 WHOIS 服务器。
 * 覆盖 RDAP bootstrap 里没有的 ccTLD（如 .cn → whois.cnnic.cn）。
 */
export async function discoverWhoisServer(tld: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const text = await whoisQuery('whois.iana.org', tld, timeoutMs);
  const m = text.match(/^\s*whois:\s*(\S+)\s*$/im);
  if (!m) return null;
  const server = m[1].toLowerCase();
  return server.includes('.') ? server : null;
}

const NOT_FOUND_PATTERNS = [
  /No match for/i,
  /NOT FOUND/i,
  /No Data Found/i,
  /No entries found/i,
  /No Object Found/i,
  /No matching record/i,
  /Domain not found/i,
  /does not exist/i,
  /is available for (purchase|registration)/i,
  /Status:\s*(free|AVAILABLE)\b/i,
  /is free\b/i,
  /^%\s*The queried object does not exist/im,
];

export function isWhoisNotFound(text: string): boolean {
  return NOT_FOUND_PATTERNS.some((re) => re.test(text));
}
