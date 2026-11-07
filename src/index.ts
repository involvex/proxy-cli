import hasFlag from "has-flag";
import * as http from "http";
import { createProxy } from "proxy";

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
`);
  process.exit(0);
} else if (hasFlag("version") || hasFlag("v")) {
  console.log("proxy-cli version 1.0.0");
  process.exit(0);
} else if (hasFlag("server") || hasFlag("s")) {
  await run_server();
} else {
  await main();
}
async function run_server() {
  const server = await createProxy(http.createServer());
  await server.listen(3128, () => {
    var port = server.address().port || 3128;
    console.log("HTTP(s) proxy server listening on port %d", port);
  });
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
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
  }
}
