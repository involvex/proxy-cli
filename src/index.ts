#!/usr/bin/env node
import hasFlag from "has-flag";
import * as http from "http";
import * as net from "net";

const all_proxies_url =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt";
const http_proxies_url =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt";
const socks4_proxies_url =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt";
const socks5_proxies_url =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt";
const country_proxies_base_url =
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/";
const country_proxies_url = (country_code: string) =>
  `${country_proxies_base_url}${country_code.toLowerCase()}/data.txt`;

const DEFAULT_PORT = 3128;
const DEFAULT_TIMEOUT_MS = 10000;

const hopByHopHeaders = [
  "Connection",
  "Keep-Alive",
  "Proxy-Authenticate",
  "Proxy-Authorization",
  "TE",
  "Trailers",
  "Transfer-Encoding",
  "Upgrade",
];
const isHopByHop = new RegExp("^(" + hopByHopHeaders.join("|") + ")$", "i");

interface ProxyEntry {
  protocol: "http" | "socks4" | "socks5";
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

interface ServerOptions {
  port: number;
  timeoutMs: number;
  refreshMs?: number;
  proxy?: string;
  all: boolean;
  http: boolean;
  socks4: boolean;
  socks5: boolean;
  country?: string;
}

let upstreamList: ProxyEntry[] = [];
let upstreamIndex = 0;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

if (hasFlag("help") || hasFlag("h") || hasFlag("-h")) {
  console.log(`Usage: proxy-cli [options]
Options:
  --help, -h          Show help information
  --version, -v       Show version information
  --all               Fetch all proxies
  --http              Fetch HTTP proxies
  --socks4            Fetch SOCKS4 proxies
  --socks5            Fetch SOCKS5 proxies
  --country <code>    Fetch proxies for a specific country (e.g., US, CA, GB)
  --server, -s        Run as a forwarding proxy server
  --proxy <url>       Single upstream proxy to route through
  --port, -p <port>   Local port to listen on in server mode (default 3128)
  --timeout <ms>      Upstream request timeout in ms (default 10000)
  --refresh <ms>      Refetch the proxy list every N ms in server mode
`);
  process.exit(0);
} else if (hasFlag("version") || hasFlag("v")) {
  console.log("proxy-cli version 1.0.0");
  process.exit(0);
} else if (
  hasFlag("all") ||
  hasFlag("http") ||
  hasFlag("socks4") ||
  hasFlag("socks5") ||
  hasFlag("country") ||
  hasFlag("server") ||
  hasFlag("s")
) {
  if (hasFlag("server") || hasFlag("s")) {
    await run_server(parseServerOptions());
  } else {
    await main();
  }
} else {
  // No flags given: default to serving a proxy.
  await run_server(parseServerOptions());
}

function parseServerOptions(): ServerOptions {
  const port =
    parseInt(getFlagValue("--port") ?? getFlagValue("-p") ?? "", 10) ||
    DEFAULT_PORT;
  const timeoutMs =
    parseInt(getFlagValue("--timeout") ?? "", 10) || DEFAULT_TIMEOUT_MS;
  const refreshMs = getFlagValue("--refresh")
    ? parseInt(getFlagValue("--refresh")!, 10)
    : undefined;
  return {
    port,
    timeoutMs,
    refreshMs,
    proxy: getFlagValue("--proxy"),
    all: hasFlag("all"),
    http: hasFlag("http"),
    socks4: hasFlag("socks4"),
    socks5: hasFlag("socks5"),
    country: getFlagValue("--country"),
  };
}

function getFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function parseProxy(line: string): ProxyEntry {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("empty proxy line");
  const parsed = new URL(trimmed);
  const protocol = parsed.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "socks4" && protocol !== "socks5") {
    throw new Error(`unsupported proxy protocol: ${protocol}`);
  }
  const port = parseInt(parsed.port, 10);
  if (!port || port < 1 || port > 65535) {
    throw new Error(`invalid proxy port: ${parsed.port}`);
  }
  const entry: ProxyEntry = {
    protocol: protocol as "http" | "socks4" | "socks5",
    host: parsed.hostname,
    port,
  };
  if (parsed.username) {
    entry.auth = {
      username: parsed.username,
      password: parsed.password ?? "",
    };
  }
  return entry;
}

async function fetchProxies(url: string): Promise<string[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch proxies from ${url}: ${response.statusText}`,
    );
  }
  const data = await response.text();
  return data.split("\n").filter((line) => line.trim() !== "");
}

async function buildUpstreamList(
  options: ServerOptions,
): Promise<ProxyEntry[]> {
  if (options.proxy) {
    return [parseProxy(options.proxy)];
  }
  const urls: string[] = [];
  if (options.all) {
    urls.push(all_proxies_url);
  } else if (options.http) {
    urls.push(http_proxies_url);
  } else if (options.socks4) {
    urls.push(socks4_proxies_url);
  } else if (options.socks5) {
    urls.push(socks5_proxies_url);
  } else if (options.country) {
    urls.push(country_proxies_url(options.country));
  } else {
    urls.push(all_proxies_url);
  }

  const entries: ProxyEntry[] = [];
  for (const url of urls) {
    try {
      const lines = await fetchProxies(url);
      for (const line of lines) {
        try {
          entries.push(parseProxy(line));
        } catch {
          // skip malformed lines
        }
      }
    } catch (e) {
      console.error(`Warning: ${errorMessage(e)}`);
    }
  }
  return entries;
}

function getNextProxy(): ProxyEntry | null {
  if (upstreamList.length === 0) return null;
  const entry = upstreamList[upstreamIndex % upstreamList.length]!;
  upstreamIndex++;
  return entry;
}

function connectPromise(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(
        new Error(
          `timeout connecting to ${socket.remoteAddress}:${socket.remotePort}`,
        ),
      );
    };
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

class SocketReader {
  private buf = Buffer.alloc(0);
  private eof = false;
  private err: Error | null = null;
  private queue: {
    n: number;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  }[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private socket: net.Socket,
    private timeoutMs: number,
  ) {
    socket.on("data", (c) =>
      this.onData(typeof c === "string" ? Buffer.from(c, "latin1") : c),
    );
    socket.on("end", () => {
      this.eof = true;
      this.process();
    });
    socket.on("error", (e) => {
      this.err = e;
      this.process();
    });
    socket.on("close", () => {
      if (!this.eof && !this.err) {
        this.err = new Error("socket closed");
        this.process();
      }
    });
  }

  private onData(c: Buffer) {
    this.buf = Buffer.concat([this.buf, c]);
    this.process();
    this.refreshTimer();
  }

  private refreshTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.err = new Error("timeout");
      this.process();
    }, this.timeoutMs);
  }

  private process() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      const { n, resolve, reject } = this.queue[0]!;
      if (this.err) {
        this.queue.shift();
        reject(this.err);
        continue;
      }
      if (this.buf.length >= n) {
        this.queue.shift();
        resolve(this.buf.slice(0, n));
        this.buf = this.buf.slice(n);
        continue;
      }
      if (this.eof && this.buf.length === 0) {
        this.queue.shift();
        reject(new Error("eof"));
        continue;
      }
      break;
    }
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.queue.push({ n, resolve, reject });
      this.process();
      this.refreshTimer();
    });
  }

  async readUntil(pattern: string): Promise<Buffer> {
    const pat = Buffer.from(pattern, "latin1");
    const acc: Buffer[] = [];
    while (true) {
      const b = await this.read(1);
      acc.push(b);
      const cat = Buffer.concat(acc);
      const idx = cat.indexOf(pat);
      if (idx !== -1) {
        return cat.slice(0, idx + pat.length);
      }
    }
  }
}

async function readChunked(reader: SocketReader): Promise<Buffer> {
  const parts: Buffer[] = [];
  while (true) {
    const lineBuf = await reader.readUntil("\r\n");
    const line = lineBuf.toString("latin1").trim();
    const size = parseInt(line.split(";")[0]!.trim(), 16);
    if (!size) {
      // consume trailer headers until the empty line (robust against early EOF)
      while (true) {
        try {
          const trailer = await reader.readUntil("\r\n");
          if (trailer.length <= 2) break;
        } catch {
          break;
        }
      }
      break;
    }
    parts.push(await reader.read(size));
    await reader.read(2);
  }
  return Buffer.concat(parts);
}

async function readUntilClose(reader: SocketReader): Promise<Buffer> {
  const parts: Buffer[] = [];
  while (true) {
    try {
      parts.push(await reader.read(4096));
    } catch (e) {
      if ((e as Error).message === "eof") break;
      throw e;
    }
  }
  return Buffer.concat(parts);
}

async function readHttpResponseHead(
  reader: SocketReader,
): Promise<{ statusCode: number; headers: Record<string, string> }> {
  const headerBuf = await reader.readUntil("\r\n\r\n");
  const headerText = headerBuf.toString("latin1");
  const lines = headerText.split("\r\n");
  const statusCode = parseInt(lines[0]!.split(" ")![1] ?? "0", 10);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(":");
    if (idx !== -1) {
      headers[lines[i]!.slice(0, idx).toLowerCase()] = lines[i]!.slice(
        idx + 1,
      ).trim();
    }
  }
  return { statusCode, headers };
}

async function readHttpResponse(reader: SocketReader): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}> {
  const { statusCode, headers } = await readHttpResponseHead(reader);
  const cl = headers["content-length"];
  let body: Buffer;
  if (cl !== undefined) {
    body = await reader.read(parseInt(cl, 10));
  } else if (
    headers["transfer-encoding"] &&
    headers["transfer-encoding"]!.includes("chunked")
  ) {
    body = await readChunked(reader);
  } else {
    body = await readUntilClose(reader);
  }
  return { statusCode, headers, body };
}

function buildSocksAddr(host: string): Buffer {
  if (net.isIP(host) === 4) {
    return Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(host.split(".").map(Number)),
    ]);
  }
  const hb = Buffer.from(host, "utf8");
  return Buffer.concat([Buffer.from([0x03, hb.length]), hb]);
}

async function socks5Connect(
  entry: ProxyEntry,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = net.connect(entry.port, entry.host);
  const reader = new SocketReader(socket, timeoutMs);
  await connectPromise(socket, timeoutMs);

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greet = await reader.read(2);
  if (greet[0] !== 0x05 || greet[1] !== 0x00) {
    socket.destroy();
    throw new Error("SOCKS5 greeting failed");
  }

  const addr = buildSocksAddr(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

  const resp = await reader.read(4);
  if (resp[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 connect failed: ${resp[1]}`);
  }
  const atyp = resp[3];
  let addrLen: number;
  if (atyp === 0x01) addrLen = 4;
  else if (atyp === 0x04) addrLen = 16;
  else if (atyp === 0x03) {
    addrLen = (await reader.read(1))[0]!;
  } else {
    socket.destroy();
    throw new Error(`SOCKS5 bad address type: ${atyp}`);
  }
  if (addrLen > 0) await reader.read(addrLen);
  await reader.read(2);
  return socket;
}

async function socks4Connect(
  entry: ProxyEntry,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = net.connect(entry.port, entry.host);
  const reader = new SocketReader(socket, timeoutMs);
  await connectPromise(socket, timeoutMs);

  const ip = net.isIP(host);
  let ipBuf: Buffer;
  let domainBuf: Buffer | null = null;
  if (ip === 4) {
    ipBuf = Buffer.from(host.split(".").map(Number));
  } else {
    ipBuf = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    domainBuf = Buffer.from(host, "utf8");
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const userid = Buffer.from([0x00]);
  const body = domainBuf
    ? Buffer.concat([portBuf, ipBuf, userid, domainBuf, Buffer.from([0x00])])
    : Buffer.concat([portBuf, ipBuf, userid]);
  socket.write(Buffer.concat([Buffer.from([0x04, 0x01]), body]));

  const resp = await reader.read(8);
  if (resp.length < 8 || resp[0] !== 0x00 || resp[1] !== 0x5a) {
    socket.destroy();
    throw new Error("SOCKS4 connect failed");
  }
  return socket;
}

function clientHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

async function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forwardHttp(
  entry: ProxyEntry,
  targetUrl: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}> {
  const socket = net.connect(entry.port, entry.host);
  const reader = new SocketReader(socket, timeoutMs);
  await connectPromise(socket, timeoutMs);

  const authHeader = entry.auth
    ? "Basic " +
      Buffer.from(`${entry.auth.username}:${entry.auth.password}`).toString(
        "base64",
      )
    : null;

  let head = `${method} ${targetUrl.href} HTTP/1.1\r\n`;
  head += `Host: ${targetUrl.host}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    const kl = key.toLowerCase();
    if (isHopByHop.test(kl) || kl === "host" || kl === "proxy-authorization")
      continue;
    const safeValue = value.replace(/\r\n/g, " ");
    head += `${key}: ${safeValue}\r\n`;
  }
  if (authHeader) head += `Proxy-Authorization: ${authHeader}\r\n`;
  head += "Connection: close\r\n\r\n";

  socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
  const resp = await readHttpResponse(reader);
  socket.end();
  return resp;
}

async function connectUpstream(
  entry: ProxyEntry,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket | null> {
  if (entry.protocol === "http") {
    const socket = net.connect(entry.port, entry.host);
    const reader = new SocketReader(socket, timeoutMs);
    await connectPromise(socket, timeoutMs);

    const authHeader = entry.auth
      ? "Basic " +
        Buffer.from(`${entry.auth.username}:${entry.auth.password}`).toString(
          "base64",
        )
      : null;
    let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
    if (authHeader) req += `Proxy-Authorization: ${authHeader}\r\n`;
    req += "Connection: close\r\n\r\n";
    socket.write(req);

    const resp = await readHttpResponseHead(reader);
    if (resp.statusCode !== 200) {
      socket.destroy();
      return null;
    }
    // CONNECT response has no body; the socket is now the tunnel.
    return socket;
  }
  if (entry.protocol === "socks5") {
    return await socks5Connect(entry, host, port, timeoutMs);
  }
  return await socks4Connect(entry, host, port, timeoutMs);
}

async function run_server(options: ServerOptions) {
  upstreamList = await buildUpstreamList(options);
  console.log(`Loaded ${upstreamList.length} upstream proxies`);

  if (options.refreshMs) {
    setInterval(async () => {
      try {
        upstreamList = await buildUpstreamList(options);
        console.log(`Refreshed upstream proxy list (${upstreamList.length})`);
      } catch (e) {
        console.error(`Warning: refresh failed: ${errorMessage(e)}`);
      }
    }, options.refreshMs);
  }

  const server = http.createServer();

  server.on("request", async (req, res) => {
    const body = await collectBody(req);
    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url ?? "http://localhost/");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid request URL\n");
      return;
    }

    const headers = clientHeaders(req);
    const maxAttempts = upstreamList.length;
    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts++;
      const entry = getNextProxy();
      if (!entry) break;
      try {
        const resp = await forwardHttp(
          entry,
          targetUrl,
          req.method ?? "GET",
          headers,
          body,
          options.timeoutMs,
        );
        const outHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(resp.headers)) {
          if (isHopByHop.test(key)) continue;
          outHeaders[key] = value;
        }
        res.writeHead(resp.statusCode, outHeaders);
        res.end(resp.body);
        return;
      } catch {
        // try the next upstream proxy
        continue;
      }
    }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway: all upstream proxies failed\n");
  });

  server.on("connect", async (req, socket, head) => {
    const lastColon = req.url?.lastIndexOf(":");
    if (lastColon === undefined || lastColon < 0) {
      socket.destroy();
      return;
    }
    const host = req.url!.substring(0, lastColon);
    const port = parseInt(req.url!.substring(lastColon + 1), 10);

    let attempts = 0;
    const maxAttempts = upstreamList.length;
    while (attempts < maxAttempts) {
      attempts++;
      const entry = getNextProxy();
      if (!entry) break;
      try {
        const tunnel = await connectUpstream(
          entry,
          host,
          port,
          options.timeoutMs,
        );
        if (!tunnel) continue;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
        const cleanup = () => {
          socket.destroy();
          tunnel.destroy();
        };
        socket.on("error", cleanup);
        tunnel.on("error", cleanup);
        socket.on("close", () => tunnel.destroy());
        tunnel.on("close", () => socket.destroy());
        return;
      } catch {
        continue;
      }
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, () => {
      const address = server.address();
      const port =
        typeof address === "string" ? address : (address?.port ?? options.port);
      console.log("HTTP(s) proxy server listening on port %d", port);
      resolve();
    });
    server.once("error", reject);
  });
}

async function main() {
  try {
    if (hasFlag("all")) {
      const proxies = await fetchProxies(all_proxies_url);
      console.log(proxies.join("\n"));
    } else if (hasFlag("http")) {
      const proxies = await fetchProxies(http_proxies_url);
      console.log(proxies.join("\n"));
    } else if (hasFlag("socks4")) {
      const proxies = await fetchProxies(socks4_proxies_url);
      console.log(proxies.join("\n"));
    } else if (hasFlag("socks5")) {
      const proxies = await fetchProxies(socks5_proxies_url);
      console.log(proxies.join("\n"));
    } else if (hasFlag("country")) {
      const countryCode = process.argv[process.argv.indexOf("--country") + 1];
      if (!countryCode) {
        throw new Error("Country code is required when using --country option");
      }
      const proxies = await fetchProxies(country_proxies_url(countryCode));
      console.log(proxies.join("\n"));
    }
  } catch (e) {
    console.error(`Error: ${errorMessage(e)}`);
  }
}
