// Lee credenciales de proxy residencial desde variables de entorno.
// Configurar en Coolify:
//   PROXY_URL=http://gate.smartproxy.com:7000   (o el endpoint de tu provider)
//   PROXY_USERNAME=usuario
//   PROXY_PASSWORD=password
//
// Si PROXY_URL no está definida, devolvemos null y el adapter navega directo.

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export function getProxyConfig(): ProxyConfig | null {
  const url = process.env.PROXY_URL?.trim();
  if (!url) return null;

  return {
    server: url,
    username: process.env.PROXY_USERNAME?.trim() || undefined,
    password: process.env.PROXY_PASSWORD?.trim() || undefined,
  };
}

export function getProxyConfigFor(portal: string): ProxyConfig | null {
  // Permite override por portal: IDEALISTA_PROXY_URL, FOTOCASA_PROXY_URL...
  const upper = portal.toUpperCase();
  const url =
    process.env[`${upper}_PROXY_URL`]?.trim() ||
    process.env.PROXY_URL?.trim();
  if (!url) return null;

  return {
    server: url,
    username:
      process.env[`${upper}_PROXY_USERNAME`]?.trim() ||
      process.env.PROXY_USERNAME?.trim() ||
      undefined,
    password:
      process.env[`${upper}_PROXY_PASSWORD`]?.trim() ||
      process.env.PROXY_PASSWORD?.trim() ||
      undefined,
  };
}
