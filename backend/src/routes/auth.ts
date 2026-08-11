import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import * as oidc from 'openid-client';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { users, roles, ssoConfig, groups, groupMembers } from '../db/schema.js';
import { authenticate, JWT_SECRET } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { logger } from '../utils/logger.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// ── Rate limiting on auth endpoints ────────────────────────────────────
// Per-IP (optionally via X-Forwarded-For when TRUST_PROXY=1) so the limit
// cannot be spoofed by default. Login limits are keyed per IP + username.

const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function clientIp(req: Request): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
}

function buildAuthLimiter(opts: { defaultWindowMs: number; defaultMax: number; perUsername: boolean }) {
  const windowMs = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '', 10) || opts.defaultWindowMs;
  const max = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '', 10) || opts.defaultMax;
  // Enforce limits in production; dev/e2e environments keep unlimited so
  // local development and the E2E suite are not blocked.
  if (process.env.NODE_ENV !== 'production') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return rateLimit({
    windowMs,
    max,
    message: { error: 'Too many attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: (req: Request) => {
      const ip = clientIp(req);
      if (opts.perUsername) {
        const username = String((req.body as any)?.email || '').trim().toLowerCase();
        return `${ip}:${username}`;
      }
      return ip;
    },
  });
}

const loginLimiter = buildAuthLimiter({ defaultWindowMs: 15 * 60 * 1000, defaultMax: 10, perUsername: true });
const registerLimiter = buildAuthLimiter({ defaultWindowMs: 60 * 60 * 1000, defaultMax: 5, perUsername: false });
const ssoLimiter = buildAuthLimiter({ defaultWindowMs: 15 * 60 * 1000, defaultMax: 10, perUsername: true });

function tokenCookieOptions(req: Request) {
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

// ── SSO / OIDC Configuration ──────────────────────────────────────────────

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Helper to read SSO config from DB
async function getSSOConfig() {
  const [config] = await db.select().from(ssoConfig).where(eq(ssoConfig.id, 1));
  return config || null;
}

// Determine role from resolved SSO group names
function resolveRoleFromGroups(groupNames: string[], adminMapping: string[], editorMapping: string[]): string {
  if (groupNames.some(g => adminMapping.includes(g))) return 'admin';
  if (groupNames.some(g => editorMapping.includes(g))) return 'editor';
  return 'reader';
}

async function getOidcClient(issuer: string, clientId: string, clientSecret: string) {
  const options: any = {};
  // Allow HTTP for local/e2e — production always uses HTTPS
  if (process.env.NODE_ENV !== 'production') {
    options.execute = [oidc.allowInsecureRequests];
  }
  const oidcConfig = await oidc.discovery(new URL(issuer), clientId, undefined, oidc.ClientSecretBasic(clientSecret), options);
  return oidcConfig;
}

// Decode JWT payload without verification (the id_token is already verified by the callback)
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ── GET /api/auth/config — return available auth methods ──────────────────

router.get('/config', asyncHandler(async (_req, res) => {
  const config = await getSSOConfig();
  const ssoConfigured = !!(config && config.enabled && config.provider && config.client_id && config.client_secret && config.issuer);
  res.json({
    providers: ssoConfigured ? ['local', config!.provider] : ['local'],
    sso: ssoConfigured ? { provider: config!.provider, name: config!.provider === 'keycloak' ? 'Keycloak' : 'SSO' } : null,
  });
}));

// ── GET /api/auth/sso/login — redirect to OIDC provider ───────────────────

router.get('/sso/login', ssoLimiter, asyncHandler(async (_req, res) => {
  const config = await getSSOConfig();
  if (!config || !config.enabled) {
    res.status(400).json({ error: 'SSO not configured' });
    return;
  }
  try {
    const oidcClient = await getOidcClient(config.issuer, config.client_id, config.client_secret);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authUrl = oidc.buildAuthorizationUrl(oidcClient, {
      scope: 'openid email profile groups',
      state,
      nonce,
      redirect_uri: config.redirect_uri,
    });
    const secure = process.env.NODE_ENV === 'production' || _req.secure;
    res.cookie('sso_state', state, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 5 * 60 * 1000 });
    res.cookie('sso_nonce', nonce, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 5 * 60 * 1000 });

    let authUrlStr = String(authUrl);
    // In E2E tests the issuer container hostname is not reachable from the
    // browser — substitute it with localhost so the redirect works.
    if (process.env.NODE_ENV === 'e2e') {
      const issuerHost = new URL(config.issuer).hostname;
      if (issuerHost !== 'localhost') {
        authUrlStr = authUrlStr.replace(issuerHost, 'localhost');
      }
    }
    res.redirect(authUrlStr);
  } catch (err) {
    logger.error({ err }, 'SSO login failed');
    res.status(500).json({ error: 'Failed to initiate SSO login' });
  }
}));

// ── GET /api/auth/sso/callback — handle OIDC provider callback ────────────

router.get('/sso/callback', asyncHandler(async (req, res) => {
  const state = req.cookies?.sso_state;
  const nonce = req.cookies?.sso_nonce;
  if (!state || !nonce) {
    res.redirect(`${FRONTEND_URL}/login?error=missing_sso_state`);
    return;
  }

  try {
    const config = await getSSOConfig();
    if (!config || !config.enabled) {
      res.redirect(`${FRONTEND_URL}/login?error=sso_not_configured`);
      return;
    }

    const oidcClient = await getOidcClient(config.issuer, config.client_id, config.client_secret);
    const currentUrl = new URL(req.originalUrl || req.url, config.redirect_uri);
    const tokenSet = await oidc.authorizationCodeGrant(
      oidcClient, currentUrl,
      { expectedState: state, expectedNonce: nonce } as any,
      { id_token_signed_response_alg: 'RS256' },
    );

    const rawTokenSet = tokenSet as any;
    // id_token may already be decoded claims (object) in v6, or a string JWT
    let claims: Record<string, unknown> = {};
    if (tokenSet.id_token) {
      if (typeof tokenSet.id_token === 'string') {
        claims = decodeJwtPayload(tokenSet.id_token);
      } else {
        claims = tokenSet.id_token;
      }
    }

    // Fetch userinfo to get additional claims (groups) that may not be in the id_token
    let userinfo: Record<string, unknown> = {};
    if (tokenSet.access_token) {
      try {
        userinfo = await oidc.fetchUserInfo(oidcClient, tokenSet.access_token, String(claims.sub || '')) as Record<string, unknown>;
      } catch {}
    }

    // Merge: id_token takes precedence, userinfo fills gaps
    const mergedClaims = { ...userinfo, ...claims };
    const email = String(mergedClaims.email || mergedClaims.preferred_username || '');
    const name = String(mergedClaims.name || mergedClaims.given_name || email.split('@')[0] || 'SSO User');
    const sub = String(mergedClaims.sub || '');

    if (!email && !sub) {
      res.redirect(`${FRONTEND_URL}/login?error=no_user_info`);
      return;
    }

    // Use merged claims for group extraction
    const groupClaimName = config.group_claim || 'groups';
    const ssoGroupNames: string[] = [];
    if (Array.isArray(mergedClaims[groupClaimName])) {
      ssoGroupNames.push(...mergedClaims[groupClaimName].map(String));
    }
    if (groupClaimName !== 'groups' && Array.isArray(mergedClaims.groups)) {
      ssoGroupNames.push(...mergedClaims.groups.map(String));
    }
    if (mergedClaims.realm_access && typeof mergedClaims.realm_access === 'object') {
      const ra = mergedClaims.realm_access as Record<string, unknown>;
      if (Array.isArray(ra.roles)) ssoGroupNames.push(...ra.roles.map(String));
    }

    const uniqueGroupNames = [...new Set(ssoGroupNames.map((g: string) => g.trim()).filter(Boolean))];

    // Find or create user
    let [user] = await db.select().from(users).where(eq(users.provider_id, sub));
    if (!user && email) {
      [user] = await db.select().from(users).where(eq(users.email, email));
    }
    if (!user) {
      const [readerRole] = await db.select().from(roles).where(eq(roles.name, 'reader'));
      [user] = await db.insert(users).values({
        email, name, password_hash: '',
        provider: config.provider, provider_id: sub,
        role_id: readerRole?.id || null,
      }).returning();
    } else if (!user.provider_id) {
      await db.update(users).set({ provider: config.provider, provider_id: sub }).where(eq(users.id, user.id));
    }

    // Upsert groups and add user membership
    for (const groupName of uniqueGroupNames) {
      let [group] = await db.select().from(groups).where(and(eq(groups.name, groupName), eq(groups.provider, config.provider)));
      if (!group) {
        [group] = await db.insert(groups).values({ name: groupName, provider: config.provider }).returning();
      }
      const [existingMember] = await db.select().from(groupMembers)
        .where(and(eq(groupMembers.group_id, group.id), eq(groupMembers.user_id, user.id)));
      if (!existingMember) {
        await db.insert(groupMembers).values({ group_id: group.id, user_id: user.id });
      }
    }

    // Remove user from SSO-provisioned groups not in current claims
    const allUserSsoMemberships = await db.select({
      groupId: groupMembers.group_id,
      groupName: groups.name,
    }).from(groupMembers)
      .leftJoin(groups, eq(groupMembers.group_id, groups.id))
      .where(and(eq(groupMembers.user_id, user.id), eq(groups.provider, config.provider)));

    for (const membership of allUserSsoMemberships) {
      if (membership.groupName && !uniqueGroupNames.includes(membership.groupName)) {
        await db.delete(groupMembers)
          .where(and(eq(groupMembers.group_id, membership.groupId!), eq(groupMembers.user_id, user.id)));
      }
    }

    // Map groups to role using configured mappings
    const ssoRoleName = resolveRoleFromGroups(uniqueGroupNames, config.admin_group_mapping || [], config.editor_group_mapping || []);
    const [mappedRole] = await db.select().from(roles).where(eq(roles.name, ssoRoleName));
    if (mappedRole && user.role_id !== mappedRole.id) {
      await db.update(users).set({ role_id: mappedRole.id }).where(eq(users.id, user.id));
      user.role_id = mappedRole.id;
    }

    // Issue JWT
    let roleName = 'reader';
    let permissions: string[] = [];
    if (user.role_id) {
      const [role] = await db.select().from(roles).where(eq(roles.id, user.role_id));
      if (role) { roleName = role.name; permissions = role.permissions || []; }
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: roleName, permissions },
      JWT_SECRET, { expiresIn: '7d' },
    );

    // Store refresh token for short-lived token refresh (OIDC group change detection)
    const tokenSetAny = tokenSet as any;
    if (tokenSetAny.refresh_token) {
      const expiresIn = (tokenSetAny.expires_in as number) || 3600;
      await db.update(users).set({
        oidc_refresh_token: tokenSetAny.refresh_token,
        oidc_token_expires_at: new Date(Date.now() + expiresIn * 1000),
      }).where(eq(users.id, user.id));
    }

    res.cookie('token', token, tokenCookieOptions(req));
    await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));
    res.clearCookie('sso_state');
    res.clearCookie('sso_nonce');
    res.redirect(`${FRONTEND_URL}/`);
  } catch (err) {
    logger.error({ err }, 'SSO callback failed');
    res.redirect(`${FRONTEND_URL}/login?error=sso_failed`);
  }
}));

// ── GET /api/auth/setup-status — check if first-time setup is needed ──────

router.get('/setup-status', asyncHandler(async (_req, res) => {
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
  res.json({ required: Number(count) === 0 });
}));

// ── Local auth (register / login / me / logout) ───────────────────────────

// POST /api/auth/register
router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    res.status(400).json({ error: 'Email, password, and name are required' });
    return;
  }

  // Check if user exists
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  // Hash password
  const password_hash = await bcrypt.hash(password, 10);

  // First user is always admin
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
  const isFirstUser = Number(count) === 0;

  // Seed default roles if table is empty (fresh DB from drizzle-kit push)
  const [{ roleCount }] = await db.select({ roleCount: sql<number>`COUNT(*)` }).from(roles);
  if (Number(roleCount) === 0) {
    const defaultRoles = [
      {
        name: 'admin', description: 'Full system access', is_system: true,
        permissions: [
          'admin', 'flow:create', 'flow:edit', 'flow:delete', 'flow:read',
          'endpoint:read', 'endpoint:write',
          'mcp:read', 'mcp:write',
          'embedding:read', 'embedding:write',
          'store:read', 'store:write',
          'document:write', 'knowledge:write',
          'chat:create', 'execution:approve',
          'group:read', 'group:write',
          'secrets:read', 'secrets:write', 'secrets:read_app', 'secrets:write_app',
          'secrets:read_group', 'secrets:write_group', 'secrets:audit', 'secrets:rotate',
          'vaults:read', 'vaults:write',
        ],
      },
      {
        name: 'editor', description: 'Can create and edit flows', is_system: true,
        permissions: [
          'flow:create', 'flow:edit', 'flow:read',
          'execution:approve',
          'endpoint:read', 'mcp:read', 'embedding:read', 'store:read',
          'document:write', 'knowledge:write', 'chat:create',
          'group:read',
        ],
      },
    {
      name: 'reader', description: 'Read-only access for regular users', is_system: true,
      permissions: [],
    },
    ];
    await db.insert(roles).values(defaultRoles);
  }

  // Get role: admin for first user, reader otherwise
  const [role] = await db.select().from(roles).where(eq(roles.name, isFirstUser ? 'admin' : 'reader'));

  // Create user
  const [user] = await db.insert(users).values({
    email,
    password_hash,
    name,
    role_id: role?.id || null,
  }).returning();

  // Generate JWT
  const rolePermissions = role?.permissions || [];
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: role?.name || 'reader', permissions: rolePermissions },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

  // Set httpOnly cookie
  res.cookie('token', token, tokenCookieOptions(req));

  await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));

  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name, role: role?.name || 'reader', permissions: rolePermissions, groups: [] },
  });
}));

// POST /api/auth/login
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Get role
  let roleName = 'reader';
  let permissions: string[] = [];
  if (user.role_id) {
    const [role] = await db.select().from(roles).where(eq(roles.id, user.role_id));
    if (role) {
      roleName = role.name;
      permissions = role.permissions || [];
    }
  }

  // Generate JWT
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: roleName, permissions },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

  // Set httpOnly cookie
  res.cookie('token', token, tokenCookieOptions(req));

  // Update last_login
  await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));

  // The JWT is delivered exclusively via the httpOnly cookie; it is not
  // echoed in the response body.
  const loginGroups = await db.select({ id: groups.id, name: groups.name, role: groupMembers.role })
    .from(groupMembers)
    .leftJoin(groups, eq(groupMembers.group_id, groups.id))
    .where(eq(groupMembers.user_id, user.id));
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: roleName, permissions, groups: loginGroups },
  });
}));

// GET /api/auth/me — also refreshes OIDC token and syncs groups
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user!.userId;

  // ── OIDC token refresh with group sync ─────────────────────────
  const [currentUser] = await db.select().from(users).where(eq(users.id, userId));
  const refreshToken = currentUser?.oidc_refresh_token;
  const tokenExpiresAt = currentUser?.oidc_token_expires_at ? new Date(currentUser.oidc_token_expires_at).getTime() : 0;
  const needsRefresh = refreshToken && tokenExpiresAt < Date.now() - 60000;

  if (needsRefresh) {
    try {
      const ssoCfg = await getSSOConfig();
      if (ssoCfg && ssoCfg.enabled) {
        const oidcClient = await getOidcClient(ssoCfg.issuer, ssoCfg.client_id, ssoCfg.client_secret);
        const refreshed = await oidc.refreshTokenGrant(
          oidcClient, refreshToken,
        ) as any;

        // Decode updated id_token for group claims
        const newClaims: Record<string, unknown> = {};
        if (refreshed.id_token) {
          if (typeof refreshed.id_token === 'string') {
            const parts = refreshed.id_token.split('.');
            if (parts.length === 3) {
              Object.assign(newClaims, JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
            }
          } else {
            Object.assign(newClaims, refreshed.id_token);
          }
        }

        // Extract groups from refreshed token
        const groupClaim = ssoCfg.group_claim || 'groups';
        const newGroupNames: string[] = [];
        if (Array.isArray(newClaims[groupClaim])) {
          newGroupNames.push(...(newClaims[groupClaim] as string[]));
        }

        // Persist updated tokens to DB (cluster-safe)
        const newExpiresIn = (refreshed.expires_in as number) || 3600;
        const dbUpdates: Record<string, unknown> = {
          oidc_token_expires_at: new Date(Date.now() + newExpiresIn * 1000),
        };
        if (refreshed.refresh_token) {
          dbUpdates.oidc_refresh_token = refreshed.refresh_token;
        }
        await db.update(users).set(dbUpdates).where(eq(users.id, userId));

        // Get current groups for this user
        const currentMemberships = await db.select({
          groupId: groupMembers.group_id,
          groupName: groups.name,
        }).from(groupMembers)
          .leftJoin(groups, eq(groupMembers.group_id, groups.id))
          .where(eq(groupMembers.user_id, userId));

        const currentGroupNames = currentMemberships.map(m => m.groupName).filter(Boolean) as string[];

        // Only update if groups changed
        const changed = currentGroupNames.length !== newGroupNames.length ||
          !currentGroupNames.every(g => newGroupNames.includes(g));

        if (changed) {
          // Remove old SSO-provisioned group memberships
          const allSsoGroups = await db.select({ id: groups.id }).from(groups)
            .where(eq(groups.provider, ssoCfg.provider));
          const ssoGroupIds = allSsoGroups.map(g => g.id);
          if (ssoGroupIds.length > 0) {
            await db.delete(groupMembers)
              .where(and(eq(groupMembers.user_id, userId), inArray(groupMembers.group_id, ssoGroupIds)));
          }

          // Add new group memberships
          for (const gName of newGroupNames) {
            let [group] = await db.select().from(groups)
              .where(and(eq(groups.name, gName), eq(groups.provider, ssoCfg.provider)));
            if (!group) {
              [group] = await db.insert(groups).values({ name: gName, provider: ssoCfg.provider }).returning();
            }
            await db.insert(groupMembers).values({ group_id: group.id, user_id: userId }).onConflictDoNothing();
          }

          // Update role based on new groups
          const newRoleName = resolveRoleFromGroups(newGroupNames, ssoCfg.admin_group_mapping || [], ssoCfg.editor_group_mapping || []);
          const [newRole] = await db.select().from(roles).where(eq(roles.name, newRoleName));
          if (newRole) {
            await db.update(users).set({ role_id: newRole.id }).where(eq(users.id, userId));
          }
        }
      }
    } catch (e) {
      // Refresh failed — continue with existing session
      logger.error({ error: String(e) }, 'OIDC token refresh failed');
    }
  }

  const userGroups = await db.select({ id: groups.id, name: groups.name, role: groupMembers.role })
    .from(groupMembers)
    .leftJoin(groups, eq(groupMembers.group_id, groups.id))
    .where(eq(groupMembers.user_id, userId));

  // Re-read user's current role/permissions (may have changed via refresh)
  const [updatedUser] = await db.select().from(users).where(eq(users.id, userId));
  let roleName = req.user?.role || 'reader';
  let permissions: string[] = req.user?.permissions || [];
  if (updatedUser?.role_id) {
    const [role] = await db.select().from(roles).where(eq(roles.id, updatedUser.role_id));
    if (role) {
      roleName = role.name;
      permissions = role.permissions || [];
    }
  }

  res.json({
    user: {
      userId,
      email: req.user?.email,
      name: updatedUser?.name ?? req.user?.email ?? '',
      role: roleName,
      permissions,
      groups: userGroups,
    },
  });
}));

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ status: 'logged_out' });
});

// ── GET /api/auth/profile — full user profile with role ────────────────────

router.get('/profile', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user!.userId;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  let roleInfo = null;
  if (user.role_id) {
    const [role] = await db.select().from(roles).where(eq(roles.id, user.role_id));
    if (role) roleInfo = { id: role.id, name: role.name, permissions: role.permissions };
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    role: roleInfo,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });
}));

// ── PUT /api/auth/profile — update profile fields ─────────────────────────

router.put('/profile', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user!.userId;
  const { name, email } = req.body || {};

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  // If changing email, check it's not taken
  if (updates.email) {
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }
  }

  await db.update(users).set(updates).where(eq(users.id, userId));

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  let roleInfo = null;
  if (user.role_id) {
    const [role] = await db.select().from(roles).where(eq(roles.id, user.role_id));
    if (role) roleInfo = { id: role.id, name: role.name, permissions: role.permissions };
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    role: roleInfo,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });
}));

// ── PUT /api/auth/password — change password (local accounts only) ─────────

router.put('/password', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user!.userId;
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'Current password and new password are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  if (user.provider !== 'local') {
    res.status(403).json({ error: 'Password change is only available for local accounts' });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.password_hash || '');
  if (!valid) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  await db.update(users).set({ password_hash }).where(eq(users.id, userId));

  res.json({ status: 'ok' });
}));

export default router;
