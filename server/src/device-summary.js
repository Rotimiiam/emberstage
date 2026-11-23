// Read-only, exact device scope; never select credentials or provider target URLs.
export function installDeviceSummary({ addRoute, json, db, getStrictWorkspaceEntitlement }) {
  addRoute('GET', '/api/device/summary', (req, res) => {
    const reply = (body, code = 200) => json(res, body, code, { 'Cache-Control': 'no-store' });
    const auth = req.authContext;
    if (auth?.type !== 'device' || auth.device.status !== 'active') {
      return reply({ error: 'ACCOUNT_UNAUTHORIZED' }, 401);
    }
    try {
      const workspace = db.queryOne('SELECT id, name FROM workspaces WHERE id = ?', [auth.workspaceId]);
      if (!workspace || auth.device.workspace_id !== workspace.id) return reply({ error: 'ACCOUNT_UNAUTHORIZED' }, 401);
      const now = Date.now();
      // The standing guard checks expiry; also fail closed on malformed/equal timestamps here.
      const bearer = req.headers.authorization?.slice(7).trim();
      const session = db.queryOne('SELECT expires_at FROM device_sessions WHERE device_id = ? AND id = ?',
        [auth.device.id, dbTokenHash(bearer)]);
      const accessEnd = Date.parse(session?.expires_at);
      if (!Number.isFinite(accessEnd) || accessEnd <= now) return reply({ error: 'ACCOUNT_UNAUTHORIZED' }, 401);
      const entitlement = getStrictWorkspaceEntitlement(workspace.id);
      const paidEnd = Date.parse(entitlement.paidUntil);
      const pro = entitlement.plan === 'pro' && entitlement.canStream === true && Number.isFinite(paidEnd) && paidEnd > now;
      const validEnd = Math.min(now + 60000, accessEnd, pro ? paidEnd : Infinity);
      const clamp = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
      const destinations = db.queryAll(`SELECT t.id, t.provider, COALESCE(c.status, 'disconnected') AS status
        FROM provider_targets t LEFT JOIN provider_connections c ON c.id = t.provider_connection_id AND c.workspace_id = t.workspace_id
        WHERE t.workspace_id = ?
        UNION ALL SELECT id, 'custom' AS provider, 'configured' AS status FROM custom_rtmp_targets WHERE workspace_id = ?
        ORDER BY id LIMIT 3`, [workspace.id, workspace.id]);
      const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
      if (!identity(auth.device.id) || !identity(workspace.id) || destinations.some(d => !identity(d.id) ||
        !['twitch', 'youtube', 'facebook', 'custom'].includes(d.provider) || !['connected', 'disconnected', 'configured'].includes(d.status))) {
        return reply({ error: 'ACCOUNT_SUMMARY_UNAVAILABLE' }, 503);
      }
      // Labels are display-only, bounded and stripped of control characters.
      const label = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
      return reply({ success: true, deviceId: auth.device.id, workspaceId: workspace.id,
        deviceLabel: label(auth.device.name), workspaceLabel: label(workspace.name),
        plan: pro ? 'pro' : 'free', paidUntil: Number.isFinite(paidEnd) ? new Date(paidEnd).toISOString() : null,
        ceilings: { maxDevices: pro ? clamp(entitlement.maxDevices, 3) : 0,
          maxDestinations: pro ? clamp(entitlement.maxDestinations, 3) : 0,
          maxActiveBroadcasts: pro ? clamp(entitlement.maxActiveBroadcasts, 1) : 0 },
        // Pro is not proof that hosted OAuth is available. Until explicit hosted
        // availability is supplied safely, conservatively advertise it as absent.
        features: { streaming: pro, destinations: pro, oauthDestinations: false }, destinations,
        observedAt: new Date(now).toISOString(), validUntil: new Date(validEnd).toISOString() });
    } catch {
      return reply({ error: 'ACCOUNT_SUMMARY_UNAVAILABLE' }, 503);
    }
  }, ['operator'], true, 'device');
}

import { createHash } from 'node:crypto';
function dbTokenHash(token) { return createHash('sha256').update(token || '').digest('hex'); }
