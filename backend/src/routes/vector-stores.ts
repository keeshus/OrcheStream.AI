import { Router } from 'express';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { vectorStores, groupMembers } from '../db/schema.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import neo4j from 'neo4j-driver';
// Initialize pgvector fallback + load persisted stores (also done in the worker
// so retriever nodes work in worker-executed runs).
import { registerStore, unregisterStore, createQdrantStore, createNeo4jStore, initVectorStores } from 'orchestream-ai-shared';
initVectorStores(db).catch(() => {});

const router = Router();

async function checkGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const [member] = await db.select()
    .from(groupMembers)
    .where(and(
      eq(groupMembers.user_id, userId),
      eq(groupMembers.group_id, groupId),
      eq(groupMembers.role, 'admin'),
    ))
    .limit(1);
  return !!member;
}

// Initialize pgvector fallback: searches the Postgres embeddings table that
// document uploads write to (previously misregistered as a Qdrant client).
initVectorStores(db).catch(() => {});

// GET /api/vector-stores/:id/collections — list collections
import { QdrantClient } from '@qdrant/js-client-rest';
router.get('/vector-stores/:id/collections', asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const [rs] = await db.select().from(vectorStores).where(eq(vectorStores.id, id));
  if (!rs) { res.status(404).json({ error: 'Not found' }); return; }

  const isAdmin = req.user?.permissions?.includes('admin');
  if (!isAdmin && rs.group_id) {
    const userGroups = await db.select({ groupId: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, req.user!.userId));
    const groupIds = userGroups.map(g => g.groupId);
    if (!groupIds.includes(rs.group_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  try {
    if (rs.store_type === 'neo4j') {
      const driver = neo4j.driver(rs.url, neo4j.auth.basic('', rs.api_key || ''));
      const session = driver.session();
      try {
        const result = await session.run('MATCH (d:Document) RETURN DISTINCT d.collectionName AS name');
        res.json(result.records.map(r => r.get('name')));
      } finally { await session.close(); await driver.close(); }
    } else {
      const client = new QdrantClient({ url: rs.url, apiKey: rs.api_key || undefined });
      const result = await client.getCollections();
      res.json(result.collections.map((c: any) => c.name));
    }
  } catch { res.json([]); }
}));

// POST /api/vector-stores/:id/refresh — refresh and persist collections
router.post('/vector-stores/:id/refresh', requirePermission('store:write', 'store:write_group'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const [rs] = await db.select().from(vectorStores).where(eq(vectorStores.id, id));
  if (!rs) { res.status(404).json({ error: 'Not found' }); return; }

  const isAdmin = req.user!.permissions?.includes('admin');
  if (rs.group_id) {
    if (!isAdmin) {
      const isGroupAdmin = await checkGroupAdmin(req.user!.userId, rs.group_id);
      if (!isGroupAdmin) {
        res.status(403).json({ error: 'Only group admins can refresh group-scoped vector stores' });
        return;
      }
    }
  } else {
    if (!isAdmin && !req.user!.permissions.includes('store:write')) {
      res.status(403).json({ error: 'Insufficient permissions to refresh app-wide vector stores' });
      return;
    }
  }

  let collections: string[] = [];
  try {
    if (rs.store_type === 'neo4j') {
      const driver = neo4j.driver(rs.url, neo4j.auth.basic('', rs.api_key || ''));
      const session = driver.session();
      try {
        const result = await session.run('MATCH (d:Document) RETURN DISTINCT d.collectionName AS name');
        collections = result.records.map(r => r.get('name'));
      } finally { await session.close(); await driver.close(); }
    } else {
      const client = new QdrantClient({ url: rs.url, apiKey: rs.api_key || undefined });
      const result = await client.getCollections();
      collections = result.collections.map((c: any) => c.name);
    }
  } catch { collections = []; }
  const [updated] = await db.update(vectorStores).set({ collections: collections as any, updated_at: new Date() }).where(eq(vectorStores.id, id)).returning();
  res.json(updated);
}));

router.get('/vector-stores', asyncHandler(async (req, res) => {
  const isAdmin = req.user?.permissions?.includes('admin');
  const conditions: any[] = [];

  if (!isAdmin) {
    const userGroups = await db.select({ groupId: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, req.user!.userId));
    const groupIds = userGroups.map(g => g.groupId);

    if (groupIds.length > 0) {
      conditions.push(
        or(
          isNull(vectorStores.group_id),
          inArray(vectorStores.group_id, groupIds),
        ),
      );
    } else {
      conditions.push(isNull(vectorStores.group_id));
    }
  }

  if (req.query.group_id) {
    conditions.push(eq(vectorStores.group_id, req.query.group_id as string));
  }

  const result = conditions.length > 0
    ? await db.select().from(vectorStores).where(and(...conditions))
    : await db.select().from(vectorStores);

  res.json(result);
}));

router.get('/vector-stores/:id', asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const [row] = await db.select().from(vectorStores).where(eq(vectorStores.id, id));
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const isAdmin = req.user?.permissions?.includes('admin');
  if (!isAdmin && row.group_id) {
    const userGroups = await db.select({ groupId: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, req.user!.userId));
    const groupIds = userGroups.map(g => g.groupId);
    if (!groupIds.includes(row.group_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  res.json(row);
}));

router.post('/vector-stores', requirePermission('store:write', 'store:write_group'), asyncHandler(async (req, res) => {
  const { name, storeType = 'qdrant', url, apiKey, groupId } = req.body;
  if (!name || !url) { res.status(400).json({ error: 'name and url required' }); return; }

  if (groupId) {
    const isAdmin = req.user!.permissions?.includes('admin');
    const isGroupAdmin = await checkGroupAdmin(req.user!.userId, groupId);
    if (!isAdmin && !isGroupAdmin) {
      res.status(403).json({ error: 'Only group admins can create group-scoped vector stores' });
      return;
    }
  }

  try {
    const factory = storeType === 'neo4j' ? createNeo4jStore : createQdrantStore;
    const store = factory(url, apiKey || undefined);
    registerStore(name, store);
  } catch (err: any) {
    res.status(400).json({ error: `Connection failed: ${err.message}` }); return;
  }

  const [row] = await db.insert(vectorStores).values({
    name, store_type: storeType, url, api_key: apiKey || null,
    group_id: groupId || null,
  }).returning();
  res.status(201).json(row);
}));

router.put('/vector-stores/:id', requirePermission('store:write', 'store:write_group'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;

  const [existing] = await db.select().from(vectorStores).where(eq(vectorStores.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const isAdmin = req.user!.permissions?.includes('admin');
  if (existing.group_id) {
    if (!isAdmin) {
      const isGroupAdmin = await checkGroupAdmin(req.user!.userId, existing.group_id);
      if (!isGroupAdmin) {
        res.status(403).json({ error: 'Only group admins can modify group-scoped vector stores' });
        return;
      }
    }
  } else {
    if (!isAdmin && !req.user!.permissions.includes('store:write')) {
      res.status(403).json({ error: 'Insufficient permissions to modify app-wide vector stores' });
      return;
    }
  }

  const data: Record<string, unknown> = { updated_at: new Date() };
  const { name, url, apiKey, groupId } = req.body;
  if (name !== undefined) data.name = name;
  if (url !== undefined) data.url = url;
  if (apiKey !== undefined) data.api_key = apiKey;
  if (groupId !== undefined) data.group_id = groupId || null;

  if (url) {
    try {
      const factory = existing.store_type === 'neo4j' ? createNeo4jStore : createQdrantStore;
      registerStore(existing.name, factory(url, apiKey || undefined));
    } catch {}
  }

  const [row] = await db.update(vectorStores).set(data).where(eq(vectorStores.id, id)).returning();
  res.json(row);
}));

router.delete('/vector-stores/:id', requirePermission('store:write', 'store:write_group'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;

  const [existing] = await db.select().from(vectorStores).where(eq(vectorStores.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const isAdmin = req.user!.permissions?.includes('admin');
  if (existing.group_id) {
    if (!isAdmin) {
      const isGroupAdmin = await checkGroupAdmin(req.user!.userId, existing.group_id);
      if (!isGroupAdmin) {
        res.status(403).json({ error: 'Only group admins can delete group-scoped vector stores' });
        return;
      }
    }
  } else {
    if (!isAdmin && !req.user!.permissions.includes('store:write')) {
      res.status(403).json({ error: 'Insufficient permissions to delete app-wide vector stores' });
      return;
    }
  }

  await db.delete(vectorStores).where(eq(vectorStores.id, id));
  // Drop the in-memory registration so uploads no longer mirror into a
  // store that was just deleted from the database.
  unregisterStore(existing.name);
  res.status(204).send();
}));

export default router;
