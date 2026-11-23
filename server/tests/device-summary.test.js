import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = ':memory:';
process.env.ENCRYPTION_SECRET = 'synthetic-summary-fixture-not-a-real-credential';
process.env.FAKE_WORKERS = 'true';
process.env.APP_BASE_URL = 'https://account.example';
// Fail before any accidental external I/O. Tests call the handler without sockets.
let externalFetches = 0;
globalThis.fetch = async () => { externalFetches++; throw new Error('SYNTHETIC_EXTERNAL_IO_FORBIDDEN'); };
const { handleRequest } = await import('../src/server.js');
const db = await import('../src/db.js');
const { nangoClient } = await import('../src/nango-client.js');
const { workerManager, createFacebookSnapshot } = await import('../src/worker-manager.js');
db.initDatabase();
const now = new Date().toISOString();
const future = new Date(Date.now() + 3600000).toISOString();
const token = 'da_synthetic_summary_access';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
db.run('INSERT INTO workspaces (id,name,created_at,paid_until,paystack_status) VALUES (?,?,?,?,?)', ['ws_summary','Synthetic',now,future,'active']);
db.run("INSERT INTO workspaces (id,name,created_at) VALUES ('ws_other','Other',?)", [now]);
db.run("INSERT INTO devices (id,workspace_id,name,status,created_at,ingest_key_hash,ingest_key_last4) VALUES ('dev_summary','ws_summary','Synthetic','active',?,'DO_NOT_EXPOSE_HASH','NOPE')", [now]);
db.run('INSERT INTO device_sessions (id,device_id,refresh_token_hash,expires_at,refresh_token_expires_at,created_at) VALUES (?,?,?,?,?,?)', [tokenHash,'dev_summary','DO_NOT_EXPOSE_REFRESH',future,future,now]);
db.run("INSERT INTO provider_connections (id,workspace_id,provider,encrypted_tokens,status,updated_at) VALUES ('conn_summary','ws_summary','youtube','DO_NOT_EXPOSE_PROVIDER','connected',?)", [now]);
db.run("INSERT INTO provider_targets (id,workspace_id,provider_connection_id,provider,external_id,name,created_at) VALUES ('target_summary','ws_summary','conn_summary','youtube','DO_NOT_EXPOSE_EXTERNAL','Synthetic',?)", [now]);

async function request(path = '/api/device/summary', headers = { authorization: `Bearer ${token}` }, method = 'GET') {
  const req = Readable.from([]); req.url = path; req.method = method;
  req.headers = { host: 'account.example', origin: 'https://account.example', ...headers };
  req.socket = { encrypted: true, remoteAddress: '192.0.2.1' };
  const res = { status: 0, headers: {}, body: '', setHeader(k,v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status,headers = {}) { this.status = status; for (const [k,v] of Object.entries(headers)) this.setHeader(k,v); }, end(body = '') { this.body = String(body); } };
  await handleRequest(req,res); return { ...res, data: JSON.parse(res.body) };
}

test('exact device scope and paid summary are bounded, no credentials or provider URLs', async () => {
  const r = await request(); assert.equal(r.status,200); assert.equal(r.headers['cache-control'],'no-store');
  assert.equal(r.data.deviceId,'dev_summary'); assert.equal(r.data.workspaceId,'ws_summary');
  assert.equal(r.data.plan,'pro'); assert.deepEqual(r.data.ceilings,{maxDevices:3,maxDestinations:3,maxActiveBroadcasts:1});
  assert.deepEqual(r.data.destinations,[{id:'target_summary',provider:'youtube',status:'connected'}]);
  assert.deepEqual(Object.keys(r.data).sort(),['success','deviceId','workspaceId','deviceLabel','workspaceLabel','plan','paidUntil','ceilings','features','destinations','observedAt','validUntil'].sort());
  assert.ok(Date.parse(r.data.validUntil)-Date.parse(r.data.observedAt)<=60000);
  assert.ok(!r.body.includes('DO_NOT_EXPOSE') && !r.body.includes(token));
  // Query parameters cannot select another workspace; only authenticated device scope does.
  assert.equal((await request('/api/device/summary?workspaceId=ws_other')).data.workspaceId,'ws_summary');
  assert.equal((await request('/api/workspaces/ws_other/devices')).status,403);
  assert.equal((await request('/api/device/summary',{})).status,401);
  db.run("INSERT INTO users (id,email,password_hash,created_at) VALUES ('user_summary','synthetic@example.invalid','synthetic',?)", [now]);
  db.run("INSERT INTO web_sessions (id,user_id,csrf_secret,expires_at) VALUES ('web_summary','user_summary','synthetic',?)", [future]);
  assert.equal((await request('/api/device/summary',{cookie:'session_id=web_summary'})).status,401);
});

test('device and workspace stream status allowlist every provider and never serialize raw secrets', async () => {
  const idle = await request('/api/device/stream-status');
  assert.equal(idle.status,200);
  assert.deepEqual(idle.data,{success:true,stream:null,destinations:[]});
  const secret = 'SYNTHETIC_STATUS_SECRET_SENTINEL';
  const raw = {
    stream_url: `rtmps://example.invalid/${secret}`, stream_key: secret,
    access_token: secret, streamUrl: secret, streamKey: secret, encrypted_stream_key: secret,
    url: secret, permalink_url: `https://example.invalid/${secret}`,
    title: secret, description: secret, connectionId: secret,
    broadcast: { id: secret, nested: { token: secret } },
    broadcast_snapshot: { secret }, arbitrary: [{ nested: { secret } }]
  };
  const session = { id: 'stream_summary', workspace_id: 'ws_summary' };
  db.run('INSERT INTO stream_sessions (id,workspace_id,device_id,status,started_at,created_at) VALUES (?,?,?,?,?,?)',
    [session.id,session.workspace_id,'dev_summary','streaming',now,now]);
  for (const provider of ['youtube','facebook','twitch','custom']) {
    const targetId = `status_${provider}`;
    const destination = { id: `destination_${provider}`, target_id: targetId, target_type: provider === 'custom' ? 'custom' : 'provider' };
    if (provider === 'custom') {
      db.run('INSERT INTO custom_rtmp_targets (id,workspace_id,name,stream_url,encrypted_stream_key,created_at) VALUES (?,?,?,?,?,?)',
        [targetId,session.workspace_id,'Custom fixture',raw.stream_url,secret,now]);
    } else {
      const connectionId = provider === 'youtube' ? 'conn_summary' : `connection_${provider}`;
      if (provider !== 'youtube') db.run('INSERT INTO provider_connections (id,workspace_id,provider,encrypted_tokens,status,updated_at) VALUES (?,?,?,?,?,?)',
        [connectionId,session.workspace_id,provider,secret,'connected',now]);
      db.run('INSERT INTO provider_targets (id,workspace_id,provider_connection_id,provider,external_id,name,broadcast_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [targetId,session.workspace_id,connectionId,provider,`external_${provider}`,`${provider} fixture`,JSON.stringify(raw),now]);
    }
    const snapshot = provider === 'facebook'
      ? { ...raw, ...createFacebookSnapshot(session,destination,'page-safe','fb-safe','connection_facebook') }
      : { ...raw, id: `${provider}-safe`, provider, lifeCycleStatus: 'ready' };
    db.run('INSERT INTO stream_session_destinations (id,stream_session_id,target_id,target_type,status,error_message,broadcast_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [destination.id,session.id,targetId,destination.target_type,provider === 'facebook' ? 'failed' : 'active',secret,JSON.stringify(snapshot),now]);
  }
  const originals = { youtube: nangoClient.youtubeApiRequest, facebook: nangoClient.getFacebookLiveVideoStatus, delivery: workerManager.getDeliveryStatus };
  let hostile = false;
  let providerReads = 0;
  nangoClient.youtubeApiRequest = async (_workspaceId,path) => {
    providerReads++;
    return path.startsWith('/liveBroadcasts')
      ? { ...raw, items: [{ ...raw, status: { ...raw, lifeCycleStatus: hostile ? { secret } : 'live' }, contentDetails: { ...raw, boundStreamId: 'yt-stream-safe' } }] }
      : { ...raw, items: [{ ...raw, status: { ...raw, streamStatus: hostile ? secret : 'active', healthStatus: { ...raw, status: hostile ? { secret } : 'good' } } }] };
  };
  nangoClient.getFacebookLiveVideoStatus = async () => {
    providerReads++; return { ...raw, status: hostile ? { secret } : 'LIVE' };
  };
  workerManager.getDeliveryStatus = () => ({ ...raw,
    relayState: hostile ? { secret } : 'relaying', lastProgressAt: hostile ? secret : now,
    bytesWritten: hostile ? { secret } : 1234 });
  const assertRedacted = response => {
    assert.equal(response.status,200);
    assert.ok(!response.body.includes(secret), 'synthetic secrets must not be serialized');
    assert.ok(!response.body.includes(token), 'device token must not be serialized');
    assert.ok(!/https?:\/\/|rtmps?:\/\//.test(response.body), 'status must contain no URLs');
    assert.ok(!/broadcast_snapshot|stream_key|access_token|connectionId|arbitrary|permalink_url/.test(response.body), 'raw fields must be absent');
    assert.deepEqual(Object.keys(response.data).sort(),['destinations','stream','success']);
    for (const d of response.data.destinations) {
      assert.deepEqual(Object.keys(d).sort(), ['target_id','target_type','status','error_message','name','provider','broadcast','delivery',...(d.provider === 'facebook' ? ['cleanupPending'] : [])].sort());
      assert.equal(d.error_message,'DESTINATION_FAILED');
      assert.deepEqual(Object.keys(d.delivery).sort(), ['relayState','lastProgressAt','bytesWritten','streamStatus','broadcastStatus','healthStatus','checkedAt',...(d.provider === 'facebook' ? ['broadcastState','receiving'] : [])].sort());
    }
  };
  try {
    for (const path of ['/api/device/stream-status',`/api/workspaces/ws_summary/streams/${session.id}/status`]) {
      const r = await request(path); assertRedacted(r);
      assert.equal(r.headers['cache-control'],'no-store');
      assert.equal(r.data.stream.id,session.id);
      assert.equal(r.data.destinations.length,4);
      const byProvider = Object.fromEntries(r.data.destinations.map(d => [d.provider,d]));
      assert.deepEqual(byProvider.youtube.broadcast,{id:'youtube-safe',provider:'youtube',lifeCycleStatus:'ready'});
      assert.equal(byProvider.youtube.delivery.broadcastStatus,'live');
      assert.equal(byProvider.youtube.delivery.streamStatus,'active');
      assert.equal(byProvider.youtube.delivery.healthStatus,'good');
      assert.deepEqual(byProvider.facebook.broadcast,{id:'fb-safe',provider:'facebook',pageId:'page-safe',status:'LIVE'});
      assert.equal(byProvider.facebook.cleanupPending,true);
      assert.equal(byProvider.facebook.delivery.broadcastState,'LIVE');
      assert.equal(byProvider.facebook.delivery.receiving,'unknown');
      assert.deepEqual(byProvider.twitch.broadcast,{id:'twitch-safe',provider:'twitch'});
      assert.equal(byProvider['Custom RTMP'].broadcast,null);
      for (const d of r.data.destinations) {
        assert.equal(d.delivery.relayState,'relaying'); assert.equal(d.delivery.bytesWritten,1234);
        assert.equal(d.delivery.lastProgressAt,now);
      }
    }
    assert.equal(providerReads,6);
    hostile = true;
    const r = await request('/api/device/stream-status'); assertRedacted(r);
    for (const d of r.data.destinations) {
      assert.equal(d.delivery.relayState,'unknown'); assert.equal(d.delivery.lastProgressAt,null);
      assert.equal(d.delivery.bytesWritten,0); assert.equal(d.delivery.broadcastStatus,'unknown');
    }
    nangoClient.youtubeApiRequest = nangoClient.getFacebookLiveVideoStatus = async () => { throw new Error(secret); };
    workerManager.getDeliveryStatus = () => { throw new Error(secret); };
    const fallback = await request('/api/device/stream-status'); assertRedacted(fallback);
    assert.equal(fallback.data.destinations.find(d => d.provider === 'facebook').broadcast.status,'unknown');
    for (const snapshot of [`{${secret}`,JSON.stringify(raw),JSON.stringify([{ ...raw }]),'null']) {
      db.run('UPDATE stream_session_destinations SET broadcast_snapshot = ? WHERE stream_session_id = ?', [snapshot,session.id]);
      const malformed = await request('/api/device/stream-status'); assertRedacted(malformed);
      assert.ok(malformed.data.destinations.every(d => d.broadcast === null), 'invalid snapshots expose no broadcast fields');
    }
    db.run("UPDATE provider_targets SET name = ? WHERE id = 'status_youtube'", [raw.stream_url]);
    db.run("UPDATE custom_rtmp_targets SET name = ? WHERE id = 'status_custom'", [raw.permalink_url]);
    const urlLabels = await request('/api/device/stream-status'); assertRedacted(urlLabels);
    assert.equal(urlLabels.data.destinations.find(d => d.provider === 'youtube').name,'');
    assert.equal(urlLabels.data.destinations.find(d => d.provider === 'Custom RTMP').name,'');
    assert.equal((await request('/api/device/stream-status',{})).status,401);
    assert.equal((await request('/api/device/stream-status',{cookie:'session_id=web_summary'})).status,401);
    assert.equal((await request(`/api/workspaces/ws_other/streams/${session.id}/status`)).status,403);
    for (const callback of ['/api/streams/publish','/api/streams/publish_done']) {
      assert.equal((await request(callback,undefined,'POST')).status,403);
    }
    assert.equal(externalFetches,0);
  } finally {
    nangoClient.youtubeApiRequest = originals.youtube;
    nangoClient.getFacebookLiveVideoStatus = originals.facebook;
    workerManager.getDeliveryStatus = originals.delivery;
    db.run('DELETE FROM stream_sessions WHERE id = ?', [session.id]);
    db.run("DELETE FROM provider_targets WHERE id = 'status_youtube'");
    for (const provider of ['facebook','twitch']) db.run('DELETE FROM provider_connections WHERE id = ?', [`connection_${provider}`]);
    db.run("DELETE FROM custom_rtmp_targets WHERE id = 'status_custom'");
  }
});

test('expired, suspended, free and revoked fail closed independently of legacy ceilings', async () => {
  db.run("UPDATE workspaces SET paid_until = ?, max_devices = 999, max_destinations = 999 WHERE id = 'ws_summary'", [new Date(Date.now()-1000).toISOString()]);
  let r = await request(); assert.equal(r.status,200); assert.equal(r.data.plan,'free');
  assert.deepEqual(r.data.ceilings,{maxDevices:0,maxDestinations:0,maxActiveBroadcasts:0});
  assert.deepEqual(r.data.features,{streaming:false,destinations:false,oauthDestinations:false});
  db.run("UPDATE workspaces SET paid_until = ?, paystack_status = 'suspended' WHERE id = 'ws_summary'", [future]);
  assert.equal((await request()).data.plan,'free');
  db.run("UPDATE workspaces SET paid_until = NULL, paystack_status = 'none' WHERE id = 'ws_summary'");
  assert.equal((await request()).data.plan,'free');
  db.run("UPDATE devices SET status = 'revoked' WHERE id = 'dev_summary'");
  assert.equal((await request()).status,401);
  db.run("UPDATE devices SET status = 'active' WHERE id = 'dev_summary'");
  for (const expires of ['invalid-date',now]) {
    db.run('UPDATE device_sessions SET expires_at = ? WHERE id = ?', [expires,tokenHash]);
    assert.equal((await request()).status,401);
  }
  db.run('DELETE FROM device_sessions WHERE id = ?', [tokenHash]);
  assert.equal((await request()).status,401);
});
