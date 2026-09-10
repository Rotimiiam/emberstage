import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';
process.env.ENCRYPTION_SECRET = 'nango-tests-no-live-credentials';
const { NangoClient } = await import('../src/nango-client.js');
const { db, initDatabase } = await import('../src/db.js');
initDatabase();

test('Nango client creates scoped connect sessions and uses current connection endpoints', async () => {
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/connect/sessions')) {
      return new Response(JSON.stringify({ data: { connect_link: 'http://connect.test/session?session_token=test-session&theme=dark', expires_at: 'soon' } }), { status: 201 });
    }
    if (url.includes('/connections?')) {
      const query = new URL(url).searchParams;
      assert.equal(query.get('tags[end_user_id]'), 'ws-1');
      assert.equal(query.get('tags[organization_id]'), 'ws-1');
      assert.equal(query.get('integrationId'), 'twitch');
      assert.equal(query.has('endUserId'), false);
      return new Response(JSON.stringify({ connections: [{ connection_id: 'connection-1', provider_config_key: 'twitch', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' }, updated_at: '2026-09-08T00:00:00Z' }] }), { status: 200 });
    }
    if (options.method === 'DELETE') return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response(JSON.stringify({ credentials: { access_token: 'redacted-test-token' } }), { status: 200 });
  };

  const client = new NangoClient(fetchFn, { baseUrl: 'http://nango.test', secretKey: 'test-secret', twitchIntegrationId: 'twitch' });
    const session = await client.createConnectSession({ workspaceId: 'ws-1', workspaceName: 'Workspace', userEmail: 'owner@example.test', provider: 'twitch' });
    const link = new URL(session.connect_link);
    assert.equal(link.origin, 'http://connect.test');
    assert.equal(link.pathname, '/session');
    assert.equal(link.searchParams.get('apiURL'), 'http://nango.test');
    assert.equal(link.searchParams.get('session_token'), 'test-session');
    assert.equal(link.searchParams.get('theme'), 'dark');
    assert.equal(session.expires_at, 'soon');
    const sessionBody = JSON.parse(requests[0].options.body);
    assert.deepEqual(sessionBody.allowed_integrations, ['twitch']);
    assert.equal(sessionBody.tags.end_user_id, 'ws-1');
    assert.equal(sessionBody.tags.organization_id, 'ws-1');
    assert.equal(sessionBody.tags.end_user_email, 'owner@example.test');

    const connection = await client.getConnection('ws-1', 'twitch');
    assert.equal(connection.connection_id, 'connection-1');
    await client.getCredentials(connection.connection_id, 'twitch');
    assert.match(requests.at(-1).url, /\/connections\/connection-1\?/);
    await client.disconnect('ws-1', 'twitch');
    assert.equal(requests.at(-1).options.method, 'DELETE');
    assert.match(requests.at(-1).url, /\/connections\/connection-1\?/);
});

test('Nango client resolves only the selected broadcast’s exact bound stream', async () => {
  const now = new Date().toISOString();
  db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ['ws-1', 'Test', now]);
  db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'youtube', 'connected', ?)", ['connection-1', 'ws-1', now]);
  db.run('INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected_broadcast_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['target-1', 'ws-1', 'connection-1', 'youtube', 'channel-1', 'Test', 'broadcast-1', now]);
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(url);
    if (url.includes('/connections?')) {
      return new Response(JSON.stringify({ connections: [{ connection_id: 'youtube-connection', provider_config_key: 'youtube', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
    }
    if (url.includes('/connections/youtube-connection?')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'redacted-youtube-token' } }), { status: 200 });
    }
    if (url.includes('/channels?part=id%2Csnippet')) {
      return new Response(JSON.stringify({ items: [{ id: 'channel-1', snippet: { title: 'Test channel' } }] }), { status: 200 });
    }
    if (url.includes('/channels?part=id&')) {
      return new Response(JSON.stringify({ items: [{ id: 'channel-1' }] }), { status: 200 });
    }
    if (url.includes('/liveBroadcasts?')) {
      assert.equal(new URL(url).searchParams.get('id'), 'broadcast-1');
      return new Response(JSON.stringify({ items: [{ id: 'broadcast-1', snippet: { channelId: 'channel-1' }, status: { lifeCycleStatus: 'ready' }, contentDetails: { boundStreamId: 'stream-1' } }] }));
    }
    if (url.includes('/liveStreams?')) {
      assert.equal(new URL(url).searchParams.get('id'), 'stream-1');
      assert.equal(new URL(url).searchParams.has('mine'), false);
      return new Response(JSON.stringify({ items: [{
        id: 'stream-1',
        status: { streamStatus: 'ready' },
        cdn: { ingestionInfo: { ingestionAddress: 'rtmp://youtube.test/live2', streamName: 'redacted-stream-key' } }
      }] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NangoClient(fetchFn, {
    baseUrl: 'http://nango.test',
    secretKey: 'test-secret',
    youtubeIntegrationId: 'youtube'
  });

  assert.deepEqual(await client.discoverTargets('ws-1', 'youtube'), [{ id: 'channel-1', name: 'Test channel' }]);
  assert.deepEqual(await client.resolveDestination('ws-1', 'youtube', 'channel-1'), {
    streamUrl: 'rtmp://youtube.test/live2',
    streamKey: 'redacted-stream-key'
  });
  assert.ok(requests.some(url => url.includes('/liveStreams?')));
  db.run('UPDATE provider_targets SET selected_broadcast_id = NULL WHERE id = ?', ['target-1']);
  await assert.rejects(client.resolveDestination('ws-1', 'youtube', 'channel-1'), /No broadcast has been selected/);
});

test('encoder reconnect does not rewrite a live auto-start broadcast, and ended broadcasts fail closed', async () => {
  const client = new NangoClient();
  const existing = {
    id: 'broadcast-reconnect', snippet: { channelId: 'channel-reconnect' },
    status: { privacyStatus: 'private', lifeCycleStatus: 'live' },
    contentDetails: { enableAutoStart: true }
  };
  let writes = 0;
  client.youtubeApiRequest = async (_workspace, pathname, options = {}) => {
    if (options.method) writes++;
    if (pathname.startsWith('/channels?')) return { items: [{ id: 'channel-reconnect' }] };
    return { items: [existing] };
  };
  assert.equal(await client.updateYoutubeBroadcast('ws-reconnect', 'channel-reconnect', existing.id, { enableAutoStart: true }), existing);
  assert.equal(writes, 0);
  existing.status.lifeCycleStatus = 'complete';
  await assert.rejects(client.updateYoutubeBroadcast('ws-reconnect', 'channel-reconnect', existing.id, { enableAutoStart: true }), /has ended/);
  assert.equal(writes, 0);
});

test('broadcast creation defaults private and binds the exact new stream', async () => {
  const calls = [];
  const client = new NangoClient();
  client.youtubeApiRequest = async (_workspace, path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    if (path.startsWith('/channels?')) return { items: [{ id: 'channel-1' }] };
    if (path.startsWith('/liveBroadcasts/bind?')) {
      assert.equal(new URLSearchParams(path.split('?')[1]).get('streamId'), 'new-stream');
      return { id: 'new-broadcast', contentDetails: { boundStreamId: 'new-stream' } };
    }
    if (path.startsWith('/liveBroadcasts?')) return { id: 'new-broadcast' };
    if (path.startsWith('/liveStreams?')) return { id: 'new-stream' };
    throw new Error('Unexpected test API route');
  };
  const result = await client.createYoutubeBroadcast('ws-1', 'channel-1', { title: 'Private test' });
  assert.equal(result.contentDetails.boundStreamId, 'new-stream');
  const body = calls.find(call => call.path.startsWith('/liveBroadcasts?')).body;
  assert.equal(body.status.privacyStatus, 'private');
  assert.equal(body.contentDetails.enableAutoStart, false);
  assert.equal(body.contentDetails.enableAutoStop, false);
  await assert.rejects(client.createYoutubeBroadcast('ws-1', 'channel-1', { title: 'Test', privacyStatus: 'typo' }), /Invalid broadcast privacy/);
});

test('broadcast update preserves writable settings and excludes read-only response fields', async () => {
  const client = new NangoClient();
  const existing = {
    id: 'broadcast-1', snippet: { channelId: 'channel-1', title: 'Before', scheduledStartTime: '2026-09-09T20:00:00Z', thumbnails: { default: {} } },
    status: { privacyStatus: 'private', lifeCycleStatus: 'ready', recordingStatus: 'notRecording' },
    contentDetails: { boundStreamId: 'stream-1', enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0, embedHtml: 'untrusted' } }
  };
  let update;
  client.youtubeApiRequest = async (_workspace, path, options = {}) => {
    if (path.startsWith('/channels?')) return { items: [{ id: 'channel-1' }] };
    if (options.method === 'PUT') { update = JSON.parse(options.body); return update; }
    return { items: [existing] };
  };
  await client.updateYoutubeBroadcast('ws-1', 'channel-1', 'broadcast-1', { title: 'After' });
  assert.equal(update.snippet.title, 'After');
  assert.equal(update.snippet.scheduledStartTime, existing.snippet.scheduledStartTime);
  assert.equal(update.snippet.channelId, undefined);
  assert.equal(update.status.lifeCycleStatus, undefined);
  assert.equal(update.contentDetails.boundStreamId, undefined);
  assert.deepEqual(update.contentDetails.monitorStream, { enableMonitorStream: false, broadcastStreamDelayMs: 0 });
  assert.equal(update.contentDetails.enableAutoStart, false);
  existing.snippet.channelId = 'someone-else';
  await assert.rejects(client.updateYoutubeBroadcast('ws-1', 'channel-1', 'broadcast-1', { title: 'Denied' }), /not found on this YouTube channel/);
});

test('provider calls have deadlines and do not expose upstream credential-bearing errors', async () => {
  let signal;
  const client = new NangoClient(async (_url, options) => {
    signal = options.signal;
    return new Response(JSON.stringify({ error: { message: 'secret-from-upstream' } }), { status: 403 });
  }, { baseUrl: 'http://nango.test', secretKey: 'test-secret' });
  await assert.rejects(client.request('/connections'), error => error.message === 'Nango request failed (403)');
  assert.ok(signal instanceof AbortSignal);
  client.fetch = async () => { throw new DOMException('secret timeout URL', 'TimeoutError'); };
  await assert.rejects(client.request('/connections'), error => error.message === 'Provider request timed out; please retry');
});

test('Nango connection lookup rejects other workspaces, integrations, and missing tags', async () => {
  const connection = { connection_id: 'valid', provider_config_key: 'youtube', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } };
  const client = new NangoClient(async () => new Response(JSON.stringify({ connections: [
    { ...connection, connection_id: 'wrong-user', tags: { ...connection.tags, end_user_id: 'ws-2' } },
    { ...connection, connection_id: 'wrong-org', tags: { ...connection.tags, organization_id: 'ws-2' } },
    { ...connection, connection_id: 'wrong-integration', provider_config_key: 'twitch' },
    { ...connection, connection_id: 'untagged', tags: undefined },
    connection
  ] })), { baseUrl: 'http://nango.test', secretKey: 'test-secret' });
  assert.deepEqual(await client.listConnections('ws-1', 'youtube'), [connection]);
  assert.equal(await client.getConnection('ws-2', 'youtube'), null);
});

test('updateYoutubeBroadcast updates enableAutoStart and enableAutoStop, preserving privacy and other settings', async () => {
  const client = new NangoClient();
  const existing = {
    id: 'broadcast-1',
    snippet: { channelId: 'channel-1', title: 'Test Title', scheduledStartTime: '2026-09-09T20:00:00Z', categoryId: '22' },
    status: { privacyStatus: 'unlisted', lifeCycleStatus: 'ready' },
    contentDetails: { boundStreamId: 'stream-1', enableAutoStart: false, enableAutoStop: false }
  };
  let update;
  client.youtubeApiRequest = async (_workspace, path, options = {}) => {
    if (path.startsWith('/channels?')) return { items: [{ id: 'channel-1' }] };
    if (options.method === 'PUT') {
      update = JSON.parse(options.body);
      return update;
    }
    return { items: [existing] };
  };

  await client.updateYoutubeBroadcast('ws-1', 'channel-1', 'broadcast-1', {
    enableAutoStart: true,
    enableAutoStop: true
  });

  assert.equal(update.contentDetails.enableAutoStart, true);
  assert.equal(update.contentDetails.enableAutoStop, true);
  assert.equal(update.status.privacyStatus, 'unlisted'); // preserved
  assert.equal(update.snippet.title, 'Test Title'); // preserved

  // Validation
  await assert.rejects(
    client.updateYoutubeBroadcast('ws-1', 'channel-1', 'broadcast-1', { enableAutoStart: 'not-a-boolean' }),
    /enableAutoStart must be a boolean/
  );
  await assert.rejects(
    client.updateYoutubeBroadcast('ws-1', 'channel-1', 'broadcast-1', { enableAutoStop: 'not-a-boolean' }),
    /enableAutoStop must be a boolean/
  );
});

test('Facebook discoverTargets correctly uses explicit fields, filters publish-capable tasks, paginates on trusted graph.facebook.com, and does not POST', async () => {
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/connections?')) {
      return new Response(JSON.stringify({ connections: [{ connection_id: 'fb-conn-1', provider_config_key: 'facebook', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
    }
    if (url.includes('/connections/fb-conn-1?')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'fb-user-token-123' } }), { status: 200 });
    }
    if (url.includes('/me/accounts?')) {
      const parsedUrl = new URL(url);
      const after = parsedUrl.searchParams.get('after');
      // Assert discovery fields MUST only include id,name,tasks and NOT access_token
      assert.match(parsedUrl.searchParams.get('fields'), /^id,name,tasks$/);
      if (!after) {
        return new Response(JSON.stringify({
          data: [
            { id: 'page-1', name: 'Page One', tasks: ['CREATE_CONTENT'] },
            { id: 'page-2', name: 'Page Two (No Publish)', tasks: ['MODERATE', 'ANALYZE'] }
          ],
          paging: { cursors: { after: 'next-cursor' }, next: 'https://graph.facebook.com/v25.0/me/accounts?after=next-cursor' }
        }), { status: 200 });
      } else if (after === 'next-cursor') {
        return new Response(JSON.stringify({
          data: [
            { id: 'page-3', name: 'Page Three', tasks: ['CREATE_CONTENT'] }
          ],
          paging: { cursors: { after: 'last-cursor' } }
        }), { status: 200 });
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NangoClient(fetchFn, {
    baseUrl: 'http://nango.test',
    secretKey: 'test-secret',
    facebookIntegrationId: 'facebook'
  });

  const targets = await client.discoverTargets('ws-1', 'facebook');
  
  // Verify discovery is purely GET, no POST requests
  assert.ok(requests.every(r => !r.options.method || r.options.method === 'GET'));
  
  // Verify we filtered out page-2 because it doesn't have CREATE_CONTENT
  assert.deepEqual(targets, [
    { id: 'page-1', name: 'Page One' },
    { id: 'page-3', name: 'Page Three' }
  ]);

  // Verify pagination URLs called are trusted graph.facebook.com
  const meAccountsRequests = requests.filter(r => r.url.includes('/me/accounts'));
  assert.equal(meAccountsRequests.length, 2);
  assert.ok(meAccountsRequests.every(r => r.url.startsWith('https://graph.facebook.com/')));
});

test('Facebook pagination rejects untrusted next URLs without sending credentials to them', async () => {
  for (const next of ['https://evil.example/accounts', 'http://graph.facebook.com/accounts', 'https://user:pass@graph.facebook.com/accounts']) {
    let calls = 0;
    const client = new NangoClient(async url => {
      calls++;
      assert.ok(url.startsWith('https://graph.facebook.com/'));
      return Response.json({ data: [], paging: { next, cursors: { after: 'cursor' } } });
    });
    await assert.rejects(client.fetchFacebookPages('synthetic-user-token'), /Untrusted Facebook pagination URL/);
    assert.equal(calls, 1);
  }
});

test('Facebook target resolution derives page token, reverifies connection/tasks, POSTs LIVE_NOW exactly once with Authorization header, and parses secure stream URL properly', async () => {
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/page-1?fields=id,access_token')) return new Response(JSON.stringify({ id: 'page-1', access_token: 'page-token-1' }));
    if (url.includes('/connections?')) {
      return new Response(JSON.stringify({ connections: [{ connection_id: 'fb-conn-1', provider_config_key: 'facebook', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
    }
    if (url.includes('/connections/fb-conn-1?')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'fb-user-token-123' } }), { status: 200 });
    }
    if (url.includes('/me/accounts?')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'page-1', name: 'Page One', access_token: 'page-token-1', tasks: ['CREATE_CONTENT'] }
        ]
      }), { status: 200 });
    }
    if (url.includes('/page-1/live_videos')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer page-token-1');
      assert.equal(JSON.parse(options.body).status, 'LIVE_NOW');
      return new Response(JSON.stringify({
        id: 'live-video-abc',
        secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/12345_key_abc?s_bl=1&s_ps=1'
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NangoClient(fetchFn, {
    baseUrl: 'http://nango.test',
    secretKey: 'test-secret',
    facebookIntegrationId: 'facebook'
  });

  const resolved = await client.resolveDestination('ws-1', 'facebook', 'page-1');
  
  // Verify token derivation & split
  assert.equal(resolved.liveVideoId, 'live-video-abc');
  assert.equal(resolved.streamUrl, 'rtmps://live-api-s.facebook.com:443/rtmp/');
  assert.equal(resolved.streamKey, '12345_key_abc?s_bl=1&s_ps=1');

  // Verify that credentials (like token) are not exposed in logs or DB via URLs, only Authorization header
  assert.ok(!resolved.streamUrl.includes('page-token-1'));
  assert.ok(!resolved.streamKey.includes('page-token-1'));
  const postRequest = requests.find(r => r.url.includes('/live_videos'));
  assert.ok(!postRequest.url.includes('page-token-1'));
});

test('Facebook target resolution rejects non-rtmps, missing host, and credentials in secure stream URL', async () => {
  const runUrlTest = async (testUrl) => {
    const fetchFn = async (url, options = {}) => {
      if (url.endsWith('/page-1?fields=id,access_token')) return new Response(JSON.stringify({ id: 'page-1', access_token: 'page-token-1' }));
      if (url.includes('/connections?')) {
        return new Response(JSON.stringify({ connections: [{ connection_id: 'fb-conn-1', provider_config_key: 'facebook', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
      }
      if (url.includes('/connections/fb-conn-1?')) {
        return new Response(JSON.stringify({ credentials: { access_token: 'fb-user-token-123' } }), { status: 200 });
      }
      if (url.includes('/me/accounts?')) {
        return new Response(JSON.stringify({ data: [{ id: 'page-1', access_token: 'page-token-1', tasks: ['CREATE_CONTENT'] }] }), { status: 200 });
      }
      if (url.includes('/page-1/live_videos')) {
        return new Response(JSON.stringify({ id: 'live-video-abc', secure_stream_url: testUrl }), { status: 200 });
      }
      if (url.includes('/live-video-abc?end_live_video=true')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const client = new NangoClient(fetchFn, { baseUrl: 'http://nango.test', secretKey: 'test-secret', facebookIntegrationId: 'facebook' });
    await client.resolveDestination('ws-1', 'facebook', 'page-1');
  };

  await assert.rejects(runUrlTest('rtmp://live-api-s.facebook.com:443/rtmp/key'), /Only rtmps protocol is supported/);
  await assert.rejects(runUrlTest('rtmps://:443/rtmp/key'), /Invalid URL format/);
  await assert.rejects(runUrlTest('rtmps://user:pass@live-api-s.facebook.com:443/rtmp/key'), /URL must not contain username or password/);
});

test('Facebook target resolution malformed URL attempts and handles cleanup', async () => {
  let endCalled = false;
  let endFailed = false;

  const fetchFn = async (url, options = {}) => {
    if (url.endsWith('/page-1?fields=id,access_token')) return new Response(JSON.stringify({ id: 'page-1', access_token: 'page-token-1' }));
    if (url.includes('/connections?')) {
      return new Response(JSON.stringify({ connections: [{ connection_id: 'fb-conn-1', provider_config_key: 'facebook', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
    }
    if (url.includes('/connections/fb-conn-1?')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'fb-user-token-123' } }), { status: 200 });
    }
    if (url.includes('/me/accounts?')) {
      return new Response(JSON.stringify({ data: [{ id: 'page-1', access_token: 'page-token-1', tasks: ['CREATE_CONTENT'] }] }), { status: 200 });
    }
    if (url.includes('/page-1/live_videos')) {
      return new Response(JSON.stringify({ id: 'live-video-abc', secure_stream_url: 'rtmps://:443/rtmp/key' }), { status: 200 });
    }
    if (url.includes('/live-video-abc?end_live_video=true')) {
      endCalled = true;
      assert.equal(options.headers.Authorization, 'Bearer page-token-1');
      if (endFailed) {
        return new Response(JSON.stringify({ error: { message: 'Meta end API exploded' } }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NangoClient(fetchFn, { baseUrl: 'http://nango.test', secretKey: 'test-secret', facebookIntegrationId: 'facebook' });
  
  // Successful end cleanup on URL parse error
  await assert.rejects(client.resolveDestination('ws-1', 'facebook', 'page-1'), /Failed parsing Facebook secure stream URL: Invalid URL format/);
  assert.equal(endCalled, true);

  // Failed end cleanup on URL parse error attaches liveVideoId and pageId to error
  endCalled = false;
  endFailed = true;
  await assert.rejects(
    client.resolveDestination('ws-1', 'facebook', 'page-1'),
    err => err.liveVideoId === 'live-video-abc' && err.pageId === 'page-1' && err.connectionId === 'fb-conn-1' && !err.message.includes('Meta end API exploded')
  );
});

test('Facebook ending live video uses page token in Authorization header and calls end_live_video API correctly', async () => {
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/page-1?fields=id,access_token')) return new Response(JSON.stringify({ id: 'page-1', access_token: 'page-token-1' }));
    if (url.includes('/connections?')) {
      return new Response(JSON.stringify({ connections: [{ connection_id: 'fb-conn-1', provider_config_key: 'facebook', tags: { end_user_id: 'ws-1', organization_id: 'ws-1' } }] }), { status: 200 });
    }
    if (url.includes('/connections/fb-conn-1?')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'fb-user-token-123' } }), { status: 200 });
    }
    if (url.includes('/me/accounts?')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'page-1', name: 'Page One', access_token: 'page-token-1', tasks: ['CREATE_CONTENT'] }
        ]
      }), { status: 200 });
    }
    if (url.includes('/live-video-abc?end_live_video=true')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer page-token-1');
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NangoClient(fetchFn, {
    baseUrl: 'http://nango.test',
    secretKey: 'test-secret',
    facebookIntegrationId: 'facebook'
  });

  const result = await client.endFacebookLiveVideo('ws-1', 'page-1', 'live-video-abc');
  assert.deepEqual(result, { success: true });
});

function facebookClientFixture(overrides = {}) {
  const calls = [];
  const connection = { connection_id: 'connection-fb', provider_config_key: 'facebook', tags: { end_user_id: 'ws-fb', organization_id: 'ws-fb' } };
  const state = {
    connection, credentials: { access_token: 'SECRET_USER' },
    pages: [{ id: 'page-external', name: 'Page', tasks: ['CREATE_CONTENT'] }],
    page: { id: 'page-external', access_token: 'SECRET_PAGE' },
    created: { id: 'live-external', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/SECRET_KEY?token=SECRET_QUERY&path=a/b' },
    status: { id: 'live-external', status: 'LIVE', permalink_url: 'https://www.facebook.com/Page/videos/123', access_token: 'SECRET_PAGE', secure_stream_url: 'SECRET_KEY' },
    end: { success: true }, ...overrides
  };
  const client = new NangoClient(async (url, options = {}) => {
    calls.push({ url, options });
    let body;
    if (url.includes('/connections?')) body = { connections: state.connection ? [state.connection] : [] };
    else if (url.includes('/connections/connection-fb?')) body = { credentials: state.credentials };
    else {
      assert.equal(new URL(url).hostname, 'graph.facebook.com');
      assert.equal(options.redirect, 'error');
      assert.ok(!url.includes('SECRET_'));
      if (url.includes('/me/accounts?')) {
        assert.equal(new URL(url).searchParams.get('fields'), 'id,name,tasks');
        assert.equal(options.headers.Authorization, 'Bearer SECRET_USER');
        body = { data: state.pages, paging: state.paging };
      } else if (url.endsWith('/page-external?fields=id,access_token')) {
        assert.equal(options.headers.Authorization, 'Bearer SECRET_USER');
        body = state.page;
      } else {
        assert.equal(options.headers.Authorization, 'Bearer SECRET_PAGE');
        if (url.endsWith('/page-external/live_videos')) body = state.created;
        else if (url.endsWith('/live-external?end_live_video=true')) body = state.end;
        else if (url.endsWith('/live-external?fields=id,status,permalink_url')) body = state.status;
        else throw new Error('Unexpected mock request');
      }
    }
    return new Response(JSON.stringify(body), { status: body.error ? 403 : 200 });
  }, { baseUrl: 'https://nango.test', secretKey: 'SECRET_NANGO' });
  return { client, calls, state };
}

test('Facebook scopes are Pages-only and discovery strips unsolicited tokens', async () => {
  let requested;
  const client = new NangoClient(async (_url, options) => {
    requested = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: {} }));
  }, { baseUrl: 'https://nango.test', secretKey: 'test' });
  await client.createConnectSession({ workspaceId: 'ws-fb', provider: 'facebook' });
  assert.equal(requested.integrations_config_defaults.facebook.user_scopes, 'pages_show_list,pages_read_engagement,pages_manage_posts');
  const f = facebookClientFixture({ pages: [
    { id: 'yes', tasks: ['CREATE_CONTENT'], access_token: 'SECRET_PAGE' },
    { id: 'no', tasks: ['MODERATE', 'ANALYZE', 'PUBLISH_VIDEO'] },
    { id: 'malformed', tasks: 'CREATE_CONTENT' }
  ], paging: { cursors: { after: 'last-page-cursor' } } });
  assert.deepEqual(await f.client.discoverTargets('ws-fb', 'facebook'), [{ id: 'yes', name: 'Facebook Page' }]);
  assert.ok(f.calls.every(call => !call.options.method || call.options.method === 'GET'));
  assert.ok(!JSON.stringify(f.calls.map(call => call.url)).includes('evil.test'));
});

test('Facebook discovery bounds cursor repetition and total requests', async () => {
  const repeated = facebookClientFixture({ paging: { cursors: { after: 'same' }, next: 'https://graph.facebook.com/v25.0/me/accounts?after=same' } });
  await assert.rejects(repeated.client.discoverTargets('ws-fb', 'facebook'), /pagination cursor/);
  assert.equal(repeated.calls.filter(call => call.url.includes('/me/accounts')).length, 2);
  let count = 0;
  const client = new NangoClient(async () => new Response(JSON.stringify({ data: [], paging: { cursors: { after: String(++count) }, next: 'https://graph.facebook.com/v25.0/me/accounts' } })));
  await assert.rejects(client.fetchFacebookPages('SECRET_USER'), /limit exceeded/);
  assert.equal(count, 20);
});

test('Facebook revalidation refuses absent credentials, foreign ownership, changed connections and missing publishing permission before POST', async () => {
  for (const overrides of [
    { connection: null },
    { connection: { connection_id: 'foreign', provider_config_key: 'facebook', tags: { end_user_id: 'foreign', organization_id: 'foreign' } } },
    { credentials: {} }, { page: { id: 'page-external' } },
    { page: { id: 'different', access_token: 'SECRET_PAGE' } },
    { pages: [{ id: 'page-external', tasks: ['MODERATE'] }] }, { pages: [] }
  ]) {
    const f = facebookClientFixture(overrides);
    await assert.rejects(f.client.createFacebookLiveVideo('ws-fb', 'page-external'));
    assert.ok(f.calls.every(call => call.options.method !== 'POST'));
  }
  const f = facebookClientFixture();
  await assert.rejects(f.client.endFacebookLiveVideo('ws-fb', 'page-external', 'live-external', 'foreign-connection'), /connection changed/);
  assert.equal(f.calls.length, 1);
});

test('Facebook stream split preserves credential query verbatim and never includes it in base URL', async () => {
  const f = facebookClientFixture();
  const result = await f.client.createFacebookLiveVideo('ws-fb', 'page-external');
  assert.equal(result.streamUrl, 'rtmps://live-api-s.facebook.com:443/rtmp/');
  assert.equal(result.streamKey, 'SECRET_KEY?token=SECRET_QUERY&path=a/b');
  assert.equal(result.connectionId, 'connection-fb');
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('Facebook missing or unsafe stream URLs always end known IDs with same token; failed cleanup retains only identity', async () => {
  for (const secure_stream_url of [undefined, '', 'https://host/rtmp/SECRET_KEY', 'rtmps:///rtmp/SECRET_KEY', 'rtmps://user:SECRET_PAGE@host/rtmp/key', 'rtmps://host/rtmp/', 'rtmps://host/rtmp/key#SECRET_KEY', 'rtmps://host/rtmp/key/extra', 'not-a-url']) {
    const f = facebookClientFixture({ created: { id: 'live-external', secure_stream_url } });
    await assert.rejects(f.client.createFacebookLiveVideo('ws-fb', 'page-external'), error => {
      assert.ok(!error.message.includes('SECRET_'));
      assert.equal(error.liveVideoId, undefined, 'confirmed cleanup needs no pending ID');
      return true;
    });
    assert.equal(f.calls.filter(call => call.url.includes('end_live_video')).length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('/connections?')).length, 1, 'uses same token rather than resolving another connection');
  }
  const f = facebookClientFixture({ created: { id: 'live-external' }, end: { error: { message: 'SECRET_PAGE SECRET_QUERY' } } });
  await assert.rejects(f.client.createFacebookLiveVideo('ws-fb', 'page-external'), error => {
    assert.equal(error.liveVideoId, 'live-external');
    assert.equal(error.pageId, 'page-external');
    assert.equal(error.connectionId, 'connection-fb');
    assert.ok(!JSON.stringify(error).includes('SECRET_'));
    assert.ok(!error.message.includes('SECRET_'));
    return true;
  });
});

test('Facebook remote errors are sanitized and status exposes only verified allowlisted fields', async () => {
  const f = facebookClientFixture();
  assert.deepEqual(await f.client.getFacebookLiveVideoStatus('ws-fb', 'page-external', 'live-external', 'connection-fb'), {
    id: 'live-external', status: 'LIVE', permalink_url: 'https://www.facebook.com/Page/videos/123'
  });
  assert.ok(f.calls.every(call => call.options.method !== 'POST'));
  f.state.status = { id: 'live-external', status: 'SECRET_PAYLOAD', permalink_url: 'https://www.facebook.com/videos/123?access_token=SECRET_PAGE' };
  assert.deepEqual(await f.client.getFacebookLiveVideoStatus('ws-fb', 'page-external', 'live-external'), { id: 'live-external', status: 'unknown', permalink_url: null });
  f.state.status.id = 'foreign-live';
  await assert.rejects(f.client.getFacebookLiveVideoStatus('ws-fb', 'page-external', 'live-external'), /did not match/);
  f.state.end = { error: { message: 'SECRET_PAGE' } };
  await assert.rejects(f.client.endFacebookLiveVideo('ws-fb', 'page-external', 'live-external'), error => error.message === 'Facebook end_live_video failed (403)');
  f.state.end = { success: false };
  await assert.rejects(f.client.endFacebookLiveVideo('ws-fb', 'page-external', 'live-external'), /not confirmed/);
});
