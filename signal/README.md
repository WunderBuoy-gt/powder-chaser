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

`scripts/build-feed.mjs` (Node 20+, no dependencies) reads the RSS/Atom feeds in `sources.json` (34 publications, including Event Marketer, BizBash, It's Nice That, The Dieline, Creative Boom, Muse by Clio, Campaign Brief, Adweek, Dezeen, designboom, Wallpaper*, Motionographer, Colossal, Hypebeast and Digiday).
Some favourites (Creative Review, The Drum, LBB, PSFK, Brand New, AIGA Eye on Design) either block automated readers or have no working feed; they're linked under Level up instead.
Feeds whose newest story is over 120 days old are treated as dead, so the next URL in the list is tried.
For each story it finds the best thumbnail (media tags, then images in the post, then the article's `og:image`), tags it by discipline, and computes trends.
Output goes to `data/feed.json`, which keeps 21 days of history so trends can compare.

The workflow `.github/workflows/signal-feed.yml` runs that script four times a day and commits the result.

## Where it lives

Pages is already enabled for this repo (deploying `main` from the root), and the feed refreshes on its own. To force a refresh, use **Actions → Signal feed → Run workflow**.

Open https://wunderbuoy-gt.github.io/powder-chaser/signal/. On a phone, use **Add to Home Screen**.

## Run it locally

    node signal/scripts/build-feed.mjs
    python3 -m http.server 8000      # from the repo root

Then open http://localhost:8000/signal/.

## Customise

- **Sources**: edit `sources.json`. Each source has a `category` and a `weight` (how much it counts toward top picks), plus one or more feed URLs; the first that works is used. The workflow log lists any source that failed.
- **Priorities**: `BOOST` and `BRIEF_ORDER` at the top of `app.js` set which disciplines lead the Today page.
- **Watchlist themes**: `WATCH` in `scripts/build-feed.mjs` (and the matching `TREND_RE` in `app.js`).
- **Lessons and prompts**: `library.js`.
