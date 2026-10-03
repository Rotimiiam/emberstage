(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.OBSBibleBroadcastBranding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORAGE_KEYS = Object.freeze({
    draft: 'obs-bible-scripture-broadcast-draft',
    applied: 'obs-bible-scripture-broadcast-applied',
    payload: 'obs-bible-saved-message-payload',
  });

  const PROTOCOL = 'obs-bible-scripture-broadcast/v1';
  const TEXT_STORAGE_KEYS = Object.freeze({
    draft: 'obs-bible-text-broadcast-draft',
    applied: 'obs-bible-text-broadcast-applied',
  });
  const SONG_LAYOUT_KEY = 'obs-bible-song-layout-v1';
  function isCompactSongLayout(layout) {
    return ['lower-third', 'gradient-strip', 'lyric-card'].includes(layout);
  }

  function sanitizeSongLayout(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      layout: sanitizeChoice(source.layout, ['full-screen', 'half-screen', 'lower-third', 'gradient-strip', 'lyric-card', 'side-panel'], 'full-screen'),
      position: sanitizeChoice(source.position, ['left', 'center', 'right'], 'left'),
    };
  }

  function sanitizeSongCue(input) {
    if (!input || !Array.isArray(input.lines) || !input.lines.length) return null;
    const lines = input.lines.slice(0, 500).map(line => String(line ?? '').slice(0, 4000));
    return {
      lines,
      lineIndex: Math.max(0, Math.min(lines.length - 1, Math.floor(Number(input.lineIndex) || 0))),
      singleLine: input.singleLine === true,
    };
  }

  function songCueLines(cue, layout) {
    const song = sanitizeSongCue(cue);
    if (!song) return [];
    if (song.singleLine) return song.lines.slice(song.lineIndex, song.lineIndex + 1);
    if (isCompactSongLayout(layout)) {
      return song.lines.slice(song.lineIndex, song.lineIndex + 2);
    }
    return song.lines;
  }

  function songCuePagination(cue, layout) {
    const song = sanitizeSongCue(cue);
    if (!song) return { step: 1, pageIndex: 0, pageCount: 0 };
    const step = song.singleLine ? 1 : (isCompactSongLayout(layout) ? 2 : Math.max(song.lines.length, 1));
    const pageCount = Math.max(1, Math.ceil(song.lines.length / step));
    const pageIndex = Math.min(pageCount - 1, Math.floor(song.lineIndex / step));
    return { step, pageIndex, pageCount };
  }
  const ALLOWED_LOGO_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_LOGO_FILE_BYTES = 1024 * 1024;
  const MAX_LOGO_DATA_URL_LENGTH = 1600000;
  const MIN_LOGO_DIMENSION = 24;
  const MAX_LOGO_DIMENSION = 4096;
  const MAX_LOGO_PIXELS = 4096 * 4096;
  const LAYOUTS = Object.freeze(['legacy', 'lower-third', 'full-screen']);
  const LOGO_POSITIONS = Object.freeze(['top-left', 'top-right', 'in-card']);
  const MOTIONS = Object.freeze(['none', 'fade', 'rise']);
  const DURATIONS = Object.freeze([150, 300, 500]);

  const DEFAULT_BROADCAST_SETTINGS = Object.freeze({
    layout: 'legacy',
    churchName: '',
    logoDataUrl: '',
    accentColor: '#d7b46a',
    logoPosition: 'in-card',
    entranceStyle: 'fade',
    entranceDuration: 300,
    exitStyle: 'fade',
    exitDuration: 300,
    safeMarginPercent: 5,
  });

  function nearestDuration(value, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (DURATIONS.includes(numeric)) return numeric;
    if (!Number.isFinite(numeric)) return fallback;
    return DURATIONS.reduce((best, current) => {
      return Math.abs(current - numeric) < Math.abs(best - numeric) ? current : best;
    }, fallback);
  }

  function sanitizeText(value, maxLength) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function sanitizeAccentColor(value, fallback) {
    const text = String(value ?? '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
      return '#' + text.slice(1).split('').map(char => char + char).join('').toLowerCase();
    }
    return fallback;
  }

  function sanitizeChoice(value, allowedValues, fallback) {
    return allowedValues.includes(value) ? value : fallback;
  }

  function isAllowedLogoMimeType(mimeType) {
    return ALLOWED_LOGO_MIME_TYPES.includes(String(mimeType || '').toLowerCase());
  }

  function isSafeLogoDataUrl(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (text.length > MAX_LOGO_DATA_URL_LENGTH) return false;
    return /^data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,[a-z0-9+/=]+$/i.test(text);
  }

  function sanitizeBroadcastSettings(input, fallback) {
    const base = Object.assign({}, DEFAULT_BROADCAST_SETTINGS, fallback || {});
    const source = input && typeof input === 'object' ? input : {};
    return {
      layout: sanitizeChoice(source.layout, LAYOUTS, base.layout),
      churchName: sanitizeText(source.churchName, 80),
      logoDataUrl: isSafeLogoDataUrl(source.logoDataUrl) ? String(source.logoDataUrl || '') : base.logoDataUrl,
      accentColor: sanitizeAccentColor(source.accentColor, base.accentColor),
      logoPosition: sanitizeChoice(source.logoPosition, LOGO_POSITIONS, base.logoPosition),
      entranceStyle: sanitizeChoice(source.entranceStyle, MOTIONS, base.entranceStyle),
      entranceDuration: nearestDuration(source.entranceDuration, base.entranceDuration),
      exitStyle: sanitizeChoice(source.exitStyle, MOTIONS, base.exitStyle),
      exitDuration: nearestDuration(source.exitDuration, base.exitDuration),
      safeMarginPercent: 5,
    };
  }

  function coerceMessagePayload(message) {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      return {
        fadein: message.fadein === true,
        messageContent: typeof message.messageContent === 'string' ? message.messageContent : '',
        kind: typeof message.kind === 'string' ? message.kind : '',
        position: typeof message.position === 'string' ? message.position : null,
        song: message.kind === 'song' ? sanitizeSongCue(message.song) : null,
        scripture: message.scripture && typeof message.scripture === 'object'
          ? {
              reference: sanitizeText(message.scripture.reference, 120),
              verseText: sanitizeText(message.scripture.verseText, 2000),
            }
          : null,
      };
    }

    return {
      fadein: false,
      messageContent: typeof message === 'string' ? message : '',
      kind: '',
      position: null,
      scripture: null,
    };
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }

  function stripMarkup(html) {
    return decodeEntities(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''));
  }

  function extractScriptureParts(payload) {
    const normalized = coerceMessagePayload(payload);
    if (normalized.kind === 'text') {
      return { reference: '', verseText: stripMarkup(normalized.messageContent) };
    }
    if (normalized.scripture && (normalized.scripture.reference || normalized.scripture.verseText)) {
      return normalized.scripture;
    }

    const markup = normalized.messageContent || '';
    const match = markup.match(/^\s*<span>([\s\S]*?)<\/span>\s*([\s\S]*)$/i);
    if (match) {
      return {
        reference: sanitizeText(stripMarkup(match[1]), 120),
        verseText: sanitizeText(stripMarkup(match[2]), 2000),
      };
    }

    return {
      reference: '',
      verseText: sanitizeText(stripMarkup(markup), 2000),
    };
  }

  function shouldUseBroadcastLayout(payload, settings) {
    const normalizedPayload = coerceMessagePayload(payload);
    const normalizedSettings = sanitizeBroadcastSettings(settings);
    return ['scripture', 'text'].includes(normalizedPayload.kind) && normalizedSettings.layout !== 'legacy';
  }

  return {
    SONG_LAYOUT_KEY,
    isCompactSongLayout,
    sanitizeSongLayout,
    sanitizeSongCue,
    songCueLines,
    songCuePagination,
    STORAGE_KEYS,
    TEXT_STORAGE_KEYS,
    PROTOCOL,
    ALLOWED_LOGO_MIME_TYPES,
    MAX_LOGO_FILE_BYTES,
    MAX_LOGO_DATA_URL_LENGTH,
    MIN_LOGO_DIMENSION,
    MAX_LOGO_DIMENSION,
    MAX_LOGO_PIXELS,
    DEFAULT_BROADCAST_SETTINGS,
    sanitizeBroadcastSettings,
    sanitizeAccentColor,
    coerceMessagePayload,
    extractScriptureParts,
    shouldUseBroadcastLayout,
    isAllowedLogoMimeType,
    isSafeLogoDataUrl,
  };
});
