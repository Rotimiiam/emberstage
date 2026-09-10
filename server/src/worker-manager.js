import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { decrypt } from './crypto-utils.js';
import { config } from './config.js';
import { nangoClient } from './nango-client.js';

// Authenticate the immutable identity, not mutable relay/remote status. No token is stored.
function facebookSnapshotSignature(snapshot) {
  return crypto.createHmac('sha256', config.ENCRYPTION_SECRET).update(JSON.stringify([
    snapshot.provider, snapshot.workspaceId, snapshot.sessionId, snapshot.destinationId,
    snapshot.targetId, snapshot.pageId, snapshot.id, snapshot.connectionId
  ])).digest('hex');
}

export function createFacebookSnapshot(session, destination, pageId, liveVideoId, connectionId) {
  if (![pageId, liveVideoId, connectionId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Facebook live ownership metadata is missing');
  const snapshot = {
    provider: 'facebook', workspaceId: session.workspace_id, sessionId: session.id,
    destinationId: destination.id, targetId: destination.target_id,
    pageId, id: liveVideoId, connectionId, status: 'created', cleanupState: 'pending'
  };
  return { ...snapshot, signature: facebookSnapshotSignature(snapshot) };
}

export function readFacebookSnapshot(session, destination) {
  let snapshot;
  try { snapshot = JSON.parse(destination.broadcast_snapshot || 'null'); }
  catch { throw new Error('Invalid broadcast cleanup snapshot'); }
  if (snapshot?.provider !== 'facebook') return null;
  if (destination.target_type !== 'provider' || snapshot.workspaceId !== session.workspace_id ||
      snapshot.sessionId !== session.id || snapshot.destinationId !== destination.id ||
      snapshot.targetId !== destination.target_id || !snapshot.pageId || !snapshot.id || !snapshot.connectionId ||
      snapshot.signature !== facebookSnapshotSignature(snapshot)) {
    throw new Error('Facebook cleanup ownership binding is invalid; manual recovery required');
  }
  return snapshot;
}

export class WorkerManager {
  constructor(spawnFn = spawn) {
    this.spawn = spawnFn;
    this.activeWorkers = new Map(); // key: workerDbId -> childProcess or mock
    this.facebookCleanups = new Map();
  }

  // Local write progress proves a relay is moving bytes, not that a platform is live.
  getDeliveryStatus(streamSessionId, destinationId) {
    const record = [...this.activeWorkers.values()].find(item =>
      item.streamSessionId === streamSessionId && item.destinationId === destinationId);
    if (record) {
      const stale = Date.now() - (record.lastProgressAt || record.createdAt) > 15000;
      return {
        relayState: record.stopping ? 'stopped' : stale ? 'stalled' : record.lastProgressAt ? 'relaying' : 'starting',
        lastProgressAt: record.lastProgressAt ? new Date(record.lastProgressAt).toISOString() : null,
        bytesWritten: record.bytesWritten
      };
    }
    const worker = db.queryOne(
      'SELECT status FROM stream_workers WHERE stream_session_id = ? AND destination_id = ? ORDER BY created_at DESC LIMIT 1',
      [streamSessionId, destinationId]
    );
    return { relayState: ['failed', 'stopped'].includes(worker?.status) ? worker.status : 'unknown', lastProgressAt: null, bytesWritten: 0 };
  }

  reconcileSessionAfterUnexpectedExit(streamSessionId) {
    const running = db.queryOne(
      "SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ? AND status = 'running'",
      [streamSessionId]
    );
    if (Number(running?.count || 0) !== 0) return;
    const now = new Date().toISOString();
    db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'streaming'", [now, streamSessionId]);
    db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'streaming'", [now, streamSessionId]);
  }

  async cleanupFacebookDestination(session, destination) {
    if (this.facebookCleanups.has(destination.id)) return this.facebookCleanups.get(destination.id);
    const operation = (async () => {
      const latest = db.queryOne('SELECT * FROM stream_session_destinations WHERE id = ? AND stream_session_id = ?', [destination.id, session.id]);
      if (!latest) throw new Error('Facebook cleanup destination is missing');
      try {
        const snapshot = readFacebookSnapshot(session, latest);
        if (!snapshot || snapshot.cleanupState === 'ended') return;
        await nangoClient.endFacebookLiveVideo(session.workspace_id, snapshot.pageId, snapshot.id, snapshot.connectionId);
        db.run("UPDATE stream_session_destinations SET status = 'stopped', error_message = NULL, broadcast_snapshot = ? WHERE id = ?", [JSON.stringify({ ...snapshot, cleanupState: 'ended' }), latest.id]);
      } catch {
        db.run("UPDATE stream_session_destinations SET status = 'failed', error_message = 'Facebook live cleanup pending; retry stop after restoring the original connection and Page permissions' WHERE id = ?", [latest.id]);
        throw new Error('Facebook live cleanup pending; retry stop after restoring the original connection and Page permissions');
      }
    })();
    this.facebookCleanups.set(destination.id, operation);
    try { return await operation; }
    finally { this.facebookCleanups.delete(destination.id); }
  }

  cleanupFacebookAfterExit(streamSessionId, destinationId) {
    const session = db.queryOne('SELECT * FROM stream_sessions WHERE id = ?', [streamSessionId]);
    const destination = db.queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [streamSessionId, destinationId]);
    if (session && destination?.broadcast_snapshot) {
      this.cleanupFacebookDestination(session, destination).catch(() => {
        console.error('[Facebook] Remote cleanup pending after relay exit; retry stop.');
      });
    }
  }

  // Starts a worker for a destination
  async startWorker(streamSessionId, destinationId, targetType, target, ingestUrl, streamKey) {
    // Validate target and connection
    if (!target) {
      throw new Error(`Target ${destinationId} not found`);
    }
    if (target.selected !== 1) {
      throw new Error(`Target ${destinationId} is not selected`);
    }

    let destUrl = '';
    let destKey = '';

    if (targetType === 'custom') {
      destUrl = target.stream_url;
      destKey = decrypt(target.encrypted_stream_key, config.ENCRYPTION_SECRET);
      if (!destKey) {
        throw new Error(`Failed to decrypt stream key for custom target ${destinationId}`);
      }
    } else {
      destUrl = target.resolved_stream_url;
      destKey = target.resolved_stream_key;
      if (!destUrl || !destKey) throw new Error(`Provider credentials for target ${destinationId} could not be resolved`);
    }

    if (!streamKey) {
      throw new Error('Contribution stream key is required');
    }

    const workerId = 'sw_' + Math.random().toString(36).substring(2, 15);
    const destinationFullUrl = `${destUrl.replace(/\/+$/, '')}/${destKey.replace(/^\/+/, '')}`;
    const localIngestUrl = `${ingestUrl.replace(/\/+$/, '')}/${streamKey}`;

    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'error', '-nostats',
      '-progress', 'pipe:1', '-stats_period', '1',
      '-rtmp_live', 'live',
      '-i', localIngestUrl,
      '-c', 'copy',
      '-f', 'flv',
      destinationFullUrl
    ];

    let child;
    let pid = null;
    try {
      if (this.spawn === spawn && (process.env.FAKE_WORKERS === 'true' || config.DATABASE_URL === ':memory:')) {
        // Mock worker
        child = {
          pid: Math.floor(Math.random() * 10000) + 1000,
          kill: (sig) => {
            child.killed = true;
            if (child.onexit) child.onexit(0);
          },
          on: (event, cb) => {
            if (event === 'exit') {
              child.onexit = cb;
            }
          }
        };
      } else {
        child = this.spawn(config.FFMPEG_PATH, ffmpegArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, EMBERSTAGE_WORKER_ID: workerId }
        });
      }
      pid = child.pid ?? null;
    } catch (err) {
      db.run(
        `INSERT INTO stream_workers (id, stream_session_id, destination_id, pid, status, created_at)
         VALUES (?, ?, ?, NULL, 'failed', ?)`,
        [workerId, streamSessionId, destinationId, new Date().toISOString()]
      );
      throw new Error('Failed to spawn ffmpeg relay worker');
    }

    db.run(
      `INSERT INTO stream_workers (id, stream_session_id, destination_id, pid, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [workerId, streamSessionId, destinationId, pid, new Date().toISOString()]
    );

    const record = {
      child, streamSessionId, destinationId, stopping: false, resolveExit: null,
      createdAt: Date.now(), lastProgressAt: null, bytesWritten: 0, mediaTime: 0,
      errorMessage: 'Relay process exited unexpectedly'
    };
    this.activeWorkers.set(workerId, record);

    let progressBuffer = '';
    let progress = {};
    child.stdout?.on('data', chunk => {
      progressBuffer += chunk.toString();
      // FFmpeg values are tiny. Discard malformed/oversized lines rather than retain them.
      if (progressBuffer.length > 16384) { progressBuffer = ''; progress = {}; return; }
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.trim().split('=', 2);
        if (key === 'total_size' || key === 'out_time_us') progress[key] = Number(value);
        if (key !== 'progress') continue;
        const bytes = progress.total_size;
        const mediaTime = progress.out_time_us;
        if (Number.isFinite(bytes) && Number.isFinite(mediaTime) && bytes > record.bytesWritten && mediaTime > record.mediaTime) {
          record.bytesWritten = bytes;
          record.mediaTime = mediaTime;
          record.lastProgressAt = Date.now();
          if (!record.stopping) db.run(
            "UPDATE stream_session_destinations SET status = 'active', error_message = NULL WHERE stream_session_id = ? AND target_id = ? AND status = 'pending'",
            [streamSessionId, destinationId]
          );
        }
        progress = {};
      }
    });
    // Drain stderr continuously. Keep only fixed classifications, never URL/key-bearing output.
    child.stderr?.on('data', chunk => {
      const message = chunk.toString().slice(0, 8192).toLowerCase();
      if (/unauthorized|forbidden|authentication|403|401/.test(message)) record.errorMessage = 'Relay authentication was rejected';
      else if (/connection refused|connection timed out|network is unreachable|failed to resolve/.test(message)) record.errorMessage = 'Relay network connection failed';
      else if (/codec.*not.*supported|invalid.*codec|could not write header/.test(message)) record.errorMessage = 'Relay media format is not supported';
      else if (/input\/output error|error opening input/.test(message)) record.errorMessage = 'Relay media connection failed';
    });

    if (child.on) {
      child.on('error', () => {
        db.run(`UPDATE stream_workers SET status = 'failed' WHERE id = ?`, [workerId]);
        db.run(
          `UPDATE stream_session_destinations SET status = 'failed', error_message = 'Relay process failed to start' WHERE stream_session_id = ? AND target_id = ?`,
          [streamSessionId, destinationId]
        );
        this.activeWorkers.delete(workerId);
        this.reconcileSessionAfterUnexpectedExit(streamSessionId);
        this.cleanupFacebookAfterExit(streamSessionId, destinationId);
        if (record.resolveExit) record.resolveExit();
      });
      child.on('exit', () => {
        const finalStatus = record.stopping ? 'stopped' : 'failed';
        db.run(`UPDATE stream_workers SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE ? END WHERE id = ?`, [finalStatus, workerId]);
        if (!record.stopping) {
          db.run(
            `UPDATE stream_session_destinations SET status = 'failed', error_message = ? WHERE stream_session_id = ? AND target_id = ?`,
            [record.errorMessage, streamSessionId, destinationId]
          );
        }
        this.activeWorkers.delete(workerId);
        if (!record.stopping) {
          this.reconcileSessionAfterUnexpectedExit(streamSessionId);
          this.cleanupFacebookAfterExit(streamSessionId, destinationId);
        }
        if (record.resolveExit) record.resolveExit();
      });
    }

    return workerId;
  }

  // Stops all workers belonging to that exact workspace/session and marks state.
  async stopWorkersForSession(streamSessionId) {
    const workers = db.queryAll('SELECT * FROM stream_workers WHERE stream_session_id = ? AND status = ?', [
      streamSessionId,
      'running'
    ]);

    for (const w of workers) {
      const record = this.activeWorkers.get(w.id);
      if (record) {
        record.stopping = true;
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            clearTimeout(failureTimer);
            resolve();
          };
          record.resolveExit = finish;
          const forceTimer = setTimeout(() => {
            try { record.child.kill('SIGKILL'); } catch {}
          }, 3000);
          const failureTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`Relay worker ${w.id} did not exit after termination signals`));
          }, 5000);
          try {
            record.child.kill('SIGTERM');
          } catch (error) {
            clearTimeout(forceTimer);
            clearTimeout(failureTimer);
            reject(error);
          }
        });
      } else if (w.pid && this.isOwnedWorkerProcess(w.pid, w.id)) {
        await this.stopOwnedProcess(w.pid, w.id);
      } else if (w.pid && this.isProcessAlive(w.pid)) {
        throw new Error(`Refusing to terminate unverified process for relay worker ${w.id}`);
      }
      db.run(`UPDATE stream_workers SET status = 'stopped' WHERE id = ?`, [w.id]);
    }
  }

  async reconcileAfterRestart() {
    // Include snapshots created before spawn and failed cleanup on already-stopped sessions.
    const sessions = db.queryAll(
      `SELECT s.* FROM stream_sessions s WHERE s.status IN ('reserved', 'streaming')
       OR EXISTS (SELECT 1 FROM stream_workers w WHERE w.stream_session_id = s.id AND w.status = 'running')
       OR EXISTS (SELECT 1 FROM stream_session_destinations d WHERE d.stream_session_id = s.id AND d.broadcast_snapshot IS NOT NULL AND d.status != 'stopped')`
    );
    const stoppedAt = new Date().toISOString();
    let cleanupPending = 0;
    for (const session of sessions) {
      const streamSessionId = session.id;
      await this.stopWorkersForSession(streamSessionId);
      const destinations = db.queryAll('SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND broadcast_snapshot IS NOT NULL', [streamSessionId]);
      for (const dest of destinations) {
        try { await this.cleanupFacebookDestination(session, dest); }
        catch { cleanupPending++; }
      }

      db.transaction(() => {
        db.run("UPDATE stream_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status != 'stopped'", [stoppedAt, streamSessionId]);
        db.run("UPDATE streaming_sessions SET status = 'stopped', stopped_at = ? WHERE id = ? AND status != 'stopped'", [stoppedAt, streamSessionId]);
        db.run("UPDATE stream_session_destinations SET status = 'stopped' WHERE stream_session_id = ? AND status != 'failed'", [streamSessionId]);
      });
    }

    if (cleanupPending) console.error(`[Facebook] ${cleanupPending} remote cleanup(s) pending; retry stop.`);
    return { cleanupPending };
  }

  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  isOwnedWorkerProcess(pid, workerId) {
    if (process.platform !== 'linux') return false;
    try {
      const executable = path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
      const expected = path.basename(config.FFMPEG_PATH);
      const environment = fs.readFileSync(`/proc/${pid}/environ`);
      return executable.startsWith(expected) && environment.includes(Buffer.from(`EMBERSTAGE_WORKER_ID=${workerId}\0`));
    } catch {
      return false;
    }
  }

  async stopOwnedProcess(pid, workerId) {
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!this.isProcessAlive(pid)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!this.isOwnedWorkerProcess(pid, workerId)) {
      throw new Error(`Relay worker ${workerId} ownership changed during shutdown`);
    }
    process.kill(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!this.isProcessAlive(pid)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Relay worker ${workerId} remained alive after SIGKILL`);
  }
}

export const workerManager = new WorkerManager();
