import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const databasePath = path.join(os.tmpdir(), `emberstage-streaming-smoke-${process.pid}.db`);
const encryptionSecret = 'streaming-smoke-secret-at-least-32-bytes';
process.env.NODE_ENV = 'test'; // Never load local account/provider credentials into this synthetic test.
process.env.DATABASE_URL = databasePath;
process.env.ENCRYPTION_SECRET = encryptionSecret;
process.env.RTMP_INGEST_BASE_URL = 'rtmp://127.0.0.1:19350/live';
process.env.CONTRIBUTION_INGEST_URL = 'rtmp://127.0.0.1:19350/live';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
delete process.env.FAKE_WORKERS;

const [{ handleRequest }, { db, initDatabase }, { encrypt }, { workerManager }] = await Promise.all([
  import('../src/server.js'),
  import('../src/db.js'),
  import('../src/crypto-utils.js'),
  import('../src/worker-manager.js')
]);

const server = http.createServer(handleRequest);
let publisher;
let receiver;

function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for streaming state transition'));
      setTimeout(check, 100);
    };
    check();
  });
}

async function request(pathname, token, options = {}) {
  const response = await fetch(`http://127.0.0.1:3099${pathname}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  initDatabase();
  const now = new Date().toISOString();
  const workspaceId = 'ws_stream_smoke';
  const deviceId = 'dev_stream_smoke';
  const targetId = 'crt_stream_smoke';
  const accessToken = `da_${crypto.randomBytes(24).toString('hex')}`;
  const accessHash = crypto.createHash('sha256').update(accessToken).digest('hex');
  const ingestKey = `esk_${crypto.randomBytes(24).toString('base64url')}`;
  const ingestKeyHash = crypto.createHash('sha256').update(ingestKey).digest('hex');
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  db.run("INSERT INTO workspaces (id, name, stripe_status, max_devices, max_destinations, created_at) VALUES (?, ?, 'active', 2, 3, ?)", [workspaceId, 'Streaming Smoke', now]);
  db.run("INSERT INTO devices (id, workspace_id, name, status, ingest_key_hash, ingest_key_last4, ingest_key_rotated_at, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)", [deviceId, workspaceId, 'Smoke OBS', ingestKeyHash, ingestKey.slice(-4), now, now]);
  db.run('INSERT INTO device_sessions (id, device_id, refresh_token_hash, expires_at, refresh_token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [accessHash, deviceId, 'unused-smoke-refresh', expiry, expiry, now]);
  db.run('INSERT INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', [targetId, workspaceId, 'Local sink', 'rtmp://127.0.0.1:19350/sink', encrypt('smoke-output', encryptionSecret), now]);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3099, '127.0.0.1', resolve);
  });

  publisher = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '20',
    '-c:a', 'aac', '-f', 'flv', `rtmp://127.0.0.1:19350/live/${ingestKey}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  publisher.stderr.resume(); // URLs include ephemeral test keys; do not retain or print them.

  await waitFor(() => {
    const session = db.queryOne("SELECT id, status, started_at FROM stream_sessions WHERE device_id = ? AND status = 'streaming' ORDER BY created_at DESC LIMIT 1", [deviceId]);
    const worker = session && db.queryOne("SELECT status, pid FROM stream_workers WHERE stream_session_id = ? AND status = 'running'", [session.id]);
    return session?.started_at && worker?.pid ? { session, worker } : null;
  });

  const streamId = db.queryOne("SELECT id FROM stream_sessions WHERE device_id = ? AND status = 'streaming'", [deviceId]).id;
  const progressFields = {};
  for (const record of workerManager.activeWorkers.values()) record.child.stdout?.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      const [key, value] = line.split('=', 2);
      if (['total_size', 'out_time_us', 'frame', 'progress'].includes(key) && /^[\d.\s-]+$|^(N\/A|continue|end)$/.test(value)) progressFields[key] = value;
    }
  });

  // A PID alone cannot prove relay delivery. Decode real audio/video at the sink.
  receiver = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-rtmp_live', 'live', '-rw_timeout', '15000000',
    '-i', 'rtmp://127.0.0.1:19350/sink/smoke-output',
    '-t', '2', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let receiverProgress = '';
  receiver.stdout.on('data', chunk => { receiverProgress = (receiverProgress + chunk.toString()).slice(-8192); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      receiver.kill('SIGKILL');
      reject(new Error('Relay sink did not receive decodable audio/video within 25 seconds'));
    }, 25000);
    receiver.once('error', () => { clearTimeout(timeout); reject(new Error('Sink decoder failed to start')); });
    receiver.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('Sink decoder exited before delivery was verified'));
    });
  });
  assert.match(receiverProgress, /progress=end/);
  assert.ok([...receiverProgress.matchAll(/^frame=(\d+)$/gm)].some(match => Number(match[1]) > 0), 'Sink must decode actual video frames');
  await waitFor(() => workerManager.getDeliveryStatus(streamId, targetId).lastProgressAt, 6000).catch(() => {});
  const delivery = workerManager.getDeliveryStatus(streamId, targetId);
  assert.equal(delivery.relayState, 'relaying', `Relay progress fields: ${JSON.stringify(progressFields)}`);
  assert.ok(delivery.bytesWritten > 0);

  publisher.kill('SIGTERM');
  await waitFor(() => db.queryOne('SELECT status FROM stream_sessions WHERE id = ?', [streamId])?.status === 'stopped');
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ? AND status = 'running'", [streamId]).count, 0);
  console.log('PASS real NGINX-RTMP callbacks, decoded relay audio/video at sink, write-progress status, and disconnect cleanup');
} catch (error) {
  if (publisher && publisher.exitCode === null) publisher.kill('SIGKILL');
  throw error;
} finally {
  if (publisher && publisher.exitCode === null) publisher.kill('SIGKILL');
  if (receiver && receiver.exitCode === null) receiver.kill('SIGKILL');
  await workerManager.reconcileAfterRestart().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.rmSync(`${databasePath}-wal`, { force: true });
}
