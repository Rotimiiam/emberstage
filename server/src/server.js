import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as db from './db.js';
import * as cryptoUtils from './crypto-utils.js';
import { workerManager, createFacebookSnapshot, readFacebookSnapshot } from './worker-manager.js';
import { nangoClient } from './nango-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export const inflightWorkspaceMutations = new Set();

export async function runWithMutationGuard(workspaceId, res, action) {
  if (inflightWorkspaceMutations.has(workspaceId)) {
    return json(res, { error: 'Conflict: A workspace settings mutation is in progress. Please retry shortly.' }, 409);
  }
  inflightWorkspaceMutations.add(workspaceId);
  try {
    return await action();
  } finally {
    inflightWorkspaceMutations.delete(workspaceId);
  }
}

export let googleOidcClient = {
  fetchJwks: async () => {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    return response.json();
  },
  exchangeCode: async (code, verifier) => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID || '',
        client_secret: config.GOOGLE_CLIENT_SECRET || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.GOOGLE_REDIRECT_URI || '',
        code_verifier: verifier
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error_description || 'Google token exchange failed');
    }
    return body;
  }
};

export function getNormalizedAuth0Domain() {
  const domain = config.AUTH0_DOMAIN;
  if (!domain || typeof domain !== 'string') return null;
  const trimmed = domain.trim();
  if (/^(https?:\/\/)/i.test(trimmed) || /\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return null;
  }
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export let auth0OidcClient = {
  fetchJwks: async (domain) => {
    const response = await fetch(`https://${domain}/.well-known/jwks.json`);
    if (!response.ok) {
      throw new Error('Failed to fetch JWKS');
    }
    return response.json();
  },
  exchangeCode: async (domain, code, verifier) => {
    const response = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.AUTH0_CLIENT_ID || '',
        client_secret: config.AUTH0_CLIENT_SECRET || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.AUTH0_REDIRECT_URI || '',
        code_verifier: verifier
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error_description || 'Auth0 token exchange failed');
    }
    return body;
  }
};

export let providerOAuthClient = {
  exchangeCode: async (provider, code, verifier) => {
    if (provider === 'twitch') {
      const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.TWITCH_CLIENT_ID || '',
          client_secret: config.TWITCH_CLIENT_SECRET || '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.TWITCH_REDIRECT_URI || '',
          code_verifier: verifier
        })
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || 'Twitch token exchange failed');
      }
      return body;
    } else if (provider === 'youtube') {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.YOUTUBE_CLIENT_ID || '',
          client_secret: config.YOUTUBE_CLIENT_SECRET || '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.YOUTUBE_REDIRECT_URI || '',
          code_verifier: verifier
        })
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || 'YouTube token exchange failed');
      }
      return body;
    } else if (provider === 'facebook') {
      const response = await fetch(`https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.FACEBOOK_CLIENT_ID || '',
          client_secret: config.FACEBOOK_CLIENT_SECRET || '',
          code,
          redirect_uri: config.FACEBOOK_REDIRECT_URI || '',
          code_verifier: verifier
        })
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || 'Facebook token exchange failed');
      }
      return body;
    }
    throw new Error('Unsupported exchange provider');
  },
  
  fetchTargets: async (provider, accessToken) => {
    if (provider === 'twitch') {
      const response = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Client-Id': config.TWITCH_CLIENT_ID || ''
        }
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || 'Failed to fetch Twitch user');
      }
      return (body.data || []).map(u => ({ id: u.id, name: u.display_name }));
    } else if (provider === 'youtube') {
      const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || 'Failed to fetch YouTube channels');
      }
      return (body.items || []).map(item => ({ id: item.id, name: item.snippet.title }));
    } else if (provider === 'facebook') {
      const response = await fetch(`https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/me/accounts`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || 'Failed to fetch Facebook pages');
      }
      return (body.data || []).map(page => ({ id: page.id, name: page.name }));
    }
    return [];
  }
};

// Parsers & Helpers
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts.shift().trim();
    if (name) {
      list[name] = decodeURIComponent(parts.join('='));
    }
  });
  return list;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('Payload Too Large'));
      } else {
        body += chunk;
      }
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

async function readJson(req, limit = 256 * 1024) {
  const text = await readBody(req, limit);
  return JSON.parse(text || '{}');
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

const rateLimitCache = new Map();
function rateLimit(key, maxHits, windowMs) {
  if (process.env.DATABASE_URL === ':memory:') {
    return true;
  }
  const now = Date.now();
  const state = rateLimitCache.get(key) || { hits: 0, resetTime: now + windowMs };
  if (now > state.resetTime) {
    state.hits = 1;
    state.resetTime = now + windowMs;
  } else {
    state.hits += 1;
  }
  rateLimitCache.set(key, state);
  return state.hits <= maxHits;
}

function setSecurityHeaders(res, extraHeaders = {}) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
}

function json(res, data, statusCode = 200, headers = {}) {
  setSecurityHeaders(res, headers);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(data));
}

function html(res, content, statusCode = 200) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

// Router Setup
const routes = [];

function addRoute(method, pathPattern, handler, rolesAllowed = null, authRequired = true, authKind = 'web') {
  const regexPattern = '^' + pathPattern.replace(/:[a-zA-Z0-9_]+/g, '([^/]+)') + '$';
  const paramNames = (pathPattern.match(/:[a-zA-Z0-9_]+/g) || []).map(p => p.slice(1));
  routes.push({
    method,
    regex: new RegExp(regexPattern),
    paramNames,
    handler,
    rolesAllowed,
    authRequired,
    authKind
  });
}

// Unified Authentication + Authorization Middleware-like function
function authAndAuthorize(req, res, route) {
  if (!route.authRequired) {
    return { authenticated: true };
  }

  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers['authorization'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (route.authKind !== 'device' && route.authKind !== 'both') {
      json(res, { error: 'Forbidden: Device bearer tokens are not allowed on this endpoint' }, 403);
      return null;
    }
    // Device Token Auth (Authorization: Bearer <accessToken>)
    const token = authHeader.substring(7).trim();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ds = db.queryOne('SELECT * FROM device_sessions WHERE id = ?', [tokenHash]);
    if (!ds || new Date(ds.expires_at) < new Date()) {
      json(res, { error: 'Unauthorized: Invalid or expired device token' }, 401);
      return null;
    }

    const device = db.queryOne('SELECT * FROM devices WHERE id = ?', [ds.device_id]);
    if (!device || device.status === 'revoked') {
      json(res, { error: 'Unauthorized: Device is revoked or not found' }, 401);
      return null;
    }

    // Tenant check: if route has workspaceId, device must match it
    if (req.workspaceId && device.workspace_id !== req.workspaceId) {
      json(res, { error: 'Forbidden: Device does not belong to this workspace' }, 403);
      return null;
    }

    // Devices are treated as 'operator' role equivalent for streaming tasks
    if (route.rolesAllowed && !route.rolesAllowed.includes('operator')) {
      json(res, { error: 'Forbidden: Device credentials not authorized for this action' }, 403);
      return null;
    }

    req.authContext = { type: 'device', device, workspaceId: device.workspace_id };
    return req.authContext;
  } else {
    // Web Session Auth (Session Cookie)
    const sessionId = cookies['session_id'];
    if (!sessionId) {
      json(res, { error: 'Unauthorized: Authentication required' }, 401);
      return null;
    }

    const session = db.queryOne('SELECT * FROM web_sessions WHERE id = ?', [sessionId]);
    if (!session || new Date(session.expires_at) < new Date()) {
      json(res, { error: 'Unauthorized: Session expired or invalid' }, 401);
      return null;
    }

    const user = db.queryOne('SELECT id, email FROM users WHERE id = ?', [session.user_id]);
    if (!user) {
      json(res, { error: 'Unauthorized: User not found' }, 401);
      return null;
    }

    // Check workspace membership if workspaceId is present in route
    let role = null;
    if (req.workspaceId) {
      const membership = db.queryOne(
        'SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?',
        [req.workspaceId, user.id]
      );
      if (!membership) {
        json(res, { error: 'Forbidden: You do not have access to this workspace' }, 403);
        return null;
      }
      role = membership.role;

      // Validate role permissions
      if (route.rolesAllowed && !route.rolesAllowed.includes(role)) {
        json(res, { error: 'Forbidden: Insufficient workspace role' }, 403);
        return null;
      }
    }

    req.authContext = { type: 'web', user, role, workspaceId: req.workspaceId, session };
    return req.authContext;
  }
}

// --- DEFINE ROUTES ---

// 1. Auth: Register
addRoute('POST', '/api/auth/register', async (req, res) => {
  try {
    const bodyText = await readBody(req);
    const { email, password, workspaceName } = JSON.parse(bodyText);

    if (!email || !password || !workspaceName) {
      return json(res, { error: 'Missing required fields: email, password, workspaceName' }, 400);
    }

    const existing = db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return json(res, { error: 'Email already registered' }, 400);
    }

    const userId = 'u_' + cryptoUtils.generateRandomToken(12);
    const workspaceId = 'w_' + cryptoUtils.generateRandomToken(12);
    const passwordHash = cryptoUtils.hashPassword(password);
    const now = new Date().toISOString();

    // Create Web Session
    const sessionId = cryptoUtils.generateRandomToken(32);
    const csrfSecret = cryptoUtils.generateRandomToken(32);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    db.transaction(() => {
      // Create User, Workspace, Membership inside a simple atomic transaction
      db.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
        userId,
        email,
        passwordHash,
        now
      ]);

      db.run(
        "INSERT INTO workspaces (id, name, stripe_customer_id, stripe_subscription_id, stripe_status, max_devices, max_destinations, created_at) VALUES (?, ?, NULL, NULL, 'none', 1, 1, ?)",
        [workspaceId, workspaceName, now]
      );

      db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')", [
        workspaceId,
        userId
      ]);

      db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
        sessionId,
        userId,
        csrfSecret,
        expiresAt
      ]);

      db.logAudit({
        workspaceId,
        userId,
        action: 'auth.register',
        details: { email, workspaceName }
      });
    });

    const secureFlag = config.IS_PROD ? '; Secure' : '';
    const setCookies = [
      `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
      `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
    ];

    res.setHeader('Set-Cookie', setCookies);
    return json(res, {
      success: true,
      user: { id: userId, email },
      workspace: { id: workspaceId, name: workspaceName }
    }, 201);
  } catch (err) {
    return json(res, { error: 'Invalid payload or server error' }, 400);
  }
}, null, false);

// 2. Auth: Login
addRoute('POST', '/api/auth/login', async (req, res) => {
  // Simple rate limit for login
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!rateLimit('login:' + ip, 5, 60000)) { // 5 requests per minute
    return json(res, { error: 'Too many login attempts. Please try again later.' }, 429);
  }

  try {
    const bodyText = await readBody(req);
    const { email, password } = JSON.parse(bodyText);

    if (!email || !password) {
      return json(res, { error: 'Missing email or password' }, 400);
    }

    const user = db.queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !cryptoUtils.verifyPassword(password, user.password_hash)) {
      return json(res, { error: 'Invalid email or password' }, 401);
    }

    // Create Web Session
    const sessionId = cryptoUtils.generateRandomToken(32);
    const csrfSecret = cryptoUtils.generateRandomToken(32);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
      sessionId,
      user.id,
      csrfSecret,
      expiresAt
    ]);

    // Find user's primary workspace for audit logging
    const membership = db.queryOne('SELECT workspace_id FROM memberships WHERE user_id = ? LIMIT 1', [user.id]);
    if (membership) {
      db.logAudit({
        workspaceId: membership.workspace_id,
        userId: user.id,
        action: 'auth.login',
        details: { email }
      });
    }

    const secureFlag = config.IS_PROD ? '; Secure' : '';
    const setCookies = [
      `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
      `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
    ];

    res.setHeader('Set-Cookie', setCookies);
    return json(res, { success: true, user: { id: user.id, email } });
  } catch (err) {
    return json(res, { error: 'Invalid payload or server error' }, 400);
  }
}, null, false);

// 3. Auth: Logout
addRoute('POST', '/api/auth/logout', async (req, res) => {
  const ctx = req.authContext;
  if (ctx && ctx.session) {
    db.run('DELETE FROM web_sessions WHERE id = ?', [ctx.session.id]);
    if (ctx.workspaceId) {
      db.logAudit({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        action: 'auth.logout',
        details: {}
      });
    }
  }
  const secureFlag = config.IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
    `_csrf=; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`
  ]);
  return json(res, { success: true });
}, null, true);

// 4. Auth: Me
addRoute('GET', '/api/auth/me', (req, res) => {
  const ctx = req.authContext;
  if (ctx.type !== 'web') {
    return json(res, { error: 'Web session required' }, 401);
  }
  const memberships = db.queryAll('SELECT workspace_id, role FROM memberships WHERE user_id = ?', [ctx.user.id]);
  const linkedGoogle = db.queryOne('SELECT email FROM google_identities WHERE user_id = ?', [ctx.user.id]);
  return json(res, { success: true, user: ctx.user, memberships, linkedGoogleEmail: linkedGoogle ? linkedGoogle.email : null });
}, null, true);

// 4b. Auth: Google OIDC Configurations
addRoute('GET', '/api/auth/config', (req, res) => {
  const normDomain = getNormalizedAuth0Domain();
  return json(res, {
    google: {
      enabled: !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI),
      client_id: config.GOOGLE_CLIENT_ID
    },
    auth0: {
      enabled: !!(normDomain && config.AUTH0_CLIENT_ID && config.AUTH0_CLIENT_SECRET && config.AUTH0_REDIRECT_URI)
    }
  });
}, null, false);

addRoute('GET', '/api/auth/google/start', (req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    return json(res, { error: 'Google sign-in is not configured' }, 503);
  }
  
  const loggedInUserId = null; // GET start is strictly sign-in only (no link)
  
  const state = cryptoUtils.generateRandomToken(32);
  const nonce = cryptoUtils.generateRandomToken(32);
  const pkceVerifier = cryptoUtils.generateRandomToken(32);
  
  // PKCE S256 Challenge
  const hash = crypto.createHash('sha256').update(pkceVerifier).digest();
  const pkceChallenge = hash.toString('base64url');
  
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  
  db.run('INSERT INTO google_auth_states (state, pkce_verifier, nonce, user_id, expires_at) VALUES (?, ?, ?, ?, ?)', [
    state,
    pkceVerifier,
    nonce,
    loggedInUserId,
    expiresAt
  ]);
  
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
    nonce
  }).toString();
  
  res.writeHead(302, { 'Location': googleAuthUrl });
  res.end();
}, null, false);

addRoute('POST', '/api/auth/google/link/start', (req, res) => {
  const ctx = req.authContext;
  if (ctx.type !== 'web') {
    return json(res, { error: 'Web session required' }, 401);
  }
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    return json(res, { error: 'Google sign-in is not configured' }, 503);
  }

  const state = cryptoUtils.generateRandomToken(32);
  const nonce = cryptoUtils.generateRandomToken(32);
  const pkceVerifier = cryptoUtils.generateRandomToken(32);

  // PKCE S256 Challenge
  const hash = crypto.createHash('sha256').update(pkceVerifier).digest();
  const pkceChallenge = hash.toString('base64url');

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  db.run('INSERT INTO google_auth_states (state, pkce_verifier, nonce, user_id, expires_at) VALUES (?, ?, ?, ?, ?)', [
    state,
    pkceVerifier,
    nonce,
    ctx.user.id, // Explicit link state bound securely to current user
    expiresAt
  ]);

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
    nonce
  }).toString();

  return json(res, { url: googleAuthUrl });
}, null, true, 'web');

addRoute('GET', '/api/auth/google/callback', async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');

  if (!code || !state) {
    return html(res, '<h1>Authentication Error</h1><p>Missing code or state parameters</p>', 400);
  }

  const stateRow = db.queryOne('SELECT * FROM google_auth_states WHERE state = ?', [state]);
  if (!stateRow) {
    return html(res, '<h1>Authentication Error</h1><p>Invalid or expired state</p>', 400);
  }

  // Delete state on single-use
  db.run('DELETE FROM google_auth_states WHERE state = ?', [state]);

  if (new Date(stateRow.expires_at) < new Date()) {
    return html(res, '<h1>Authentication Error</h1><p>State has expired</p>', 400);
  }

  try {
    const tokens = await googleOidcClient.exchangeCode(code, stateRow.pkce_verifier);
    const idToken = tokens.id_token;
    if (!idToken) {
      return html(res, '<h1>Authentication Error</h1><p>Failed to retrieve ID Token</p>', 400);
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return html(res, '<h1>Authentication Error</h1><p>Malformed ID Token</p>', 400);
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    if (header.alg !== 'RS256') {
      console.error('OIDC verification failed: unsupported alg', { alg: header.alg });
      return html(res, '<h1>Authentication Error</h1><p>Invalid algorithm used in token signature</p>', 400);
    }

    // Signature verification against JWKS
    const jwks = await googleOidcClient.fetchJwks();
    const jwk = jwks.keys.find(k => k.kid === header.kid);
    if (!jwk) {
      return html(res, '<h1>Authentication Error</h1><p>Public key not found for ID Token</p>', 400);
    }

    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e
      },
      format: 'jwk'
    });

    const verifierObj = crypto.createVerify('RSA-SHA256');
    verifierObj.update(`${headerB64}.${payloadB64}`);
    const isValid = verifierObj.verify(publicKey, Buffer.from(signatureB64, 'base64url'));
    if (!isValid) {
      return html(res, '<h1>Authentication Error</h1><p>ID Token signature verification failed</p>', 400);
    }

    // Assert OIDC claims
    const nowSecs = Math.floor(Date.now() / 1000);
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      return html(res, '<h1>Authentication Error</h1><p>Invalid ID Token issuer</p>', 400);
    }
    if (payload.aud !== config.GOOGLE_CLIENT_ID) {
      return html(res, '<h1>Authentication Error</h1><p>Invalid ID Token audience</p>', 400);
    }
    if (payload.exp < nowSecs) {
      return html(res, '<h1>Authentication Error</h1><p>ID Token has expired</p>', 400);
    }
    if (payload.nonce !== stateRow.nonce) {
      return html(res, '<h1>Authentication Error</h1><p>ID Token nonce mismatch</p>', 400);
    }
    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      return html(res, '<h1>Authentication Error</h1><p>Email is not verified by Google</p>', 400);
    }

    const googleSub = payload.sub;
    const googleEmail = payload.email;

    if (typeof googleSub !== 'string' || !googleSub.trim()) {
      console.error('OIDC verification failed: sub is not a nonempty string');
      return html(res, '<h1>Authentication Error</h1><p>Invalid sub claim in ID Token</p>', 400);
    }
    if (typeof googleEmail !== 'string' || !googleEmail.trim()) {
      console.error('OIDC verification failed: email is not a nonempty string');
      return html(res, '<h1>Authentication Error</h1><p>Invalid email claim in ID Token</p>', 400);
    }

    // Check link vs sign-in
    if (stateRow.user_id) {
      // LINK OPERATION
      const linkedToAnother = db.queryOne('SELECT * FROM google_identities WHERE google_sub = ?', [googleSub]);
      if (linkedToAnother) {
        if (linkedToAnother.user_id === stateRow.user_id) {
          res.writeHead(302, { 'Location': '/app?success=Google account is already linked.' });
          return res.end();
        }
        res.writeHead(302, { 'Location': '/app?error=Google account is already linked to another user.' });
        return res.end();
      }

      const alreadyLinked = db.queryOne('SELECT * FROM google_identities WHERE user_id = ?', [stateRow.user_id]);
      if (alreadyLinked) {
        res.writeHead(302, { 'Location': '/app?error=This account is already linked to a different Google email.' });
        return res.end();
      }

      db.run('INSERT INTO google_identities (google_sub, user_id, email, created_at) VALUES (?, ?, ?, ?)', [
        googleSub,
        stateRow.user_id,
        googleEmail,
        new Date().toISOString()
      ]);

      const workspaceId = (db.queryOne('SELECT workspace_id FROM memberships WHERE user_id = ?', [stateRow.user_id]) || {}).workspace_id;
      db.logAudit({
        workspaceId,
        userId: stateRow.user_id,
        action: 'auth.google.linked',
        details: { email: googleEmail }
      });

      res.writeHead(302, { 'Location': '/app?success=Google account successfully linked.' });
      return res.end();
    }

    // SIGN-IN OR AUTO-REGISTER
    const existingIdentity = db.queryOne('SELECT * FROM google_identities WHERE google_sub = ?', [googleSub]);
    if (existingIdentity) {
      const user = db.queryOne('SELECT * FROM users WHERE id = ?', [existingIdentity.user_id]);
      if (!user) {
        return html(res, '<h1>Authentication Error</h1><p>Linked user profile not found</p>', 404);
      }

      const sessionId = cryptoUtils.generateRandomToken(32);
      const csrfSecret = cryptoUtils.generateRandomToken(32);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
        sessionId,
        user.id,
        csrfSecret,
        expiresAt
      ]);

      const workspaceId = (db.queryOne('SELECT workspace_id FROM memberships WHERE user_id = ?', [user.id]) || {}).workspace_id;
      db.logAudit({
        workspaceId,
        userId: user.id,
        action: 'auth.login.google',
        details: { email: googleEmail }
      });

      const secureFlag = config.IS_PROD ? '; Secure' : '';
      res.writeHead(302, {
        'Location': '/app',
        'Set-Cookie': [
          `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
          `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
        ]
      });
      return res.end();
    }

    // Unlinked sub. Verify that the email doesn't belong to any existing account
    const existingUser = db.queryOne('SELECT * FROM users WHERE email = ?', [googleEmail]);
    if (existingUser) {
      res.writeHead(302, { 'Location': '/app?error=An account with this email already exists. Please log in with password first and link your Google account.' });
      return res.end();
    }

    // Auto-create new user + workspace + link Google atomically
    const userId = 'u_' + cryptoUtils.generateRandomToken(12);
    const workspaceId = 'w_' + cryptoUtils.generateRandomToken(12);
    const randomPassword = cryptoUtils.generateRandomToken(32);
    const passwordHash = cryptoUtils.hashPassword(randomPassword);
    const nowStr = new Date().toISOString();

    const sessionId = cryptoUtils.generateRandomToken(32);
    const csrfSecret = cryptoUtils.generateRandomToken(32);
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.transaction(() => {
      db.run('INSERT INTO users (id, email, password_hash, has_password, created_at) VALUES (?, ?, ?, 0, ?)', [
        userId,
        googleEmail,
        passwordHash,
        nowStr
      ]);

      db.run('INSERT INTO google_identities (google_sub, user_id, email, created_at) VALUES (?, ?, ?, ?)', [
        googleSub,
        userId,
        googleEmail,
        nowStr
      ]);

      db.run(
        "INSERT INTO workspaces (id, name, stripe_customer_id, stripe_subscription_id, stripe_status, max_devices, max_destinations, created_at) VALUES (?, ?, NULL, NULL, 'none', 1, 1, ?)",
        [workspaceId, `${googleEmail.split('@')[0]}'s Workspace`, nowStr]
      );

      db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')", [
        workspaceId,
        userId
      ]);

      db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
        sessionId,
        userId,
        csrfSecret,
        sessionExpiresAt
      ]);

      db.logAudit({
        workspaceId,
        userId,
        action: 'auth.register.google',
        details: { email: googleEmail }
      });
    });

    const secureFlag = config.IS_PROD ? '; Secure' : '';
    res.writeHead(302, {
      'Location': '/app',
      'Set-Cookie': [
        `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
        `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
      ]
    });
    return res.end();

  } catch (err) {
    console.error('Google callback error:', { marker: 'OIDC_CALLBACK_FAILURE' });
    return html(res, `<h1>Authentication Error</h1><p>An unexpected authentication error occurred. Please try again later.</p>`, 500);
  }
}, null, false);

addRoute('POST', '/api/auth/google/unlink', (req, res) => {
  const ctx = req.authContext;
  if (ctx.type !== 'web') {
    return json(res, { error: 'Web session required' }, 401);
  }
  
  const user = db.queryOne('SELECT has_password FROM users WHERE id = ?', [ctx.user.id]);
  if (user && user.has_password === 0) {
    return json(res, { error: 'Cannot unlink your sole login method. Please set a password first.' }, 400);
  }
  
  const existing = db.queryOne('SELECT * FROM google_identities WHERE user_id = ?', [ctx.user.id]);
  if (!existing) {
    return json(res, { error: 'No Google identity linked to this account' }, 400);
  }
  
  db.run('DELETE FROM google_identities WHERE user_id = ?', [ctx.user.id]);
  
  const workspaceId = (db.queryOne('SELECT workspace_id FROM memberships WHERE user_id = ?', [ctx.user.id]) || {}).workspace_id;
  db.logAudit({
    workspaceId,
    userId: ctx.user.id,
    action: 'auth.google.unlinked',
    details: { email: existing.email }
  });
  
  return json(res, { success: true });
}, null, true, 'web');

// 4c. Auth: Auth0 OIDC Routes
const auth0Error = (res, statusCode = 400) => {
  return html(res, '<h1>Authentication Error</h1><p>An error occurred during authentication. Please try again later.</p>', statusCode);
};

addRoute('GET', '/api/auth/auth0/start', (req, res) => {
  const normDomain = getNormalizedAuth0Domain();
  if (!normDomain || !config.AUTH0_CLIENT_ID || !config.AUTH0_CLIENT_SECRET || !config.AUTH0_REDIRECT_URI) {
    return json(res, { error: 'Auth0 sign-in is not configured' }, 503);
  }

  const state = cryptoUtils.generateRandomToken(32);
  const nonce = cryptoUtils.generateRandomToken(32);
  const pkceVerifier = cryptoUtils.generateRandomToken(32);

  // PKCE S256 Challenge
  const hash = crypto.createHash('sha256').update(pkceVerifier).digest();
  const pkceChallenge = hash.toString('base64url');

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  db.run('INSERT INTO auth0_auth_states (state, pkce_verifier, nonce, expires_at) VALUES (?, ?, ?, ?)', [
    state,
    pkceVerifier,
    nonce,
    expiresAt
  ]);

  const auth0Url = `https://${normDomain}/authorize?` + new URLSearchParams({
    client_id: config.AUTH0_CLIENT_ID,
    redirect_uri: config.AUTH0_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
    nonce
  }).toString();

  res.writeHead(302, { 'Location': auth0Url });
  res.end();
}, null, false);

addRoute('GET', '/api/auth/auth0/callback', async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');

  if (!code || !state) {
    return auth0Error(res, 400);
  }

  const stateRow = db.queryOne('SELECT * FROM auth0_auth_states WHERE state = ?', [state]);
  if (!stateRow) {
    return auth0Error(res, 400);
  }

  // Single-use state
  db.run('DELETE FROM auth0_auth_states WHERE state = ?', [state]);

  if (new Date(stateRow.expires_at) < new Date()) {
    return auth0Error(res, 400);
  }

  const normDomain = getNormalizedAuth0Domain();
  if (!normDomain) {
    return auth0Error(res, 400);
  }

  try {
    const tokens = await auth0OidcClient.exchangeCode(normDomain, code, stateRow.pkce_verifier);
    const idToken = tokens.id_token;
    if (!idToken) {
      return auth0Error(res, 400);
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return auth0Error(res, 400);
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (e) {
      return auth0Error(res, 400);
    }

    if (header.alg !== 'RS256') {
      console.error('Auth0 OIDC verification failed: unsupported alg', { alg: header.alg });
      return auth0Error(res, 400);
    }

    // Signature verification against JWKS
    const jwks = await auth0OidcClient.fetchJwks(normDomain);
    const jwk = jwks.keys.find(k => k.kid === header.kid);
    if (!jwk) {
      console.error('Auth0 public key not found for ID Token');
      return auth0Error(res, 400);
    }

    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e
      },
      format: 'jwk'
    });

    const verifierObj = crypto.createVerify('RSA-SHA256');
    verifierObj.update(`${headerB64}.${payloadB64}`);
    const isValid = verifierObj.verify(publicKey, Buffer.from(signatureB64, 'base64url'));
    if (!isValid) {
      console.error('Auth0 ID Token signature verification failed');
      return auth0Error(res, 400);
    }

    // Assert OIDC claims
    const nowSecs = Math.floor(Date.now() / 1000);
    if (payload.iss !== `https://${normDomain}/`) {
      console.error('Auth0 OIDC validation failed: invalid iss', { expected: `https://${normDomain}/`, actual: payload.iss });
      return auth0Error(res, 400);
    }

    const aud = payload.aud;
    const client_id = config.AUTH0_CLIENT_ID;
    const isAudValid = (typeof aud === 'string' && aud === client_id) || 
                       (Array.isArray(aud) && aud.includes(client_id));
    if (!isAudValid) {
      console.error('Auth0 OIDC validation failed: invalid aud', { expected: client_id, actual: aud });
      return auth0Error(res, 400);
    }

    if (payload.exp < nowSecs) {
      console.error('Auth0 OIDC validation failed: expired token');
      return auth0Error(res, 400);
    }

    if (payload.nonce !== stateRow.nonce) {
      console.error('Auth0 OIDC validation failed: nonce mismatch');
      return auth0Error(res, 400);
    }

    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      console.error('Auth0 OIDC validation failed: email not verified');
      return auth0Error(res, 400);
    }

    const auth0Sub = payload.sub;
    const auth0Email = payload.email;

    if (typeof auth0Sub !== 'string' || !auth0Sub.trim()) {
      console.error('Auth0 OIDC validation failed: empty sub');
      return auth0Error(res, 400);
    }
    if (typeof auth0Email !== 'string' || !auth0Email.trim()) {
      console.error('Auth0 OIDC validation failed: empty email');
      return auth0Error(res, 400);
    }

    // Existing Auth0 subject signs in
    const existingIdentity = db.queryOne('SELECT * FROM auth0_identities WHERE auth0_sub = ?', [auth0Sub]);
    if (existingIdentity) {
      const user = db.queryOne('SELECT * FROM users WHERE id = ?', [existingIdentity.user_id]);
      if (!user) {
        return auth0Error(res, 404);
      }

      const sessionId = cryptoUtils.generateRandomToken(32);
      const csrfSecret = cryptoUtils.generateRandomToken(32);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
        sessionId,
        user.id,
        csrfSecret,
        expiresAt
      ]);

      const workspaceId = (db.queryOne('SELECT workspace_id FROM memberships WHERE user_id = ?', [user.id]) || {}).workspace_id;
      db.logAudit({
        workspaceId,
        userId: user.id,
        action: 'auth.login.auth0',
        details: { email: auth0Email }
      });

      const secureFlag = config.IS_PROD ? '; Secure' : '';
      res.writeHead(302, {
        'Location': '/app',
        'Set-Cookie': [
          `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
          `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
        ]
      });
      return res.end();
    }

    // New subject/email auto-registers a new user/workspace only if email is not already used
    const existingUser = db.queryOne('SELECT * FROM users WHERE email = ?', [auth0Email]);
    if (existingUser) {
      res.writeHead(302, { 'Location': '/app?error=An account with this email already exists.' });
      return res.end();
    }

    // Auto-create new user + workspace + link Auth0 atomically
    const userId = 'u_' + cryptoUtils.generateRandomToken(12);
    const workspaceId = 'w_' + cryptoUtils.generateRandomToken(12);
    const randomPassword = cryptoUtils.generateRandomToken(32);
    const passwordHash = cryptoUtils.hashPassword(randomPassword);
    const nowStr = new Date().toISOString();

    const sessionId = cryptoUtils.generateRandomToken(32);
    const csrfSecret = cryptoUtils.generateRandomToken(32);
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.transaction(() => {
      db.run('INSERT INTO users (id, email, password_hash, has_password, created_at) VALUES (?, ?, ?, 0, ?)', [
        userId,
        auth0Email,
        passwordHash,
        nowStr
      ]);

      db.run('INSERT INTO auth0_identities (auth0_sub, user_id, email, created_at) VALUES (?, ?, ?, ?)', [
        auth0Sub,
        userId,
        auth0Email,
        nowStr
      ]);

      db.run(
        "INSERT INTO workspaces (id, name, stripe_customer_id, stripe_subscription_id, stripe_status, max_devices, max_destinations, created_at) VALUES (?, ?, NULL, NULL, 'none', 1, 1, ?)",
        [workspaceId, `${auth0Email.split('@')[0]}'s Workspace`, nowStr]
      );

      db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')", [
        workspaceId,
        userId
      ]);

      db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [
        sessionId,
        userId,
        csrfSecret,
        sessionExpiresAt
      ]);

      db.logAudit({
        workspaceId,
        userId,
        action: 'auth.register.auth0',
        details: { email: auth0Email }
      });
    });

    const secureFlag = config.IS_PROD ? '; Secure' : '';
    res.writeHead(302, {
      'Location': '/app',
      'Set-Cookie': [
        `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`,
        `_csrf=${csrfSecret}; Path=/; SameSite=Lax; Max-Age=86400${secureFlag}`
      ]
    });
    return res.end();

  } catch (err) {
    console.error('Auth0 callback error:', err);
    return auth0Error(res, 500);
  }
}, null, false);

// 5. Workspaces: List
addRoute('GET', '/api/workspaces', (req, res) => {
  const ctx = req.authContext;
  if (ctx.type !== 'web') {
    return json(res, { error: 'Web session required' }, 401);
  }
  const workspaces = db.queryAll(
    `SELECT w.*, m.role FROM workspaces w
     INNER JOIN memberships m ON w.id = m.workspace_id
     WHERE m.user_id = ?`,
    [ctx.user.id]
  );
  return json(res, { success: true, workspaces });
}, null, true);

// 6. Workspace: Get Details
addRoute('GET', '/api/workspaces/:workspaceId', (req, res) => {
  const ctx = req.authContext;
  const workspace = db.queryOne('SELECT * FROM workspaces WHERE id = ?', [req.workspaceId]);
  return json(res, { success: true, workspace, role: ctx.role });
}, ['owner', 'operator', 'finance'], true);

// 7. Workspace: Members List
addRoute('GET', '/api/workspaces/:workspaceId/members', (req, res) => {
  const members = db.queryAll(
    `SELECT u.id, u.email, m.role FROM users u
     INNER JOIN memberships m ON u.id = m.user_id
     WHERE m.workspace_id = ?`,
    [req.workspaceId]
  );
  return json(res, { success: true, members });
}, ['owner', 'operator'], true);

// 8. Workspace: Add Member (Owner Only)
addRoute('POST', '/api/workspaces/:workspaceId/members', async (req, res) => {
  try {
    const bodyText = await readBody(req);
    const { email, role } = JSON.parse(bodyText);

    if (!email || !role || !['owner', 'operator', 'finance'].includes(role)) {
      return json(res, { error: 'Missing or invalid role/email' }, 400);
    }

    const targetUser = db.queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (!targetUser) {
      return json(res, { error: 'User with this email must be registered first' }, 400);
    }

    const existingMember = db.queryOne('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', [
      req.workspaceId,
      targetUser.id
    ]);
    if (existingMember) {
      return json(res, { error: 'User is already a member of this workspace' }, 400);
    }

    db.run('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      req.workspaceId,
      targetUser.id,
      role
    ]);

    db.logAudit({
      workspaceId: req.workspaceId,
      userId: req.authContext.user.id,
      action: 'workspace.member_added',
      details: { addedUserEmail: email, role }
    });

    return json(res, { success: true });
  } catch (e) {
    return json(res, { error: 'Invalid payload' }, 400);
  }
}, ['owner'], true);

// 9. Workspace: Audits List
addRoute('GET', '/api/workspaces/:workspaceId/audits', (req, res) => {
  const audits = db.queryAll(
    'SELECT * FROM audit_records WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100',
    [req.workspaceId]
  );
  return json(res, { success: true, audits });
}, ['owner', 'operator', 'finance'], true);

export function getStrictWorkspaceEntitlement(workspaceId) {
  return getWorkspaceEntitlement(workspaceId);
}

// 10. Workspace Devices: Link-Code Generator
addRoute('POST', '/api/workspaces/:workspaceId/devices/link-code', async (req, res) => {
  try {
    const bodyText = await readBody(req);
    const { name } = JSON.parse(bodyText || '{}');

    if (!name) {
      return json(res, { error: 'Device name is required' }, 400);
    }

    // Check device pairing limits BEFORE generating code
    const devicesCount = db.queryOne(
      "SELECT COUNT(*) as count FROM devices WHERE workspace_id = ? AND status != 'revoked'",
      [req.workspaceId]
    ).count;

    const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
    if (!entitlement.canStream) {
      return json(res, { error: 'Workspace has reached its maximum paired devices limit' }, 402);
    }
    if (devicesCount >= entitlement.maxDevices) {
      return json(res, { error: 'Workspace has reached its maximum paired devices limit' }, 402);
    }

    // Link code: secure uppercase Alphanumeric
    const linkCode = cryptoUtils.generateRandomToken(4).toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
    const deviceId = 'dev_' + cryptoUtils.generateRandomToken(12);

    db.run(
      `INSERT INTO devices (id, workspace_id, name, link_code, link_code_expires_at, linked_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?)`,
      [deviceId, req.workspaceId, name, linkCode, expiresAt, new Date().toISOString()]
    );

    db.logAudit({
      workspaceId: req.workspaceId,
      userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
      action: 'device.link_code_generated',
      details: { deviceName: name }
    });

    return json(res, { success: true, linkCode, expiresAt });
  } catch (err) {
    return json(res, { error: 'Invalid request payload' }, 400);
  }
}, ['owner', 'operator'], true);

// 11. Workspace Devices: List Devices
addRoute('GET', '/api/workspaces/:workspaceId/devices', (req, res) => {
  const devices = db.queryAll(`SELECT id, workspace_id, name, linked_at, status, created_at,
      CASE WHEN ingest_key_hash IS NULL THEN 0 ELSE 1 END AS has_ingest_key,
      ingest_key_last4, ingest_key_rotated_at
    FROM devices WHERE workspace_id = ? ORDER BY created_at DESC`, [
    req.workspaceId
  ]);
  return json(res, { success: true, devices });
}, ['owner', 'operator'], true);

// Generate or rotate the reusable OBS ingest key. The raw key is returned once
// and only its SHA-256 hash is retained by the control plane.
addRoute('POST', '/api/workspaces/:workspaceId/devices/:deviceId/ingest-key/rotate', (req, res) => {
  const device = db.queryOne('SELECT * FROM devices WHERE id = ? AND workspace_id = ?', [
    req.params.deviceId,
    req.workspaceId
  ]);
  if (!device || device.status !== 'active') {
    return json(res, { error: 'Active device not found in workspace' }, 404);
  }

  const live = db.queryOne(
    "SELECT id FROM stream_sessions WHERE device_id = ? AND status = 'streaming' LIMIT 1",
    [device.id]
  );
  if (live) {
    return json(res, { error: 'End the active stream before rotating this device stream key.' }, 409);
  }

  const ingestServer = config.RTMP_INGEST_BASE_URL;
  if (config.IS_PROD && (!process.env.RTMP_INGEST_BASE_URL || !ingestServer.startsWith('rtmps://'))) {
    return json(res, { error: 'Managed ingest is not configured with a production RTMPS endpoint.' }, 503);
  }

  const streamKey = 'ember_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(streamKey).digest('hex');
  const rotatedAt = new Date().toISOString();
  db.run(
    'UPDATE devices SET ingest_key_hash = ?, ingest_key_last4 = ?, ingest_key_rotated_at = ? WHERE id = ?',
    [keyHash, streamKey.slice(-4), rotatedAt, device.id]
  );
  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.user.id,
    deviceId: device.id,
    action: 'device.ingest_key.rotated',
    details: { deviceId: device.id }
  });

  return json(res, { success: true, ingestServer, streamKey, rotatedAt });
}, ['owner', 'operator'], true, 'web');

// 12. Workspace Devices: Revoke Device
addRoute('POST', '/api/workspaces/:workspaceId/devices/:deviceId/revoke', async (req, res) => {
  const device = db.queryOne('SELECT * FROM devices WHERE id = ? AND workspace_id = ?', [
    req.params.deviceId,
    req.workspaceId
  ]);
  if (!device) {
    return json(res, { error: 'Device not found in workspace' }, 404);
  }

  const activeStreams = db.queryAll(
    "SELECT id FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming')",
    [device.id]
  );
  for (const stream of activeStreams) {
    await stopStreamSession(stream.id, req.workspaceId);
  }

  db.run("UPDATE devices SET status = 'revoked', link_code = NULL, link_code_expires_at = NULL, ingest_key_hash = NULL, ingest_key_last4 = NULL WHERE id = ?", [
    device.id
  ]);
  db.run('DELETE FROM device_sessions WHERE device_id = ?', [device.id]);

  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    action: 'device.revoked',
    details: { deviceId: device.id, deviceName: device.name }
  });

  return json(res, { success: true });
}, ['owner', 'operator'], true);

// 12. Device: Bootstrap & Heartbeat Runtime routes
addRoute('GET', '/api/device/bootstrap', (req, res) => {
  const workspace = db.queryOne('SELECT id, name FROM workspaces WHERE id = ?', [req.authContext.workspaceId]);
  const activeStream = db.queryOne(
    "SELECT id, status, started_at, stopped_at FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming') ORDER BY created_at DESC LIMIT 1",
    [req.authContext.device.id]
  );
  return json(res, {
    success: true,
    deviceId: req.authContext.device.id,
    workspaceId: req.authContext.workspaceId,
    device: {
      id: req.authContext.device.id,
      name: req.authContext.device.name,
      hasIngestKey: !!req.authContext.device.ingest_key_hash,
      ingestKeyLast4: req.authContext.device.ingest_key_last4 || null,
      ingestKeyRotatedAt: req.authContext.device.ingest_key_rotated_at || null
    },
    workspace,
    activeStream: activeStream || null
  });
}, ['operator'], true, 'device');

addRoute('POST', '/api/device/heartbeat', (req, res) => {
  return json(res, { success: true, status: 'alive' });
}, ['operator'], true, 'device');

// 13. Public: Pair Device
addRoute('POST', '/api/devices/pair', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!rateLimit('pair:' + ip, 5, 60000)) { // 5 requests per minute
    return json(res, { error: 'Too many pairing attempts. Please try again later.' }, 429);
  }

  try {
    const bodyText = await readBody(req);
    const { link_code } = JSON.parse(bodyText);
    const normalizedLinkCode = typeof link_code === 'string'
      ? link_code.replace(/[\s-]/g, '').toUpperCase()
      : '';

    if (!normalizedLinkCode) {
      return json(res, { error: 'Missing link_code' }, 400);
    }

    let result = null;
    db.transaction(() => {
      const device = db.queryOne('SELECT * FROM devices WHERE link_code = ?', [normalizedLinkCode]);
      if (!device) {
        result = { error: 'Invalid or expired link code', status: 400 };
        return;
      }

      if (device.status !== 'pending') {
        result = { error: 'Link code has already been consumed or is invalid', status: 400 };
        return;
      }

      if (new Date(device.link_code_expires_at) < new Date()) {
        result = { error: 'Link code has expired', status: 400 };
        return;
      }

      // Verify limit again at pairing execution
      const activeCount = db.queryOne(
        "SELECT COUNT(*) as count FROM devices WHERE workspace_id = ? AND status = 'active'",
        [device.workspace_id]
      ).count;

      const entitlement = getStrictWorkspaceEntitlement(device.workspace_id);
      if (!entitlement.canStream) {
        result = { error: 'Maximum active devices limit exceeded. Please upgrade your subscription.', status: 402 };
        return;
      }
      if (activeCount >= entitlement.maxDevices) {
        result = { error: 'Maximum active devices limit exceeded. Please upgrade your subscription.', status: 402 };
        return;
      }

      const accessToken = 'da_' + cryptoUtils.generateRandomToken(32);
      const refreshToken = 'dr_' + cryptoUtils.generateRandomToken(32);
      const refreshTokenHash = cryptoUtils.hashRefreshToken(refreshToken);
      const now = new Date().toISOString();
      const sessionExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes access token
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days refresh token

      // Consume code and activate device with conditional state guard
      const info = db.run(
        "UPDATE devices SET status = 'active', link_code = NULL, link_code_expires_at = NULL, linked_at = ? WHERE id = ? AND status = 'pending'",
        [now, device.id]
      );

      if (info.changes === 0) {
        result = { error: 'Link code has already been consumed or is invalid', status: 400 };
        return;
      }

      const accessTokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
      db.run(
        'INSERT INTO device_sessions (id, device_id, refresh_token_hash, expires_at, refresh_token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [accessTokenHash, device.id, refreshTokenHash, sessionExpiresAt, refreshExpiresAt, now]
      );

      db.logAudit({
        workspaceId: device.workspace_id,
        deviceId: device.id,
        action: 'device.paired',
        details: { deviceName: device.name }
      });

      result = {
        status: 200,
        body: {
          success: true,
          deviceId: device.id,
          accessToken,
          refreshToken,
          expiresAt: sessionExpiresAt
        }
      };
    });

    if (result.status !== 200) {
      return json(res, { error: result.error }, result.status);
    }
    return json(res, result.body, 200);
  } catch (err) {
    return json(res, { error: 'Invalid payload or error processing pair' }, 400);
  }
}, null, false);

// 14. Public: Device Refresh Token Rotation
addRoute('POST', '/api/devices/refresh', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!rateLimit('refresh:' + ip, 20, 60000)) { // 20 requests per minute
    return json(res, { error: 'Too many refresh attempts. Please try again later.' }, 429);
  }

  try {
    const bodyText = await readBody(req);
    const { refreshToken } = JSON.parse(bodyText);

    if (!refreshToken) {
      return json(res, { error: 'Missing refreshToken' }, 400);
    }

    const incomingHash = cryptoUtils.hashRefreshToken(refreshToken);

    let result = null;
    db.transaction(() => {
      // Replay detection inside transaction
      const used = db.queryOne('SELECT * FROM used_refresh_tokens WHERE hash = ?', [incomingHash]);
      if (used) {
        db.run('DELETE FROM device_sessions WHERE device_id = ?', [used.device_id]);
        result = { error: 'Refresh token replay detected. All sessions revoked.', status: 401 };
        return;
      }

      const session = db.queryOne('SELECT * FROM device_sessions WHERE refresh_token_hash = ?', [incomingHash]);
      if (!session) {
        result = { error: 'Invalid or expired refresh token', status: 401 };
        return;
      }

      if (new Date(session.refresh_token_expires_at) < new Date()) {
        result = { error: 'Refresh token has expired', status: 401 };
        return;
      }

      const device = db.queryOne('SELECT id, workspace_id, status FROM devices WHERE id = ?', [session.device_id]);
      if (!device || device.status === 'revoked') {
        result = { error: 'Device is revoked or not found', status: 401 };
        return;
      }

      // Mark as used and delete session inside transaction
      db.run('DELETE FROM device_sessions WHERE id = ?', [session.id]);
      db.run('INSERT INTO used_refresh_tokens (hash, device_id, expires_at) VALUES (?, ?, ?)', [
        incomingHash,
        session.device_id,
        session.refresh_token_expires_at
      ]);

      const newAccessToken = 'da_' + cryptoUtils.generateRandomToken(32);
      const newAccessTokenHash = crypto.createHash('sha256').update(newAccessToken).digest('hex');
      const newRefreshToken = 'dr_' + cryptoUtils.generateRandomToken(32);
      const newRefreshTokenHash = cryptoUtils.hashRefreshToken(newRefreshToken);
      const now = new Date().toISOString();
      const sessionExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes access
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days refresh

      db.run(
        'INSERT INTO device_sessions (id, device_id, refresh_token_hash, expires_at, refresh_token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newAccessTokenHash, device.id, newRefreshTokenHash, sessionExpiresAt, refreshExpiresAt, now]
      );

      result = {
        status: 200,
        body: {
          success: true,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          expiresAt: sessionExpiresAt
        }
      };
    });

    if (result.status !== 200) {
      return json(res, { error: result.error }, result.status);
    }
    return json(res, result.body, 200);
  } catch (err) {
    return json(res, { error: 'Invalid payload' }, 400);
  }
}, null, false);

// Helpers for Paystack subscription billing
function isPaystackConfigured() {
  return !!(
    /^sk_(test|live)_\S+$/.test(config.PAYSTACK_SECRET_KEY || '') &&
    config.PAYSTACK_PLAN_CODE &&
    String(config.PAYSTACK_PLAN_AMOUNT) === '300000' &&
    config.PAYSTACK_CURRENCY === 'NGN'
  );
}

export function getWorkspaceEntitlement(workspaceId) {
  const workspace = db.queryOne('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
  if (!workspace) {
    return {
      plan: 'free',
      paidUntil: null,
      cancelAtPeriodEnd: false,
      canStream: false,
      maxDevices: 0,
      maxDestinations: 0,
      maxActiveBroadcasts: 0,
      subscriptionStatus: 'none',
      manageAvailable: false
    };
  }

  const paidUntil = workspace.paid_until || null;
  const cancelAtPeriodEnd = !!workspace.cancel_at_period_end;
  const paystackStatus = workspace.paystack_status || 'none';
  // A provider status or a legacy Stripe column is never proof of payment.
  const payments = db.queryOne(`SELECT COUNT(*) AS count, MAX(CASE WHEN mode = ? THEN paid_until END) AS mode_paid_until
    FROM paystack_payments WHERE workspace_id = ?`, [paystackMode(), workspaceId]);
  const modeMatches = !payments.count || Date.parse(payments.mode_paid_until) >= Date.parse(paidUntil);
  const isPro = Number.isFinite(Date.parse(paidUntil)) && Date.parse(paidUntil) > Date.now() && paystackStatus !== 'suspended' && modeMatches;

  return {
    plan: isPro ? 'pro' : 'free',
    paidUntil,
    cancelAtPeriodEnd,
    canStream: isPro,
    maxDevices: isPro ? 3 : 0,
    maxDestinations: isPro ? 3 : 0,
    maxActiveBroadcasts: isPro ? 1 : 0,
    subscriptionStatus: paystackStatus,
    manageAvailable: !!db.queryOne('SELECT 1 FROM paystack_subscriptions WHERE subscription_code = ? AND workspace_id = ? AND mode = ?',
      [workspace.paystack_subscription_id, workspaceId, paystackMode()])
  };
}

function addOneMonthClamped(date) {
  const d = new Date(date);
  const currentMonth = d.getUTCMonth();
  d.setUTCMonth(currentMonth + 1);
  if (d.getUTCMonth() !== (currentMonth + 1) % 12) {
    d.setUTCDate(0);
  }
  return d;
}

function paystackMode() {
  const key = config.PAYSTACK_SECRET_KEY || '';
  return /^sk_live_/.test(key) ? 'live' : /^sk_test_/.test(key) ? 'test' : 'unconfigured';
}

function paymentPlanCode(data) {
  return (typeof data.plan === 'string' ? data.plan : data.plan?.plan_code) || data.plan_object?.plan_code || null;
}

function safePaystackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['paystack.com', 'paystack.co'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

async function paystackRequest(endpoint, body) {
  let response;
  let result;
  try {
    response = await fetch(`https://api.paystack.co${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
    result = await response.json();
  } catch { throw new Error('Payment provider unavailable. Please retry verification shortly.'); }
  if (!response.ok || result.status !== true || !result.data) {
    const error = new Error('Payment provider could not complete this request.');
    // Only a definite rejection of initialization permits a new checkout.
    error.definiteRejection = response.status >= 400 && response.status < 500;
    throw error;
  }
  return result.data;
}

async function verifyPaystackPlan() {
  if (!isPaystackConfigured()) throw new Error('Paystack NGN billing is not configured.');
  let origin;
  try { origin = new URL(config.APP_BASE_URL); } catch { throw new Error('Checkout callback origin is not configured.'); }
  const localTest = paystackMode() === 'test' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((!localTest && origin.protocol !== 'https:') || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Checkout requires an HTTPS app origin (loopback HTTP is allowed with test keys).');
  }
  const plan = await paystackRequest(`/plan/${encodeURIComponent(config.PAYSTACK_PLAN_CODE)}`);
  if (plan.plan_code !== config.PAYSTACK_PLAN_CODE || plan.amount !== 300000 || plan.currency !== 'NGN' ||
      plan.interval !== 'monthly' || plan.domain !== paystackMode()) {
    throw new Error('Paystack plan must be NGN 3,000 monthly in the configured payment mode.');
  }
}

function validatePaidTransaction(data, reference) {
  const paidAt = Date.parse(data.paid_at);
  if (data.reference !== reference || data.status !== 'success' || data.domain !== paystackMode() ||
      data.amount !== 300000 || data.currency !== 'NGN' || paymentPlanCode(data) !== config.PAYSTACK_PLAN_CODE ||
      !/^CUS_[a-zA-Z0-9]+$/.test(data.customer?.customer_code || '') ||
      !/^\d+$/.test(String(data.id || '')) || !Number.isFinite(paidAt) || paidAt > Date.now() + 60000) {
    throw new Error('Verification failed: Payment details mismatch.');
  }
}

// Both callback verification and webhooks enter this transaction. Metadata never
// selects a workspace. A renewal requires an already bound subscription.
function applyPaidTransaction(data, reference, subscriptionCode = null, invoice = null) {
  validatePaidTransaction(data, reference);
  let invoiceEnd = null;
  if (invoice?.period_end || invoice?.period_start) {
    const start = Date.parse(invoice.period_start), end = Date.parse(invoice.period_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 32 * 86400000 ||
        end > Date.parse(data.paid_at) + 32 * 86400000 || (invoice.amount !== undefined && invoice.amount !== 300000) ||
        (invoice.domain !== undefined && invoice.domain !== data.domain)) throw new Error('Invalid paid invoice period.');
    invoiceEnd = new Date(end).toISOString();
  }
  return db.transaction(() => {
    const checkout = db.queryOne('SELECT * FROM paystack_checkouts WHERE reference = ?', [reference]);
    const subscription = subscriptionCode && db.queryOne('SELECT * FROM paystack_subscriptions WHERE subscription_code = ?', [subscriptionCode]);
    const workspaceId = checkout?.workspace_id || subscription?.workspace_id;
    if (!workspaceId || (checkout && (checkout.plan_code !== paymentPlanCode(data) || checkout.amount !== data.amount ||
        checkout.currency !== data.currency || checkout.mode !== data.domain)) ||
        (subscription && (subscription.customer_code !== data.customer.customer_code || subscription.plan_code !== paymentPlanCode(data) ||
          subscription.mode !== data.domain || (subscription.workspace_id && subscription.workspace_id !== workspaceId)))) {
      throw new Error('Payment is not bound to this workspace.');
    }
    if (!checkout && !invoiceEnd) throw new Error('Renewal requires a verified invoice period.');
    const previous = db.queryOne('SELECT * FROM paystack_payments WHERE reference = ? OR (mode = ? AND transaction_id = ?)',
      [reference, data.domain, String(data.id)]);
    if (previous) {
      if (previous.reference !== reference || previous.workspace_id !== workspaceId) throw new Error('Payment reference conflict.');
      if (invoiceEnd && previous.paid_until !== invoiceEnd) {
        db.run('UPDATE paystack_payments SET paid_until = ? WHERE reference = ?', [invoiceEnd, reference]);
        const latest = db.queryOne('SELECT MAX(paid_until) AS paid_until FROM paystack_payments WHERE workspace_id = ? AND mode = ?', [workspaceId, data.domain]);
        db.run('UPDATE workspaces SET paid_until = ? WHERE id = ?', [latest.paid_until, workspaceId]);
      }
      return getWorkspaceEntitlement(workspaceId);
    }
    const paidUntil = invoiceEnd || addOneMonthClamped(data.paid_at).toISOString();
    db.run(`INSERT INTO paystack_payments (reference, transaction_id, workspace_id, customer_code, plan_code, mode, paid_at, paid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [reference, String(data.id), workspaceId, data.customer.customer_code,
      paymentPlanCode(data), data.domain, new Date(data.paid_at).toISOString(), paidUntil]);
    const current = db.queryOne('SELECT paid_until, paystack_status FROM workspaces WHERE id = ?', [workspaceId]);
    const nextPaidUntil = Date.parse(current.paid_until) > Date.parse(paidUntil) ? current.paid_until : paidUntil;
    db.run(`UPDATE workspaces SET paid_until = ?, paystack_customer_code = ?,
      paystack_status = CASE WHEN paystack_status IN ('none', 'past_due') THEN 'active' ELSE paystack_status END,
      max_devices = 3, max_destinations = 3 WHERE id = ?`, [nextPaidUntil, data.customer.customer_code, workspaceId]);
    if (checkout) db.run("UPDATE paystack_checkouts SET status = 'verified', updated_at = ? WHERE reference = ?", [new Date().toISOString(), reference]);
    db.logAudit({ workspaceId, action: 'billing.payment_verified', details: { reference, paidUntil: nextPaidUntil } });
    return getWorkspaceEntitlement(workspaceId);
  });
}

function rememberSubscription(data) {
  const code = data.subscription_code;
  const customer = data.customer?.customer_code;
  if (!/^SUB_[a-zA-Z0-9]+$/.test(code || '') || !/^CUS_[a-zA-Z0-9]+$/.test(customer || '') ||
      paymentPlanCode(data) !== config.PAYSTACK_PLAN_CODE || data.domain !== paystackMode()) return null;
  const existing = db.queryOne('SELECT * FROM paystack_subscriptions WHERE subscription_code = ?', [code]);
  if (existing && (existing.customer_code !== customer || existing.plan_code !== paymentPlanCode(data) || existing.mode !== data.domain)) {
    throw new Error('Subscription ownership mismatch.');
  }
  db.run(`INSERT OR IGNORE INTO paystack_subscriptions (subscription_code, customer_code, plan_code, mode, status)
    VALUES (?, ?, ?, ?, ?)`, [code, customer, paymentPlanCode(data), data.domain, 'pending']);
  return code;
}

// Paystack's subscription.create can precede charge.success and usually has no
// checkout reference. Resolve its actual invoice transaction, never guess using
// customer/email/timestamps (customers can own several workspaces).
async function bindPaystackSubscription(code, invoice = null) {
  const subscription = db.queryOne('SELECT * FROM paystack_subscriptions WHERE subscription_code = ?', [code]);
  if (!subscription) throw new Error('Subscription not recognized.');
  if (!invoice) {
    const remote = await paystackRequest(`/subscription/${encodeURIComponent(code)}`);
    if (remote.subscription_code !== code || remote.customer?.customer_code !== subscription.customer_code ||
        paymentPlanCode(remote) !== subscription.plan_code || remote.domain !== subscription.mode) throw new Error('Subscription ownership mismatch.');
    invoice = remote.most_recent_invoice;
  }
  const transaction = invoice?.transaction;
  let reference = transaction?.reference;
  if (!reference && /^\d+$/.test(String(transaction?.id || transaction || ''))) {
    const fetched = await paystackRequest(`/transaction/${encodeURIComponent(transaction?.id || transaction)}`);
    reference = fetched.reference;
  }
  if (!reference || invoice.paid !== 1 && invoice.paid !== true) throw new Error('Subscription payment association is pending.');
  const paid = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
  validatePaidTransaction(paid, reference);
  if (paid.customer.customer_code !== subscription.customer_code) throw new Error('Subscription customer mismatch.');
  applyPaidTransaction(paid, reference, code, invoice);
  const payment = db.queryOne('SELECT * FROM paystack_payments WHERE reference = ?', [reference]);
  db.transaction(() => {
    const current = db.queryOne('SELECT * FROM paystack_subscriptions WHERE subscription_code = ?', [code]);
    const workspace = db.queryOne('SELECT paystack_subscription_id FROM workspaces WHERE id = ?', [payment.workspace_id]);
    const oldSubscription = workspace.paystack_subscription_id && db.queryOne('SELECT status FROM paystack_subscriptions WHERE subscription_code = ?', [workspace.paystack_subscription_id]);
    if ((subscription.workspace_id && subscription.workspace_id !== payment.workspace_id) ||
        (workspace.paystack_subscription_id && workspace.paystack_subscription_id !== code && oldSubscription?.status !== 'disabled')) throw new Error('Subscription binding conflict.');
    const status = current.status === 'pending' ? 'active' : current.status;
    db.run('UPDATE paystack_subscriptions SET workspace_id = ?, status = ? WHERE subscription_code = ?', [payment.workspace_id, status, code]);
    db.run('UPDATE workspaces SET paystack_subscription_id = ?, cancel_at_period_end = ?, paystack_status = ? WHERE id = ?',
      [code, current.cancel_at_period_end, status, payment.workspace_id]);
  });
}

// 14.2. Public: GET Paystack plan configuration
addRoute('GET', '/api/billing/plan', async (req, res) => {
  let configured = false;
  const mode = !config.PAYSTACK_SECRET_KEY ? 'unconfigured' : (config.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test');
  let checkoutUnavailableReason = null;
  try { await verifyPaystackPlan(); configured = true; }
  catch (err) { checkoutUnavailableReason = err.message; }
  return json(res, {
    plan: {
      name: 'Emberstage Pro',
      amount: 300000,
      currency: 'NGN',
      interval: 'monthly',
      maxDevices: 3,
      maxDestinations: 3,
      maxActiveBroadcasts: 1
    },
    checkoutAvailable: configured,
    checkoutUnavailableReason,
    mode
  });
}, null, false);

// 14.3. Workspace Billing: GET Workspace Billing/Entitlement Details
addRoute('GET', '/api/workspaces/:workspaceId/billing', async (req, res) => {
  let configured = false;
  const mode = !config.PAYSTACK_SECRET_KEY ? 'unconfigured' : (config.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test');
  let checkoutUnavailableReason = null;
  try { await verifyPaystackPlan(); configured = true; }
  catch (err) { checkoutUnavailableReason = err.message; }

  const entitlement = getWorkspaceEntitlement(req.workspaceId);

  return json(res, {
    plan: {
      name: 'Emberstage Pro',
      amount: 300000,
      currency: 'NGN',
      interval: 'monthly',
      maxDevices: 3,
      maxDestinations: 3,
      maxActiveBroadcasts: 1
    },
    checkoutAvailable: configured,
    checkoutUnavailableReason,
    mode,
    entitlement: {
      plan: entitlement.plan,
      paidUntil: entitlement.paidUntil,
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
      canStream: entitlement.canStream,
      maxDevices: entitlement.maxDevices,
      maxDestinations: entitlement.maxDestinations,
      maxActiveBroadcasts: entitlement.maxActiveBroadcasts
    },
    subscription: {
      status: entitlement.subscriptionStatus,
      manageAvailable: entitlement.manageAvailable
    }
  });
}, ['owner', 'operator', 'finance'], true);

// 15. Workspace Billing: Paystack Checkout
addRoute('POST', '/api/workspaces/:workspaceId/billing/checkout', async (req, res) => {
  if (!isPaystackConfigured()) {
    return json(res, { error: 'Paystack subscription billing is not configured or configured with incorrect plan parameters.' }, 503);
  }

  const workspaceId = req.workspaceId;
  let initializedReference = null;
  try {
    await verifyPaystackPlan();
    const result = db.transaction(() => {
      const entitlement = getWorkspaceEntitlement(workspaceId);
      if (entitlement.plan === 'pro') {
        throw Object.assign(new Error('Workspace already has an active subscription'), { status: 409 });
      }

      const workspace = db.queryOne('SELECT paystack_subscription_id, paystack_status FROM workspaces WHERE id = ?', [workspaceId]);
      const paidCheckout = db.queryOne("SELECT reference FROM paystack_checkouts WHERE workspace_id = ? AND status = 'verified' LIMIT 1", [workspaceId]);
      if ((workspace.paystack_subscription_id || paidCheckout) && workspace.paystack_status !== 'disabled') {
        throw Object.assign(new Error('Manage the existing subscription before starting another checkout.'), { status: 409 });
      }

      const pending = db.queryOne(
        `SELECT * FROM paystack_checkouts WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [workspaceId]
      );
      if (pending) {
        if (pending.plan_code !== config.PAYSTACK_PLAN_CODE || pending.mode !== paystackMode() || pending.amount !== 300000 || pending.currency !== 'NGN') {
          throw Object.assign(new Error('An existing checkout requires reconciliation.'), { status: 409 });
        }
        if (pending.checkout_url && safePaystackUrl(pending.checkout_url)) return { url: pending.checkout_url, reference: pending.reference };
        throw Object.assign(new Error('Checkout initialization is pending; verify this reference before retrying.'), { status: 409, reference: pending.reference });
      }

      const reference = 'ref_' + crypto.randomBytes(8).toString('hex');
      const mode = config.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO paystack_checkouts (reference, workspace_id, plan_code, amount, currency, mode, status, checkout_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        [reference, workspaceId, config.PAYSTACK_PLAN_CODE, 300000, 'NGN', mode, now, now]
      );

      return { reference, mode };
    });

    if (result.url) {
      return json(res, { success: true, url: result.url, reference: result.reference });
    }

    const { reference } = result;
    initializedReference = reference;
    const data = await paystackRequest('/transaction/initialize', {
        email: req.authContext.user.email,
        amount: '300000',
        currency: 'NGN',
        plan: config.PAYSTACK_PLAN_CODE,
        reference: reference,
        callback_url: `${new URL(config.APP_BASE_URL).origin}/app?billing=return&workspaceId=${encodeURIComponent(workspaceId)}#workspace`,
        metadata: { workspace_id: workspaceId, reference: reference }
    });
    const authUrl = data.authorization_url;
    if (data.reference !== reference || !safePaystackUrl(authUrl)) {
      return json(res, { error: 'Invalid authorization URL received from payment provider' }, 500);
    }

    db.run(
      `UPDATE paystack_checkouts SET checkout_url = ?, updated_at = ? WHERE reference = ?`,
      [authUrl, new Date().toISOString(), reference]
    );

    return json(res, { success: true, url: authUrl, reference });
  } catch (err) {
    if (initializedReference && err.definiteRejection) {
      db.run("UPDATE paystack_checkouts SET status = 'failed', updated_at = ? WHERE reference = ?", [new Date().toISOString(), initializedReference]);
    }
    return json(res, { error: err.message || 'Failed to initialize checkout with Paystack', reference: err.reference || initializedReference }, err.status || 503);
  }
}, ['owner', 'finance'], true);

// 15.2. Workspace Billing: Paystack Verify Reference
addRoute('POST', '/api/workspaces/:workspaceId/billing/verify', async (req, res) => {
  if (!isPaystackConfigured()) {
    return json(res, { error: 'Paystack subscription billing is not configured or configured with incorrect plan parameters.' }, 503);
  }

  const workspaceId = req.workspaceId;
  let bodyText = '';
  try {
    bodyText = await readBody(req);
  } catch (e) {}

  let reference = '';
  try {
    const parsed = JSON.parse(bodyText || '{}');
    reference = parsed.reference || '';
  } catch (e) {}

  if (typeof reference !== 'string' || !/^[a-zA-Z0-9._=-]{1,150}$/.test(reference)) {
    return json(res, { error: 'Missing reference parameter' }, 400);
  }

  const checkout = db.queryOne('SELECT * FROM paystack_checkouts WHERE reference = ?', [reference]);
  if (!checkout) {
    return json(res, { error: 'Checkout reference not found' }, 404);
  }
  if (checkout.workspace_id !== workspaceId) {
    return json(res, { error: 'Forbidden: Checkout reference belongs to a different workspace' }, 403);
  }

  if (checkout.status === 'verified' && db.queryOne('SELECT reference FROM paystack_payments WHERE reference = ?', [reference])) {
    if (checkout.mode !== paystackMode() || checkout.plan_code !== config.PAYSTACK_PLAN_CODE) {
      return json(res, { error: 'Checkout belongs to a different payment configuration.' }, 400);
    }
    const entitlement = getWorkspaceEntitlement(workspaceId);
    return json(res, {
      verified: true,
      entitlement: {
        plan: entitlement.plan,
        paidUntil: entitlement.paidUntil,
        cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        canStream: entitlement.canStream,
        maxDevices: entitlement.maxDevices,
        maxDestinations: entitlement.maxDestinations,
        maxActiveBroadcasts: entitlement.maxActiveBroadcasts
      },
      subscription: {
        status: entitlement.subscriptionStatus,
        manageAvailable: entitlement.manageAvailable
      }
    });
  }

  try {
    const data = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (data.status !== 'success') {
      return json(res, { verified: false, message: 'Transaction is not successful or still pending on Paystack.' });
    }
    const entitlement = applyPaidTransaction(data, reference);

    return json(res, {
      verified: true,
      entitlement: {
        plan: entitlement.plan,
        paidUntil: entitlement.paidUntil,
        cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        canStream: entitlement.canStream,
        maxDevices: entitlement.maxDevices,
        maxDestinations: entitlement.maxDestinations,
        maxActiveBroadcasts: entitlement.maxActiveBroadcasts
      },
      subscription: {
        status: entitlement.subscriptionStatus,
        manageAvailable: entitlement.manageAvailable
      }
    });
  } catch (err) {
    return json(res, { error: 'Payment could not be verified. No access was granted.' }, 400);
  }
}, ['owner', 'finance'], true);

// 16. Workspace Billing: Paystack subscription management
addRoute('POST', '/api/workspaces/:workspaceId/billing/portal', async (req, res) => {
  if (!config.PAYSTACK_SECRET_KEY) {
    return json(res, { error: 'Paystack integration is not configured. Please contact support.' }, 503);
  }

  const workspace = db.queryOne('SELECT paystack_subscription_id FROM workspaces WHERE id = ?', [req.workspaceId]);
  const subId = workspace?.paystack_subscription_id;
  if (!subId || !getWorkspaceEntitlement(req.workspaceId).manageAvailable) {
    return json(res, { error: 'No active subscription found. Please complete subscription first.' }, 400);
  }

  try {
    const subscriptionCode = encodeURIComponent(subId);
    const data = await paystackRequest(`/subscription/${subscriptionCode}/manage/link`);
    if (!safePaystackUrl(data.link)) return json(res, { error: 'Invalid subscription management URL' }, 502);
    return json(res, { success: true, url: data.link });
  } catch (err) {
    return json(res, { error: 'Failed to contact Paystack API' }, 500);
  }
}, ['owner', 'finance'], true);

// 17. Public: Paystack Webhook
addRoute('POST', '/api/billing/webhook', async (req, res) => {
  const rawBody = await readBody(req);
  const signatureHeader = req.headers['x-paystack-signature'];

  if (!config.PAYSTACK_SECRET_KEY) {
    return json(res, { error: 'Webhook endpoint not configured' }, 503);
  }

  const expectedSignature = crypto.createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  let verified = false;
  try {
    verified = typeof signatureHeader === 'string' && crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signatureHeader, 'hex')
    );
  } catch (err) {
    verified = false;
  }
  if (!verified) {
    return json(res, { error: 'Invalid Paystack signature' }, 400);
  }

  try {
    const event = JSON.parse(rawBody);
    const eventType = event.event;
    const data = event.data || {};
    if (!eventType) return json(res, { error: 'Missing Paystack event type' }, 400);
    const eventId = `paystack:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;

    const duplicate = db.queryOne('SELECT COUNT(*) as count FROM processed_webhook_events WHERE id = ?', [eventId]).count;
    if (duplicate > 0) {
      return json(res, { received: true, duplicate: true, message: 'Event already processed' });
    }

    if (!isPaystackConfigured() || data.domain !== paystackMode()) return json(res, { received: true, ignored: true });
    const code = data.subscription_code || data.subscription?.subscription_code;
    if (eventType === 'charge.success') {
      if (!data.reference) throw new Error('Missing payment reference.');
      const paid = await paystackRequest(`/transaction/verify/${encodeURIComponent(data.reference)}`);
      applyPaidTransaction(paid, data.reference, code);
    } else if (eventType === 'subscription.create') {
      const remembered = rememberSubscription(data);
      if (!remembered) return json(res, { received: true, ignored: true });
      await bindPaystackSubscription(remembered);
    } else if (eventType === 'invoice.update' && (data.paid === 1 || data.paid === true)) {
      if (!code) throw new Error('Subscription association is pending.');
      if (!db.queryOne('SELECT subscription_code FROM paystack_subscriptions WHERE subscription_code = ?', [code])) {
        const remote = await paystackRequest(`/subscription/${encodeURIComponent(code)}`);
        if (rememberSubscription(remote) !== code) throw new Error('Subscription mismatch.');
      }
      await bindPaystackSubscription(code, data);
    } else if (['subscription.not_renew', 'subscription.disable', 'invoice.payment_failed'].includes(eventType)) {
      const subscription = code && db.queryOne('SELECT * FROM paystack_subscriptions WHERE subscription_code = ?', [code]);
      if (!subscription || subscription.mode !== data.domain) throw new Error('Subscription association is pending.');
      const status = eventType === 'invoice.payment_failed' ? 'past_due' : (eventType === 'subscription.disable' ? 'disabled' : 'non_renewing');
      const cancelled = eventType !== 'invoice.payment_failed' || subscription.cancel_at_period_end;
      db.transaction(() => {
        db.run('UPDATE paystack_subscriptions SET status = ?, cancel_at_period_end = ? WHERE subscription_code = ?', [status, Number(cancelled), code]);
        if (subscription.workspace_id) db.run(`UPDATE workspaces SET paystack_status = ?, cancel_at_period_end = ?
          WHERE id = ? AND paystack_subscription_id = ?`, [status, Number(cancelled), subscription.workspace_id, code]);
      });
    }
    db.run('INSERT OR IGNORE INTO processed_webhook_events (id, created_at) VALUES (?, ?)', [eventId, new Date().toISOString()]);

    return json(res, { received: true });
  } catch (err) {
    // Retry unknown/out-of-order associations; never permanently consume them.
    return json(res, { error: 'Payment event is pending verification. Please retry.' }, 503);
  }
}, null, false);

async function syncNangoProvider(workspaceId, provider) {
  const connection = await nangoClient.getConnection(workspaceId, provider);
  const existing = db.queryOne('SELECT * FROM provider_connections WHERE workspace_id = ? AND provider = ?', [workspaceId, provider]);
  if (!connection) {
    if (existing) db.run("UPDATE provider_connections SET status = 'disconnected', updated_at = ? WHERE id = ?", [new Date().toISOString(), existing.id]);
    return null;
  }

  const now = new Date().toISOString();
  const localConnectionId = existing?.id || `pc_nango_${crypto.createHash('sha256').update(`${workspaceId}:${provider}`).digest('hex').slice(0, 24)}`;
  if (existing) {
    db.run("UPDATE provider_connections SET status = 'connected', encrypted_tokens = NULL, updated_at = ? WHERE id = ?", [now, existing.id]);
  } else {
    db.run(
      `INSERT INTO provider_connections (id, workspace_id, provider, encrypted_tokens, status, updated_at)
       VALUES (?, ?, ?, NULL, 'connected', ?)`,
      [localConnectionId, workspaceId, provider, now]
    );
  }

  const targets = await nangoClient.discoverTargets(workspaceId, provider);
  for (const target of targets) {
    const targetId = `pt_nango_${crypto.createHash('sha256').update(`${workspaceId}:${provider}:${target.id}`).digest('hex').slice(0, 24)}`;
    db.run(
      `INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET name = excluded.name, provider_connection_id = excluded.provider_connection_id`,
      [targetId, workspaceId, localConnectionId, provider, String(target.id), target.name, now]
    );
  }
  return { provider, status: 'connected', updated_at: connection.updated_at || connection.created || now };
}

// 18. Workspace Providers: List Providers Status
addRoute('GET', '/api/workspaces/:workspaceId/providers', async (req, res) => {
  let nangoError = null;
  if (nangoClient.isConfigured()) {
    try {
      await Promise.all(['twitch', 'youtube', 'facebook'].map(provider => syncNangoProvider(req.workspaceId, provider)));
    } catch (error) {
      nangoError = error.message || 'Nango is unavailable';
    }
  }
  const connections = db.queryAll('SELECT provider, status, updated_at FROM provider_connections WHERE workspace_id = ?', [
    req.workspaceId
  ]);

  const map = Object.fromEntries(connections.map(c => [c.provider, c]));

  const result = {
    twitch: {
      connected: !!map.twitch && map.twitch.status === 'connected',
      connect_available: nangoClient.isConfigured() || !!config.TWITCH_CLIENT_ID,
      reason: nangoError,
      details: map.twitch || null
    },
    youtube: {
      connected: !!map.youtube && map.youtube.status === 'connected',
      connect_available: nangoClient.isConfigured(),
      reason: nangoError || (nangoClient.isConfigured() ? null : 'YouTube connector requires Nango and custom developer credentials.'),
      details: map.youtube || null
    },
    facebook: {
      connected: !!map.facebook && map.facebook.status === 'connected',
      connect_available: nangoClient.isConfigured(),
      reason: nangoError || (nangoClient.isConfigured() ? null : 'Facebook connector requires Nango, business verification, and developer credentials.'),
      details: map.facebook || null
    },
    instagram: {
      connected: false,
      connect_available: false,
      reason: 'Instagram connector is disabled permanently.',
      details: null
    }
  };

  return json(res, { success: true, providers: result });
}, ['owner', 'operator'], true);

// 19. Workspace Providers: Connect Route
addRoute('POST', '/api/workspaces/:workspaceId/providers/:provider/connect', async (req, res) => {
  const provider = req.params.provider;

  if (!['twitch', 'youtube', 'facebook'].includes(provider)) {
    return json(res, { error: provider === 'instagram' ? 'Instagram connector is disabled permanently and cannot be connected.' : 'Unknown provider' }, provider === 'instagram' ? 403 : 400);
  }

  if (nangoClient.isConfigured()) {
    try {
      const workspace = db.queryOne('SELECT name FROM workspaces WHERE id = ?', [req.workspaceId]);
      const session = await nangoClient.createConnectSession({
        workspaceId: req.workspaceId,
        workspaceName: workspace?.name || 'Emberstage workspace',
        userEmail: req.authContext.type === 'web' ? req.authContext.user.email : null,
        provider
      });
      if (!session?.connect_link) throw new Error('Nango did not return a connection link');
      return json(res, { success: true, url: session.connect_link, expiresAt: session.expires_at });
    } catch (error) {
      return json(res, { error: `Could not start ${provider} connection: ${error.message}` }, error.status === 400 ? 400 : 503);
    }
  }

  const isDefaultSecret = (config.ENCRYPTION_SECRET === 'default-super-secret-emberstage-encryption-key-for-mvp-setup' || !process.env.ENCRYPTION_SECRET);
  if (isDefaultSecret && process.env.NODE_ENV !== 'test') {
    return json(res, { error: 'OAuth provider service is unavailable: Security keys are not configured' }, 503);
  }

  // Check credentials
  let clientId, clientSecret, redirectUri, authUrlBase, scopes;
  if (provider === 'twitch') {
    clientId = config.TWITCH_CLIENT_ID;
    clientSecret = config.TWITCH_CLIENT_SECRET;
    redirectUri = config.TWITCH_REDIRECT_URI;
    authUrlBase = 'https://id.twitch.tv/oauth2/authorize';
    scopes = 'channel:read:stream_key';
  } else if (provider === 'youtube') {
    clientId = config.YOUTUBE_CLIENT_ID;
    clientSecret = config.YOUTUBE_CLIENT_SECRET;
    redirectUri = config.YOUTUBE_REDIRECT_URI;
    authUrlBase = 'https://accounts.google.com/o/oauth2/v2/auth';
    scopes = 'https://www.googleapis.com/auth/youtube.readonly';
  } else if (provider === 'facebook') {
    clientId = config.FACEBOOK_CLIENT_ID;
    clientSecret = config.FACEBOOK_CLIENT_SECRET;
    redirectUri = config.FACEBOOK_REDIRECT_URI;
    authUrlBase = `https://www.facebook.com/${config.FACEBOOK_API_VERSION}/dialog/oauth`;
    scopes = 'pages_manage_posts,publish_video';
  }

  // If a provider credential is absent, fail 503 honestly
  if (!clientId || !clientSecret || !redirectUri) {
    return json(res, { error: `Provider ${provider} is not configured on this server. Missing credentials.` }, 503);
  }

  const { verifier, challenge } = cryptoUtils.generatePKCE();
  const state = cryptoUtils.generateRandomToken(20);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.run(
    'INSERT OR REPLACE INTO oauth_states (state, workspace_id, provider, pkce_verifier, expires_at) VALUES (?, ?, ?, ?, ?)',
    [state, req.workspaceId, provider, verifier, expiresAt]
  );

  let authorizationUrl = `${authUrlBase}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}&scope=${encodeURIComponent(scopes)}`;
  if (provider === 'twitch' || provider === 'youtube') {
    authorizationUrl += `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
  }

  return json(res, { success: true, authorizationUrl });
}, ['owner', 'operator'], true);

// 20. Public Providers: OAuth Callback Scaffolding (Usable Twitch, scaffolded others)
addRoute('GET', '/api/providers/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');

  const isDefaultSecret = (config.ENCRYPTION_SECRET === 'default-super-secret-emberstage-encryption-key-for-mvp-setup' || !process.env.ENCRYPTION_SECRET);
  if (isDefaultSecret && process.env.NODE_ENV !== 'test') {
    return html(res, '<h1>Error</h1><p>OAuth provider service is unavailable due to configuration issues</p>', 503);
  }

  if (!code || !state) {
    return html(res, '<h1>OAuth Error</h1><p>Missing code or state parameters</p>', 400);
  }

  const oauthState = db.queryOne('SELECT * FROM oauth_states WHERE state = ?', [state]);
  if (!oauthState) {
    return html(res, '<h1>OAuth Error</h1><p>Invalid or expired state verification token</p>', 400);
  }

  if (oauthState.provider !== provider) {
    return html(res, '<h1>OAuth Error</h1><p>Provider state mismatch</p>', 400);
  }

  if (new Date(oauthState.expires_at) < new Date()) {
    db.run('DELETE FROM oauth_states WHERE state = ?', [state]);
    return html(res, '<h1>OAuth Error</h1><p>OAuth session has expired. Please try connecting again.</p>', 400);
  }

  if (!['twitch', 'youtube', 'facebook'].includes(provider)) {
    return html(res, '<h1>Unsupported callback provider</h1>', 400);
  }

  try {
    let body = null;
    try {
      body = await providerOAuthClient.exchangeCode(provider, code, oauthState.pkce_verifier);
    } catch (exchangeErr) {
      const sanitizedMsg = escapeHtml(exchangeErr.message || 'Token exchange failed');
      return html(res, `<h1>${provider.charAt(0).toUpperCase() + provider.slice(1)} OAuth Error</h1><p>${sanitizedMsg}</p>`, 400);
    }

    let fetchedTargets = [];
    try {
      fetchedTargets = await providerOAuthClient.fetchTargets(provider, body.access_token);
    } catch (fetchErr) {
      // Fallback target if fetching fails (e.g. offline/mock tests)
      fetchedTargets = [{ id: `${provider}_target_default`, name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Target` }];
    }

    // Encrypt sensitive tokens server-side using ENCRYPTION_SECRET
    const encrypted = cryptoUtils.encrypt(JSON.stringify(body), config.ENCRYPTION_SECRET);
    const connectionId = 'pc_' + cryptoUtils.generateRandomToken(12);

    db.transaction(() => {
      // Verify state still exists inside transaction to guarantee atomicity
      const stateExists = db.queryOne('SELECT 1 FROM oauth_states WHERE state = ?', [state]);
      if (!stateExists) {
        throw new Error('OAuth state already consumed');
      }

      // Consume OAuth state immediately
      db.run('DELETE FROM oauth_states WHERE state = ?', [state]);

      // Remove existing connection for this workspace/provider combo first (cascading deletes targets)
      db.run('DELETE FROM provider_connections WHERE workspace_id = ? AND provider = ?', [oauthState.workspace_id, provider]);

      db.run(
        `INSERT INTO provider_connections (id, workspace_id, provider, encrypted_tokens, status, updated_at)
         VALUES (?, ?, ?, ?, 'connected', ?)`,
        [connectionId, oauthState.workspace_id, provider, encrypted, new Date().toISOString()]
      );

      // Persist the targets retrieved
      for (const target of fetchedTargets) {
        db.run(
          `INSERT OR REPLACE INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          ['pt_' + cryptoUtils.generateRandomToken(12), oauthState.workspace_id, connectionId, provider, String(target.id), target.name, new Date().toISOString()]
        );
      }

      db.logAudit({
        workspaceId: oauthState.workspace_id,
        action: 'provider.connected',
        details: { provider }
      });
    });

    return html(res, `
      <!DOCTYPE html>
      <html>
      <head><title>Emberstage Connection Successful</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #fafafa;">
        <h1 style="color: #4f46e5;">Emberstage</h1>
        <h2>${provider.charAt(0).toUpperCase() + provider.slice(1)} Linked Successfully!</h2>
        <p>Your streaming connection has been registered. You can close this window now.</p>
      </body>
      </html>
    `);
  } catch (err) {
    return html(res, `<h1>Server Error</h1><p>Failed to process ${provider} OAuth callback transaction</p>`, 500);
  }
}, null, false);

// 21. Workspace Providers: Disconnect Provider
addRoute('POST', '/api/workspaces/:workspaceId/providers/:provider/disconnect', (req, res) => {
  const provider = req.params.provider;

  const references = db.queryAll(`
    SELECT d.*, s.status AS session_status, p.provider AS target_provider
    FROM stream_session_destinations d JOIN stream_sessions s ON s.id = d.stream_session_id
    LEFT JOIN provider_targets p ON p.id = d.target_id AND p.workspace_id = s.workspace_id
    WHERE s.workspace_id = ? AND d.target_type = 'provider'
  `, [req.workspaceId]);
  for (const destination of references) {
    let snapshot;
    try { snapshot = JSON.parse(destination.broadcast_snapshot || 'null'); }
    catch {
      if (provider === 'facebook' && destination.status === 'failed') return json(res, { error: 'Facebook cleanup snapshot requires recovery before disconnect' }, 409);
    }
    if (snapshot?.provider !== provider && destination.target_provider !== provider) continue;
    const active = ['reserved', 'streaming'].includes(destination.session_status);
    const cleanupPending = provider === 'facebook' && snapshot?.id && snapshot.cleanupState !== 'ended' && destination.status !== 'stopped';
    if (active || cleanupPending) return json(res, { error: 'Cannot disconnect a provider with active streams or pending Facebook cleanup; stop and retry cleanup first' }, 409);
  }

  const deleted = db.run('DELETE FROM provider_connections WHERE workspace_id = ? AND provider = ?', [
    req.workspaceId,
    provider
  ]);

  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    action: 'provider.disconnected',
    details: { provider }
  });

  return json(res, { success: true });
}, ['owner', 'operator'], true);

// 21b. Workspace Providers: Target List, Select and Deselect (Web Only)
addRoute('GET', '/api/workspaces/:workspaceId/providers/targets', (req, res) => {
  const targets = db.queryAll('SELECT id, workspace_id, provider, external_id, name, selected, created_at FROM provider_targets WHERE workspace_id = ?', [req.workspaceId]);
  return json(res, targets);
}, ['owner', 'operator'], true, 'web');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/select', (req, res) => {
  const targetId = req.params.targetId;
  const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
  if (!target) {
    return json(res, { error: 'Target not found or tenant mismatch' }, 404);
  }
  db.run('UPDATE provider_targets SET selected = 1 WHERE id = ?', [targetId]);
  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    action: 'provider.target.selected',
    details: { targetId, provider: target.provider }
  });
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'web');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/deselect', (req, res) => {
  const targetId = req.params.targetId;
  const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
  if (!target) {
    return json(res, { error: 'Target not found or tenant mismatch' }, 404);
  }

  // Reject settings/binding/deselect/disconnect conflicts while target in active/reserved session
  const activeDest = db.queryOne(`
    SELECT ssd.id FROM stream_session_destinations ssd
    INNER JOIN stream_sessions ss ON ssd.stream_session_id = ss.id
    WHERE ssd.target_id = ? AND ss.status IN ('reserved', 'streaming')
  `, [targetId]);
  if (activeDest) {
    return json(res, { error: 'Conflict: Destination is currently in an active or reserved streaming session.' }, 409);
  }

  db.run('UPDATE provider_targets SET selected = 0 WHERE id = ?', [targetId]);
  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    action: 'provider.target.deselected',
    details: { targetId, provider: target.provider }
  });
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'web');

async function enrichDestinations(workspaceId, streamId, destinations) {
  for (const d of destinations) {
    let name = '';
    let provider = '';
    if (d.target_type === 'custom') {
      const tgt = db.queryOne('SELECT name FROM custom_rtmp_targets WHERE id = ?', [d.target_id]);
      name = tgt?.name || '';
      provider = 'Custom RTMP';
    } else {
      const tgt = db.queryOne('SELECT name, provider FROM provider_targets WHERE id = ? AND workspace_id = ?', [d.target_id, workspaceId]);
      name = tgt?.name || '';
      provider = tgt?.provider || '';
    }
    d.name = name;
    d.provider = provider;

    let broadcast = null;
    if (d.broadcast_snapshot) {
      try {
        broadcast = JSON.parse(d.broadcast_snapshot);
      } catch (e) {}
    }
    d.broadcast = broadcast;
    if (broadcast?.provider === 'facebook') {
      provider = 'facebook';
      d.provider = provider;
      // Only public, non-secret fields are returned; never echo an arbitrary snapshot.
      d.broadcast = { id: broadcast.id, provider, pageId: broadcast.pageId, status: 'unknown' };
      delete d.broadcast_snapshot;
    }

    let relayState = 'unknown';
    let lastProgressAt = null;
    let bytesWritten = 0;
    try {
      const status = workerManager.getDeliveryStatus(streamId, d.target_id);
      if (status) {
        relayState = status.relayState || 'unknown';
        lastProgressAt = status.lastProgressAt || null;
        bytesWritten = status.bytesWritten || 0;
      }
    } catch (e) {}

    let streamStatus = 'unknown';
    let broadcastStatus = 'unknown';
    let healthStatus = 'unknown';
    let checkedAt = new Date().toISOString();

    if (provider === 'youtube' && broadcast?.id) {
      try {
        const bRes = await nangoClient.youtubeApiRequest(
          workspaceId,
          `/liveBroadcasts?part=id,status,contentDetails&id=${encodeURIComponent(broadcast.id)}`
        );
        const ytBroadcast = bRes.items?.[0];
        if (ytBroadcast) {
          broadcastStatus = ytBroadcast.status?.lifeCycleStatus || 'unknown';
          const boundStreamId = ytBroadcast.contentDetails?.boundStreamId;
          if (boundStreamId) {
            const sRes = await nangoClient.youtubeApiRequest(
              workspaceId,
              `/liveStreams?part=id,status&id=${encodeURIComponent(boundStreamId)}`
            );
            const ytStream = sRes.items?.[0];
            if (ytStream) {
              streamStatus = ytStream.status?.streamStatus || 'unknown';
              healthStatus = ytStream.status?.healthStatus?.status || 'unknown';
            }
          }
        }
      } catch (e) {
        // Safe fallback
      }
    }

    if (provider === 'facebook' && broadcast?.id) {
      try {
        const stored = db.queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [streamId, d.target_id]);
        const snapshot = readFacebookSnapshot({ id: streamId, workspace_id: workspaceId }, stored);
        if (snapshot) {
          const fbStatus = await nangoClient.getFacebookLiveVideoStatus(workspaceId, snapshot.pageId, snapshot.id, snapshot.connectionId);
          broadcastStatus = fbStatus.status || 'unknown';
          d.broadcast = {
            ...d.broadcast,
            permalink_url: fbStatus.permalink_url,
            status: broadcastStatus
          };
        }
      } catch (e) {
        // Safe fallback
      }
    }

    d.delivery = {
      relayState,
      lastProgressAt,
      bytesWritten,
      streamStatus,
      broadcastStatus,
      healthStatus,
      checkedAt
    };
    if (provider === 'facebook') {
      d.delivery.broadcastState = broadcastStatus;
      d.delivery.receiving = 'unknown';
      d.cleanupPending = broadcast?.cleanupState !== 'ended' && d.status === 'failed';
    }

    // Override stored status based on active delivery
    let computedStatus = d.status;
    if (computedStatus === 'pending' || computedStatus === 'active') {
      if (relayState === 'relaying') {
        computedStatus = 'active';
      } else if (relayState === 'failed') {
        computedStatus = 'failed';
      } else if (relayState === 'stopped') {
        computedStatus = 'stopped';
      } else if (relayState === 'starting') {
        computedStatus = 'pending';
      }
    }
    d.status = computedStatus;
  }
}

function facebookCleanupPending(workspaceId, pageId) {
  return db.queryAll(`SELECT d.broadcast_snapshot FROM stream_session_destinations d
    JOIN stream_sessions s ON s.id = d.stream_session_id
    WHERE s.workspace_id = ? AND d.status = 'failed' AND d.broadcast_snapshot IS NOT NULL`, [workspaceId]).some(d => {
    try {
      const snapshot = JSON.parse(d.broadcast_snapshot);
      return snapshot?.provider === 'facebook' && snapshot.cleanupState !== 'ended' && (!pageId || !snapshot.pageId || snapshot.pageId === pageId);
    } catch { return true; }
  });
}

addRoute('GET', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
  if (!target) {
    return json(res, { error: 'Target not found' }, 404);
  }
  if (target.provider !== 'youtube') {
    return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
  }

  try {
    const broadcasts = await nangoClient.getYoutubeBroadcasts(workspaceId, target.external_id);
    return json(res, {
      success: true,
      broadcasts,
      selectedBroadcastId: target.selected_broadcast_id
    });
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  return runWithMutationGuard(workspaceId, res, async () => {
    const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
    if (!target) {
      return json(res, { error: 'Target not found or tenant mismatch' }, 404);
    }
    if (target.provider !== 'youtube') {
      return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
    }

    // Reject settings/binding/deselect/disconnect conflicts while target in active/reserved session
    const activeDest = db.queryOne(`
      SELECT ssd.id FROM stream_session_destinations ssd
      INNER JOIN stream_sessions ss ON ssd.stream_session_id = ss.id
      WHERE ssd.target_id = ? AND ss.status IN ('reserved', 'streaming')
    `, [targetId]);
    if (activeDest) {
      return json(res, { error: 'Conflict: Destination is currently in an active or reserved streaming session.' }, 409);
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, { error: 'Invalid JSON body' }, 400);
    }

    try {
      const boundBroadcast = await nangoClient.createYoutubeBroadcast(workspaceId, target.external_id, {
        title: body.title,
        description: body.description,
        privacyStatus: body.privacyStatus || 'private',
        scheduledStartTime: body.scheduledStartTime,
        latencyPreference: body.latencyPreference || 'normal',
        categoryId: body.categoryId
      });

      const mapped = {
        id: boundBroadcast.id,
        title: boundBroadcast.snippet?.title || '',
        description: boundBroadcast.snippet?.description || '',
        privacyStatus: boundBroadcast.status?.privacyStatus || 'private',
        lifeCycleStatus: boundBroadcast.status?.lifeCycleStatus || 'ready',
        boundStreamId: boundBroadcast.contentDetails?.boundStreamId || null,
        scheduledStartTime: boundBroadcast.snippet?.scheduledStartTime || null,
        latencyPreference: boundBroadcast.contentDetails?.latencyPreference || 'normal',
        categoryId: boundBroadcast.snippet?.categoryId || null,
        thumbnailUrl: null
      };

      // Update target locally
      db.run(
        'UPDATE provider_targets SET selected_broadcast_id = ?, broadcast_snapshot = ? WHERE id = ?',
        [mapped.id, JSON.stringify(mapped), targetId]
      );

      db.logAudit({
        workspaceId,
        userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
        action: 'youtube.broadcast.created',
        details: { targetId, broadcastId: mapped.id }
      });

      return json(res, { success: true, broadcast: mapped });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts/select', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  return runWithMutationGuard(workspaceId, res, async () => {
    const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
    if (!target) {
      return json(res, { error: 'Target not found or tenant mismatch' }, 404);
    }
    if (target.provider !== 'youtube') {
      return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
    }

    // Reject settings/binding/deselect/disconnect conflicts while target in active/reserved session
    const activeDest = db.queryOne(`
      SELECT ssd.id FROM stream_session_destinations ssd
      INNER JOIN stream_sessions ss ON ssd.stream_session_id = ss.id
      WHERE ssd.target_id = ? AND ss.status IN ('reserved', 'streaming')
    `, [targetId]);
    if (activeDest) {
      return json(res, { error: 'Conflict: Destination is currently in an active or reserved streaming session.' }, 409);
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, { error: 'Invalid JSON body' }, 400);
    }

    const { broadcastId } = body;
    if (!broadcastId) {
      return json(res, { error: 'broadcastId is required' }, 400);
    }

    try {
      const broadcasts = await nangoClient.getYoutubeBroadcasts(workspaceId, target.external_id);
      const matched = broadcasts.find(b => b.id === broadcastId);
      if (!matched) {
        return json(res, { error: 'Broadcast not found on YouTube channel' }, 404);
      }

      if (matched.lifeCycleStatus === 'complete' || matched.lifeCycleStatus === 'completed') {
        return json(res, { error: 'The selected YouTube broadcast has already been completed and cannot be reused' }, 400);
      }

      const boundStreamId = matched.boundStreamId || matched.contentDetails?.boundStreamId;
      if (!boundStreamId) {
        return json(res, { error: 'Broadcast selection rejected: The selected broadcast does not have a bound liveStream. Streaming is unsupported for unbound broadcasts.' }, 400);
      }

      db.run(
        'UPDATE provider_targets SET selected_broadcast_id = ?, broadcast_snapshot = ? WHERE id = ?',
        [broadcastId, JSON.stringify(matched), targetId]
      );

      db.logAudit({
        workspaceId,
        userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
        action: 'youtube.broadcast.selected',
        details: { targetId, broadcastId }
      });

      return json(res, { success: true, broadcast: matched });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts/update', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  return runWithMutationGuard(workspaceId, res, async () => {
    const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
    if (!target) {
      return json(res, { error: 'Target not found or tenant mismatch' }, 404);
    }
    if (target.provider !== 'youtube') {
      return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
    }
    if (!target.selected_broadcast_id) {
      return json(res, { error: 'No broadcast has been selected' }, 400);
    }

    // Reject settings/binding/deselect/disconnect conflicts while target in active/reserved session
    const activeDest = db.queryOne(`
      SELECT ssd.id FROM stream_session_destinations ssd
      INNER JOIN stream_sessions ss ON ssd.stream_session_id = ss.id
      WHERE ssd.target_id = ? AND ss.status IN ('reserved', 'streaming')
    `, [targetId]);
    if (activeDest) {
      return json(res, { error: 'Conflict: Destination is currently in an active or reserved streaming session.' }, 409);
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, { error: 'Invalid JSON body' }, 400);
    }

    try {
      const updated = await nangoClient.updateYoutubeBroadcast(workspaceId, target.external_id, target.selected_broadcast_id, {
        title: body.title,
        description: body.description,
        privacyStatus: body.privacyStatus,
        latencyPreference: body.latencyPreference,
        categoryId: body.categoryId
      });

      const mapped = {
        id: updated.id,
        title: updated.snippet?.title || '',
        description: updated.snippet?.description || '',
        privacyStatus: updated.status?.privacyStatus || 'private',
        lifeCycleStatus: updated.status?.lifeCycleStatus || 'ready',
        boundStreamId: updated.contentDetails?.boundStreamId || null,
        scheduledStartTime: updated.snippet?.scheduledStartTime || null,
        latencyPreference: updated.contentDetails?.latencyPreference || 'normal',
        categoryId: updated.snippet?.categoryId || null,
        thumbnailUrl: updated.snippet?.thumbnails?.default?.url || updated.snippet?.thumbnails?.medium?.url || null
      };

      db.run(
        'UPDATE provider_targets SET broadcast_snapshot = ? WHERE id = ?',
        [JSON.stringify(mapped), targetId]
      );

      db.logAudit({
        workspaceId,
        userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
        action: 'youtube.broadcast.updated',
        details: { targetId, broadcastId: target.selected_broadcast_id }
      });

      return json(res, { success: true, broadcast: mapped });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts/thumbnail', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  return runWithMutationGuard(workspaceId, res, async () => {
    const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
    if (!target) {
      return json(res, { error: 'Target not found or tenant mismatch' }, 404);
    }
    if (target.provider !== 'youtube') {
      return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
    }
    if (!target.selected_broadcast_id) {
      return json(res, { error: 'No broadcast has been selected' }, 400);
    }

    // Reject settings/binding/deselect/disconnect conflicts while target in active/reserved session
    const activeDest = db.queryOne(`
      SELECT ssd.id FROM stream_session_destinations ssd
      INNER JOIN stream_sessions ss ON ssd.stream_session_id = ss.id
      WHERE ssd.target_id = ? AND ss.status IN ('reserved', 'streaming')
    `, [targetId]);
    if (activeDest) {
      return json(res, { error: 'Conflict: Destination is currently in an active or reserved streaming session.' }, 409);
    }

    let body;
    try {
      body = await readJson(req, 4 * 1024 * 1024);
    } catch (err) {
      if (err.message === 'Payload Too Large') {
        return json(res, { error: 'Payload Too Large' }, 400);
      }
      return json(res, { error: 'Invalid JSON body' }, 400);
    }

    const { contentType, dataBase64 } = body;
    if (!dataBase64) {
      return json(res, { error: 'dataBase64 is required' }, 400);
    }

    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      if (buffer.length > 2 * 1024 * 1024) {
        return json(res, { error: 'Thumbnail exceeds 2MB size limit' }, 400);
      }

      await nangoClient.uploadYoutubeThumbnail(workspaceId, target.external_id, target.selected_broadcast_id, contentType, dataBase64);

      try {
        const getRes = await nangoClient.youtubeApiRequest(workspaceId, `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(target.selected_broadcast_id)}`);
        const updated = getRes.items?.[0];
        if (updated) {
          const mapped = {
            id: updated.id,
            title: updated.snippet?.title || '',
            description: updated.snippet?.description || '',
            privacyStatus: updated.status?.privacyStatus || 'private',
            lifeCycleStatus: updated.status?.lifeCycleStatus || 'ready',
            boundStreamId: updated.contentDetails?.boundStreamId || null,
            scheduledStartTime: updated.snippet?.scheduledStartTime || null,
            latencyPreference: updated.contentDetails?.latencyPreference || 'normal',
            categoryId: updated.snippet?.categoryId || null,
            thumbnailUrl: updated.snippet?.thumbnails?.default?.url || updated.snippet?.thumbnails?.medium?.url || null
          };
          db.run('UPDATE provider_targets SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify(mapped), targetId]);
        }
      } catch (e) {}

      db.logAudit({
        workspaceId,
        userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
        action: 'youtube.broadcast.thumbnail_uploaded',
        details: { targetId, broadcastId: target.selected_broadcast_id }
      });

      return json(res, { success: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/providers/targets/:targetId/broadcasts/transition', async (req, res) => {
  const { workspaceId, targetId } = req.params;
  const target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, workspaceId]);
  if (!target) {
    return json(res, { error: 'Target not found or tenant mismatch' }, 404);
  }
  if (target.provider !== 'youtube') {
    return json(res, { error: 'Broadcasts are only supported for YouTube destinations' }, 400);
  }
  if (!target.selected_broadcast_id) {
    return json(res, { error: 'No broadcast has been selected' }, 400);
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, { error: 'Invalid JSON body' }, 400);
  }

  const { status } = body;
  if (status !== 'live' && status !== 'complete') {
    return json(res, { error: 'Status must be live or complete' }, 400);
  }

  try {
    const updated = await nangoClient.transitionYoutubeBroadcast(workspaceId, target.external_id, target.selected_broadcast_id, status);

    const mapped = {
      id: updated.id,
      title: updated.snippet?.title || '',
      description: updated.snippet?.description || '',
      privacyStatus: updated.status?.privacyStatus || 'private',
      lifeCycleStatus: updated.status?.lifeCycleStatus || 'ready',
      boundStreamId: updated.contentDetails?.boundStreamId || null,
      scheduledStartTime: updated.snippet?.scheduledStartTime || null,
      latencyPreference: updated.contentDetails?.latencyPreference || 'normal',
      categoryId: updated.snippet?.categoryId || null,
      thumbnailUrl: updated.snippet?.thumbnails?.default?.url || updated.snippet?.thumbnails?.medium?.url || null
    };

    db.run(
      'UPDATE provider_targets SET broadcast_snapshot = ? WHERE id = ?',
      [JSON.stringify(mapped), targetId]
    );

    db.logAudit({
      workspaceId,
      userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
      action: 'youtube.broadcast.transitioned',
      details: { targetId, broadcastId: target.selected_broadcast_id, status }
    });

    return json(res, { success: true });
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}, ['owner', 'operator'], true, 'both');

addRoute('GET', '/api/workspaces/:workspaceId/streams/setup', async (req, res) => {
  const { workspaceId } = req.params;
  const ingestServer = config.RTMP_INGEST_BASE_URL;

  const devices = db.queryAll(`
    SELECT id, workspace_id, name, status, linked_at, ingest_key_last4, ingest_key_rotated_at, created_at
    FROM devices WHERE workspace_id = ? ORDER BY created_at DESC
  `, [workspaceId]);

  for (const device of devices) {
    const latestSession = db.queryOne(`
      SELECT id, status, started_at, stopped_at FROM stream_sessions
      WHERE device_id = ? ORDER BY created_at DESC LIMIT 1
    `, [device.id]);
    device.latestSession = latestSession || null;
  }

  const activeSession = db.queryOne(`
    SELECT id, workspace_id, device_id, status, started_at, stopped_at, created_at
    FROM stream_sessions WHERE workspace_id = ? AND status IN ('reserved', 'streaming')
    ORDER BY created_at DESC LIMIT 1
  `, [workspaceId]);

  // Historical failures belong to latestSession, not the current delivery map.
  const sessionForDelivery = activeSession;

  const customs = db.queryAll(
    'SELECT id, name, selected, created_at FROM custom_rtmp_targets WHERE workspace_id = ? ORDER BY created_at ASC',
    [workspaceId]
  );
  const providerTargets = db.queryAll(
    'SELECT id, provider, name, selected, selected_broadcast_id, broadcast_snapshot, created_at FROM provider_targets WHERE workspace_id = ? ORDER BY created_at ASC',
    [workspaceId]
  );

  const destinations = [];

  for (const target of customs) {
    let delivery = null;
    if (sessionForDelivery) {
      const ssd = db.queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [sessionForDelivery.id, target.id]);
      if (ssd) {
        let relayState = 'unknown';
        let lastProgressAt = null;
        let bytesWritten = 0;
        try {
          const status = ssd ? workerManager.getDeliveryStatus(sessionForDelivery.id, target.id) : null;
          if (status) {
            relayState = status.relayState || 'unknown';
            lastProgressAt = status.lastProgressAt || null;
            bytesWritten = status.bytesWritten || 0;
          } else if (ssd) {
            if (ssd.status === 'failed') {
              relayState = 'failed';
            } else if (ssd.status === 'stopped') {
              relayState = 'stopped';
            } else if (ssd.status === 'pending') {
              relayState = 'starting';
            }
          }
        } catch (e) {}

        delivery = {
          relayState,
          lastProgressAt,
          bytesWritten,
          streamStatus: 'unknown',
          broadcastStatus: 'unknown',
          healthStatus: 'unknown',
          checkedAt: new Date().toISOString()
        };
      }
    }

    destinations.push({
      id: target.id,
      name: target.name,
      type: 'custom',
      provider: 'Custom RTMP',
      selected: !!target.selected,
      connected: true,
      ready: true,
      status: 'ready',
      detail: 'Ready to relay through Emberstage.',
      broadcast: null,
      delivery
    });
  }

  for (const target of providerTargets) {
    const connection = db.queryOne(
      'SELECT status FROM provider_connections WHERE workspace_id = ? AND provider = ?',
      [workspaceId, target.provider]
    );
    const providerConnected = connection && connection.status === 'connected';

    let ready = ['twitch', 'youtube', 'facebook'].includes(target.provider) && nangoClient.isConfigured() && providerConnected;
    let status = ready ? 'ready' : 'setup-required';
    let detail = '';

    let broadcast = null;
    if (target.provider === 'youtube') {
      let snapshotStr = null;
      if (activeSession) {
        const ssd = db.queryOne('SELECT broadcast_snapshot FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [activeSession.id, target.id]);
        snapshotStr = ssd?.broadcast_snapshot;
      }
      if (!snapshotStr) {
        snapshotStr = target.broadcast_snapshot;
      }
      if (snapshotStr) {
        try {
          broadcast = JSON.parse(snapshotStr);
        } catch (e) {}
      }

      if (!providerConnected) {
        ready = false;
        status = 'setup-required';
        detail = `${target.provider.charAt(0).toUpperCase() + target.provider.slice(1)} provider is disconnected. Please connect first.`;
      } else if (!target.selected_broadcast_id || !broadcast) {
        ready = false;
        status = 'setup-required';
        detail = 'YouTube broadcast selection or creation is required.';
      } else if (broadcast.lifeCycleStatus === 'complete' || broadcast.lifeCycleStatus === 'completed') {
        ready = false;
        status = 'setup-required';
        detail = 'Selected YouTube broadcast has already completed. Please select/create a new broadcast.';
      }
    } else {
      if (!providerConnected) {
        ready = false;
        status = 'setup-required';
        detail = `${target.provider.charAt(0).toUpperCase() + target.provider.slice(1)} provider is disconnected. Please connect first.`;
      }
    }

    if (ready) {
      detail = 'Ready for relay preflight through Emberstage.';
    }

    let delivery = null;
    if (sessionForDelivery || (target.provider === 'youtube' && broadcast)) {
      const ssd = sessionForDelivery ? db.queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [sessionForDelivery.id, target.id]) : null;
      if (ssd || (target.provider === 'youtube' && broadcast)) {
        let relayState = sessionForDelivery ? 'unknown' : 'stopped';
        let lastProgressAt = null;
        let bytesWritten = 0;
        try {
          const status = ssd ? workerManager.getDeliveryStatus(sessionForDelivery.id, target.id) : null;
          if (status) {
            relayState = status.relayState || 'unknown';
            lastProgressAt = status.lastProgressAt || null;
            bytesWritten = status.bytesWritten || 0;
          } else if (ssd) {
            if (ssd.status === 'failed') {
              relayState = 'failed';
            } else if (ssd.status === 'stopped') {
              relayState = 'stopped';
            } else if (ssd.status === 'pending') {
              relayState = 'starting';
            }
          }
        } catch (e) {}

        let streamStatus = 'unknown';
        let broadcastStatus = 'unknown';
        let healthStatus = 'unknown';
        let checkedAt = new Date().toISOString();

        // Active sessions use their snapshot; idle views inspect the next selection.
        const deliveryBroadcastId = broadcast?.id;
        if (target.provider === 'youtube' && deliveryBroadcastId) {
          try {
            const bRes = await nangoClient.youtubeApiRequest(
              workspaceId,
              `/liveBroadcasts?part=id,status,contentDetails&id=${encodeURIComponent(deliveryBroadcastId)}`
            );
            const ytBroadcast = bRes.items?.[0];
            if (ytBroadcast) {
              broadcastStatus = ytBroadcast.status?.lifeCycleStatus || 'unknown';
              const boundStreamId = ytBroadcast.contentDetails?.boundStreamId;
              if (boundStreamId) {
                const sRes = await nangoClient.youtubeApiRequest(
                  workspaceId,
                  `/liveStreams?part=id,status&id=${encodeURIComponent(boundStreamId)}`
                );
                const ytStream = sRes.items?.[0];
                if (ytStream) {
                  streamStatus = ytStream.status?.streamStatus || 'unknown';
                  healthStatus = ytStream.status?.healthStatus?.status || 'unknown';
                }
              }
            }
          } catch (e) {}
        }

        delivery = {
          relayState,
          lastProgressAt,
          bytesWritten,
          streamStatus,
          broadcastStatus,
          healthStatus,
          checkedAt
        };
      }
    }

    let cleanupPending = false;
    if (target.provider === 'facebook') {
      const stored = sessionForDelivery
        ? db.queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [sessionForDelivery.id, target.id])
        : db.queryOne(`SELECT d.* FROM stream_session_destinations d JOIN stream_sessions s ON s.id = d.stream_session_id
          WHERE s.workspace_id = ? AND d.target_id = ? AND d.status = 'failed' AND d.broadcast_snapshot IS NOT NULL
          ORDER BY s.created_at DESC LIMIT 1`, [workspaceId, target.id]);
      if (stored) {
        await enrichDestinations(workspaceId, stored.stream_session_id, [stored]);
        delivery = stored.delivery;
        broadcast = stored.broadcast;
        cleanupPending = Boolean(stored.cleanupPending);
        if (cleanupPending) { ready = false; status = 'cleanup-pending'; detail = 'Retry stop to end the previous Facebook live video.'; }
      }
    }
    destinations.push({
      id: target.id,
      name: target.name,
      type: 'provider',
      provider: target.provider,
      selected: !!target.selected,
      connected: !!providerConnected,
      ready,
      status,
      detail,
      broadcast,
      delivery,
      ...(target.provider === 'facebook' ? { cleanupPending, goLiveWarning: 'Starting OBS streaming creates a public Page live broadcast. Each new session creates a new broadcast.' } : {})
    });
  }

  return json(res, {
    success: true,
    ingestServer,
    devices,
    stream: activeSession || null,
    destinations
  });
}, ['owner', 'operator'], true, 'both');

function reapExpiredStreamReservations(workspaceId) {
  const now = new Date().toISOString();
  const canStream = getWorkspaceEntitlement(workspaceId).canStream;
  const expired = db.queryAll(
    "SELECT id FROM stream_sessions WHERE workspace_id = ? AND status = 'reserved' AND (expires_at IS NULL OR expires_at <= ? OR (? = 0 AND started_at IS NULL))",
    [workspaceId, now, Number(canStream)]
  );
  if (expired.length === 0) return;
  db.transaction(() => {
    for (const { id } of expired) {
      db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'reserved'", [now, id]);
      db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'preflight'", [now, id]);
      db.run("UPDATE stream_session_destinations SET status = 'stopped' WHERE stream_session_id = ? AND status = 'pending'", [id]);
    }
  });
}

// 22. Workspace Streams: Preflight Check
addRoute('POST', '/api/workspaces/:workspaceId/streams/preflight', async (req, res) => {
  try {
    const bodyText = await readBody(req);
    const { destinations } = JSON.parse(bodyText || '{"destinations":[]}');

    const workspace = db.queryOne('SELECT * FROM workspaces WHERE id = ?', [req.workspaceId]);
    
    const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
    if (!entitlement.canStream) {
      return json(res, { error: 'Payment Required: An active or trialing subscription is required for streaming.' }, 402);
    }

    if (!Array.isArray(destinations)) {
      return json(res, { eligible: false, error: 'Invalid destinations format. Must be an array.' }, 400);
    }

    const uniqueDestinations = Array.from(new Set(destinations));
    if (uniqueDestinations.length !== destinations.length) {
      return json(res, { eligible: false, error: 'Duplicate destination IDs are not allowed.' }, 400);
    }

    for (const targetId of destinations) {
      const providerTarget = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
      if (providerTarget) {
        const conn = db.queryOne('SELECT status FROM provider_connections WHERE workspace_id = ? AND provider = ?', [req.workspaceId, providerTarget.provider]);
        if (!conn || conn.status !== 'connected') {
          return json(res, { eligible: false, error: `Admission rejected: Selected destination provider ${providerTarget.provider} is disconnected. Please connect first.` }, 400);
        }
        if (!['twitch', 'youtube', 'facebook'].includes(providerTarget.provider) || !nangoClient.isConfigured()) {
          return json(res, { eligible: false, error: `${providerTarget.provider} relay setup is not available yet. Use a Custom RTMP destination.` }, 400);
        }
        if (providerTarget.provider === 'facebook' && facebookCleanupPending(req.workspaceId, providerTarget.external_id)) {
          return json(res, { error: 'Facebook live cleanup pending; retry stop before starting another broadcast' }, 409);
        }
        if (!providerTarget.selected) {
          return json(res, { eligible: false, error: `Invalid destination: Target ${targetId} is not selected` }, 400);
        }
        if (providerTarget.provider === 'youtube') {
          if (!providerTarget.selected_broadcast_id || !providerTarget.broadcast_snapshot) {
            return json(res, { eligible: false, error: 'Admission rejected: Selected YouTube destination has no broadcast selected/created.' }, 400);
          }
          let bSnap = null;
          try {
            bSnap = JSON.parse(providerTarget.broadcast_snapshot);
          } catch (e) {}
          if (!bSnap || bSnap.lifeCycleStatus === 'complete' || bSnap.lifeCycleStatus === 'completed') {
            return json(res, { eligible: false, error: 'Admission rejected: Selected YouTube broadcast is completed. Please select or create a new active broadcast.' }, 400);
          }
        }
        // Prevent two devices reserving same target concurrently
        const activeSessionWithTarget = db.queryOne(`
          SELECT s.id FROM stream_sessions s
          JOIN stream_session_destinations sd ON s.id = sd.stream_session_id
          WHERE s.workspace_id = ? AND sd.target_id = ? AND s.status IN ('reserved', 'streaming')
        `, [req.workspaceId, targetId]);
        if (activeSessionWithTarget) {
          return json(res, { eligible: false, error: 'Conflict: Target is already being reserved or streamed to by another device in this workspace.' }, 409);
        }
        continue;
      }
      const target = db.queryOne('SELECT * FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
      if (!target) {
        return json(res, { eligible: false, error: `Invalid destination: Target ${targetId} not found or tenant mismatch` }, 400);
      }
      if (!target.selected) {
        return json(res, { eligible: false, error: `Invalid destination: Target ${targetId} is not selected` }, 400);
      }
      // Prevent two devices reserving same target concurrently
      const activeSessionWithTarget = db.queryOne(`
        SELECT s.id FROM stream_sessions s
        JOIN stream_session_destinations sd ON s.id = sd.stream_session_id
        WHERE s.workspace_id = ? AND sd.target_id = ? AND s.status IN ('reserved', 'streaming')
      `, [req.workspaceId, targetId]);
      if (activeSessionWithTarget) {
        return json(res, { eligible: false, error: 'Conflict: Target is already being reserved or streamed to by another device in this workspace.' }, 409);
      }
    }

    if (destinations.length > entitlement.maxDestinations) {
      return json(res, {
        eligible: false,
        error: `Maximum destination limit exceeded. Current plan allows up to ${entitlement.maxDestinations} destination(s).`
      }, 400);
    }

    const activeCount = db.queryOne(
      "SELECT COUNT(*) as count FROM stream_sessions WHERE workspace_id = ? AND status IN ('reserved', 'streaming')",
      [req.workspaceId]
    ).count;

    if (activeCount >= entitlement.maxActiveBroadcasts) {
      return json(res, {
        eligible: false,
        error: `Workspace maximum concurrent streams reached (max ${entitlement.maxActiveBroadcasts}).`
      }, 400);
    }

    return json(res, {
      eligible: true,
      maxDestinations: entitlement.maxDestinations,
      currentActiveStreams: activeCount,
      stripeStatus: entitlement.subscriptionStatus
    });
  } catch (err) {
    return json(res, { error: 'Invalid preflight payload' }, 400);
  }
}, ['owner', 'operator'], true, 'both');

// OBS publishing to the reusable device ingest key now creates the stream.
// Keep this explicit tombstone so old docks fail clearly instead of minting
// one-time credentials and silently preserving the obsolete lifecycle.
addRoute('POST', '/api/workspaces/:workspaceId/streams/start', (req, res) => {
  return json(res, {
    error: 'Manual stream preparation is no longer required. Configure OBS once with this device stream key, then use Start Streaming in OBS.'
  }, 410);
}, ['operator'], true, 'device');

const streamOperationQueues = new Map();
const streamActivationTimers = new Set();

export async function drainStreamOperations() {
  for (const timer of streamActivationTimers) clearTimeout(timer);
  streamActivationTimers.clear();
  while (streamOperationQueues.size) await Promise.allSettled([...streamOperationQueues.values()]);
}

function serializeStreamOperation(streamId, operation) {
  const previous = streamOperationQueues.get(streamId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  streamOperationQueues.set(streamId, current);
  current.finally(() => {
    if (streamOperationQueues.get(streamId) === current) streamOperationQueues.delete(streamId);
  }).catch(() => {});
  return current;
}

async function stopStreamSession(streamId, workspaceId) {
  return serializeStreamOperation(streamId, async () => {
    const session = db.queryOne('SELECT * FROM stream_sessions WHERE id = ? AND workspace_id = ?', [streamId, workspaceId]);
    if (!session) return { missing: true };

    const unstoppedFbDestinations = db.queryAll(`
      SELECT * FROM stream_session_destinations
      WHERE stream_session_id = ? AND target_type = 'provider' AND status != 'stopped' AND broadcast_snapshot IS NOT NULL
    `, [streamId]).filter(destination => {
      try {
        const snapshot = JSON.parse(destination.broadcast_snapshot);
        return snapshot?.provider === 'facebook' && snapshot.cleanupState !== 'ended';
      } catch { return true; }
    });

    if (session.status === 'stopped' && unstoppedFbDestinations.length === 0) {
      return { alreadyStopped: true, durationSeconds: 0 };
    }

    await workerManager.stopWorkersForSession(streamId);

    // End remote Facebook live videos
    let hasCleanupError = false;
    let cleanupErrorMessage = '';

    for (const dest of unstoppedFbDestinations) {
      try { await workerManager.cleanupFacebookDestination(session, dest); }
      catch (error) {
        hasCleanupError = true;
        cleanupErrorMessage = error.message;
      }
    }

    const now = new Date().toISOString();
    const durationSeconds = session.started_at ? Math.max(0, (new Date(now) - new Date(session.started_at)) / 1000) : 0;
    const durationHours = durationSeconds / 3600;
    let transitioned = false;

    db.transaction(() => {
      const result = db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status != 'stopped'", [now, streamId]);
      transitioned = Number(result.changes) === 1;

      if (session.status === 'stopped' && unstoppedFbDestinations.length > 0) {
        transitioned = true;
      }

      db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [now, streamId]);
      db.run("UPDATE stream_session_destinations SET status = 'stopped' WHERE stream_session_id = ? AND status != 'failed'", [streamId]);

      if (session.status !== 'stopped') {
        const monthStart = now.substring(0, 7) + '-01';
        const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)).toISOString().substring(0, 10);
        const existingCounter = db.queryOne(
          "SELECT id FROM usage_counters WHERE workspace_id = ? AND metric = 'stream_hours' AND period_start = ?",
          [workspaceId, monthStart]
        );
        if (existingCounter) {
          db.run('UPDATE usage_counters SET value = value + ?, updated_at = ? WHERE id = ?', [durationHours, now, existingCounter.id]);
        } else {
          db.run(
            `INSERT INTO usage_counters (id, workspace_id, metric, value, period_start, period_end, updated_at)
             VALUES (?, ?, 'stream_hours', ?, ?, ?, ?)`,
            ['use_' + cryptoUtils.generateRandomToken(12), workspaceId, durationHours, monthStart, monthEnd, now]
          );
        }
      }
    });

    if (hasCleanupError) {
      return { cleanupError: cleanupErrorMessage, durationSeconds };
    }

    return { alreadyStopped: !transitioned, durationSeconds };
  });
}

// 24. Workspace Streams: Stop Stream (Updates reservation status & computes usage duration)
addRoute('POST', '/api/workspaces/:workspaceId/streams/:streamId/stop', async (req, res) => {
  const streamId = req.params.streamId;
  const result = await stopStreamSession(streamId, req.workspaceId);
  if (result.missing) return json(res, { error: 'Streaming session not found' }, 404);
  if (result.alreadyStopped) return json(res, { error: 'Streaming session is already stopped' }, 400);
  if (result.cleanupError) return json(res, { error: result.cleanupError }, 400);

  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    deviceId: req.authContext.type === 'device' ? req.authContext.device.id : null,
    action: 'stream.stopped',
    details: { streamId, durationSeconds: result.durationSeconds }
  });
  return json(res, { success: true, durationSeconds: result.durationSeconds });
}, ['owner', 'operator'], true, 'both');

// 24b. Workspace Streams: Custom targets and destinations queries
addRoute('GET', '/api/workspaces/:workspaceId/streams/destinations', (req, res) => {
  const customs = db.queryAll(
    'SELECT id, name, selected, created_at FROM custom_rtmp_targets WHERE workspace_id = ? ORDER BY created_at ASC',
    [req.workspaceId]
  );
  const providerTargets = db.queryAll(
    'SELECT id, provider, name, selected, created_at FROM provider_targets WHERE workspace_id = ? ORDER BY created_at ASC',
    [req.workspaceId]
  );
  const destinations = [
    ...customs.map(target => ({
      id: target.id,
      name: target.name,
      type: 'custom',
      provider: 'Custom RTMP',
      selected: !!target.selected,
      connected: true,
      ready: true,
      status: 'ready',
      detail: 'Ready to relay through Emberstage.'
    })),
    ...providerTargets.map(target => {
      const ready = ['twitch', 'youtube', 'facebook'].includes(target.provider) && nangoClient.isConfigured();
      return {
      id: target.id,
      name: target.name,
      type: 'provider',
      provider: target.provider,
      selected: !!target.selected,
      connected: true,
      ready,
      status: ready ? 'ready' : 'setup-required',
      detail: ready ? 'Ready for relay preflight through Emberstage.' : `${target.provider.charAt(0).toUpperCase() + target.provider.slice(1)} relay activation is not available yet.`
      };
    })
  ];
  return json(res, { success: true, destinations });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/streams/destinations/:destinationId/select', (req, res) => {
  const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
  if (!entitlement.canStream) {
    return json(res, { error: 'Payment Required: An active subscription is required to manage destinations.' }, 402);
  }
  const destinationId = req.params.destinationId;
  const customTarget = db.queryOne('SELECT id FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [destinationId, req.workspaceId]);
  const providerTarget = customTarget ? null : db.queryOne('SELECT id, provider FROM provider_targets WHERE id = ? AND workspace_id = ?', [destinationId, req.workspaceId]);
  if (!customTarget && !providerTarget) {
    return json(res, { error: 'Destination not found or tenant mismatch' }, 404);
  }
  if (customTarget) {
    db.run('UPDATE custom_rtmp_targets SET selected = 1 WHERE id = ?', [destinationId]);
  } else {
    db.run('UPDATE provider_targets SET selected = 1 WHERE id = ?', [destinationId]);
  }
  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    deviceId: req.authContext.type === 'device' ? req.authContext.device.id : null,
    action: 'stream.destination.selected',
    details: { destinationId, type: customTarget ? 'custom' : 'provider', provider: providerTarget ? providerTarget.provider : 'custom' }
  });
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'both');

addRoute('POST', '/api/workspaces/:workspaceId/streams/destinations/:destinationId/deselect', (req, res) => {
  const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
  if (!entitlement.canStream) {
    return json(res, { error: 'Payment Required: An active subscription is required to manage destinations.' }, 402);
  }
  const destinationId = req.params.destinationId;
  const customTarget = db.queryOne('SELECT id FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [destinationId, req.workspaceId]);
  const providerTarget = customTarget ? null : db.queryOne('SELECT id, provider FROM provider_targets WHERE id = ? AND workspace_id = ?', [destinationId, req.workspaceId]);
  if (!customTarget && !providerTarget) {
    return json(res, { error: 'Destination not found or tenant mismatch' }, 404);
  }
  if (customTarget) {
    db.run('UPDATE custom_rtmp_targets SET selected = 0 WHERE id = ?', [destinationId]);
  } else {
    db.run('UPDATE provider_targets SET selected = 0 WHERE id = ?', [destinationId]);
  }
  db.logAudit({
    workspaceId: req.workspaceId,
    userId: req.authContext.type === 'web' ? req.authContext.user.id : null,
    deviceId: req.authContext.type === 'device' ? req.authContext.device.id : null,
    action: 'stream.destination.deselected',
    details: { destinationId, type: customTarget ? 'custom' : 'provider', provider: providerTarget ? providerTarget.provider : 'custom' }
  });
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'both');

addRoute('GET', '/api/workspaces/:workspaceId/streams/custom-targets', (req, res) => {
  const customs = db.queryAll('SELECT id, name, stream_url, selected, created_at FROM custom_rtmp_targets WHERE workspace_id = ?', [req.workspaceId]);
  return json(res, { success: true, targets: customs });
}, ['owner', 'operator'], true, 'web');

addRoute('POST', '/api/workspaces/:workspaceId/streams/custom-targets', async (req, res) => {
  const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
  if (!entitlement.canStream) {
    return json(res, { error: 'Payment Required: An active subscription is required to manage destinations.' }, 402);
  }
  try {
    const bodyText = await readBody(req);
    const { name, stream_url, stream_key } = JSON.parse(bodyText || '{}');
    if (!name || !stream_url || !stream_key) {
      return json(res, { error: 'Missing name, stream_url, or stream_key' }, 400);
    }
    let parsedStreamUrl;
    try {
      parsedStreamUrl = new URL(stream_url);
    } catch {
      return json(res, { error: 'Invalid RTMP destination URL' }, 400);
    }
    if (!['rtmp:', 'rtmps:'].includes(parsedStreamUrl.protocol) || parsedStreamUrl.username || parsedStreamUrl.password) {
      return json(res, { error: 'Destination URL must use RTMP or RTMPS and must not contain credentials' }, 400);
    }
    if (parsedStreamUrl.search || parsedStreamUrl.hash) {
      return json(res, { error: 'Destination URL must be an RTMP application base URL without a query string or fragment' }, 400);
    }
    const id = 'crt_' + cryptoUtils.generateRandomToken(12);
    const encryptedKey = cryptoUtils.encrypt(stream_key, config.ENCRYPTION_SECRET);
    db.run(
      `INSERT INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [id, req.workspaceId, name, stream_url, encryptedKey, new Date().toISOString()]
    );
    return json(res, { success: true, targetId: id });
  } catch (err) {
    return json(res, { error: 'Invalid custom target payload' }, 400);
  }
}, ['owner', 'operator'], true, 'web');

addRoute('DELETE', '/api/workspaces/:workspaceId/streams/custom-targets/:targetId', (req, res) => {
  const targetId = req.params.targetId;
  const target = db.queryOne('SELECT * FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
  if (!target) {
    return json(res, { error: 'Custom target not found or tenant mismatch' }, 404);
  }
  db.run('DELETE FROM custom_rtmp_targets WHERE id = ?', [targetId]);
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'web');

addRoute('POST', '/api/workspaces/:workspaceId/streams/custom-targets/:targetId/select', (req, res) => {
  const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
  if (!entitlement.canStream) {
    return json(res, { error: 'Payment Required: An active subscription is required to manage destinations.' }, 402);
  }
  const targetId = req.params.targetId;
  const target = db.queryOne('SELECT * FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
  if (!target) {
    return json(res, { error: 'Custom target not found or tenant mismatch' }, 404);
  }
  db.run('UPDATE custom_rtmp_targets SET selected = 1 WHERE id = ?', [targetId]);
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'web');

addRoute('POST', '/api/workspaces/:workspaceId/streams/custom-targets/:targetId/deselect', (req, res) => {
  const entitlement = getStrictWorkspaceEntitlement(req.workspaceId);
  if (!entitlement.canStream) {
    return json(res, { error: 'Payment Required: An active subscription is required to manage destinations.' }, 402);
  }
  const targetId = req.params.targetId;
  const target = db.queryOne('SELECT * FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [targetId, req.workspaceId]);
  if (!target) {
    return json(res, { error: 'Custom target not found or tenant mismatch' }, 404);
  }
  db.run('UPDATE custom_rtmp_targets SET selected = 0 WHERE id = ?', [targetId]);
  return json(res, { success: true });
}, ['owner', 'operator'], true, 'web');

// 25. Workspace Streams: List Streaming Sessions
addRoute('GET', '/api/workspaces/:workspaceId/streams', (req, res) => {
  const streams = db.queryAll('SELECT * FROM streaming_sessions WHERE workspace_id = ? ORDER BY created_at DESC', [
    req.workspaceId
  ]);
  return json(res, { success: true, streams });
}, ['owner', 'operator'], true, 'web');

async function activatePublishedStream(session, streamKey) {
  const latest = db.queryOne('SELECT * FROM stream_sessions WHERE id = ?', [session.id]);
  if (!latest || latest.status === 'stopped' || latest.status === 'streaming') return;

  const entitlement = getStrictWorkspaceEntitlement(session.workspace_id);
  const now = new Date();
  const isExpired = latest.expires_at && new Date(latest.expires_at) <= now;
  const device = db.queryOne("SELECT status FROM devices WHERE id = ?", [session.device_id]);
  // A reservation is not an already-live broadcast. Expiry grace must not be
  // usable to start a new relay after the paid period has ended.
  const allowed = device?.status === 'active' && entitlement.canStream && !isExpired;
  if (!allowed) {
    const nowStr = now.toISOString();
    db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [nowStr, session.id]);
    db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [nowStr, session.id]);
    return;
  }

  // Claim activation synchronously so duplicate NGINX callbacks cannot spawn duplicate relays.
  const startedAt = new Date().toISOString();
  db.run("UPDATE stream_sessions SET status = 'streaming', started_at = ? WHERE id = ? AND status = 'reserved'", [startedAt, session.id]);
  const claimed = db.queryOne('SELECT status FROM stream_sessions WHERE id = ?', [session.id]);
  if (!claimed || claimed.status !== 'streaming') return;
  db.run("UPDATE streaming_sessions SET status = 'streaming', started_at = ? WHERE id = ?", [startedAt, session.id]);

  const destinations = db.queryAll('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [session.id]);
  const localIngestUrl = config.CONTRIBUTION_INGEST_URL || 'rtmp://localhost/live';
  let activatedCount = 0;

  for (const destination of destinations) {
    let createdLiveVideoId = null;
    let createdConnectionId = null;
    let target = null;
    try {
      if (destination.target_type === 'custom') {
        target = db.queryOne('SELECT * FROM custom_rtmp_targets WHERE id = ? AND workspace_id = ?', [destination.target_id, session.workspace_id]);
      } else {
        target = db.queryOne('SELECT * FROM provider_targets WHERE id = ? AND workspace_id = ?', [destination.target_id, session.workspace_id]);
        if (!target || target.selected !== 1) throw new Error('Provider target is no longer approved');

        const conn = db.queryOne('SELECT status FROM provider_connections WHERE workspace_id = ? AND provider = ?', [session.workspace_id, target.provider]);
        if (!conn || conn.status !== 'connected') {
          throw new Error(`Admission rejected: Provider ${target.provider} is disconnected.`);
        }

        let broadcastId = null;
        if (destination.broadcast_snapshot) {
          try {
            const snap = JSON.parse(destination.broadcast_snapshot);
            broadcastId = snap?.id;
          } catch (e) {}
        }
        // Validate the exact admitted broadcast and binding before changing its settings.
        if (target.provider === 'youtube' && !broadcastId) {
          throw new Error('The admitted YouTube broadcast snapshot is missing');
        }
        if (target.provider === 'facebook' && destination.broadcast_snapshot) throw new Error('Facebook activation already has a broadcast snapshot');
        const resolved = await nangoClient.resolveDestination(session.workspace_id, target.provider, target.external_id, broadcastId);
        if (target.provider === 'facebook') {
          createdLiveVideoId = resolved.liveVideoId;
          createdConnectionId = resolved.connectionId;
          const snapshotJson = JSON.stringify(createFacebookSnapshot(session, destination, target.external_id, resolved.liveVideoId, resolved.connectionId));
          db.run(
            "UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE id = ?",
            [snapshotJson, destination.id]
          );
          destination.broadcast_snapshot = snapshotJson;
        }
        if (target.provider === 'youtube') {
          if (!broadcastId) {
            throw new Error('No broadcast has been selected for this YouTube channel');
          }
          await nangoClient.updateYoutubeBroadcast(session.workspace_id, target.external_id, broadcastId, {
            enableAutoStart: true
          });
        }

        target = { ...target, resolved_stream_url: resolved.streamUrl, resolved_stream_key: resolved.streamKey };
      }
      await workerManager.startWorker(session.id, destination.target_id, destination.target_type, target, localIngestUrl, streamKey);
      db.run("UPDATE stream_session_destinations SET error_message = NULL WHERE id = ?", [destination.id]);
      activatedCount++;
    } catch (err) {
      const fbPageId = target?.provider === 'facebook' ? target.external_id : null;
      const fbLiveVideoId = createdLiveVideoId || (fbPageId && err.liveVideoId);

      if (fbLiveVideoId && fbPageId) {
        try {
          // Parsing can fail after Meta creates the object. Save its identity before retrying end.
          if (!destination.broadcast_snapshot) {
            const snapshot = createFacebookSnapshot(session, destination, fbPageId, fbLiveVideoId, createdConnectionId || err.connectionId);
            destination.broadcast_snapshot = JSON.stringify(snapshot);
            db.run('UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE id = ?', [destination.broadcast_snapshot, destination.id]);
          }
          await workerManager.cleanupFacebookDestination(session, destination);
        } catch {
          db.run("UPDATE stream_session_destinations SET status = 'failed', error_message = 'Facebook live cleanup pending; retry stop' WHERE id = ?", [destination.id]);
          continue;
        }
      }
      db.run("UPDATE stream_session_destinations SET status = 'failed', error_message = ? WHERE id = ?", [target?.provider === 'facebook' ? 'Facebook relay could not start' : err.message || 'Relay could not start', destination.id]);
    }
  }

  if (activatedCount === 0) {
    const now = new Date().toISOString();
    db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [now, session.id]);
    db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [now, session.id]);
  }
}

function findDeviceForIngestKey(streamKey) {
  const computedHash = crypto.createHash('sha256').update(streamKey).digest('hex');
  const device = db.queryOne(
    "SELECT * FROM devices WHERE ingest_key_hash = ? AND status = 'active'",
    [computedHash]
  );
  const expectedHash = device?.ingest_key_hash || computedHash;
  const matches = crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(expectedHash));
  return device && matches ? device : null;
}

function reservePublishedStream(device, clientId = '') {
  if (inflightWorkspaceMutations.has(device.workspace_id)) {
    return { error: 'Conflict: A workspace settings mutation is in progress. Please retry shortly.', status: 409 };
  }
  reapExpiredStreamReservations(device.workspace_id);
  return db.transaction(() => {
    const workspace = db.queryOne('SELECT * FROM workspaces WHERE id = ?', [device.workspace_id]);

    const existing = db.queryOne(
      "SELECT * FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming') ORDER BY created_at DESC LIMIT 1",
      [device.id]
    );
    if (existing) {
      if (clientId && existing.publisher_identity && String(existing.publisher_identity) !== String(clientId)) {
        return { error: 'Conflict: A concurrent streaming session is already active with a different client ID.', status: 409 };
      }
      const entitlement = getWorkspaceEntitlement(device.workspace_id);
      if (entitlement.canStream && Date.parse(existing.expires_at) <= Date.now()) {
        existing.expires_at = new Date(Date.parse(entitlement.paidUntil) + 2 * 3600000).toISOString();
        db.run('UPDATE stream_sessions SET expires_at = ? WHERE id = ?', [existing.expires_at, existing.id]);
      }
      const continuingLiveSession = existing.status === 'streaming' && !!existing.started_at &&
        entitlement.subscriptionStatus !== 'suspended' && Date.parse(entitlement.paidUntil) <= Date.now() &&
        Number.isFinite(Date.parse(existing.expires_at)) && Date.parse(existing.expires_at) > Date.now();
      if (!entitlement.canStream && !continuingLiveSession) {
        return { error: 'Payment Required: An unexpired paid subscription is required to start streaming.', status: 402 };
      }
      return { session: existing, existing: true };
    }

    const entitlement = getStrictWorkspaceEntitlement(device.workspace_id);
    if (!entitlement.canStream) {
      return { error: 'Payment Required: An active or trialing subscription is required for streaming.', status: 402 };
    }

    const customDestinations = db.queryAll(
      "SELECT id, 'custom' AS target_type FROM custom_rtmp_targets WHERE workspace_id = ? AND selected = 1 ORDER BY created_at ASC",
      [device.workspace_id]
    );
    const providerDestinations = db.queryAll(
      "SELECT *, 'provider' AS target_type FROM provider_targets WHERE workspace_id = ? AND selected = 1 ORDER BY created_at ASC",
      [device.workspace_id]
    );
    const unsupported = providerDestinations.find(target => !['twitch', 'youtube', 'facebook'].includes(target.provider) || !nangoClient.isConfigured());
    if (unsupported) return { error: `${unsupported.provider} relay setup is not available yet.`, status: 400 };

    for (const target of providerDestinations) {
      if (target.provider === 'facebook' && facebookCleanupPending(device.workspace_id, target.external_id)) {
        return { error: 'Facebook live cleanup pending; retry stop before starting another broadcast', status: 409 };
      }
      const conn = db.queryOne('SELECT status FROM provider_connections WHERE workspace_id = ? AND provider = ?', [device.workspace_id, target.provider]);
      if (!conn || conn.status !== 'connected') {
        return { error: `Admission rejected: Selected destination provider ${target.provider} is disconnected.`, status: 400 };
      }
      if (target.provider === 'youtube') {
        if (!target.selected_broadcast_id || !target.broadcast_snapshot) {
          return { error: 'Admission rejected: Selected YouTube destination has no broadcast selected/created.', status: 400 };
        }
        let bSnap = null;
        try {
          bSnap = JSON.parse(target.broadcast_snapshot);
        } catch (e) {}
        if (!bSnap || bSnap.lifeCycleStatus === 'complete' || bSnap.lifeCycleStatus === 'completed') {
          return { error: 'Admission rejected: Selected YouTube broadcast is completed. Please select or create a new active broadcast.', status: 400 };
        }
      }
    }

    const destinationsMap = new Map();
    for (const d of customDestinations) {
      destinationsMap.set(d.id, d);
    }
    for (const d of providerDestinations) {
      destinationsMap.set(d.id, d);
    }
    const destinations = Array.from(destinationsMap.values());

    if (destinations.length === 0) {
      return { error: 'Select at least one ready destination before starting OBS.', status: 400 };
    }

    // Prevent two devices in same workspace reserving same target concurrently
    for (const d of destinations) {
      const activeSessionWithTarget = db.queryOne(`
        SELECT s.id, s.device_id FROM stream_sessions s
        JOIN stream_session_destinations sd ON s.id = sd.stream_session_id
        WHERE s.workspace_id = ? AND sd.target_id = ? AND s.status IN ('reserved', 'streaming') AND s.device_id != ?
      `, [device.workspace_id, d.id, device.id]);
      if (activeSessionWithTarget) {
        return { error: `Conflict: Target is already being reserved or streamed to by another device in this workspace.`, status: 409 };
      }
    }

    if (destinations.length > entitlement.maxDestinations) {
      return { error: `Maximum destination limit exceeded. Current plan allows up to ${entitlement.maxDestinations} destination(s).`, status: 400 };
    }

    const activeCount = db.queryOne(
      "SELECT COUNT(*) AS count FROM stream_sessions WHERE workspace_id = ? AND status IN ('reserved', 'streaming')",
      [device.workspace_id]
    ).count;
    if (activeCount >= entitlement.maxActiveBroadcasts) {
      return { error: `Workspace maximum concurrent streams reached (max ${entitlement.maxActiveBroadcasts}).`, status: 400 };
    }

    const streamId = 'stream_' + cryptoUtils.generateRandomToken(12);
    const now = new Date().toISOString();
    let expiresAt = null;
    if (entitlement.paidUntil) {
      const graceMs = 2 * 3600 * 1000;
      expiresAt = new Date(new Date(entitlement.paidUntil).getTime() + graceMs).toISOString();
    }

    const destinationIds = destinations.map(({ id }) => id);
    db.run(
      `INSERT INTO streaming_sessions (id, workspace_id, device_id, status, destinations, started_at, stopped_at, created_at)
       VALUES (?, ?, ?, 'preflight', ?, NULL, NULL, ?)`,
      [streamId, device.workspace_id, device.id, JSON.stringify(destinationIds), now]
    );
    db.run(
      `INSERT INTO stream_sessions (id, workspace_id, device_id, status, expires_at, stream_key_hash, publisher_identity, started_at, stopped_at, created_at)
       VALUES (?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL, ?)`,
      [streamId, device.workspace_id, device.id, expiresAt, device.ingest_key_hash, clientId, now]
    );
    for (const { id: targetId, target_type: targetType } of destinations) {
      let snapshot = null;
      if (targetType === 'provider') {
        const pt = db.queryOne("SELECT broadcast_snapshot FROM provider_targets WHERE id = ? AND provider = 'youtube'", [targetId]);
        snapshot = pt?.broadcast_snapshot || null;
      }
      db.run(
        `INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, error_message, broadcast_snapshot, created_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        ['ssd_' + cryptoUtils.generateRandomToken(12), streamId, targetId, targetType, snapshot, now]
      );
    }

    const monthStart = now.substring(0, 7) + '-01';
    const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)).toISOString().substring(0, 10);
    const existingCounter = db.queryOne(
      "SELECT id FROM usage_counters WHERE workspace_id = ? AND metric = 'stream_sessions_count' AND period_start = ?",
      [device.workspace_id, monthStart]
    );
    if (existingCounter) {
      db.run('UPDATE usage_counters SET value = value + 1, updated_at = ? WHERE id = ?', [now, existingCounter.id]);
    } else {
      db.run(
        `INSERT INTO usage_counters (id, workspace_id, metric, value, period_start, period_end, updated_at)
         VALUES (?, ?, 'stream_sessions_count', 1, ?, ?, ?)`,
        ['use_' + cryptoUtils.generateRandomToken(12), device.workspace_id, monthStart, monthEnd, now]
      );
    }

    db.logAudit({
      workspaceId: device.workspace_id,
      deviceId: device.id,
      action: 'stream.publish_started',
      details: { streamId, destination_ids: destinationIds }
    });
    return {
      session: db.queryOne('SELECT * FROM stream_sessions WHERE id = ?', [streamId]),
      existing: false
    };
  });
}

// Device-safe status polling; never returns contribution or destination credentials.
addRoute('GET', '/api/workspaces/:workspaceId/streams/:streamId/status', async (req, res) => {
  reapExpiredStreamReservations(req.workspaceId);
  const stream = db.queryOne('SELECT id, status, expires_at, started_at, stopped_at FROM stream_sessions WHERE id = ? AND workspace_id = ?', [req.params.streamId, req.workspaceId]);
  if (!stream) return json(res, { error: 'Streaming session not found' }, 404);
  const destinations = db.queryAll('SELECT target_id, target_type, status, error_message, broadcast_snapshot FROM stream_session_destinations WHERE stream_session_id = ?', [stream.id]);
  await enrichDestinations(req.workspaceId, stream.id, destinations);
  return json(res, { success: true, stream, destinations });
}, ['owner', 'operator'], true, 'both');

addRoute('GET', '/api/device/stream-status', async (req, res) => {
  let stream = db.queryOne(
    "SELECT id, status, started_at, stopped_at FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming') ORDER BY created_at DESC LIMIT 1",
    [req.authContext.device.id]
  );
  if (!stream && facebookCleanupPending(req.authContext.device.workspace_id)) {
    stream = db.queryOne(`SELECT s.id, s.status, s.started_at, s.stopped_at FROM stream_sessions s
      WHERE s.device_id = ? AND EXISTS (SELECT 1 FROM stream_session_destinations d WHERE d.stream_session_id = s.id AND d.status = 'failed' AND d.broadcast_snapshot IS NOT NULL)
      ORDER BY s.created_at DESC LIMIT 1`, [req.authContext.device.id]);
  }
  if (!stream) return json(res, { success: true, stream: null, destinations: [] });
  const destinations = db.queryAll(
    'SELECT target_id, target_type, status, error_message, broadcast_snapshot FROM stream_session_destinations WHERE stream_session_id = ?',
    [stream.id]
  );
  const workspaceId = req.workspaceId || req.authContext.device?.workspace_id;
  await enrichDestinations(workspaceId, stream.id, destinations);
  return json(res, { success: true, stream, destinations });
}, ['operator'], true, 'device');

// 26. NGINX-RTMP on_publish callback: authenticate the reusable device key,
// snapshot selected destinations, and create the live session.
addRoute('POST', '/api/streams/publish', async (req, res) => {
  try {
    const remoteAddress = req.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      return json(res, { error: 'Forbidden: Ingest callback must originate on loopback' }, 403);
    }
    const bodyText = (await readBody(req)).trim();
    let key = '';
    let clientId = '';
    if (bodyText.startsWith('{')) {
      try {
        const parsed = JSON.parse(bodyText);
        key = parsed.name || parsed.key || parsed.streamKey || '';
        clientId = parsed.clientid || parsed.clientId || '';
      } catch (e) {}
    } else {
      const params = new URLSearchParams(bodyText);
      key = params.get('name') || params.get('key') || params.get('streamKey') || '';
      clientId = params.get('clientid') || '';
    }

    if (!key) {
      return json(res, { error: 'Missing stream key (name)' }, 400);
    }

    const device = findDeviceForIngestKey(key);
    if (!device) {
      return json(res, { error: 'Unauthorized: Invalid stream key' }, 401);
    }

    const reserved = await serializeStreamOperation('device:' + device.id, () => reservePublishedStream(device, clientId));
    if (reserved.error) return json(res, { error: reserved.error }, reserved.status);
    const session = reserved.session;

    // Authorize first, then start pull relays after NGINX has accepted the publisher.
    if (!reserved.existing) {
      const timer = setTimeout(() => {
        streamActivationTimers.delete(timer);
        serializeStreamOperation(session.id, () => activatePublishedStream(session, key)).catch(() => {
          const now = new Date().toISOString();
          db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [now, session.id]);
          db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?", [now, session.id]);
        });
      }, 250);
      streamActivationTimers.add(timer);
      if (typeof timer.unref === 'function') timer.unref();
    }

    // NGINX authorizes publishing only for 2xx responses.
    return json(res, {
      success: true,
      message: reserved.existing ? 'Publish already active' : 'Publish authorized',
      streamId: session.id
    }, 200);
  } catch (err) {
    return json(res, { error: 'Publish authorization error: ' + err.message }, 500);
  }
}, null, false, 'both');

// 27. NGINX-RTMP on_publish_done callback: Stop relays/revoke the session when OBS disconnects
addRoute('POST', '/api/streams/publish_done', async (req, res) => {
  try {
    const remoteAddress = req.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      return json(res, { error: 'Forbidden: Ingest callback must originate on loopback' }, 403);
    }
    const bodyText = (await readBody(req)).trim();
    let key = '';
    let clientId = '';
    if (bodyText.startsWith('{')) {
      try {
        const parsed = JSON.parse(bodyText);
        key = parsed.name || parsed.key || parsed.streamKey || '';
        clientId = parsed.clientid || parsed.clientId || '';
      } catch (e) {}
    } else {
      const params = new URLSearchParams(bodyText);
      key = params.get('name') || params.get('key') || params.get('streamKey') || '';
      clientId = params.get('clientid') || '';
    }

    if (!key) {
      return json(res, { error: 'Missing stream key (name)' }, 400);
    }

    const device = findDeviceForIngestKey(key);
    if (!device) {
      // Idempotency: Unknown/non-matching key is not an error for a done callback, just return success
      return json(res, { success: true, message: 'Done callback ignored for invalid key' }, 200);
    }

    const responseData = await serializeStreamOperation('device:' + device.id, async () => {
      const session = db.queryOne(
        "SELECT * FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming') AND stream_key_hash = ? ORDER BY created_at DESC LIMIT 1",
        [device.id, device.ingest_key_hash]
      );
      if (!session) return { success: true, message: 'No active session for device' };

      // Handle NGINX clientid stale publish_done: if clientid is present and session has publisher_identity,
      // verify they are identical. If they are different, ignore publish_done (stale connection)!
      if (clientId && session.publisher_identity && String(clientId) !== String(session.publisher_identity)) {
        return { success: true, message: 'Stale done callback ignored (clientid mismatch)' };
      }

      if (!clientId && session.publisher_identity) {
        return { success: true, message: 'Done callback ignored because clientid is missing but session has a recorded publisher identity' };
      }

      const result = await stopStreamSession(session.id, device.workspace_id);
      return {
        success: true,
        message: result.alreadyStopped ? 'Session already stopped' : 'Session stopped and workers terminated'
      };
    });

    return json(res, responseData, 200);
  } catch (err) {
    return json(res, { error: 'Publish done callback error: ' + err.message }, 500);
  }
}, null, false, 'both');

// --- MAIN HTTP HANDLER ---
export async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Helper to identify device-safe stream control/bootstrap endpoints
  function isDeviceSafeRoute(path) {
    if (path.startsWith('/api/device/') || path.startsWith('/api/devices/')) {
      return true;
    }
    if (path.startsWith('/api/workspaces/') && path.includes('/streams')) {
      if (path.includes('/providers') || path.includes('/billing') || path.includes('/members')) {
        return false;
      }
      return true;
    }
    return false;
  }

  const origin = req.headers['origin'];
  
  if (isDeviceSafeRoute(pathname)) {
    const allowedDeviceOrigin = origin === 'null' || (origin && config.APP_BASE_URL && origin === config.APP_BASE_URL);
    if (allowedDeviceOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      res.setHeader('Vary', 'Origin');
    } else if (origin) {
      return json(res, { error: 'Forbidden: Request origin is not allowed' }, 403);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  } else {
    // Standard origin check for web/admin/provider routes
    if (origin === 'null') {
      return json(res, { error: 'Forbidden: Request origin null is not allowed' }, 403);
    }
    if (origin && config.APP_BASE_URL) {
      if (origin !== config.APP_BASE_URL) {
        return json(res, { error: 'Forbidden: Request origin is not allowed' }, 403);
      }
    }
  }

  // Safe fixed-path static file serving for the /app portal
  if (req.method === 'GET') {
    const brandAssets = {
      '/assets/brand/favicon.svg': 'assets/brand/favicon.svg',
      '/assets/brand/emberstage-logo.svg': 'assets/brand/emberstage-logo.svg',
      '/assets/brand/emberstage-wordmark.svg': 'assets/brand/emberstage-wordmark.svg',
      '/assets/css/emberstage_brand.css': 'assets/css/emberstage_brand.css'
    };
    if (Object.hasOwn(brandAssets, pathname)) {
      try {
        const content = fs.readFileSync(path.resolve(__dirname, '../..', brandAssets[pathname]));
        res.writeHead(200, {
          'Content-Type': pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/css; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(content);
      } catch {
        return json(res, { error: 'Brand Asset Not Found' }, 404);
      }
    }
    if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') {
      try {
        const content = fs.readFileSync(path.join(PUBLIC_DIR, 'app.html'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval';"
        });
        return res.end(content);
      } catch (err) {
        return json(res, { error: 'Static Portal File Not Found' }, 404);
      }
    } else if (pathname === '/app/app.js') {
      try {
        const content = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(content);
      } catch (err) {
        return json(res, { error: 'Static JS Not Found' }, 404);
      }
    } else if (pathname === '/app/app.css') {
      try {
        const content = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(content);
      } catch (err) {
        return json(res, { error: 'Static CSS Not Found' }, 404);
      }
    }
  }

  // Enforce LOOPBACK-only check if desired, but we bind host to loopback (127.0.0.1) naturally at server startup.

  // Find routing match
  const route = routes.find(r => r.method === req.method && r.regex.test(pathname));
  if (!route) {
    return json(res, { error: 'Not Found' }, 404);
  }

  const result = route.regex.exec(pathname);
  const params = {};
  route.paramNames.forEach((name, idx) => {
    params[name] = result[idx + 1];
  });
  req.params = params;

  if (params.workspaceId) {
    req.workspaceId = params.workspaceId;
  }

  // Double-Submit Cookie CSRF Validation on modifying web routes (POST, PUT, DELETE)
  // Skip CSRF for auth, the signed Paystack webhook, and device linking/refresh endpoints.
  // Only apply CSRF check if the client is authenticating via web session cookies (session_id is present)
  const skipCSRFPaths = [
    '/api/auth/register',
    '/api/auth/login',
    '/api/billing/webhook',
    '/api/devices/pair',
    '/api/devices/refresh'
  ];
  const cookies = parseCookies(req.headers.cookie);
  const hasSessionCookie = !!cookies['session_id'];
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !skipCSRFPaths.includes(pathname) && hasSessionCookie) {
    const sessionId = cookies['session_id'];
    const session = db.queryOne('SELECT csrf_secret FROM web_sessions WHERE id = ?', [sessionId]);
    if (!session) {
      return json(res, { error: 'Unauthorized: Session invalid' }, 401);
    }

    const csrfCookie = cookies['_csrf'];
    const csrfHeader = req.headers['x-csrf-token'];

    if (!csrfCookie || !csrfHeader) {
      return json(res, { error: 'Forbidden: CSRF validation failed' }, 403);
    }

    const expected = Buffer.from(session.csrf_secret, 'utf8');
    const actualCookie = Buffer.from(csrfCookie, 'utf8');
    const actualHeader = Buffer.from(csrfHeader, 'utf8');

    let valid = false;
    try {
      valid = crypto.timingSafeEqual(expected, actualCookie) && crypto.timingSafeEqual(expected, actualHeader);
    } catch (e) {
      valid = false;
    }

    if (!valid) {
      return json(res, { error: 'Forbidden: CSRF validation failed' }, 403);
    }
  }

  // Authentication + Authorization Guard
  const authCtx = authAndAuthorize(req, res, route);
  if (!authCtx) {
    // Response already handled by authAndAuthorize
    return;
  }

  // Execute actual route handler
  try {
    await route.handler(req, res);
  } catch (err) {
    console.error(`Route execution failed: ${pathname}`, err);
    return json(res, { error: 'Internal Server Error' }, 500);
  }
}

let streamExpiryMonitorInterval = null;
export async function expireStreamingSessions() {
  const now = Date.now();
  const sessions = db.queryAll("SELECT * FROM stream_sessions WHERE status IN ('reserved', 'streaming')");
  for (const session of sessions) {
    const entitlement = getWorkspaceEntitlement(session.workspace_id);
    const device = db.queryOne('SELECT status FROM devices WHERE id = ?', [session.device_id]);
    const expiryGrace = session.status === 'streaming' && !!session.started_at &&
      entitlement.subscriptionStatus !== 'suspended' && Date.parse(entitlement.paidUntil) <= now;
    if (device?.status !== 'active' || (!entitlement.canStream && !expiryGrace)) {
      await stopStreamSession(session.id, session.workspace_id);
      continue;
    }
    if (Number.isFinite(Date.parse(session.expires_at)) && Date.parse(session.expires_at) > now) continue;
    if (entitlement.canStream) {
      db.run('UPDATE stream_sessions SET expires_at = ? WHERE id = ?',
        [new Date(Date.parse(entitlement.paidUntil) + 2 * 3600000).toISOString(), session.id]);
    } else {
      await stopStreamSession(session.id, session.workspace_id);
    }
  }
}

function startStreamExpiryMonitor() {
  if (streamExpiryMonitorInterval) return;
  let running = false;
  streamExpiryMonitorInterval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await expireStreamingSessions();
    } catch (err) {
      console.error('[StreamExpiryMonitor] Stream cleanup failed; will retry.');
    } finally { running = false; }
  }, 10000);
  if (streamExpiryMonitorInterval.unref) {
    streamExpiryMonitorInterval.unref();
  }
}
startStreamExpiryMonitor();
