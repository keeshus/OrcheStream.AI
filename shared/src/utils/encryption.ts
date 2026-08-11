import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

const WEAK_ENCRYPTION_KEYS = [
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
];

export function getKek(): Buffer {
  const hex = process.env.SECRETS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY environment variable is required (64 hex chars = 256-bit AES key)'
    );
  }
  if (process.env.NODE_ENV === 'production' && WEAK_ENCRYPTION_KEYS.includes(hex)) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is a known default value: generate a unique random 64-hex-char key for production'
    );
  }
  return Buffer.from(hex, 'hex');
}

export async function ensureInitialKeyVersion(): Promise<void> {
  const { db } = getDb();
  const { encryptionKeyVersions } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [existing] = await db.select().from(encryptionKeyVersions).where(eq(encryptionKeyVersions.is_current, true));
  if (existing) return;
  const [current] = await db.select().from(encryptionKeyVersions).orderBy(encryptionKeyVersions.version);
  if (current) {
    await db.update(encryptionKeyVersions).set({ is_current: true }).where(eq(encryptionKeyVersions.id, current.id));
    return;
  }
  await rotateEncryptionKey();
}

export async function encrypt(plaintext: string): Promise<{
  encryptedValue: string;
  iv: string;
  tag: string;
  keyVersion: number;
}> {
  const { db } = getDb();
  const { encryptionKeyVersions } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const [currentKey] = await db
    .select()
    .from(encryptionKeyVersions)
    .where(eq(encryptionKeyVersions.is_current, true));
  if (!currentKey) throw new Error('No current encryption key version found');

  const keyMaterial = await unwrapKey(currentKey);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyMaterial, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');

  return {
    encryptedValue: encrypted,
    iv: iv.toString('base64'),
    tag,
    keyVersion: currentKey.version,
  };
}

export async function decrypt(
  encryptedValue: string,
  iv: string,
  tag: string,
  keyVersion: number
): Promise<string> {
  const { db } = getDb();
  const { encryptionKeyVersions } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const [keyRecord] = await db
    .select()
    .from(encryptionKeyVersions)
    .where(eq(encryptionKeyVersions.version, keyVersion));
  if (!keyRecord) throw new Error(`Encryption key version ${keyVersion} not found`);

  const keyMaterial = await unwrapKey(keyRecord);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyMaterial, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let decrypted = decipher.update(encryptedValue, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export async function rotateEncryptionKey(): Promise<{ version: number }> {
  const { db } = getDb();
  const { encryptionKeyVersions } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const [maxVersion] = await db
    .select({ max: (await import('drizzle-orm')).sql<number>`COALESCE(MAX(${encryptionKeyVersions.version}), 0)` })
    .from(encryptionKeyVersions);
  const nextVersion = (maxVersion?.max ?? 0) + 1;

  const newKey = crypto.randomBytes(KEY_LENGTH);
  const kek = getKek();
  const wrapIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, kek, wrapIv);
  let wrapped = cipher.update(newKey.toString('base64'), 'utf8', 'base64');
  wrapped += cipher.final('base64');
  const wrapTag = cipher.getAuthTag().toString('base64');

  await db.update(encryptionKeyVersions)
    .set({ is_current: false, deactivated_at: new Date() })
    .where(eq(encryptionKeyVersions.is_current, true));

  const [record] = await db.insert(encryptionKeyVersions).values({
    version: nextVersion,
    key_material_encrypted: wrapped,
    key_material_iv: wrapIv.toString('base64'),
    key_material_tag: wrapTag,
    is_current: true,
    activated_at: new Date(),
  }).returning();

  return { version: record.version };
}

export async function reEncryptAllSecrets(): Promise<number> {
  const { db } = getDb();
  const { secrets, encryptionKeyVersions } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const [currentKey] = await db
    .select()
    .from(encryptionKeyVersions)
    .where(eq(encryptionKeyVersions.is_current, true));
  if (!currentKey) throw new Error('No current encryption key version');

  const allSecrets = await db.select().from(secrets);
  let count = 0;
  for (const secret of allSecrets) {
    if (secret.key_version === currentKey.version) continue;
    if (!secret.encrypted_value || !secret.encryption_iv || !secret.encryption_tag) continue;
    const plaintext = await decrypt(secret.encrypted_value, secret.encryption_iv, secret.encryption_tag, secret.key_version);
    const { encryptedValue, iv, tag } = await encrypt(plaintext);
    await db.update(secrets)
      .set({ encrypted_value: encryptedValue, encryption_iv: iv, encryption_tag: tag, key_version: currentKey.version })
      .where(eq(secrets.id, secret.id));
    count++;
  }
  return count;
}

async function unwrapKey(keyRecord: { key_material_encrypted: string; key_material_iv: string; key_material_tag: string }): Promise<Buffer> {
  const kek = getKek();
  const decipher = crypto.createDecipheriv(ALGORITHM, kek, Buffer.from(keyRecord.key_material_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(keyRecord.key_material_tag, 'base64'));
  let keyStr = decipher.update(keyRecord.key_material_encrypted, 'base64', 'utf8');
  keyStr += decipher.final('utf8');
  return Buffer.from(keyStr, 'base64');
}
