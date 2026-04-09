const { handleYouTubeExtract, setCors } = require('../_shared');

module.exports = async function youtubeExtract(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  await handleYouTubeExtract(res, reqUrl);
};
