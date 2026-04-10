const { instagramGetUrl } = require('instagram-url-direct');
const { Readable } = require('node:stream');
const ytdl = require('@distube/ytdl-core');

const REQUEST_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
};

const YOUTUBE_REQUEST_TIMEOUT_MS = Number(process.env.YOUTUBE_REQUEST_TIMEOUT_MS || 12000);
const YOUTUBE_INNERTUBE_TIMEOUT_MS = Number(process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS || 10000);
const YOUTUBE_PIPED_TIMEOUT_MS = Number(process.env.YOUTUBE_PIPED_TIMEOUT_MS || 10000);

const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENTS = [
  { key: 'web', clientName: 'WEB', clientVersion: '2.20250305.01.00' },
  { key: 'android', clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
  { key: 'ios', clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone14,3' },
  { key: 'tv', clientName: 'TVHTML5', clientVersion: '7.20250305.01.00' },
  {
    key: 'web_embedded',
    clientName: 'WEB_EMBEDDED_PLAYER',
    clientVersion: '1.20260115.01.00',
    thirdParty: { embedUrl: 'https://www.youtube.com/' },
  },
];

const DEFAULT_PIPED_INSTANCES = [
  'https://piped.video',
  'https://piped.private.coffee',
  'https://piped.adminforge.de',
];

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
  if (lowered.includes('innertube api returned 400')) {
    return 'YouTube temporarily rejected this request. Please try another video or retry in a moment.';
  }
  if (lowered.includes('innertube unavailable')) {
    return 'YouTube temporarily blocked this request. Try another video or retry in a few minutes.';
  }
  if (lowered.includes('sign in to confirm') || lowered.includes('not a bot')) {
    return 'YouTube temporarily blocked this request. Please try again shortly.';
  }
  if (lowered.includes('piped unavailable')) {
    return 'YouTube is temporarily unavailable from all fallback providers. Please retry in a few minutes.';
  }

  return raw;
}

function extractYouTubeVideoId(videoUrl) {
  const matched = String(videoUrl || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?]+)/);
  return matched?.[1] || null;
}

function getPipedInstances() {
  const configured = String(process.env.YOUTUBE_PIPED_INSTANCES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const list = configured.length > 0 ? configured : DEFAULT_PIPED_INSTANCES;
  const seen = new Set();
  const normalized = [];

  for (const value of list) {
    const trimmed = value.replace(/\/+$/g, '');
    if (!/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeMaybeRelativeUrl(value, baseUrl) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
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

function buildInnertubeClientContext(client) {
  const context = {
    hl: 'en',
    gl: 'US',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    clientName: client.clientName,
    clientVersion: client.clientVersion,
  };

  if (client.androidSdkVersion) {
    context.androidSdkVersion = client.androidSdkVersion;
  }
  if (client.clientScreen) {
    context.clientScreen = client.clientScreen;
  }
  if (client.deviceMake) {
    context.deviceMake = client.deviceMake;
  }
  if (client.deviceModel) {
    context.deviceModel = client.deviceModel;
  }

  return context;
}

function isTemporaryYouTubeFailure(message, statusCode) {
  const lowered = String(message || '').toLowerCase();
  return (
    statusCode === 429 ||
    statusCode === 503 ||
    statusCode === 403 ||
    lowered.includes('bot-check') ||
    lowered.includes('not a bot') ||
    lowered.includes('sign in to confirm') ||
    lowered.includes('temporarily') ||
    lowered.includes('rate limit')
  );
}

function withAbortTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('YouTube request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function withPromiseTimeout(promise, timeoutMs, message = 'YouTube request timed out') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = YOUTUBE_INNERTUBE_TIMEOUT_MS) {
  const { signal, clear } = withAbortTimeout(timeoutMs);
  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clear();
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = YOUTUBE_INNERTUBE_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return { response, data };
}

async function getYouTubeInfoWithRetry(target) {
  const requestOptions = getYouTubeRequestOptions();
  const attempts = [
    { requestOptions },
    // These clients often bypass stricter WEB checks for some videos.
    { requestOptions, playerClients: ['ANDROID', 'WEB'] },
    { requestOptions, playerClients: ['IOS', 'WEB'] },
    { requestOptions, playerClients: ['TVHTML5_SIMPLY_EMBEDDED_PLAYER', 'WEB'] },
  ];

  let lastError = null;
  let innertubeError = null;
  let pipedError = null;
  for (const options of attempts) {
    try {
      return await withPromiseTimeout(ytdl.getInfo(target, options), YOUTUBE_REQUEST_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }

  // Fallback: Try YouTube's official Innertube API (no cookies needed)
  try {
    console.log('[YouTube] ytdl-core failed, trying Innertube fallback...');
    return await getYouTubeInfoViaInnertube(target);
  } catch (error) {
    innertubeError = error;
    console.log('[YouTube] Innertube fallback failed:', error.message);
  }

  // Final fallback: Try public Piped API instances.
  try {
    console.log('[YouTube] Innertube failed, trying Piped fallback...');
    return await getYouTubeInfoViaPiped(target);
  } catch (error) {
    pipedError = error;
    console.log('[YouTube] Piped fallback failed:', error.message);
  }

  if (pipedError) {
    throw pipedError;
  }
  if (innertubeError) {
    throw innertubeError;
  }
  throw lastError || new Error('No playable formats found');
}

async function getYouTubeInfoViaInnertube(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    throw new Error('Could not extract video ID');
  }

  let lastReason = 'Video not available';
  let lastHttpStatus = null;

  for (const client of INNERTUBE_CLIENTS) {
    const innertubeUrl = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`;
    const body = {
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: buildInnertubeClientContext(client),
        ...(client.thirdParty ? { thirdParty: client.thirdParty } : {}),
      },
    };

    const { response, data } = await fetchJsonWithTimeout(innertubeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-YouTube-Client-Name': client.clientName,
        'X-YouTube-Client-Version': client.clientVersion,
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
        'User-Agent': REQUEST_HEADERS['User-Agent'],
      },
      body: JSON.stringify(body),
    }, YOUTUBE_INNERTUBE_TIMEOUT_MS);

    if (!response.ok) {
      lastHttpStatus = response.status;
      continue;
    }

    if (data.playabilityStatus?.status === 'OK') {
      return convertInnertubeToyDLFormat(data, videoId);
    }

    lastReason = data.playabilityStatus?.reason || data.playabilityStatus?.status || lastReason;
  }

  if (lastHttpStatus) {
    throw new Error(`Innertube API returned ${lastHttpStatus}`);
  }
  throw new Error(`Innertube unavailable: ${lastReason}`);
}

function convertPipedToYDLFormat(pipedData, videoId, baseInstance) {
  const formats = [];
  const videoStreams = Array.isArray(pipedData?.videoStreams) ? pipedData.videoStreams : [];
  const audioStreams = Array.isArray(pipedData?.audioStreams) ? pipedData.audioStreams : [];

  for (const stream of videoStreams) {
    const streamUrl = normalizeMaybeRelativeUrl(stream?.url, baseInstance);
    if (!streamUrl) {
      continue;
    }

    const ext = String(stream?.format || 'mp4').toLowerCase();
    const qualityLabel = stream?.quality || null;
    formats.push({
      itag: Number(stream?.itag || 0) || `${ext}_${qualityLabel || 'video'}`,
      url: streamUrl,
      mimeType: `video/${ext}`,
      bitrate: Number(stream?.bitrate || 0) || null,
      width: Number(stream?.width || 0) || null,
      height: Number(stream?.height || 0) || null,
      fps: Number(stream?.fps || 0) || null,
      qualityLabel,
      container: ext,
      hasVideo: true,
      hasAudio: stream?.videoOnly === false,
      contentLength: Number(stream?.contentLength || stream?.size || 0) || 0,
    });
  }

  for (const stream of audioStreams) {
    const streamUrl = normalizeMaybeRelativeUrl(stream?.url, baseInstance);
    if (!streamUrl) {
      continue;
    }

    const ext = String(stream?.format || 'm4a').toLowerCase();
    formats.push({
      itag: Number(stream?.itag || 0) || `audio_${ext}_${stream?.bitrate || 0}`,
      url: streamUrl,
      mimeType: `audio/${ext}`,
      bitrate: Number(stream?.bitrate || 0) || null,
      width: null,
      height: null,
      fps: null,
      qualityLabel: stream?.quality || 'audio',
      container: ext,
      hasVideo: false,
      hasAudio: true,
      contentLength: Number(stream?.contentLength || stream?.size || 0) || 0,
    });
  }

  if (formats.length === 0) {
    throw new Error('Piped fallback returned no downloadable formats');
  }

  return {
    videoDetails: {
      videoId,
      title: pipedData?.title || `YouTube ${videoId}`,
      lengthSeconds: Number(pipedData?.duration || 0) || 0,
      author: pipedData?.uploader || pipedData?.uploaderName || 'Unknown',
      thumbnails: pipedData?.thumbnailUrl ? [{ url: pipedData.thumbnailUrl }] : [],
    },
    formats,
  };
}

async function getYouTubeInfoViaPiped(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    throw new Error('Could not extract video ID');
  }

  const instances = getPipedInstances();
  let lastStatus = null;
  let lastReason = 'Unknown provider error';

  for (const instance of instances) {
    const endpoint = `${instance}/api/v1/streams/${videoId}`;
    try {
      const { response, data } = await fetchJsonWithTimeout(endpoint, {
        headers: {
          Accept: 'application/json',
          'User-Agent': REQUEST_HEADERS['User-Agent'],
        },
      }, YOUTUBE_PIPED_TIMEOUT_MS);

      if (!response.ok) {
        lastStatus = response.status;
        lastReason = `status ${response.status}`;
        continue;
      }

      return convertPipedToYDLFormat(data, videoId, instance);
    } catch (error) {
      lastReason = error?.message || lastReason;
    }
  }

  if (lastStatus) {
    throw new Error(`Piped unavailable: HTTP ${lastStatus}`);
  }
  throw new Error(`Piped unavailable: ${lastReason}`);
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
        url: format.url,
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
        url: format.url,
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
    const temporary = isTemporaryYouTubeFailure(message, error?.statusCode);
    res.statusCode = temporary ? 503 : 500;
    if (temporary) {
      res.setHeader('Retry-After', '60');
    }
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

    // Check if this is an Innertube response (has direct URLs) or ytdl response
    if (chosen.url) {
      // Innertube format: stream directly from the format URL
      const formatStream = await fetchWithTimeout(chosen.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        },
      }, YOUTUBE_REQUEST_TIMEOUT_MS);

      if (!formatStream.ok) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        const details = formatStream.statusText || 'unknown error';
        res.end(JSON.stringify({ error: `Failed to fetch video stream: ${details}` }));
        return;
      }

      const stream = Readable.fromWeb(formatStream.body);
      res.statusCode = 200;
      res.setHeader('content-type', formatStream.headers.get('content-type') || 'video/mp4');
      res.setHeader('content-disposition', `attachment; filename="${title}.mp4"`);
      res.setHeader('cache-control', 'no-store');
      const upstreamContentLength = formatStream.headers.get('content-length');
      if (upstreamContentLength) {
        res.setHeader('content-length', upstreamContentLength);
      }

      stream.on('error', (error) => {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: `Stream download failed: ${error?.message || 'unknown error'}` }));
        } else {
          res.end();
        }
      });

      stream.pipe(res);
    } else {
      // ytdl-core format: use downloadFromInfo
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
    }
  } catch (error) {
    const message = getYouTubeFriendlyError(error?.message, 'YouTube download failed');
    const temporary = isTemporaryYouTubeFailure(message, error?.statusCode);
    res.statusCode = temporary ? 503 : 500;
    if (temporary) {
      res.setHeader('Retry-After', '60');
    }
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
