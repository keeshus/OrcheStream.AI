import { Router } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { secrets, secretAccessLog, groupMembers, flows } from '../db/schema.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { encrypt, decrypt, ensureInitialKeyVersion, reEncryptAllSecrets, rotateEncryptionKey } from 'orchestream-ai-shared';
import rateLimit from 'express-rate-limit';

const router = Router();
router.use(authenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

const revealLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reveal requests. Try again in 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function logAccess(action: string, secretId: string | undefined, userId: string | undefined, ip: string | undefined, metadata?: Record<string, unknown>) {
  await db.insert(secretAccessLog).values({
    secret_id: secretId,
    action,
    user_id: userId,
    ip_address: ip,
    metadata: metadata ?? {},
  });
}

async function checkScopeAccess(scope: string, scopeId: string | undefined, user: { userId: string; permissions: string[] }): Promise<boolean> {
  if (user.permissions.includes('admin')) return true;
  if (scope === 'app') return user.permissions.includes('secrets:read_app') || user.permissions.includes('secrets:write_app');
  if (scope === 'group') {
    if (!scopeId || !isValidUUID(scopeId)) return false;
    const [membership] = await db.select().from(groupMembers).where(
      and(eq(groupMembers.group_id, scopeId), eq(groupMembers.user_id, user.userId))
    );
    if (!membership) return false;
    // Group admins can read their group's secrets; other members need group
    // secret read permissions.
    if (membership.role === 'admin') return true;
    return user.permissions.includes('secrets:read_group') || user.permissions.includes('secrets:write_group');
  }
  if (scope === 'flow') {
    if (!scopeId || !isValidUUID(scopeId)) return false;
    const [flow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id }).from(flows).where(eq(flows.id, scopeId));
    if (!flow) return false;
    if (flow.created_by === user.userId) return true;
    if (flow.group_id) {
      const [membership] = await db.select().from(groupMembers).where(
        and(eq(groupMembers.group_id, flow.group_id), eq(groupMembers.user_id, user.userId))
      );
      if (membership) return user.permissions.includes('secrets:read') || user.permissions.includes('secrets:write');
    }
    return false;
  }
  return false;
}

async function checkWriteScope(scope: string, scopeId: string | undefined, user: { userId: string; permissions: string[] }): Promise<boolean> {
  if (user.permissions.includes('admin')) return true;
  if (scope === 'app') return user.permissions.includes('secrets:write_app');
  if (scope === 'group') {
    if (!scopeId || !isValidUUID(scopeId)) return false;
    const [membership] = await db.select().from(groupMembers).where(
      and(eq(groupMembers.group_id, scopeId), eq(groupMembers.user_id, user.userId))
    );
    if (!membership) return false;
    // Group admins can manage their group's secrets.
    if (membership.role === 'admin') return true;
    return user.permissions.includes('secrets:write_group');
  }
  if (scope === 'flow') {
    if (!scopeId || !isValidUUID(scopeId)) return false;
    if (user.permissions.includes('admin')) return true;
    const [flow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id }).from(flows).where(eq(flows.id, scopeId));
    if (!flow) return false;
    if (flow.created_by === user.userId) return true;
    return false;
  }
  return false;
}

// GET /api/secrets — list secrets (metadata only, never values)
router.get('/', asyncHandler(async (req, res) => {
  const { scope, scopeId, search } = req.query as Record<string, string | undefined>;
  const user = req.user!;

  if (scope && !['app', 'group', 'flow'].includes(scope)) {
    res.status(400).json({ error: 'Invalid scope. Must be app, group, or flow.' });
    return;
  }

  const conditions = [];
  if (scope) conditions.push(eq(secrets.scope, scope));
  if (scopeId && isValidUUID(scopeId)) conditions.push(eq(secrets.scope_id, scopeId));

  if (scope && scopeId) {
    const access = await checkScopeAccess(scope, scopeId, user);
    if (!access) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
  } else if (scope === 'app') {
    if (!user.permissions.includes('secrets:read_app') && !user.permissions.includes('admin')) {
      res.status(403).json({ error: 'Insufficient permissions' }); return;
    }
  } else if (scope === 'group') {
    res.status(400).json({ error: 'scopeId is required for group scope' }); return;
  } else if (scope === 'flow') {
    res.status(400).json({ error: 'scopeId is required for flow scope' }); return;
  }

  if (search) {
    conditions.push(sql`${secrets.name} ILIKE ${'%' + search + '%'}`);
  }

  const rows = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      scope: secrets.scope,
      scopeId: secrets.scope_id,
      secretType: secrets.secret_type,
      referencePath: secrets.reference_path,
      keyVersion: secrets.key_version,
      expiresAt: secrets.expires_at,
      createdAt: secrets.created_at,
      updatedAt: secrets.updated_at,
    })
    .from(secrets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(secrets.created_at));

  res.json(rows);
}));

// POST /api/secrets — create a secret
router.post('/', requirePermission('secrets:write'), asyncHandler(async (req, res) => {
  const { name, value, scope = 'app', scopeId, secretType = 'core', referencePath } = req.body || {};

  const isCyberArk = secretType === 'cyberark';
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  if (!isCyberArk && !value) { res.status(400).json({ error: 'name and value are required' }); return; }
  if (isCyberArk && !referencePath) { res.status(400).json({ error: 'referencePath is required for cyberark secrets' }); return; }
  if (!['core', 'cyberark'].includes(secretType)) { res.status(400).json({ error: 'secretType must be "core" or "cyberark"' }); return; }
  if (!['app', 'group', 'flow'].includes(scope)) { res.status(400).json({ error: 'Invalid scope' }); return; }
  if (scope !== 'app' && !scopeId) { res.status(400).json({ error: 'scopeId is required for group/flow scope' }); return; }

  const user = req.user!;
  const canWrite = await checkWriteScope(scope, scopeId, user);
  if (!canWrite) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

  const [existing] = await db.select().from(secrets).where(
    and(eq(secrets.name, name), eq(secrets.scope, scope),
      scopeId ? eq(secrets.scope_id, scopeId) : sql`${secrets.scope_id} IS NULL`)
  );
  if (existing) { res.status(409).json({ error: 'A secret with this name already exists in this scope' }); return; }

  let encryptedValue = null, encryptionIv = null, encryptionTag = null, keyVersion = 0;
  if (!isCyberArk) {
    await ensureInitialKeyVersion();
    const encrypted = await encrypt(value);
    encryptedValue = encrypted.encryptedValue;
    encryptionIv = encrypted.iv;
    encryptionTag = encrypted.tag;
    keyVersion = encrypted.keyVersion;
  }

  const [secret] = await db.insert(secrets).values({
    name,
    scope,
    scope_id: scopeId || null,
    secret_type: secretType,
    reference_path: isCyberArk ? referencePath : null,
    encrypted_value: encryptedValue,
    encryption_iv: encryptionIv,
    encryption_tag: encryptionTag,
    key_version: keyVersion,
    created_by: user.userId,
  }).returning();

  await logAccess('created', secret.id, user.userId, req.ip);

  res.status(201).json({ id: secret.id, name: secret.name, scope: secret.scope, scopeId: secret.scope_id, secretType: secret.secret_type });
}));

// PUT /api/secrets/:id — update secret value (or reference path for cyberark)
router.put('/:id', requirePermission('secrets:write'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  if (!isValidUUID(id)) { res.status(404).json({ error: 'Secret not found' }); return; }
  const { value, referencePath } = req.body || {};

  const [secret] = await db.select().from(secrets).where(eq(secrets.id, id));
  if (!secret) { res.status(404).json({ error: 'Secret not found' }); return; }

  const canWrite = await checkWriteScope(secret.scope, secret.scope_id ?? undefined, req.user!);
  if (!canWrite) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

  if (secret.secret_type === 'cyberark') {
    if (!referencePath) { res.status(400).json({ error: 'referencePath is required' }); return; }
    await db.update(secrets).set({
      reference_path: referencePath,
      updated_at: new Date(),
    }).where(eq(secrets.id, id));
  } else {
    if (!value) { res.status(400).json({ error: 'value is required' }); return; }
    await ensureInitialKeyVersion();
    const encrypted = await encrypt(value);
    await db.update(secrets).set({
      encrypted_value: encrypted.encryptedValue,
      encryption_iv: encrypted.iv,
      encryption_tag: encrypted.tag,
      key_version: encrypted.keyVersion,
      updated_at: new Date(),
    }).where(eq(secrets.id, id));
  }

  await logAccess('updated', id, req.user!.userId, req.ip);

  res.json({ status: 'updated' });
}));

// DELETE /api/secrets/:id
router.delete('/:id', requirePermission('secrets:write'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  if (!isValidUUID(id)) { res.status(404).json({ error: 'Secret not found' }); return; }

  const [secret] = await db.select().from(secrets).where(eq(secrets.id, id));
  if (!secret) { res.status(404).json({ error: 'Secret not found' }); return; }

  const canWrite = await checkWriteScope(secret.scope, secret.scope_id ?? undefined, req.user!);
  if (!canWrite) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

  await db.delete(secrets).where(eq(secrets.id, id));
  await logAccess('deleted', id, req.user!.userId, req.ip);

  res.json({ status: 'deleted' });
}));

// POST /api/secrets/:id/reveal — reveal secret value (audit-logged, rate-limited)
router.post('/:id/reveal', revealLimiter, requirePermission('secrets:read', 'secrets:write'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  if (!isValidUUID(id)) { res.status(404).json({ error: 'Secret not found' }); return; }

  const [secret] = await db.select().from(secrets).where(eq(secrets.id, id));
  if (!secret) { res.status(404).json({ error: 'Secret not found' }); return; }

  const access = await checkScopeAccess(secret.scope, secret.scope_id ?? undefined, req.user!);
  if (!access) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
  if (!secret.encrypted_value || !secret.encryption_iv || !secret.encryption_tag) {
    res.status(400).json({ error: 'Secret has no encrypted value (CyberArk reference only)' }); return;
  }

  const value = await decrypt(secret.encrypted_value, secret.encryption_iv, secret.encryption_tag, secret.key_version);
  await logAccess('revealed', id, req.user!.userId, req.ip);

  res.json({ value });
}));

// GET /api/secrets/audit-log
router.get('/audit-log', requirePermission('secrets:audit'), asyncHandler(async (req, res) => {
  const { limit = '50', offset = '0' } = req.query as Record<string, string>;
  const rows = await db
    .select()
    .from(secretAccessLog)
    .orderBy(desc(secretAccessLog.created_at))
    .limit(parseInt(limit))
    .offset(parseInt(offset));
  res.json(rows);
}));

// POST /api/secrets/rotate-key
router.post('/rotate-key', requirePermission('secrets:rotate'), asyncHandler(async (_req, res) => {
  const result = await rotateEncryptionKey();
  res.json(result);
}));

// POST /api/secrets/re-encrypt
router.post('/re-encrypt', requirePermission('secrets:rotate'), asyncHandler(async (_req, res) => {
  const count = await reEncryptAllSecrets();
  res.json({ reEncryptedCount: count });
}));

export default router;
