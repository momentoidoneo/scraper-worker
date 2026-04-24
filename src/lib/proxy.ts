// Lee credenciales de proxy residencial desde variables de entorno.
// Configurar en Coolify:
//   PROXY_URL=http://geo.iproyal.com:12321
//   PROXY_USERNAME=usuario
//   PROXY_PASSWORD=password

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseProxyUrl(raw: string | undefined): ProxyConfig | null {
  const value = clean(raw);
  if (!value) return null;

  const withProtocol = value.startsWith("http") ? value : `http://${value}`;
  try {
    const url = new URL(withProtocol);
    const username = decodeURIComponent(url.username || "") || undefined;
    const password = decodeURIComponent(url.password || "") || undefined;
    url.username = "";
    url.password = "";
    return {
      server: url.toString().replace(/\/$/, ""),
      username,
      password,
    };
  } catch {
    return { server: withProtocol.replace(/\/\/[^/@]+@/, "//") };
  }
}

function proxyFromHost(host: string | undefined, port: string | undefined): ProxyConfig | null {
  const value = clean(host);
  if (!value) return null;

  const withProtocol = value.startsWith("http") ? value : `http://${value}`;
  try {
    const url = new URL(withProtocol);
    const proxyPort = clean(port);
    if (!url.port && proxyPort) url.port = proxyPort;
    return { server: url.toString().replace(/\/$/, "") };
  } catch {
    const proxyPort = clean(port);
    const portPart = proxyPort ? `:${proxyPort}` : "";
    return { server: `http://${value}${portPart}` };
  }
}

export function getProxyConfig(): ProxyConfig | null {
  const parsed = parseProxyUrl(process.env.PROXY_URL) || proxyFromHost(process.env.PROXY_HOST, process.env.PROXY_PORT);
  if (!parsed) return null;

  return {
    server: parsed.server,
    username: clean(process.env.PROXY_USERNAME) || clean(process.env.PROXY_USER) || parsed.username,
    password: clean(process.env.PROXY_PASSWORD) || clean(process.env.PROXY_PASS) || parsed.password,
  };
}

export function getProxyConfigFor(portal: string): ProxyConfig | null {
  const upper = portal.toUpperCase();
  const parsed =
    parseProxyUrl(process.env[`${upper}_PROXY_URL`]) ||
    parseProxyUrl(process.env.PROXY_URL) ||
    proxyFromHost(
      process.env[`${upper}_PROXY_HOST`] || process.env.PROXY_HOST,
      process.env[`${upper}_PROXY_PORT`] || process.env.PROXY_PORT,
    );
  if (!parsed) return null;

  return {
    server: parsed.server,
    username:
      clean(process.env[`${upper}_PROXY_USERNAME`]) ||
      clean(process.env[`${upper}_PROXY_USER`]) ||
      clean(process.env.PROXY_USERNAME) ||
      clean(process.env.PROXY_USER) ||
      parsed.username,
    password:
      clean(process.env[`${upper}_PROXY_PASSWORD`]) ||
      clean(process.env[`${upper}_PROXY_PASS`]) ||
      clean(process.env.PROXY_PASSWORD) ||
      clean(process.env.PROXY_PASS) ||
      parsed.password,
  };
}

export function isLikelyProxyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "407",
    "ERR_PROXY",
    "ERR_TUNNEL",
    "ERR_INVALID_AUTH_CREDENTIALS",
    "Proxy Authentication",
    "Timeout",
    "timeout",
  ].some((hint) => message.includes(hint));
}
