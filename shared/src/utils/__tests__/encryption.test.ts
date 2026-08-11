import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

describe('SECRETS_ENCRYPTION_KEY production fail-fast', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalKey = process.env.SECRETS_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.SECRETS_ENCRYPTION_KEY = originalKey;
  });

  it('throws for the known default hex key in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.SECRETS_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const mod = await import('../encryption.js');
    expect(() => mod.getKek()).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('throws when the key is shorter than 64 hex chars', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.SECRETS_ENCRYPTION_KEY = '0123456789abcdef';
    const mod = await import('../encryption.js');
    expect(() => mod.getKek()).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('allows the known default when NODE_ENV is not production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.SECRETS_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const mod = await import('../encryption.js');
    expect(mod.getKek().length).toBe(KEY_LENGTH);
  });
});

describe('encryption core primitives', () => {
  it('encrypts and decrypts with AES-256-GCM correctly', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const plaintext = 'hello-world-12345';

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag().toString('base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    expect(decrypted).toBe(plaintext);
  });

  it('decrypt with tampered ciphertext throws (GCM auth tag catches it)', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = cipher.update('secret-data', 'utf8', 'base64') + cipher.final('base64');
    const tag = cipher.getAuthTag();

    // Corrupt the ciphertext by flipping a bit in the raw bytes
    const raw = Buffer.from(encrypted, 'base64');
    raw[0] = raw[0] ^ 0xFF;
    const tampered = raw.toString('base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    expect(() => {
      let d = decipher.update(tampered, 'base64', 'utf8');
      d += decipher.final('utf8');
    }).toThrow();
  });

  it('decrypt with wrong IV throws', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update('test', 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const wrongIv = crypto.randomBytes(IV_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, wrongIv);
    decipher.setAuthTag(tag);
    expect(() => {
      let d = decipher.update(encrypted, 'base64', 'utf8');
      d += decipher.final('utf8');
    }).toThrow();
  });

  it('key wrapping round-trips correctly', () => {
    const kek = crypto.randomBytes(KEY_LENGTH);
    const dataKey = crypto.randomBytes(KEY_LENGTH);
    const wrapIv = crypto.randomBytes(IV_LENGTH);

    // Wrap the data key with the KEK
    const cipher = crypto.createCipheriv(ALGORITHM, kek, wrapIv);
    let wrapped = cipher.update(dataKey.toString('base64'), 'utf8', 'base64');
    wrapped += cipher.final('base64');
    const wrapTag = cipher.getAuthTag();

    // Unwrap with the KEK
    const decipher = crypto.createDecipheriv(ALGORITHM, kek, wrapIv);
    decipher.setAuthTag(wrapTag);
    let unwrapped = decipher.update(wrapped, 'base64', 'utf8');
    unwrapped += decipher.final('utf8');

    expect(Buffer.from(unwrapped, 'base64')).toEqual(dataKey);
  });

  it('per-secret IVs produce different ciphertext for identical plaintext', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const plaintext = 'same-value';

    const iv1 = crypto.randomBytes(IV_LENGTH);
    const c1 = crypto.createCipheriv(ALGORITHM, key, iv1);
    let enc1 = c1.update(plaintext, 'utf8', 'base64');
    enc1 += c1.final('base64');

    const iv2 = crypto.randomBytes(IV_LENGTH);
    const c2 = crypto.createCipheriv(ALGORITHM, key, iv2);
    let enc2 = c2.update(plaintext, 'utf8', 'base64');
    enc2 += c2.final('base64');

    expect(enc1).not.toBe(enc2);
  });

  it('handles empty string', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update('', 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    expect(decrypted).toBe('');
  });

  it('handles unicode characters', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const plaintext = 'héllo wörld 🌍 🔐';

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    expect(decrypted).toBe(plaintext);
  });

  it('handles very long strings', () => {
    const key = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const plaintext = 'x'.repeat(100000);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    expect(decrypted).toBe(plaintext);
    expect(decrypted.length).toBe(100000);
  });

  it('wrapping with wrong KEK fails to unwrap', () => {
    const kek1 = crypto.randomBytes(KEY_LENGTH);
    const kek2 = crypto.randomBytes(KEY_LENGTH);
    const dataKey = crypto.randomBytes(KEY_LENGTH);
    const wrapIv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, kek1, wrapIv);
    let wrapped = cipher.update(dataKey.toString('base64'), 'utf8', 'base64');
    wrapped += cipher.final('base64');
    const wrapTag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv(ALGORITHM, kek2, wrapIv);
    decipher.setAuthTag(wrapTag);
    expect(() => {
      let d = decipher.update(wrapped, 'base64', 'utf8');
      d += decipher.final('utf8');
    }).toThrow();
  });
});
