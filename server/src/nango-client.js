import { config } from './config.js';
import { db } from './db.js';

const PROVIDER_SCOPES = {
  twitch: 'channel:read:stream_key',
  youtube: 'https://www.googleapis.com/auth/youtube',
  facebook: 'pages_show_list,pages_read_engagement,pages_manage_posts'
};

function integrationId(provider, settings = {}) {
  if (provider === 'twitch') return settings.twitchIntegrationId || config.NANGO_TWITCH_INTEGRATION_ID || 'twitch';
  if (provider === 'youtube') return settings.youtubeIntegrationId || config.NANGO_YOUTUBE_INTEGRATION_ID || 'youtube';
  if (provider === 'facebook') return settings.facebookIntegrationId || config.NANGO_FACEBOOK_INTEGRATION_ID || 'facebook';
  throw new Error(`Unsupported Nango provider: ${provider}`);
}

export class NangoClient {
  constructor(fetchFn = fetch, settings = {}) {
    this.fetch = fetchFn;
    this.settings = settings;
  }

  isConfigured() {
    return Boolean((this.settings.baseUrl || config.NANGO_BASE_URL) && (this.settings.secretKey || config.NANGO_SECRET_KEY));
  }

  async fetchResponse(url, options = {}) {
    try {
      return await this.fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(10000) });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'Provider request timed out; please retry'
        : 'Provider network request failed; please retry');
    }
  }

  async request(path, options = {}) {
    if (!this.isConfigured()) throw new Error('Nango is not configured');
    const baseUrl = this.settings.baseUrl || config.NANGO_BASE_URL;
    const secretKey = this.settings.secretKey || config.NANGO_SECRET_KEY;
    const response = await this.fetchResponse(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(`Nango request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async createConnectSession({ workspaceId, workspaceName, userEmail, provider }) {
    const key = integrationId(provider, this.settings);
    const response = await this.request('/connect/sessions', {
      method: 'POST',
      body: JSON.stringify({
        tags: {
          end_user_id: workspaceId,
          end_user_email: userEmail || '',
          organization_id: workspaceId,
          organization_name: workspaceName || ''
        },
        allowed_integrations: [key],
        integrations_config_defaults: {
          [key]: { user_scopes: PROVIDER_SCOPES[provider] }
        }
      })
    });
    const session = response?.data;
    if (session?.connect_link) {
      // Connect UI defaults to Nango Cloud unless its API URL is explicit.
      const link = new URL(session.connect_link);
      link.searchParams.set('apiURL', (this.settings.baseUrl || config.NANGO_BASE_URL).replace(/\/+$/, ''));
      return { ...session, connect_link: link.toString() };
    }
    return session;
  }

  async listConnections(workspaceId, provider) {
    const key = integrationId(provider, this.settings);
    const query = new URLSearchParams({
      'tags[end_user_id]': workspaceId,
      'tags[organization_id]': workspaceId,
      integrationId: key,
      limit: '20'
    });
    const response = await this.request(`/connections?${query}`);
    return (response?.connections || []).filter(connection =>
      connection.provider_config_key === key &&
      connection.tags?.end_user_id === workspaceId &&
      connection.tags?.organization_id === workspaceId
    );
  }

  async getConnection(workspaceId, provider) {
    const connections = await this.listConnections(workspaceId, provider);
    return connections.sort((a, b) => String(b.updated_at || b.created).localeCompare(String(a.updated_at || a.created)))[0] || null;
  }

  async getCredentials(connectionId, provider) {
    const query = new URLSearchParams({ provider_config_key: integrationId(provider, this.settings), force_refresh: 'true' });
    const response = await this.request(`/connections/${encodeURIComponent(connectionId)}?${query}`);
    return response?.credentials || {};
  }

  async disconnect(workspaceId, provider) {
    const connection = await this.getConnection(workspaceId, provider);
    if (!connection) return false;
    const query = new URLSearchParams({ provider_config_key: integrationId(provider, this.settings) });
    await this.request(`/connections/${encodeURIComponent(connection.connection_id)}?${query}`, { method: 'DELETE' });
    return true;
  }

  async twitchRequest(workspaceId, path) {
    const connection = await this.getConnection(workspaceId, 'twitch');
    if (!connection) throw new Error('Twitch is not connected');
    const credentials = await this.getCredentials(connection.connection_id, 'twitch');
    const accessToken = credentials.access_token || credentials.raw?.access_token;
    if (!accessToken) throw new Error('Nango did not return a Twitch access token');
    if (!config.TWITCH_CLIENT_ID) throw new Error('Twitch client ID is not configured');
    const response = await this.fetchResponse(`https://api.twitch.tv/helix${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': config.TWITCH_CLIENT_ID,
        Accept: 'application/json'
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Twitch API request failed (${response.status})`);
    return body;
  }

  async youtubeApiRequest(workspaceId, path, options = {}) {
    const connection = await this.getConnection(workspaceId, 'youtube');
    if (!connection) throw new Error('YouTube is not connected');
    const credentials = await this.getCredentials(connection.connection_id, 'youtube');
    const accessToken = credentials.access_token || credentials.raw?.access_token;
    if (!accessToken) throw new Error('Nango did not return a YouTube access token');
    const response = await this.fetchResponse(`https://www.googleapis.com/youtube/v3${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = {
        liveStreamingNotEnabled: 'Enable live streaming on your YouTube channel before continuing',
        livePermissionBlocked: 'YouTube has restricted live streaming on this channel',
        quotaExceeded: 'YouTube API quota has been exceeded; try again later',
        invalidTransition: 'YouTube is not ready for this broadcast transition',
        errorStreamInactive: 'YouTube is not receiving video yet; start the encoder and wait for ingest',
        insufficientLivePermissions: 'Reconnect YouTube with live-streaming permissions'
      };
      throw new Error(messages[body?.error?.errors?.[0]?.reason] || `YouTube API request failed (${response.status})`);
    }
    return body;
  }

  async youtubeRequest(workspaceId, path) {
    return this.youtubeApiRequest(workspaceId, path);
  }

  async fetchFacebookPages(userAccessToken) {
    const pages = [];
    const version = config.FACEBOOK_API_VERSION;
    if (!/^v\d+\.0$/.test(version)) throw new Error('Invalid Facebook API version');
    let url = `https://graph.facebook.com/${version}/me/accounts?fields=id,name,tasks&limit=100`;
    const trustedDomain = 'graph.facebook.com';
    const cursors = new Set();

    for (let count = 0; url && count < 20; count++) {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname !== trustedDomain) {
        throw new Error('Untrusted Facebook pagination URL');
      }

      const res = await this.fetchResponse(url, {
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          Accept: 'application/json'
        }
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Facebook Page fetch failed (${res.status})`);
      }

      if (!Array.isArray(body.data)) throw new Error('Invalid Facebook Page response');
      const data = body.data;
      for (const page of data) {
        const tasks = page.tasks || [];
        const publishCapable = Array.isArray(tasks) && tasks.includes('CREATE_CONTENT');
        if (publishCapable && typeof page.id === 'string' && /^[\w-]+$/.test(page.id)) {
          pages.push({ id: page.id, name: typeof page.name === 'string' ? page.name : 'Facebook Page' });
        }
      }

      if (body.paging?.next) {
        const next = new URL(body.paging.next);
        if (next.protocol !== 'https:' || next.hostname !== trustedDomain || next.username || next.password || (next.port && next.port !== '443')) {
          throw new Error('Untrusted Facebook pagination URL');
        }
        const after = body.paging.cursors?.after;
        if (typeof after !== 'string' || after.length > 4096 || cursors.has(after)) throw new Error('Invalid Facebook pagination cursor');
        cursors.add(after);
        url = `https://graph.facebook.com/${version}/me/accounts?fields=id,name,tasks&limit=100&after=${encodeURIComponent(after)}`;
      } else {
        url = null;
      }
    }
    if (url) throw new Error('Facebook Page discovery limit exceeded');
    return pages;
  }

  async getFacebookPageCredentials(workspaceId, targetPageId, expectedConnectionId) {
    if (typeof targetPageId !== 'string' || !/^[\w-]+$/.test(targetPageId)) throw new Error('Invalid Facebook Page ID');
    const connection = expectedConnectionId
      ? (await this.listConnections(workspaceId, 'facebook')).find(candidate => candidate.connection_id === expectedConnectionId)
      : await this.getConnection(workspaceId, 'facebook');
    if (!connection) throw new Error(expectedConnectionId ? 'Facebook connection changed; cleanup requires the original connection' : 'Facebook is not connected');
    const credentials = await this.getCredentials(connection.connection_id, 'facebook');
    const userAccessToken = credentials.access_token || credentials.raw?.access_token;
    if (!userAccessToken) throw new Error('Facebook user access token is missing');

    const pages = await this.fetchFacebookPages(userAccessToken);
    if (!pages.some(page => page.id === targetPageId)) throw new Error('Reverification failed: Page ownership or CREATE_CONTENT permission was not verified');
    const response = await this.fetchResponse(`https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/${encodeURIComponent(targetPageId)}?fields=id,access_token`, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${userAccessToken}`, Accept: 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Facebook Page token request failed (${response.status})`);
    if (body.id !== targetPageId || typeof body.access_token !== 'string' || !body.access_token.trim()) throw new Error('Facebook Page access token is missing or mismatched');
    return { pageToken: body.access_token, connectionId: connection.connection_id };
  }

  async createFacebookLiveVideo(workspaceId, pageId) {
    const { pageToken, connectionId } = await this.getFacebookPageCredentials(workspaceId, pageId);
    if (!pageToken) {
      throw new Error('Failed to resolve Page access token');
    }

    const version = config.FACEBOOK_API_VERSION;
    const response = await this.fetchResponse(`https://graph.facebook.com/${version}/${pageId}/live_videos`, {
      redirect: 'error',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ status: 'LIVE_NOW' })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Facebook live_videos creation failed (${response.status})`);
    }

    const secureStreamUrl = body.secure_stream_url;
    const liveVideoId = body.id;
    if (typeof liveVideoId !== 'string' || !/^[\w-]+$/.test(liveVideoId)) throw new Error('Facebook did not return a valid live video ID; remote creation outcome is unknown');

    try {
      if (typeof secureStreamUrl !== 'string' || !secureStreamUrl || /[\s\\]/.test(secureStreamUrl)) {
        throw new Error('Facebook response did not include a secure stream URL');
      }

      let parsed;
      try {
        parsed = new URL(secureStreamUrl);
      } catch (e) {
        throw new Error('Invalid URL format');
      }

      if (parsed.protocol !== 'rtmps:') {
        throw new Error('Only rtmps protocol is supported');
      }
      if (!parsed.hostname) {
        throw new Error('URL must have a non-empty hostname');
      }
      if (parsed.username || parsed.password) {
        throw new Error('URL must not contain username or password');
      }
      if (parsed.hash || !parsed.pathname.startsWith('/rtmp/') || !parsed.pathname.slice(6) || parsed.pathname.slice(6).includes('/')) {
        throw new Error('Invalid Facebook secure_stream_url structure');
      }
      // Split only the path, never a slash occurring in a credential-bearing query.
      const streamUrl = `${parsed.protocol}//${parsed.host}/rtmp/`;
      const streamKey = parsed.pathname.slice(6) + parsed.search;

      return {
        liveVideoId,
        connectionId,
        streamUrl,
        streamKey
      };
    } catch (parseError) {
      // Must attempt to end the created live video
      try {
        const endUrl = `https://graph.facebook.com/${version}/${liveVideoId}?end_live_video=true`;
        const endResponse = await this.fetchResponse(endUrl, {
          redirect: 'error',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pageToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        });
        const endBody = await endResponse.json().catch(() => ({}));
        if (!endResponse.ok || endBody.success !== true) {
          throw new Error('Facebook cleanup was not confirmed');
        }
      } catch (cleanupErr) {
        const err = new Error(`Failed parsing Facebook secure stream URL: ${parseError.message}. Subsequent cleanup also failed: ${cleanupErr.message}`);
        err.liveVideoId = liveVideoId;
        err.pageId = pageId;
        err.connectionId = connectionId;
        throw err;
      }
      throw new Error(`Failed parsing Facebook secure stream URL: ${parseError.message}`);
    }
  }

  async getFacebookLiveVideoStatus(workspaceId, pageId, liveVideoId, connectionId) {
    if (typeof liveVideoId !== 'string' || !/^[\w-]+$/.test(liveVideoId)) throw new Error('Invalid Facebook live video ID');
    const { pageToken } = await this.getFacebookPageCredentials(workspaceId, pageId, connectionId);
    if (!pageToken) {
      throw new Error('Failed to resolve Page access token');
    }
    const version = config.FACEBOOK_API_VERSION;
    const response = await this.fetchResponse(`https://graph.facebook.com/${version}/${liveVideoId}?fields=id,status,permalink_url`, {
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Facebook live_video fetch failed (${response.status})`);
    }
    const body = await response.json().catch(() => ({}));
    if (body.id !== liveVideoId) throw new Error('Facebook live video response did not match');
    const statuses = ['LIVE', 'LIVE_NOW', 'LIVE_STOPPED', 'PROCESSING', 'VOD', 'UNPUBLISHED', 'SCHEDULED_UNPUBLISHED', 'SCHEDULED_LIVE', 'SCHEDULED_CANCELED'];
    let permalink_url = null;
    try {
      const link = new URL(body.permalink_url);
      if (link.protocol === 'https:' && (link.hostname === 'facebook.com' || link.hostname.endsWith('.facebook.com')) && !link.username && !link.password && !link.search && !link.hash) permalink_url = link.href;
    } catch {}
    return { id: liveVideoId, status: statuses.includes(body.status) ? body.status : 'unknown', permalink_url };
  }

  async endFacebookLiveVideo(workspaceId, pageId, liveVideoId, connectionId) {
    if (typeof liveVideoId !== 'string' || !/^[\w-]+$/.test(liveVideoId)) throw new Error('Invalid Facebook live video ID');
    const { pageToken } = await this.getFacebookPageCredentials(workspaceId, pageId, connectionId);
    if (!pageToken) {
      throw new Error('Failed to resolve Page access token');
    }

    const version = config.FACEBOOK_API_VERSION;
    const response = await this.fetchResponse(`https://graph.facebook.com/${version}/${liveVideoId}?end_live_video=true`, {
      redirect: 'error',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        Accept: 'application/json'
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Facebook end_live_video failed (${response.status})`);
    }
    if (body.success !== true) throw new Error('Facebook end_live_video was not confirmed');
    return { success: true };
  }

  async discoverTargets(workspaceId, provider) {
    if (provider === 'twitch') {
      const body = await this.twitchRequest(workspaceId, '/users');
      return (body.data || []).map(user => ({ id: String(user.id), name: user.display_name || user.login || 'Twitch channel' }));
    }
    if (provider === 'youtube') {
      const body = await this.youtubeRequest(workspaceId, '/channels?part=id%2Csnippet&mine=true');
      return (body.items || []).map(channel => ({
        id: String(channel.id),
        name: channel.snippet?.title || 'YouTube channel'
      }));
    }
    if (provider === 'facebook') {
      const connection = await this.getConnection(workspaceId, 'facebook');
      if (!connection) return [];
      const credentials = await this.getCredentials(connection.connection_id, 'facebook');
      const userAccessToken = credentials.access_token || credentials.raw?.access_token;
      if (!userAccessToken) return [];
      const pages = await this.fetchFacebookPages(userAccessToken);
      return pages.map(p => ({ id: String(p.id), name: p.name }));
    }
    return [];
  }

  async resolveDestination(workspaceId, provider, externalId, broadcastId = null) {
    if (provider === 'facebook') {
      const liveVideo = await this.createFacebookLiveVideo(workspaceId, externalId);
      return {
        streamUrl: liveVideo.streamUrl,
        streamKey: liveVideo.streamKey,
        liveVideoId: liveVideo.liveVideoId,
        connectionId: liveVideo.connectionId
      };
    }
    if (provider === 'twitch') {
      const query = new URLSearchParams({ broadcaster_id: externalId });
      const body = await this.twitchRequest(workspaceId, `/streams/key?${query}`);
      const streamKey = body.data?.[0]?.stream_key;
      if (!streamKey) throw new Error('Twitch did not return a stream key');
      return { streamUrl: 'rtmp://live.twitch.tv/app', streamKey };
    }
    if (provider === 'youtube') {
      const target = db.queryOne(
        'SELECT * FROM provider_targets WHERE workspace_id = ? AND provider = ? AND external_id = ?',
        [workspaceId, 'youtube', externalId]
      );
      if (!target) {
        throw new Error('Provider target not found in database');
      }
      const actualBroadcastId = broadcastId || target.selected_broadcast_id;
      if (!actualBroadcastId) {
        throw new Error('No broadcast has been selected for this YouTube channel. Please select or create a broadcast first.');
      }

      const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
      if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
        throw new Error('The connected YouTube channel no longer matches this destination');
      }

      const bRes = await this.youtubeApiRequest(
        workspaceId,
        `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(actualBroadcastId)}`
      );
      const broadcast = bRes.items?.[0];
      if (!broadcast) {
        throw new Error('The selected YouTube broadcast could not be found or has been deleted');
      }

      if (String(broadcast.id) !== String(actualBroadcastId) || broadcast.snippet?.channelId !== externalId) {
        throw new Error('The selected broadcast does not belong to this YouTube destination');
      }

      const lifeCycle = broadcast.status?.lifeCycleStatus;
      if (lifeCycle === 'complete' || lifeCycle === 'completed') {
        throw new Error('The selected YouTube broadcast has already been completed and cannot be reused');
      }

      const boundStreamId = broadcast.contentDetails?.boundStreamId;
      if (!boundStreamId) {
        throw new Error('The selected YouTube broadcast does not have a bound stream');
      }

      const sRes = await this.youtubeApiRequest(
        workspaceId,
        `/liveStreams?part=id,cdn,status&id=${encodeURIComponent(boundStreamId)}`
      );
      const stream = sRes.items?.[0];
      if (!stream || String(stream.id) !== String(boundStreamId)) {
        throw new Error('The bound YouTube liveStream could not be found');
      }

      if (!stream.cdn?.ingestionInfo?.ingestionAddress || !stream.cdn?.ingestionInfo?.streamName) {
        throw new Error('Bound YouTube liveStream is missing ingestion details');
      }

      return {
        streamUrl: stream.cdn.ingestionInfo.ingestionAddress,
        streamKey: stream.cdn.ingestionInfo.streamName
      };
    }
    throw new Error(`${provider} relay setup is not available yet`);
  }

  async getYoutubeBroadcasts(workspaceId, externalId) {
    const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
    if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
      throw new Error('The connected YouTube channel no longer matches this destination');
    }

    const body = await this.youtubeApiRequest(workspaceId, '/liveBroadcasts?part=id,snippet,status,contentDetails&broadcastStatus=all&maxResults=50');
    const broadcasts = (body.items || []).filter(item => item.snippet?.channelId === externalId).map(item => ({
      id: item.id,
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      privacyStatus: item.status?.privacyStatus || 'private',
      lifeCycleStatus: item.status?.lifeCycleStatus || 'ready',
      boundStreamId: item.contentDetails?.boundStreamId || null,
      scheduledStartTime: item.snippet?.scheduledStartTime || null,
      latencyPreference: item.contentDetails?.latencyPreference || 'normal',
      categoryId: item.snippet?.categoryId || null,
      thumbnailUrl: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url || null
    }));

    return broadcasts;
  }

  async createYoutubeBroadcast(workspaceId, externalId, params) {
    const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
    if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
      throw new Error('The connected YouTube channel no longer matches this destination');
    }

    const { title, description, privacyStatus, scheduledStartTime, latencyPreference, categoryId } = params;
    if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('Broadcast title must contain 1–100 characters');
    if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) throw new Error('Broadcast description exceeds 5000 characters');
    if (privacyStatus && !['private', 'unlisted', 'public'].includes(privacyStatus)) throw new Error('Invalid broadcast privacy');
    if (latencyPreference && !['normal', 'low', 'ultraLow'].includes(latencyPreference)) throw new Error('Invalid broadcast latency');

    const broadcastBody = {
      snippet: {
        title: title || 'Emberstage Live Broadcast',
        description: description || '',
        scheduledStartTime: scheduledStartTime || new Date().toISOString(),
        ...(categoryId ? { categoryId } : {})
      },
      status: {
        privacyStatus: privacyStatus || 'private'
      },
      contentDetails: {
        latencyPreference: latencyPreference || 'normal',
        enableAutoStart: false,
        enableAutoStop: false
      }
    };

    const broadcast = await this.youtubeApiRequest(workspaceId, '/liveBroadcasts?part=id,snippet,status,contentDetails', {
      method: 'POST',
      body: JSON.stringify(broadcastBody)
    });

    const streamBody = {
      snippet: {
        title: (title || 'Emberstage') + ' Stream Key'
      },
      cdn: {
        frameRate: 'variable',
        ingestionType: 'rtmp',
        resolution: 'variable'
      }
    };

    const stream = await this.youtubeApiRequest(workspaceId, '/liveStreams?part=id,snippet,cdn,status', {
      method: 'POST',
      body: JSON.stringify(streamBody)
    });

    if (!broadcast.id || !stream.id) throw new Error('YouTube did not return the created broadcast and stream');
    const bound = await this.youtubeApiRequest(workspaceId, `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,snippet,status,contentDetails`, {
      method: 'POST'
    });

    if (bound.id !== broadcast.id || bound.contentDetails?.boundStreamId !== stream.id) throw new Error('YouTube did not confirm the requested broadcast binding');
    return bound;
  }

  async updateYoutubeBroadcast(workspaceId, externalId, broadcastId, params) {
    const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
    if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
      throw new Error('The connected YouTube channel no longer matches this destination');
    }

    const getRes = await this.youtubeApiRequest(workspaceId, `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(broadcastId)}`);
    const existing = getRes.items?.[0];
    if (!existing || existing.snippet?.channelId !== externalId) {
      throw new Error('Broadcast not found on this YouTube channel');
    }
    if (['complete', 'completed', 'revoked'].includes(existing.status?.lifeCycleStatus)) {
      throw new Error('The selected YouTube broadcast has ended');
    }
    // Reconnecting an encoder must not rewrite immutable settings on a live event.
    if (Object.keys(params).length === 1 && params.enableAutoStart === true && existing.contentDetails?.enableAutoStart === true) {
      return existing;
    }

    const { title, description, privacyStatus, latencyPreference, categoryId, enableAutoStart, enableAutoStop } = params;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 100)) throw new Error('Broadcast title must contain 1–100 characters');
    if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) throw new Error('Broadcast description exceeds 5000 characters');
    if (privacyStatus !== undefined && !['private', 'unlisted', 'public'].includes(privacyStatus)) throw new Error('Invalid broadcast privacy');
    if (latencyPreference !== undefined && !['normal', 'low', 'ultraLow'].includes(latencyPreference)) throw new Error('Invalid broadcast latency');
    if (enableAutoStart !== undefined && typeof enableAutoStart !== 'boolean') throw new Error('enableAutoStart must be a boolean');
    if (enableAutoStop !== undefined && typeof enableAutoStop !== 'boolean') throw new Error('enableAutoStop must be a boolean');

    const updatedSnippet = {
      title: existing.snippet.title,
      description: existing.snippet.description,
      scheduledStartTime: existing.snippet.scheduledStartTime,
      scheduledEndTime: existing.snippet.scheduledEndTime,
      categoryId: existing.snippet.categoryId,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(categoryId !== undefined ? { categoryId } : {})
    };

    const updatedStatus = {
      privacyStatus: existing.status?.privacyStatus,
      ...(privacyStatus !== undefined ? { privacyStatus } : {})
    };

    const updatedContentDetails = {};
    for (const key of ['enableAutoStart', 'enableAutoStop', 'enableClosedCaptions', 'enableDvr', 'enableEmbed', 'recordFromStart', 'latencyPreference']) {
      if (existing.contentDetails?.[key] !== undefined) updatedContentDetails[key] = existing.contentDetails[key];
    }
    updatedContentDetails.monitorStream = {
      enableMonitorStream: existing.contentDetails?.monitorStream?.enableMonitorStream ?? true,
      broadcastStreamDelayMs: existing.contentDetails?.monitorStream?.broadcastStreamDelayMs ?? 0
    };
    if (latencyPreference !== undefined) updatedContentDetails.latencyPreference = latencyPreference;
    if (enableAutoStart !== undefined) updatedContentDetails.enableAutoStart = enableAutoStart;
    if (enableAutoStop !== undefined) updatedContentDetails.enableAutoStop = enableAutoStop;

    const updateBody = {
      id: broadcastId,
      snippet: updatedSnippet,
      status: updatedStatus,
      contentDetails: updatedContentDetails
    };

    const updated = await this.youtubeApiRequest(workspaceId, '/liveBroadcasts?part=id,snippet,status,contentDetails', {
      method: 'PUT',
      body: JSON.stringify(updateBody)
    });

    return updated;
  }

  async uploadYoutubeThumbnail(workspaceId, externalId, broadcastId, contentType, dataBase64) {
    const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
    if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
      throw new Error('The connected YouTube channel no longer matches this destination');
    }

    if (!['image/jpeg', 'image/png'].includes(contentType) || typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new Error('Thumbnail must be a JPEG or PNG image');
    const broadcast = await this.youtubeApiRequest(workspaceId, `/liveBroadcasts?part=id,snippet&id=${encodeURIComponent(broadcastId)}`);
    if (broadcast.items?.[0]?.snippet?.channelId !== externalId) throw new Error('Broadcast not found on this YouTube channel');
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > 2 * 1024 * 1024) {
      throw new Error('Thumbnail size exceeds 2MB limit');
    }

    const connection = await this.getConnection(workspaceId, 'youtube');
    if (!connection) throw new Error('YouTube is not connected');
    const credentials = await this.getCredentials(connection.connection_id, 'youtube');
    const accessToken = credentials.access_token || credentials.raw?.access_token;
    if (!accessToken) throw new Error('Nango did not return a YouTube access token');

    const uploadUrl = `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(broadcastId)}`;
    const response = await this.fetchResponse(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType || 'image/jpeg',
        'Content-Length': String(buffer.length)
      },
      body: buffer
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`YouTube thumbnail upload failed (${response.status})`);
    return body;
  }

  async transitionYoutubeBroadcast(workspaceId, externalId, broadcastId, status) {
    if (!['live', 'complete'].includes(status)) throw new Error('Invalid broadcast transition');
    const channels = await this.youtubeApiRequest(workspaceId, '/channels?part=id&mine=true');
    if (!(channels.items || []).some(channel => String(channel.id) === String(externalId))) {
      throw new Error('The connected YouTube channel no longer matches this destination');
    }

    const broadcast = await this.youtubeApiRequest(workspaceId, `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(broadcastId)}`);
    if (broadcast.items?.[0]?.snippet?.channelId !== externalId) throw new Error('Broadcast not found on this YouTube channel');
    const targetStatus = status;
    const response = await this.youtubeApiRequest(
      workspaceId,
      `/liveBroadcasts/transition?id=${encodeURIComponent(broadcastId)}&broadcastStatus=${encodeURIComponent(targetStatus)}&part=id,snippet,status,contentDetails`,
      { method: 'POST' }
    );
    return response;
  }
}

export const nangoClient = new NangoClient();
