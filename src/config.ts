// Runtime configuration, read once at boot. Nothing here is a secret: the
// gateway holds no credentials of its own, only the address of the account
// API it forwards every call to.

export interface GatewayConfig {
  /** Base URL of the account API, no trailing slash. */
  accountApiUrl: string;
  /** HTTP port the gateway listens on. */
  port: number;
  /** Hostname that selects the A2A behaviour; every other Host defaults to MCP. */
  a2aHost: string;
  /**
   * Public base URL of the A2A service, with trailing slash. Not the host
   * root: a2a.agentspodium.com is the platform's agent directory (neighbour's
   * a2a-router), so the hosting service lives under /hosting/ there and the
   * gateway strips that prefix before the request reaches this process.
   */
  a2aBaseUrl: string;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    accountApiUrl: stripTrailingSlash(env.ACCOUNT_API ?? "https://agentspodium.com/api"),
    port: Number(env.PORT ?? 3200),
    a2aHost: env.A2A_HOST ?? "a2a.agentspodium.com",
    a2aBaseUrl: env.A2A_BASE_URL ?? `https://${env.A2A_HOST ?? "a2a.agentspodium.com"}/hosting/`,
  };
}
