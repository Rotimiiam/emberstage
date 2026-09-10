import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

process.env.DATABASE_URL = ':memory:';
process.env.ENCRYPTION_SECRET = 'worker-test-secret-not-a-live-credential';
const { db, initDatabase } = await import('../src/db.js');
const { WorkerManager, createFacebookSnapshot } = await import('../src/worker-manager.js');
const { nangoClient } = await import('../src/nango-client.js');
initDatabase();

let sequence = 0;
async function fixture({ withoutPid = false } = {}) {
  const id = `worker_test_${++sequence}`;
  const now = new Date().toISOString();
  db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [id, id, now]);
  db.run("INSERT INTO stream_sessions (id, workspace_id, status, created_at) VALUES (?, ?, 'streaming', ?)", [id, id, now]);
  db.run("INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, created_at) VALUES (?, ?, ?, 'provider', 'pending', ?)", [id, id, id, now]);
  const child = new EventEmitter();
  child.pid = withoutPid ? undefined : 1000 + sequence;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', 0); return true; };
  let captured;
  const manager = new WorkerManager((command, args, options) => {
    captured = { command, args, options };
    return child;
  });
  const workerId = await manager.startWorker(id, id, 'provider', {
    selected: 1, resolved_stream_url: 'rtmp://example.test/app', resolved_stream_key: 'private-destination-key'
  }, 'rtmp://127.0.0.1/live', 'private-contribution-key');
  return { id, workerId, manager, child, captured, status: () => manager.getDeliveryStatus(id, id) };
}

test('spawn does not imply delivery; complete advancing progress marks relaying', async () => {
  const f = await fixture();
  assert.equal(f.status().relayState, 'starting');
  assert.equal(db.queryOne('SELECT status FROM stream_session_destinations WHERE id = ?', [f.id]).status, 'pending');
  assert.deepEqual(f.captured.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(f.captured.args.includes('pipe:1'));
  f.child.stdout.write('total_size=1024\nout_time_us=1000000\npro');
  assert.equal(f.status().relayState, 'starting', 'partial progress record is not confirmation');
  f.child.stdout.write('gress=continue\n');
  assert.equal(f.status().relayState, 'relaying');
  assert.equal(f.status().bytesWritten, 1024);
  assert.equal(db.queryOne('SELECT status FROM stream_session_destinations WHERE id = ?', [f.id]).status, 'active');
  const record = f.manager.activeWorkers.get(f.workerId);
  record.lastProgressAt = Date.now() - 16000;
  f.child.stdout.write('total_size=1024\nout_time_us=1000000\nprogress=continue\n');
  assert.equal(f.status().relayState, 'stalled', 'unchanged counters must not refresh liveness');
  f.child.stdout.write('total_size=2048\nout_time_us=2000000\nprogress=continue\n');
  assert.equal(f.status().relayState, 'relaying');
  assert.ok(!JSON.stringify(f.status()).includes('private-'));
  await f.manager.stopWorkersForSession(f.id);
  assert.equal(f.status().relayState, 'stopped');
  assert.equal(f.manager.activeWorkers.size, 0);
});

test('malformed progress cannot mark delivery and stderr retains no secrets', async () => {
  const f = await fixture();
  f.child.stdout.write('total_size=NaN\nout_time_us=1000\nprogress=continue\n');
  f.child.stdout.write('x'.repeat(20000));
  assert.equal(f.status().relayState, 'starting');
  f.child.stderr.write('Server returned 403 Forbidden: rtmp://example.test/private-destination-key');
  f.child.emit('exit', 1);
  assert.equal(f.status().relayState, 'failed');
  const destination = db.queryOne('SELECT status, error_message FROM stream_session_destinations WHERE id = ?', [f.id]);
  assert.equal(destination.error_message, 'Relay authentication was rejected');
  assert.ok(!JSON.stringify(destination).includes('private-destination-key'));
});

test('spawn error is failed, and starting worker becomes stalled without progress', async () => {
  const f = await fixture({ withoutPid: true });
  assert.equal(db.queryOne('SELECT pid FROM stream_workers WHERE id = ?', [f.workerId]).pid, null);
  f.manager.activeWorkers.get(f.workerId).createdAt -= 16000;
  assert.equal(f.status().relayState, 'stalled');
  f.child.emit('error', new Error('Secret-bearing child error must not be exposed'));
  assert.equal(f.status().relayState, 'failed');
  assert.equal(db.queryOne('SELECT error_message FROM stream_session_destinations WHERE id = ?', [f.id]).error_message, 'Relay process failed to start');
});

test('Restart reconciliation cleans up Facebook live videos even with zero running workers and removed targets', async () => {
  const wsId = 'ws-reconcile-test';
  const sessId = 'sess-reconcile-test';
  const destId = 'dest-reconcile-test';
  const now = new Date().toISOString();

  // Insert session and a destination in failed state with a valid Facebook broadcast snapshot
  db.run("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Reconcile Test', ?)", [wsId, now]);
  db.run("INSERT INTO stream_sessions (id, workspace_id, status, created_at) VALUES (?, ?, 'stopped', ?)", [sessId, wsId, now]);
  
  const snap = JSON.stringify(createFacebookSnapshot({ id: sessId, workspace_id: wsId }, { id: destId, target_id: 'target-removed-id' }, 'fb-page-reconcile-abc', 'fb-video-reconcile-123', 'connection-reconcile'));
  db.run("INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, broadcast_snapshot, created_at) VALUES (?, ?, 'target-removed-id', 'provider', 'failed', ?, ?)", [destId, sessId, snap, now]);

  // Mock endFacebookLiveVideo on nangoClient
  const { nangoClient } = await import('../src/nango-client.js');
  const originalEnd = nangoClient.endFacebookLiveVideo;
  let endCalled = false;
  let receivedPageId = null;
  let receivedLiveVideoId = null;

  nangoClient.endFacebookLiveVideo = async (workspaceId, pageId, liveVideoId) => {
    endCalled = true;
    receivedPageId = pageId;
    receivedLiveVideoId = liveVideoId;
    return { success: true };
  };

  const manager = new WorkerManager();
  try {
    await manager.reconcileAfterRestart();

    assert.equal(endCalled, true);
    assert.equal(receivedPageId, 'fb-page-reconcile-abc');
    assert.equal(receivedLiveVideoId, 'fb-video-reconcile-123');

    // Verify destination was moved to stopped after successful cleanup
    const updatedDest = db.queryOne("SELECT status FROM stream_session_destinations WHERE id = ?", [destId]);
    assert.equal(updatedDest.status, 'stopped');
  } finally {
    nangoClient.endFacebookLiveVideo = originalEnd;
  }
});

test('restart retries failed cleanup once per pass without workers, including crash after snapshot before spawn', async () => {
  const id = 'fb-before-spawn';
  const now = new Date().toISOString();
  db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [id, id, now]);
  db.run("INSERT INTO stream_sessions (id, workspace_id, status, created_at) VALUES (?, ?, 'streaming', ?)", [id, id, now]);
  const snapshot = createFacebookSnapshot({ id, workspace_id: id }, { id, target_id: 'removed-target' }, 'external-page', 'external-video', 'original-connection');
  db.run("INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, broadcast_snapshot, created_at) VALUES (?, ?, 'removed-target', 'provider', 'pending', ?, ?)", [id, id, JSON.stringify(snapshot), now]);
  const original = nangoClient.endFacebookLiveVideo;
  let attempts = 0;
  let fail = true;
  nangoClient.endFacebookLiveVideo = async (...args) => {
    attempts++;
    assert.deepEqual(args, [id, 'external-page', 'external-video', 'original-connection']);
    if (fail) throw new Error('SECRET_UPSTREAM_TOKEN');
    return { success: true };
  };
  const manager = new WorkerManager();
  try {
    assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?', [id]).count, 0);
    assert.deepEqual(await manager.reconcileAfterRestart(), { cleanupPending: 1 });
    assert.equal(attempts, 1);
    const failed = db.queryOne('SELECT * FROM stream_session_destinations WHERE id = ?', [id]);
    assert.equal(failed.status, 'failed');
    assert.equal(JSON.parse(failed.broadcast_snapshot).cleanupState, 'pending');
    assert.ok(!JSON.stringify(failed).includes('SECRET_'));
    assert.equal(db.queryOne('SELECT status FROM stream_sessions WHERE id = ?', [id]).status, 'stopped');
    fail = false;
    assert.deepEqual(await manager.reconcileAfterRestart(), { cleanupPending: 0 });
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(db.queryOne('SELECT broadcast_snapshot FROM stream_session_destinations WHERE id = ?', [id]).broadcast_snapshot).cleanupState, 'ended');
    await manager.reconcileAfterRestart();
    assert.equal(attempts, 2, 'confirmed end is not retried');
  } finally { nangoClient.endFacebookLiveVideo = original; }
});

test('forged, cross-tenant and cross-session snapshots cannot end remote objects', async () => {
  const id = 'fb-forged-snapshot';
  const now = new Date().toISOString();
  db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [id, id, now]);
  db.run("INSERT INTO stream_sessions (id, workspace_id, status, created_at) VALUES (?, ?, 'stopped', ?)", [id, id, now]);
  const session = { id, workspace_id: id };
  const destination = { id, target_id: 'deleted-target' };
  const good = createFacebookSnapshot(session, destination, 'external-page', 'owned-video', 'connection');
  db.run("INSERT INTO stream_session_destinations (id, stream_session_id, target_id, target_type, status, created_at) VALUES (?, ?, ?, 'provider', 'failed', ?)", [id, id, destination.target_id, now]);
  const original = nangoClient.endFacebookLiveVideo;
  let calls = 0;
  nangoClient.endFacebookLiveVideo = async () => { calls++; return { success: true }; };
  const manager = new WorkerManager();
  try {
    for (const change of [{ id: 'forged-video' }, { pageId: 'other-page' }, { workspaceId: 'other-workspace' }, { sessionId: 'other-session' }, { destinationId: 'other-destination' }, { connectionId: 'other-connection' }, { signature: undefined }]) {
      db.run('UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify({ ...good, ...change }), id]);
      await assert.rejects(manager.cleanupFacebookDestination(session, destination), /cleanup pending/);
    }
    assert.equal(calls, 0);
    db.run('UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify(good), id]);
    await Promise.all([manager.cleanupFacebookDestination(session, destination), manager.cleanupFacebookDestination(session, destination)]);
    assert.equal(calls, 1, 'concurrent cleanup coalesces');
  } finally { nangoClient.endFacebookLiveVideo = original; }
});

test('unexpected Facebook encoder failure immediately attempts exact snapshot cleanup', async () => {
  const f = await fixture();
  const snapshot = createFacebookSnapshot({ id: f.id, workspace_id: f.id }, { id: f.id, target_id: f.id }, 'page-on-exit', 'video-on-exit', 'connection-on-exit');
  db.run('UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify(snapshot), f.id]);
  const original = nangoClient.endFacebookLiveVideo;
  let calls = 0;
  nangoClient.endFacebookLiveVideo = async (...args) => {
    calls++;
    assert.deepEqual(args, [f.id, 'page-on-exit', 'video-on-exit', 'connection-on-exit']);
    return { success: true };
  };
  try {
    f.child.emit('error', new Error('SECRET_CHILD_ERROR'));
    f.child.emit('exit', 1);
    await Promise.all([...f.manager.facebookCleanups.values()]);
    assert.equal(calls, 1);
    const destination = db.queryOne('SELECT * FROM stream_session_destinations WHERE id = ?', [f.id]);
    assert.equal(JSON.parse(destination.broadcast_snapshot).cleanupState, 'ended');
    assert.ok(!JSON.stringify(destination).includes('SECRET_'));
  } finally { nangoClient.endFacebookLiveVideo = original; }
});
