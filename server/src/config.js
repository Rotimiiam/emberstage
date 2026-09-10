import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple robust .env parser
function loadEnv() {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.substring(0, index).trim();
      let val = trimmed.substring(index + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.substring(1, val.length - 1);
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.substring(1, val.length - 1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

export const config = {
  get PORT() { return parseInt(process.env.PORT || '3000', 10); },
  get HOST() {
    if (process.env.NODE_ENV === 'production') {
      const appBaseUrl = process.env.APP_BASE_URL || '';
      const encryptionSecret = process.env.ENCRYPTION_SECRET || '';
      const isHttps = appBaseUrl.startsWith('https://');
      const hasRealSecret = encryptionSecret && encryptionSecret !== 'default-super-secret-emberstage-encryption-key-for-mvp-setup';
      if (isHttps && hasRealSecret) {
        return process.env.HOST || '0.0.0.0';
      }
    }
    return '127.0.0.1';
  },
  get DATABASE_URL() { return process.env.DATABASE_URL || 'emberstage.db'; },
  get ENCRYPTION_SECRET() { return process.env.ENCRYPTION_SECRET || 'default-super-secret-emberstage-encryption-key-for-mvp-setup'; },
  
  // Google OIDC Auth
  get GOOGLE_CLIENT_ID() { return process.env.GOOGLE_CLIENT_ID || null; },
  get GOOGLE_CLIENT_SECRET() { return process.env.GOOGLE_CLIENT_SECRET || null; },
  get GOOGLE_REDIRECT_URI() { return process.env.GOOGLE_REDIRECT_URI || null; },

  // Auth0 Auth Configuration
  get AUTH0_DOMAIN() { return process.env.AUTH0_DOMAIN || null; },
  get AUTH0_CLIENT_ID() { return process.env.AUTH0_CLIENT_ID || null; },
  get AUTH0_CLIENT_SECRET() { return process.env.AUTH0_CLIENT_SECRET || null; },
  get AUTH0_REDIRECT_URI() { return process.env.AUTH0_REDIRECT_URI || null; },

  // Twitch OAuth
  get TWITCH_CLIENT_ID() { return process.env.TWITCH_CLIENT_ID || null; },
  get TWITCH_CLIENT_SECRET() { return process.env.TWITCH_CLIENT_SECRET || null; },
  get TWITCH_REDIRECT_URI() { return process.env.TWITCH_REDIRECT_URI || null; },

  // YouTube OAuth (scaffolded but honest unavailable without credentials)
  get YOUTUBE_CLIENT_ID() { return process.env.YOUTUBE_CLIENT_ID || null; },
  get YOUTUBE_CLIENT_SECRET() { return process.env.YOUTUBE_CLIENT_SECRET || null; },
  get YOUTUBE_REDIRECT_URI() { return process.env.YOUTUBE_REDIRECT_URI || null; },

  // Facebook OAuth (scaffolded but honest unavailable without credentials)
  get FACEBOOK_CLIENT_ID() { return process.env.FACEBOOK_CLIENT_ID || null; },
  get FACEBOOK_CLIENT_SECRET() { return process.env.FACEBOOK_CLIENT_SECRET || null; },
  get FACEBOOK_REDIRECT_URI() { return process.env.FACEBOOK_REDIRECT_URI || null; },
  get FACEBOOK_API_VERSION() { return process.env.FACEBOOK_API_VERSION || 'v25.0'; },

  // Self-hosted Nango provider credential broker
  get NANGO_BASE_URL() { return process.env.NANGO_BASE_URL || null; },
  get NANGO_SECRET_KEY() { return process.env.NANGO_SECRET_KEY || null; },
  get NANGO_TWITCH_INTEGRATION_ID() { return process.env.NANGO_TWITCH_INTEGRATION_ID || 'twitch'; },
  get NANGO_YOUTUBE_INTEGRATION_ID() { return process.env.NANGO_YOUTUBE_INTEGRATION_ID || 'youtube'; },
  get NANGO_FACEBOOK_INTEGRATION_ID() { return process.env.NANGO_FACEBOOK_INTEGRATION_ID || 'facebook'; },

  // Paystack
  get PAYSTACK_SECRET_KEY() { return process.env.PAYSTACK_SECRET_KEY || null; },
  get PAYSTACK_PLAN_CODE() { return process.env.PAYSTACK_PLAN_CODE || null; },
  get PAYSTACK_PLAN_AMOUNT() { return process.env.PAYSTACK_PLAN_AMOUNT || null; },
  get PAYSTACK_CURRENCY() { return process.env.PAYSTACK_CURRENCY || 'NGN'; },
  get APP_BASE_URL() { return process.env.APP_BASE_URL || null; },
  get IS_PROD() { return process.env.NODE_ENV === 'production'; },
  get CONTRIBUTION_INGEST_URL() { return process.env.CONTRIBUTION_INGEST_URL || 'rtmp://localhost/live'; },
  get FFMPEG_PATH() { return process.env.FFMPEG_PATH || 'ffmpeg'; },
  get FAKE_WORKERS() { return process.env.FAKE_WORKERS === 'true'; },
  get RTMP_INGEST_BASE_URL() { return process.env.RTMP_INGEST_BASE_URL || 'rtmp://127.0.0.1/live'; },
};

// Simple validation
if (config.DATABASE_URL !== ':memory:' && !config.DATABASE_URL.endsWith('.db')) {
  console.warn(`[Emberstage Config Warning]: DATABASE_URL is set to '${config.DATABASE_URL}'. Usually a local SQLite database should end with .db`);
}

if (config.ENCRYPTION_SECRET === 'default-super-secret-emberstage-encryption-key-for-mvp-setup') {
  console.warn(`[Emberstage Config Warning]: ENCRYPTION_SECRET is using default value. This is insecure for production!`);
}
