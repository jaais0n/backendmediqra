const { setCors } = require('./_shared');

module.exports = async function health(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    provider: 'vercel',
    build: '2026-04-10-youtube-hardening-2',
    instagram: true,
    youtube: true,
    youtubeMode: 'native-limited+piped-fallback',
    youtubeMp3Conversion: false,
    youtubeCookieConfigured: Boolean(String(process.env.YOUTUBE_COOKIE || '').trim()),
  }));
};
