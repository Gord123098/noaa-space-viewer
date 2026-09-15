# NOAA GOES & Space Weather Viewer

A browser-based dashboard for current NOAA satellite imagery and space-weather observations.

## Features

- GOES East and West Earth imagery with regional and full-disk views
- Lightning mapper layers
- Solar imagery and coronagraph observations
- Aurora forecasts
- X-ray, proton, solar-wind, and planetary Kp telemetry
- Animated playback and GIF downloads

All observations are loaded directly from public NOAA services. This project is not affiliated with or endorsed by NOAA.

## Local development

Requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

## Build

```sh
pnpm build
```

The production site is written to `dist-pages/`.

## Deployment

Pushes to `main` automatically deploy to GitHub Pages through `.github/workflows/pages.yml`.
