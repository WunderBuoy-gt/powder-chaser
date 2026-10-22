# Powder Chaser

A storm-chasing app for skiers and snowboarders. Static HTML/CSS/JS, no build step, no API key.

## Run it

    cd powder-chaser
    python3 -m http.server 8000     # or: npx serve .

Open http://localhost:8000. To put it online, drop the folder on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages).

## Files

- `index.html`: page shell
- `styles.css`: light and dark themes, storm pulse animation
- `resorts.js`: 134 curated resorts with coordinates and base/summit elevations
- `app.js`: data fetching, storm detection, snow estimates, best-day scoring and rendering

## Data

Forecasts come from Open-Meteo (free for non-commercial use, CC BY 4.0), requested at each resort's mid-mountain elevation.
If the API can't be reached, the app switches to clearly labelled simulated data.
Commercial use needs an Open-Meteo API plan.

## Tuning

The thresholds are at the top of `app.js`: `STORM_INCOMING_CM` (default 15 cm, about 6") and `STORM_INCOMING_HOURS` (72).

## Also in this repo: Signal

`signal/` is a separate app: a daily briefing on experiential marketing, graphic design, brand and content for creative directors. See [signal/README.md](signal/README.md).
