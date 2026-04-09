# Vercel Backend

This folder is the Vercel deployment root for the production backend.

## What it supports

- Instagram extraction and download endpoints
- Proxying Instagram media URLs
- Health checks for the mobile app
- Native YouTube extraction and download endpoints on Vercel

## YouTube on Vercel (native mode)

This implementation runs YouTube extraction/download directly in Vercel functions using JavaScript-only parsing.

Current limitation:

- MP4 direct formats are supported.
- MP3 conversion is not supported in this Vercel-native mode.

Optional for bot-check errors:

- Add Vercel environment variable `YOUTUBE_COOKIE` with your YouTube browser cookie header value.
- Redeploy after setting it.

YouTube routes:

- `/youtube/extract`
- `/youtube/download`

## Deploy on Vercel

1. Create a new Vercel project from this repository.
2. Set the root directory to `InstaSave/vercel`.
3. Deploy with the default settings.

## App configuration

Point the mobile app's backend URL to the deployed Vercel project root, for example:

- `https://your-project.vercel.app`

The app will use these routes through rewrites:

- `/health`
- `/extract`
- `/download`
- `/proxy`
- `/youtube/extract`
- `/youtube/download`

The app checks `/health` and enables/disables YouTube automatically.
