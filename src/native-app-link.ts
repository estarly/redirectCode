/**
 * El 302 a https://instagram.com abre la web, que pide «Abrir Instagram».
 * En Android el intent abre la app. En iPhone un salto mínimo lanza la app
 * y, si no está instalada, vuelve a la web.
 */

export type PhonePlatform = 'android' | 'ios' | 'other';

export type NfcPresentation =
  | { kind: 'redirect'; url: string }
  | { kind: 'html'; html: string };

type AppTarget = { iosUrl: string; packageName: string };

const RESERVED = new Set([
  'about',
  'accounts',
  'directory',
  'explore',
  'login',
  'p',
  'privacy',
  'reel',
  'reels',
  'stories',
  'terms',
  'tv',
  'watch',
]);

export const phonePlatform = (userAgent?: string): PhonePlatform => {
  const ua = String(userAgent || '');
  if (/android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'other';
};

const bareHost = (hostname: string) => hostname.replace(/^www\./, '').toLowerCase();

const firstSegment = (pathname: string) => {
  const raw = String(pathname || '')
    .split('/')
    .filter(Boolean)[0];
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const handleOf = (segment: string) => segment.replace(/^@+/, '').trim();

const isHandle = (value: string) =>
  Boolean(value) &&
  !RESERVED.has(value.toLowerCase()) &&
  /^(?!.*\.\.)(?!\.)(?!.*\.$)[A-Za-z0-9._]{1,50}$/.test(value);

/** Chrome abre esta URL directo en el paquete, sin pasar por la web. */
const androidIntent = (webUrl: string, packageName: string) => {
  const u = new URL(webUrl);
  const path = `${u.host}${u.pathname}${u.search}`;
  return `intent://${path}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
};

const targetFor = (raw: string): AppTarget | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = bareHost(u.hostname);
  const segment = handleOf(firstSegment(u.pathname));

  if (host === 'instagram.com' || host === 'instagr.am') {
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `instagram://user?username=${encodeURIComponent(segment)}`,
      packageName: 'com.instagram.android',
    };
  }

  if (host === 'threads.net' || host === 'threads.com') {
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `barcelona://user?username=${encodeURIComponent(segment)}`,
      packageName: 'com.instagram.barcelona',
    };
  }

  if (host === 'facebook.com' || host === 'fb.com' || host === 'm.facebook.com' || host === 'fb.me') {
    const id = String(u.searchParams.get('id') || '').trim();
    if (/profile\.php$/i.test(firstSegment(u.pathname)) && /^\d{5,}$/.test(id)) {
      return { iosUrl: `fb://profile/${id}`, packageName: 'com.facebook.katana' };
    }
    if (/^\d{5,}$/.test(segment)) {
      return { iosUrl: `fb://profile/${segment}`, packageName: 'com.facebook.katana' };
    }
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `fb://facewebmodal/f?href=${encodeURIComponent(u.toString())}`,
      packageName: 'com.facebook.katana',
    };
  }

  if (host === 'wa.me' || host === 'whatsapp.com' || host === 'api.whatsapp.com') {
    const fromPath = firstSegment(u.pathname);
    const phone = String(u.searchParams.get('phone') || (/^\d{8,}$/.test(fromPath) ? fromPath : '')).replace(
      /\D/g,
      '',
    );
    if (phone.length < 8) return null;
    const qs = new URLSearchParams();
    qs.set('phone', phone);
    const text = u.searchParams.get('text');
    if (text) qs.set('text', text);
    return {
      iosUrl: `whatsapp://send?${qs.toString()}`,
      packageName: 'com.whatsapp',
    };
  }

  if (host === 'tiktok.com') {
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `tiktok://user?username=${encodeURIComponent(segment)}`,
      packageName: 'com.zhiliaoapp.musically',
    };
  }

  if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
    return {
      iosUrl: `youtube://${u.host}${u.pathname}${u.search}`,
      packageName: 'com.google.android.youtube',
    };
  }

  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.org') {
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `tg://resolve?domain=${encodeURIComponent(segment)}`,
      packageName: 'org.telegram.messenger',
    };
  }

  if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
    if (!isHandle(segment)) return null;
    return {
      iosUrl: `twitter://user?screen_name=${encodeURIComponent(segment)}`,
      packageName: 'com.twitter.android',
    };
  }

  if (host === 'linkedin.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const kind = (parts[0] || '').toLowerCase();
    const name = handleOf(parts[1] || '');
    if ((kind !== 'in' && kind !== 'company') || !isHandle(name)) return null;
    return {
      iosUrl: `linkedin://${kind}/${encodeURIComponent(name)}`,
      packageName: 'com.linkedin.android',
    };
  }

  if (
    (host === 'google.com' || host === 'maps.google.com') &&
    u.pathname.toLowerCase().startsWith('/maps')
  ) {
    const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
    return {
      iosUrl: q ? `comgooglemaps://?q=${encodeURIComponent(q)}` : `comgooglemapsurl://${u.toString()}`,
      packageName: 'com.google.android.apps.maps',
    };
  }

  return null;
};

const iosBridgeHtml = (appUrl: string, webUrl: string) => `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Abriendo…</title>
</head>
<body>
<script>
(function () {
  var app = ${JSON.stringify(appUrl)};
  var web = ${JSON.stringify(webUrl)};
  var left = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) left = true;
  });
  window.addEventListener('pagehide', function () { left = true; });
  window.location.href = app;
  setTimeout(function () {
    if (!left) window.location.replace(web);
  }, 1200);
})();
</script>
</body>
</html>`;

/** Cómo entregar el destino NFC en el teléfono. En escritorio se deja el https. */
export const presentNfcDestination = (webUrl: string, userAgent?: string): NfcPresentation => {
  const platform = phonePlatform(userAgent);
  if (platform === 'other') return { kind: 'redirect', url: webUrl };

  const target = targetFor(webUrl);
  if (!target) return { kind: 'redirect', url: webUrl };

  if (platform === 'android') {
    return { kind: 'redirect', url: androidIntent(webUrl, target.packageName) };
  }

  return { kind: 'html', html: iosBridgeHtml(target.iosUrl, webUrl) };
};
