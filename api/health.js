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
    instagram: true,
    youtube: true,
    youtubeMode: 'native-limited',
    youtubeMp3Conversion: false,
  }));
};
