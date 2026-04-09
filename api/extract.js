const { setCors, handleInstagramExtract } = require('./_shared');

module.exports = async function extract(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  await handleInstagramExtract(req, res, reqUrl);
};
