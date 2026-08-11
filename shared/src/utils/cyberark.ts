// ── CyberArk Conjur REST API Client ───────────────────────────────
//
// Implements the Conjur API specification:
//   Auth:   POST /api/authn/{account}/{login}/authenticate
//           Body: raw API key (text/plain), Response: base64 token
//   Secret: GET  /api/secrets/{account}/variable/{identifier}
//           Authorization: Token token="<base64-token>"
//           Response: raw text
//
// Token TTL is 8 minutes (cryptographically embedded in the token).
// On 401, we clear the cached token and retry once.
//
// For self-hosted Conjur, omit the /api prefix:
//   Auth:   POST /authn/{account}/{login}/authenticate
//   Secret: GET  /secrets/{account}/variable/{identifier}
// ──────────────────────────────────────────────────────────────────

import https from 'node:https';

export interface CyberArkConfig {
  baseUrl: string;
  account: string;
  login: string;
  apiKey: string;
  caCert?: string;
  /** Set to true for self-hosted Conjur (no /api prefix) */
  selfHosted?: boolean;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

// Token cache — TTL is 8 min per spec, re-auth before expiry
const TOKEN_TTL_MS = 8 * 60 * 1000;
const tokenCache = new Map<string, CacheEntry>();

function apiPrefix(config: CyberArkConfig): string {
  return config.selfHosted ? '' : '/api';
}

function fetchOptions(config: CyberArkConfig): RequestInit & { agent?: https.Agent } {
  const opts: RequestInit & { agent?: https.Agent } = {};
  if (config.caCert) {
    opts.agent = new https.Agent({ ca: config.caCert });
  }
  return opts;
}

function cacheKey(config: CyberArkConfig): string {
  return `${config.baseUrl}:${config.account}:${config.login}`;
}

/**
 * Authenticate to Conjur and return a base64-encoded access token.
 * The token is valid for 8 minutes.
 *
 * Spec: POST /api/authn/{account}/{login}/authenticate
 * Body: raw API key (text/plain)
 * Response: raw base64 token (text/plain)
 */
export async function authenticate(config: CyberArkConfig): Promise<string> {
  const ck = cacheKey(config);
  const cached = tokenCache.get(ck);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

const loginEncoded = encodeURIComponent(config.login);
const accountEncoded = encodeURIComponent(config.account);
const url = `${config.baseUrl.replace(/\/$/, '')}${apiPrefix(config)}/authn/${accountEncoded}/${loginEncoded}/authenticate`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Accept-Encoding': 'base64',
      },
      body: config.apiKey,
      signal: controller.signal,
      ...fetchOptions(config),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Conjur auth failed: ${res.status} ${err}`);
    }

    const token = await res.text();
    tokenCache.set(ck, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retrieve a secret value from Conjur by its variable path.
 *
 * Spec: GET /api/secrets/{account}/variable/{identifier}
 * Authorization: Token token="<base64-token>"
 * Response: raw secret value (text/plain)
 */
export async function getSecret(config: CyberArkConfig, variableId: string, retries = 1): Promise<string> {
  const token = await authenticate(config);
  const idEncoded = encodeURIComponent(variableId);
  const url = `${config.baseUrl.replace(/\/$/, '')}${apiPrefix(config)}/secrets/${encodeURIComponent(config.account)}/variable/${idEncoded}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Token token="${token}"`,
      },
      signal: controller.signal,
      ...fetchOptions(config),
    });

    // Token expired — clear cache and retry once
    if (res.status === 401 && retries > 0) {
      tokenCache.delete(cacheKey(config));
      return getSecret(config, variableId, retries - 1);
    }

    if (!res.ok) {
      if (res.status === 404) throw new Error(`Secret '${variableId}' not found in Conjur`);
      if (res.status === 403) throw new Error(`Access denied to secret '${variableId}' in Conjur`);
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Conjur getSecret failed: ${res.status} ${err}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Test connectivity to a Conjur instance by performing authentication.
 */
export async function testConnection(config: CyberArkConfig): Promise<{ success: boolean; error?: string }> {
  try {
    await authenticate(config);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function clearTokenCache() {
  tokenCache.clear();
}
