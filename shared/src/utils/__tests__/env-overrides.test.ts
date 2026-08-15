import { describe, it, expect } from 'vitest';
import { parseEnvOverrides } from '../env-overrides.js';

describe('parseEnvOverrides', () => {
  it('accepts undefined/null as empty overrides', () => {
    expect(parseEnvOverrides(undefined)).toEqual({ ok: true, value: {} });
    expect(parseEnvOverrides(null)).toEqual({ ok: true, value: {} });
  });

  it('accepts plaintext string values', () => {
    const result = parseEnvOverrides({ API_KEY: 'sk-123' });
    expect(result).toEqual({ ok: true, value: { API_KEY: 'sk-123' } });
  });

  it('accepts core_secret and cyberark references', () => {
    const result = parseEnvOverrides({
      DB_PASS: { type: 'core_secret', value: 'db-pass' },
      VAULT_TOKEN: { type: 'cyberark', value: 'prod/token' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.DB_PASS).toEqual({ type: 'core_secret', value: 'db-pass' });
      expect(result.value.VAULT_TOKEN).toEqual({ type: 'cyberark', value: 'prod/token' });
    }
  });

  it('rejects non-object values', () => {
    expect(parseEnvOverrides('nope').ok).toBe(false);
    expect(parseEnvOverrides(42).ok).toBe(false);
    expect(parseEnvOverrides([1, 2]).ok).toBe(false);
  });

  it('rejects arrays and invalid types as values', () => {
    expect(parseEnvOverrides({ A: [1, 2] }).ok).toBe(false);
    expect(parseEnvOverrides({ A: { type: 'bogus', value: 'x' } }).ok).toBe(false);
    expect(parseEnvOverrides({ A: { type: 'core_secret', value: 42 } }).ok).toBe(false);
    expect(parseEnvOverrides({ A: {} }).ok).toBe(false);
    expect(parseEnvOverrides({ A: 7 }).ok).toBe(false);
  });

  it('returns a descriptive error naming the offending variable', () => {
    const result = parseEnvOverrides({ API_KEY: 'ok', BAD: { type: 'nope', value: 'x' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('BAD');
  });
});
