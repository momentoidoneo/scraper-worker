const HOST = process.env.PROXY_HOST;
const USER = process.env.PROXY_USER;
const PASS = process.env.PROXY_PASS;

export function getProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  if (!HOST) return undefined;
  return {
    server: HOST.startsWith("http") ? HOST : `http://${HOST}`,
    username: USER || undefined,
    password: PASS || undefined,
  };
}
