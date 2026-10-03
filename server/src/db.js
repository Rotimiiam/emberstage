import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.DATABASE_URL);
db.exec('PRAGMA busy_timeout = 5000;');

db.run = function (sql, params = []) {
  return db.prepare(sql).run(...params);
};
db.queryOne = function (sql, params = []) {
  return db.prepare(sql).get(...params);
};
db.queryAll = function (sql, params = []) {
  return db.prepare(sql).all(...params);
};
db.transaction = function (fn) {
  return transaction(fn);
};
db.logAudit = function ({ workspaceId, userId = null, deviceId = null, action, details }) {
  logAudit({ workspaceId, userId, deviceId, action, details });
};

// Enable SQLite safety/performance pragmas
db.exec('PRAGMA foreign_keys = ON;');
if (config.DATABASE_URL !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL;');
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_status TEXT DEFAULT 'none',
      max_devices INTEGER DEFAULT 1,
      max_destinations INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      has_password INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'operator', 'finance')),
      PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      csrf_secret TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      link_code TEXT UNIQUE,
      link_code_expires_at TEXT,
      linked_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
      ingest_key_hash TEXT,
      ingest_key_last4 TEXT,
      ingest_key_rotated_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      refresh_token_hash TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      refresh_token_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS used_refresh_tokens (
      hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('twitch', 'youtube', 'facebook', 'instagram')),
      encrypted_tokens TEXT,
      status TEXT NOT NULL CHECK(status IN ('connected', 'disconnected')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, provider)
    );

    CREATE TABLE IF NOT EXISTS provider_targets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider_connection_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('twitch', 'youtube', 'facebook')),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      selected INTEGER DEFAULT 0 CHECK(selected IN (0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(provider_connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      pkce_verifier TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS streaming_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      device_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('preflight', 'streaming', 'stopped')),
      destinations TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS usage_counters (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      metric TEXT NOT NULL CHECK(metric IN ('stream_hours', 'stream_sessions_count')),
      value REAL NOT NULL DEFAULT 0.0,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, metric, period_start)
    );

    CREATE TABLE IF NOT EXISTS audit_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT,
      device_id TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_identities (
      google_sub TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS google_auth_states (
      state TEXT PRIMARY KEY,
      pkce_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      user_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth0_identities (
      auth0_sub TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth0_auth_states (
      state TEXT PRIMARY KEY,
      pkce_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  try {
    db.run("ALTER TABLE users ADD COLUMN has_password INTEGER DEFAULT 1");
  } catch (err) {
    // Column already exists or table is blank
  }

  for (const column of [
    'ingest_key_hash TEXT',
    'ingest_key_last4 TEXT',
    'ingest_key_rotated_at TEXT'
  ]) {
    try {
      db.exec(`ALTER TABLE devices ADD COLUMN ${column};`);
    } catch (err) {
      // Column already exists.
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_ingest_key_hash
    ON devices(ingest_key_hash) WHERE ingest_key_hash IS NOT NULL;`);

  // Create new normalized streaming tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      device_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('preflight', 'streaming', 'stopped', 'reserved')),
      expires_at TEXT,
      stream_key_hash TEXT,
      started_at TEXT,
      stopped_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS stream_session_destinations (
      id TEXT PRIMARY KEY,
      stream_session_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('provider', 'custom')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'failed', 'stopped')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(stream_session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS custom_rtmp_targets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      encrypted_stream_key TEXT NOT NULL,
      selected INTEGER DEFAULT 0 CHECK(selected IN (0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stream_workers (
      id TEXT PRIMARY KEY,
      stream_session_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running', 'stopped', 'failed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(stream_session_id) REFERENCES stream_sessions(id) ON DELETE CASCADE
    );
  `);

  try {
    db.exec(`ALTER TABLE stream_sessions ADD COLUMN expires_at TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE stream_sessions ADD COLUMN stream_key_hash TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE provider_targets ADD COLUMN selected_broadcast_id TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE provider_targets ADD COLUMN broadcast_snapshot TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE stream_session_destinations ADD COLUMN broadcast_snapshot TEXT;`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE stream_sessions ADD COLUMN publisher_identity TEXT;`);
  } catch (e) {}

  for (const column of [
    'paystack_subscription_id TEXT',
    'paystack_customer_code TEXT',
    'paystack_status TEXT DEFAULT \'none\'',
    'paid_until TEXT',
    'cancel_at_period_end INTEGER DEFAULT 0'
  ]) {
    try {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${column};`);
    } catch (err) {}
  }

  db.exec(`
      CREATE TABLE IF NOT EXISTS paystack_checkouts (
        reference TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        plan_code TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        checkout_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
    `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paystack_payments (
      reference TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      customer_code TEXT NOT NULL,
      plan_code TEXT NOT NULL,
      mode TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      paid_until TEXT NOT NULL,
      UNIQUE(mode, transaction_id)
    );
    CREATE TABLE IF NOT EXISTS paystack_subscriptions (
      subscription_code TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      customer_code TEXT NOT NULL,
      plan_code TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0
    );
  `);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_webhook_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  } catch (e) {}

  // Migrate safely from legacy streaming_sessions without destructive data loss
  try {
    const legacySessions = db.prepare("SELECT * FROM streaming_sessions").all();
    for (const sess of legacySessions) {
      const exists = db.prepare("SELECT id FROM stream_sessions WHERE id = ?").get(sess.id);
      if (!exists) {
        db.prepare(`
          INSERT INTO stream_sessions (id, workspace_id, device_id, status, started_at, stopped_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sess.id, sess.workspace_id, sess.device_id, sess.status, sess.started_at, sess.stopped_at, sess.created_at);

        try {
          const dests = JSON.parse(sess.destinations || '[]');
          for (const destId of dests) {
            const ssdId = 'ssd_' + Math.random().toString(36).substring(2, 15);
            const targetType = destId.startsWith('crt_') ? 'custom' : 'provider';
            const ssdStatus = sess.status === 'stopped' ? 'stopped' : (sess.status === 'streaming' ? 'active' : 'pending');
            db.prepare(`
              INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, error_message, created_at)
              VALUES (?, ?, ?, ?, ?, NULL, ?)
            `).run(ssdId, sess.id, destId, targetType, ssdStatus, sess.created_at);
          }
        } catch (pe) {
          // ignore parsing error
        }
      }
    }
  } catch (e) {
    // legacy table might not exist or be empty yet
  }
}

export function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

export function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

export function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
  } catch (err) {
    console.error('SQL RUN ERROR:', { sql, params: '[REDACTED]', message: err.message });
    throw err;
  }
}

export function transaction(fn) {
  try {
    // Reserve the writer before transactional reads so concurrent processes
    // cannot both pass a capacity check and then write.
    db.exec('BEGIN IMMEDIATE');
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function logAudit({ workspaceId, userId = null, deviceId = null, action, details }) {
  const id = 'aud_' + Math.random().toString(36).substring(2, 15);
  run(
    `INSERT INTO audit_records (id, workspace_id, user_id, device_id, action, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, userId, deviceId, action, JSON.stringify(details), new Date().toISOString()]
  );
}
