const { setCors, proxyUpstreamUrl } = require('./_shared');

module.exports = async function proxy(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const target = reqUrl.searchParams.get('url');
  const referer = reqUrl.searchParams.get('referer') || 'https://www.instagram.com/';

  if (!target) {
    res.statusCode = 400;
    res.end('Missing url query parameter');
    return;
  }

  await proxyUpstreamUrl(req, res, target, referer);
};
