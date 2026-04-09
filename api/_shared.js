const { instagramGetUrl } = require('instagram-url-direct');
const { Readable } = require('node:stream');
const ytdl = require('@distube/ytdl-core');

const REQUEST_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
};

function getYouTubeRequestOptions() {
  const headers = { ...REQUEST_HEADERS };
  const cookie = String(process.env.YOUTUBE_COOKIE || '').trim();
  if (cookie) {
    headers.Cookie = cookie;
  }

  return { headers };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function isAllowedHost(hostname) {
  if (!hostname) {
    return false;
  }

  const host = hostname.toLowerCase();
  return host.endsWith('instagram.com') || host.endsWith('fbcdn.net') || host.endsWith('cdninstagram.com');
}

function sanitizeFileName(value, fallback = 'youtube') {
  const cleaned = String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.slice(0, 120);
}

function extractResolutionHeight(resolutionLabel) {
  const match = String(resolutionLabel || '').match(/(\d{3,4})p/i);
  if (!match) {
    return 0;
  }
  return Number(match[1]) || 0;
}

function buildYouTubeOptions(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const mp4Options = formats
    .filter((format) => {
      const container = String(format?.container || '').toLowerCase();
      return container === 'mp4' && format?.hasVideo && format?.hasAudio;
    })
    .map((format) => ({
      formatId: String(format?.itag || ''),
      ext: 'mp4',
      resolution: format?.qualityLabel || (format?.height ? `${format.height}p` : null),
      fps: Number(format?.fps || 0) || null,
      hasAudio: true,
      hasVideo: true,
      filesize: Number(format?.contentLength || 0) || null,
      url: null,
    }))
    .filter((item) => item.formatId)
    .sort((a, b) => {
      const fpsA = Number(a.fps || 0);
      const fpsB = Number(b.fps || 0);
      if (fpsB !== fpsA) {
        return fpsB - fpsA;
      }

      const heightA = extractResolutionHeight(a.resolution);
      const heightB = extractResolutionHeight(b.resolution);
      if (heightB !== heightA) {
        return heightB - heightA;
      }

      return Number(b.filesize || 0) - Number(a.filesize || 0);
    })
    .slice(0, 20);

  return {
    title: info?.videoDetails?.title || null,
    duration: Number(info?.videoDetails?.lengthSeconds || 0) || null,
    thumbnailUrl: Array.isArray(info?.videoDetails?.thumbnails)
      ? (info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || null)
      : null,
    mp4Options,
    mp3Options: [],
    notes: 'Vercel native mode supports MP4 direct formats. MP3 conversion is not available without ffmpeg.',
  };
}

async function proxyUpstreamUrl(req, res, target, referer = 'https://www.instagram.com/') {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.statusCode = 400;
    res.end('Invalid target URL');
    return;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.statusCode = 400;
    res.end('Unsupported protocol');
    return;
  }

  if (!isAllowedHost(parsed.hostname)) {
    res.statusCode = 403;
    res.end('Host not allowed');
    return;
  }

  try {
    const upstreamHeaders = {
      ...REQUEST_HEADERS,
      Origin: 'https://www.instagram.com',
      Referer: referer,
    };

    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    let upstream = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: upstreamHeaders,
    });

    if (upstream.status === 403) {
      const retryHeaders = {
        ...REQUEST_HEADERS,
        Referer: referer,
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      };

      if (req.headers.range) {
        retryHeaders.Range = req.headers.range;
      }

      upstream = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: retryHeaders,
      });
    }

    res.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');
    const contentDisposition = upstream.headers.get('content-disposition');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const cacheControl = upstream.headers.get('cache-control');

    if (contentType) res.setHeader('content-type', contentType);
    if (contentLength) res.setHeader('content-length', contentLength);
    if (contentDisposition) res.setHeader('content-disposition', contentDisposition);
    if (acceptRanges) res.setHeader('accept-ranges', acceptRanges);
    if (cacheControl) res.setHeader('cache-control', cacheControl);

    if (!upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.statusCode = 500;
    res.end(`Proxy error: ${error?.message || 'unknown error'}`);
  }
}

async function handleInstagramExtract(req, res, reqUrl) {
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing url query parameter' }));
    return;
  }

  try {
    const data = await instagramGetUrl(target);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Extraction failed' }));
  }
}

async function handleInstagramDownload(req, res, reqUrl) {
  const postUrl = reqUrl.searchParams.get('postUrl');
  const indexParam = reqUrl.searchParams.get('index');
  const index = Number.isFinite(Number(indexParam)) ? Number(indexParam) : 0;

  if (!postUrl) {
    res.statusCode = 400;
    res.end('Missing postUrl query parameter');
    return;
  }

  try {
    const extracted = await instagramGetUrl(postUrl);
    const mediaList = Array.isArray(extracted?.media_details) ? extracted.media_details : [];
    const orderedItems = mediaList.filter((item) => typeof item?.url === 'string');
    const fallbackUrls = Array.isArray(extracted?.url_list) ? extracted.url_list.filter((u) => typeof u === 'string') : [];

    const selectedItem = orderedItems[index] || orderedItems[0];
    const selectedUrl = selectedItem?.url || fallbackUrls[index] || fallbackUrls[0];

    if (!selectedUrl) {
      res.statusCode = 404;
      res.end('No downloadable media URL found for this post');
      return;
    }

    await proxyUpstreamUrl(req, res, selectedUrl, postUrl);
  } catch (error) {
    res.statusCode = 500;
    res.end(`Download error: ${error?.message || 'unknown error'}`);
  }
}

async function handleYouTubeExtract(res, reqUrl) {
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing url query parameter' }));
    return;
  }

  if (!ytdl.validateURL(target)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid YouTube URL' }));
    return;
  }

  try {
    const info = await ytdl.getInfo(target, { requestOptions: getYouTubeRequestOptions() });
    const payload = buildYouTubeOptions(info);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'YouTube extract failed' }));
  }
}

async function handleYouTubeDownload(req, res, reqUrl) {
  const target = reqUrl.searchParams.get('url');
  const format = String(reqUrl.searchParams.get('format') || 'mp4').toLowerCase();
  const formatId = String(reqUrl.searchParams.get('formatId') || '').trim();

  if (!target) {
    res.statusCode = 400;
    res.end('Missing url query parameter');
    return;
  }

  if (!ytdl.validateURL(target)) {
    res.statusCode = 400;
    res.end('Invalid YouTube URL');
    return;
  }

  if (format !== 'mp4') {
    res.statusCode = 501;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Vercel native mode currently supports MP4 only.' }));
    return;
  }

  try {
    const info = await ytdl.getInfo(target, { requestOptions: getYouTubeRequestOptions() });
    const candidates = info.formats.filter((item) => {
      const container = String(item?.container || '').toLowerCase();
      return container === 'mp4' && item?.hasVideo && item?.hasAudio;
    });

    if (candidates.length === 0) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'No MP4 progressive format available for this video.' }));
      return;
    }

    let chosen = null;
    if (formatId) {
      chosen = candidates.find((item) => String(item?.itag || '') === formatId) || null;
    }

    if (!chosen) {
      chosen = candidates.sort((a, b) => Number(b?.height || 0) - Number(a?.height || 0))[0];
    }

    const title = sanitizeFileName(info?.videoDetails?.title, 'youtube_video');
    res.statusCode = 200;
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('content-disposition', `attachment; filename="${title}.mp4"`);
    res.setHeader('cache-control', 'no-store');

    const stream = ytdl.downloadFromInfo(info, {
      quality: String(chosen.itag),
      requestOptions: getYouTubeRequestOptions(),
    });

    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: `YouTube stream failed: ${error?.message || 'unknown error'}` }));
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'YouTube download failed' }));
  }
}

module.exports = {
  setCors,
  handleInstagramExtract,
  handleInstagramDownload,
  proxyUpstreamUrl,
  handleYouTubeExtract,
  handleYouTubeDownload,
};
