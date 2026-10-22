# Signal

A daily briefing on experiential marketing, graphic design, brand and content, built for a creative director's morning scroll.
Static HTML/CSS/JS with no build step and no API keys.

## What's in it

- **Today**: the lead story, five runners-up from other sources, an 8-story brief (one per discipline, with a progress bar), a daily lesson, a creative director prompt with a notes field, the trend radar, and swipeable rows for each discipline.
- **Feed**: every story as an image-led masonry grid. Filter by discipline or source; sort by latest, top picks or unread.
- **Trends**: rising words from the last 3 days, a 14-day watchlist of themes (immersive, AI, rebrands, retro, fandom and more) with sparklines, plus category and source activity.
- **Level up**: 40+ case studies, principles, icons, craft techniques and vocabulary, your saved prompt answers, and a directory of award shows and archives.
- **Saved**: your swipe file.

Reading progress, saved stories, notes, streak and theme are stored in your browser only.

## How the data works

`scripts/build-feed.mjs` (Node 20+, no dependencies) reads the RSS/Atom feeds in `sources.json` (about 45 publications, including Event Marketer, BizBash, PSFK, Brand New, It's Nice That, AIGA Eye on Design, Creative Review, Muse by Clio, Ads of the World, Dezeen, designboom, Motionographer, Colossal and Digiday).
For each story it finds the best thumbnail (media tags, then images in the post, then the article's `og:image`), tags it by discipline, and computes trends.
Output goes to `data/feed.json`, which keeps 21 days of history so trends can compare.

The workflow `.github/workflows/signal-feed.yml` runs that script four times a day and commits the result.

## Put it online (GitHub Pages)

1. Merge this into `main`.
2. Repo **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
3. **Actions → Signal feed → Run workflow** to build the first feed.
4. Open `https://<your-username>.github.io/powder-chaser/signal/`. On a phone, use **Add to Home Screen**.

## Run it locally

    node signal/scripts/build-feed.mjs
    python3 -m http.server 8000      # from the repo root

Then open http://localhost:8000/signal/.

## Customise

- **Sources**: edit `sources.json`. Each source has a `category` and a `weight` (how much it counts toward top picks), plus one or more feed URLs; the first that works is used. The workflow log lists any source that failed.
- **Priorities**: `BOOST` and `BRIEF_ORDER` at the top of `app.js` set which disciplines lead the Today page.
- **Watchlist themes**: `WATCH` in `scripts/build-feed.mjs` (and the matching `TREND_RE` in `app.js`).
- **Lessons and prompts**: `library.js`.
