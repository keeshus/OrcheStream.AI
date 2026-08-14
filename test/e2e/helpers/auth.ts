import { readFileSync } from 'fs';
import { resolve } from 'path';
// Must match the playwright config's storageState default (relative to the
// repo root) so locally the setup spec writes exactly the file the
// authenticated project and getAdminAuthFile() read. The parallel script
// overrides PLAYWRIGHT_AUTH_FILE with per-stack files.
const AUTH_FILE = process.env.PLAYWRIGHT_AUTH_FILE
  ? resolve(process.cwd(), process.env.PLAYWRIGHT_AUTH_FILE)
  : resolve(process.cwd(), 'e2e/.auth/user.json');

/**
 * Path to the saved admin auth state (the user registered by the setup spec).
 * Use with `request.newContext({ storageState: getAdminAuthFile() })` whenever
 * a test needs admin privileges AFTER logging in as a non-admin user — the
 * shared `request` fixture picks up the last login's cookies, so admin-only
 * calls (e.g. DELETE /api/users/:id) would silently 403.
 */
export function getAdminAuthFile(): string {
  return AUTH_FILE;
}

/**
 * Read the auth token cookie from the saved storage state.
 * This avoids needing page.context which may not work in all environments.
 */
export function getAuthCookie(): string | null {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
    const token = data.cookies?.find((c: any) => c.name === 'token');
    return token ? `${token.name}=${token.value}` : null;
  } catch {
    return null;
  }
}
