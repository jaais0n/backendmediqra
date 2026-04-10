const { instagramGetUrl } = require('instagram-url-direct');
const { Readable } = require('node:stream');
const ytdl = require('@distube/ytdl-core');

const REQUEST_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
};

function normalizeCookieEnvValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return '';
  }

  // Allow users to paste full request headers and still recover Cookie value.
  const cookieLineMatch = raw.match(/(?:^|\n)\s*cookie\s*:\s*([^\n]+)/i);
  if (cookieLineMatch?.[1]) {
    return cookieLineMatch[1].trim();
  }

  return raw.replace(/^cookie\s*:\s*/i, '').trim();
}

function getYouTubeFriendlyError(message, fallback = 'YouTube request failed') {
  const raw = String(message || '').trim();
  if (!raw) {
    return fallback;
  }

  const lowered = raw.toLowerCase();
  if (lowered.includes('sign in to confirm') || lowered.includes('not a bot')) {
    return 'YouTube bot-check blocked this request. Refresh YOUTUBE_COOKIE in Vercel and redeploy.';
  }

  return raw;
}

function getYouTubeRequestOptions() {
  const headers = { ...REQUEST_HEADERS };
  headers.Referer = 'https://www.youtube.com/';
  headers.Origin = 'https://www.youtube.com';

  const cookie = normalizeCookieEnvValue(process.env.YOUTUBE_COOKIE);
  if (cookie) {
    headers.Cookie = cookie;
  }

  return { headers };
}

async function getYouTubeInfoWithRetry(target) {
  const requestOptions = getYouTubeRequestOptions();
  const attempts = [
    { requestOptions },
    // These clients often bypass stricter WEB checks for some videos.
    { requestOptions, playerClients: ['ANDROID', 'WEB'] },
    { requestOptions, playerClients: ['TVHTML5_SIMPLY_EMBEDDED_PLAYER', 'WEB'] },
  ];

  let lastError = null;
  for (const options of attempts) {
    try {
      return await ytdl.getInfo(target, options);
    } catch (error) {
      lastError = error;
    }
  }

  // Fallback: Try YouTube's official Innertube API (no cookies needed)
  try {
    console.log('[YouTube] ytdl-core failed, trying Innertube fallback...');
    return await getYouTubeInfoViaInnertube(target);
  } catch (interttubeError) {
    console.log('[YouTube] Innertube fallback failed:', interttubeError.message);
  }

  throw lastError || new Error('No playable formats found');
}

async function getYouTubeInfoViaInnertube(videoUrl) {
  const videoId = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/)?.[1];
  if (!videoId) {
    throw new Error('Could not extract video ID');
  }

  const innertube_url = 'https://www.youtube.com/youtubei/v1/player';
  const body = {
    videoId,
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '18.49.0',
      },
    },
  };

  const response = await fetch(innertube_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Innertube API returned ${response.status}`);
  }

  const data = await response.json();
  if (data.playabilityStatus?.status !== 'OK') {
    throw new Error('Video not available via Innertube');
  }

  // Convert Innertube response to ytdl-core format
  return convertInnertubeToyDLFormat(data, videoId);
}

function convertInnertubeToyDLFormat(innertube, videoId) {
  const { videoDetails, streamingData } = innertube;
  if (!videoDetails) {
    throw new Error('No video details in Innertube response');
  }

  const formats = [];
  const videoFormats = streamingData?.formats || [];
  const adaptiveFormats = streamingData?.adaptiveFormats || [];

  // Process video formats (mp4 with audio+video)
  for (const format of videoFormats) {
    if (format.url) {
      formats.push({
        itag: format.itag,
        mimeType: format.mimeType,
        bitrate: format.bitrate,
        width: format.width,
        height: format.height,
        fps: format.fps,
        qualityLabel: format.qualityLabel || `${format.height}p`,
        container: 'mp4',
        hasVideo: true,
        hasAudio: true,
        contentLength: format.contentLength || 0,
      });
    }
  }

  // Process adaptive formats (video only or audio only)
  for (const format of adaptiveFormats) {
    if (format.url) {
      const mimeType = format.mimeType || '';
      const isVideo = mimeType.includes('video/');
      const isAudio = mimeType.includes('audio/');

      formats.push({
        itag: format.itag,
        mimeType,
        bitrate: format.bitrate,
        width: format.width,
        height: format.height,
        fps: format.fps,
        qualityLabel: format.qualityLabel || (format.height ? `${format.height}p` : 'audio'),
        container: mimeType.split('/')[1]?.split(';')[0] || 'unknown',
        hasVideo: isVideo,
        hasAudio: isAudio,
        contentLength: format.contentLength || 0,
      });
    }
  }

  if (formats.length === 0) {
    throw new Error('No downloadable formats found');
  }

  return {
    videoDetails: {
      videoId,
      title: videoDetails.title,
      lengthSeconds: videoDetails.lengthSeconds,
      author: videoDetails.author,
      thumbnails: videoDetails.thumbnail?.thumbnails || [],
    },
    formats,
  };
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
    const info = await getYouTubeInfoWithRetry(target);
    const payload = buildYouTubeOptions(info);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  } catch (error) {
    const message = getYouTubeFriendlyError(error?.message, 'YouTube extract failed');
    res.statusCode = /bot-check blocked/i.test(message) ? 503 : 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: message }));
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
    const info = await getYouTubeInfoWithRetry(target);
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

    // Check if this is an Innertube response (has direct URLs) or ytdl response
    if (chosen.url) {
      // Innertube format: stream directly from the format URL
      const formatStream = await fetch(chosen.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        },
      });

      if (!formatStream.ok) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: `Failed to fetch video stream: ${formatStream.statusText}` }));
        return;
      }

      formatStream.body.on('error', (error) => {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: `Stream download failed: ${error?.message || 'unknown error'}` }));
        }
      });

      formatStream.body.pipe(res);
    } else {
      // ytdl-core format: use downloadFromInfo
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
    }
  } catch (error) {
    const message = getYouTubeFriendlyError(error?.message, 'YouTube download failed');
    res.statusCode = /bot-check blocked/i.test(message) ? 503 : 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: message }));
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
