// ── Per-run env override validation ───────────────────────────────
// Shared by the manual-run endpoint and both webhook handlers so the
// accepted shape is identical everywhere: a flat map of variable names to
// either a plaintext string or a { type: 'core_secret' | 'cyberark', value }
// reference.

import type { EnvOverrides } from '../types/flow.js';

export type ParseEnvOverridesResult =
  | { ok: true; value: EnvOverrides }
  | { ok: false; error: string };

export function parseEnvOverrides(raw: unknown): ParseEnvOverridesResult {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'envOverrides must be a flat object mapping variable names to strings or { type, value } objects',
    };
  }

  const result: EnvOverrides = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'string') {
      result[name] = val;
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const { type, value } = val as { type?: unknown; value?: unknown };
      if ((type === 'core_secret' || type === 'cyberark') && typeof value === 'string') {
        result[name] = { type, value };
        continue;
      }
      return {
        ok: false,
        error: `Invalid envOverride for "${name}": expected { type: 'core_secret' | 'cyberark', value: string }`,
      };
    }
    return {
      ok: false,
      error: `Invalid envOverride for "${name}": expected a string or { type, value } object`,
    };
  }
  return { ok: true, value: result };
}
