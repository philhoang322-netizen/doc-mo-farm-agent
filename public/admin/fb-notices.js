/**
 * Facebook Page system notices that Graph stores as ordinary messages.
 * Shared by the inbox card and the Node ingest/classify path.
 * Pattern only: no network, no message logging.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.fbNotices = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LABELS = {
    post: 'Xem bài viết',
    ad: 'Xem quảng cáo',
    story: 'Xem story',
    comment: 'Xem bình luận',
    reel: 'Xem reel',
  };

  function fold(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function urlSpans(text) {
    const raw = String(text || '');
    const re = /https?:\/\/[^\s<>"']+/gi;
    const spans = [];
    let match;
    while ((match = re.exec(raw))) {
      let end = match.index + match[0].length;
      while (end > match.index && /[)\].,;:!?]$/.test(raw.slice(match.index, end))) end -= 1;
      const url = raw.slice(match.index, end);
      if (url.length > 'https://'.length) spans.push({ start: match.index, end, url });
    }
    return spans;
  }

  function extractUrls(text) {
    return urlSpans(text).map((span) => span.url);
  }

  function isFacebookPostUrl(url) {
    return /facebook\.com\/(?:story\.php|permalink\.php)|story_fbid=|facebook\.com\/[^/?#]+\/posts\//i.test(String(url || ''));
  }

  function storyIdFromUrl(url) {
    const raw = String(url || '');
    if (!raw) return null;
    let id = '';
    try {
      const parsed = new URL(raw);
      id = parsed.searchParams.get('story_fbid') || parsed.searchParams.get('fbid') || '';
      if (!id) {
        const path = parsed.pathname.match(/\/(?:posts|reel|videos)\/([^/?]+)/);
        if (path) id = decodeURIComponent(path[1]);
      }
    } catch (err) {
      const loose = raw.match(/story_fbid=([^&]+)/);
      if (loose) id = loose[1];
    }
    if (!id) return null;
    return id.slice(0, 120);
  }

  function kindOf(text) {
    const src = String(text || '');
    const folded = fold(src.replace(/https?:\/\/[^\s<>"']+/gi, ' '));
    if (!folded) return null;
    const at = folded.search(/da tra loi|replied to/);
    if (at < 0 || at > 80) return null;
    const bodyOnly = src.replace(/https?:\/\/\S+/g, '').trim();
    if (bodyOnly.length > 400) return null;
    if (
      folded.includes('chao mung tu dong')
      || folded.includes('automatic greeting')
      || folded.includes('automated greeting')
      || folded.includes('welcome message')
      || (folded.includes('loi chao') && folded.includes('cai dat tin nhan'))
    ) return 'greeting';
    if (folded.includes('quang cao') || /\byour ad\b/.test(folded) || /\ban ad\b/.test(folded)) return 'ad';
    if (folded.includes('binh luan') || /\byour comment\b/.test(folded) || /\ba comment\b/.test(folded)) return 'comment';
    if (/\breel\b/.test(folded)) return 'reel';
    if (/\bstory\b/.test(folded) || folded.includes('cau chuyen')) return 'story';
    const hasPostUrl = extractUrls(src).some(isFacebookPostUrl);
    if (
      folded.includes('bai viet')
      || /\byour post\b/.test(folded)
      || /\ba post\b/.test(folded)
      || hasPostUrl
    ) return 'post';
    return null;
  }

  function labelFor(kind) {
    return LABELS[kind] || null;
  }

  function describe(text) {
    const kind = kindOf(text);
    if (!kind) return null;
    const urls = extractUrls(text);
    const url = (urls.find(isFacebookPostUrl) || urls[0] || '').slice(0, 500);
    return {
      kind,
      hide: kind === 'greeting',
      label: labelFor(kind),
      url: url || null,
      storyId: storyIdFromUrl(url),
    };
  }

  function shortLabel(url) {
    const raw = String(url || '');
    if (isFacebookPostUrl(raw)) return 'Xem bài viết';
    if (/facebook\.com\/reel\//i.test(raw)) return 'Xem reel';
    try {
      const host = new URL(raw).hostname.replace(/^www\./i, '');
      return host || 'Liên kết';
    } catch (err) {
      return 'Liên kết';
    }
  }

  const NOISE_TOKENS = new Set([
    'https', 'http', 'www', 'com', 'facebook', 'fb', 'story', 'fbid', 'pfbid',
    'php', 'permalink', 'reel', 'watch', 'utm',
  ]);

  const NOISE_PHRASES = new Set([
    'bai viet', 'binh luan', 'quang cao', 'tra loi', 'chao mung', 'tu dong',
    'cai dat', 'tin nhan', 'story fbid', 'xem bai', 'xem story',
  ]);

  function stripUrls(text) {
    return String(text || '').replace(/https?:\/\/\S+/gi, ' ');
  }

  function noisePhrase(phrase) {
    const folded = fold(phrase);
    if (!folded) return true;
    if (NOISE_PHRASES.has(folded)) return true;
    return folded.split(' ').some((token) => (
      NOISE_TOKENS.has(token)
      || token.startsWith('pfbid')
      || token.length >= 16
    ));
  }

  function linkParts(text) {
    const raw = String(text || '');
    const spans = urlSpans(raw).filter((span) => span.url.length >= 36);
    if (!spans.length) return [{ type: 'text', text: raw }];
    const parts = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) parts.push({ type: 'text', text: raw.slice(cursor, span.start) });
      parts.push({ type: 'link', label: shortLabel(span.url), url: span.url });
      cursor = span.end;
    }
    if (cursor < raw.length) parts.push({ type: 'text', text: raw.slice(cursor) });
    return parts;
  }

  return {
    fold,
    describe,
    extractUrls,
    storyIdFromUrl,
    shortLabel,
    labelFor,
    linkParts,
    stripUrls,
    noisePhrase,
  };
});
