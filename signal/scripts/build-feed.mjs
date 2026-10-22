#!/usr/bin/env node
// Collects the design/experiential/content feeds in sources.json into data/feed.json.
// Zero dependencies (Node 20+). Run from anywhere: node signal/scripts/build-feed.mjs
// Keeps a rolling history (previous feed.json is merged in) so trends can compare days.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'feed.json');

const KEEP_DAYS = 21;          // history kept in feed.json
const MAX_ITEMS = 1200;
const PER_FEED = 30;           // newest items taken from each feed per run
const OG_LOOKUPS = 120;        // max article pages fetched per run to find a missing image
const STALE_DAYS = 120;        // a feed whose newest item is older than this is treated as dead
const UA = 'Mozilla/5.0 (compatible; SignalDesignBrief/1.0; +https://github.com/)';

// ---------- small utilities ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, { timeout = 20000, maxBytes = 3_000_000, accept } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: accept || 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
        'accept-language': 'en-US,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Read at most maxBytes so a huge page can't stall the run.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= maxBytes) { ctrl.abort(); break; }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) {
      const k = i++;
      try { out[k] = await fn(list[k], k); } catch (e) { out[k] = { error: e }; }
    }
  }));
  return out;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', oacute: 'ó', iacute: 'í',
  ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', middot: '·', bull: '•', times: '×', deg: '°' };

function decode(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const unCdata = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
const clean = s => decode(stripTags(decode(unCdata(s || '')))).replace(/\s+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text of the first matching element (names may carry a namespace prefix, e.g. "media:content").
function tag(block, ...names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${esc(n)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(n)}>`, 'i'));
    if (m && m[1].trim()) return unCdata(m[1]).trim();
  }
  return '';
}

// All opening tags with the given name, as attribute maps.
function openTags(block, name) {
  const re = new RegExp(`<${esc(name)}(\\s[^>]*?)?/?>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(attrs(m[1] || ''));
  return out;
}

function attrs(s) {
  const a = {};
  s.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, k, __, d, q, u) => { a[k.toLowerCase()] = decode(d ?? q ?? u ?? ''); });
  return a;
}

function absolute(u, base) {
  if (!u) return '';
  u = u.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  try { return new URL(u, base).href; } catch { return ''; }
}

// Images are shown on an https page, so upgrade them; most CDNs serve both.
const absImg = (u, base) => absolute(u, base).replace(/^http:\/\//, 'https://');

const BAD_IMG = /(feedburner|feeds\.feedblitz|pixel|tracking|gravatar|emoji|wp-includes|\/smilies\/|doubleclick|share[-_]?button|badge|spacer|blank\.(gif|png)|1x1|stat\?)/i;

function goodImage(u) {
  return u && /^https:\/\//.test(u) && !BAD_IMG.test(u) && !/\.svg(\?|$)/i.test(u);
}

// Pick the largest candidate from a srcset string.
function fromSrcset(srcset) {
  let best = '', bestW = 0;
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    const w = parseInt(d) || 1;
    if (u && w >= bestW) { best = u; bestW = w; }
  }
  return best;
}

function firstImgInHtml(html, base) {
  if (!html) return '';
  const h = decode(unCdata(html));
  const re = /<img\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(h))) {
    const a = attrs(m[1]);
    if (a.width === '1' || a.height === '1') continue;
    const u = absImg(a['data-src'] || a['data-lazy-src'] || (a.srcset && fromSrcset(a.srcset)) || a.src, base);
    if (goodImage(u)) return u;
  }
  return '';
}

function hashId(s) { return createHash('sha1').update(s).digest('hex').slice(0, 12); }

function normUrl(u) {
  try {
    const x = new URL(u);
    [...x.searchParams.keys()].forEach(k => { if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid)/i.test(k)) x.searchParams.delete(k); });
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch { return u; }
}

// ---------- feed parsing ----------

function parseFeed(xml, feedUrl) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map(b => {
    let link = '';
    if (isAtom) {
      const links = openTags(b, 'link');
      link = (links.find(l => !l.rel || l.rel === 'alternate') || links[0] || {}).href || '';
    } else {
      link = clean(tag(b, 'link')) || (openTags(b, 'link')[0] || {}).href || clean(tag(b, 'guid'));
      const fb = clean(tag(b, 'feedburner:origLink'));
      if (fb) link = fb;
    }
    link = absolute(link, feedUrl);

    const content = tag(b, 'content:encoded', 'content');
    const desc = tag(b, 'description', 'summary', 'media:description');
    const date = clean(tag(b, 'pubDate', 'published', 'updated', 'dc:date', 'a10:updated'));

    // Image candidates, best signal first.
    let image = '';
    const media = [...openTags(b, 'media:content'), ...openTags(b, 'media:thumbnail'), ...openTags(b, 'enclosure')];
    const imgMedia = media
      .filter(a => a.url && (!a.type || /^image/.test(a.type)) && (!a.medium || a.medium === 'image') && !/\.(mp3|mp4|m4a|mov|webm)(\?|$)/i.test(a.url))
      .sort((x, y) => (parseInt(y.width) || 0) - (parseInt(x.width) || 0));
    for (const a of imgMedia) { const u = absImg(a.url, link || feedUrl); if (goodImage(u)) { image = u; break; } }
    if (!image) {
      const it = openTags(b, 'itunes:image')[0];
      if (it && goodImage(absImg(it.href, feedUrl))) image = absImg(it.href, feedUrl);
    }
    if (!image) image = firstImgInHtml(content, link || feedUrl) || firstImgInHtml(desc, link || feedUrl);

    const cats = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map(m => clean(m[1]))
      .concat(openTags(b, 'category').map(a => a.term || a.label || '').filter(Boolean));

    return {
      title: clean(tag(b, 'title')),
      url: link,
      summary: clean(desc || content).slice(0, 600),
      image,
      published: date,
      feedCategories: cats.slice(0, 8),
    };
  }).filter(i => i.title && i.url);
}

// ---------- classification & trends ----------

const TAG_RULES = {
  experiential: /\b(experiential|activations?|pop-?ups?|installations?|immersive|events?|festivals?|exhibitions?|exhibits?|pavilions?|stunts?|projection[- ]mapp|sphere|museums?|fan (?:zone|experience)s?|brand experiences?|flagships?|show ?rooms?|tours?|live experiences?|sensory)\b/i,
  brand: /\b(rebrand(?:s|ed|ing)?|brand identit(?:y|ies)|visual identit(?:y|ies)|identity|logos?|logotypes?|wordmarks?|branding|brand refresh|mascots?)\b/i,
  type: /\b(typefaces?|fonts?|typograph(?:y|ic)|type design|lettering|variable fonts?|glyphs?|type foundry|foundr(?:y|ies))\b/i,
  advertising: /\b(campaigns?|ads?|adverts?|advertising|commercials?|spots?|agenc(?:y|ies)|super bowl|ooh|billboards?|cannes lions|d&ad|one show)\b/i,
  content: /\b(tiktok|instagram|youtube|creators?|influencers?|social media|content|podcasts?|newsletters?|reels|shorts|threads|ugc|streamers?|twitch|substack)\b/i,
  motion: /\b(animation|animated|motion|3d|cgi|vfx|title sequences?|music videos?|short films?|stop[- ]motion)\b/i,
  digital: /\b(websites?|web design|ux|ui|interfaces?|apps?|interactive|webgl|css|figma|framer)\b/i,
  tech: /\b(ai|a\.i\.|generative|midjourney|openai|chatgpt|claude|gemini|sora|firefly|machine learning|ar|vr|xr|vision pro|augmented reality|virtual reality|mixed reality|robots?|robotics|wearables?|holograms?|smart glasses)\b/i,
  spatial: /\b(architecture|architects?|interiors?|furniture|product design|lighting|store design|retail design|hotels?|buildings?|homes?|chairs?|lamps?)\b/i,
  culture: /\b(artists?|art|sculptures?|paintings?|photography|photographers?|murals?|galler(?:y|ies)|biennale|street art)\b/i,
  graphic: /\b(posters?|illustrations?|illustrators?|graphic design|editorial|book design|print|zines?|packaging|album (?:art|covers?)|covers?|risograph|collage)\b/i,
};

function tagsFor(item, sourceCat) {
  const text = `${item.title} ${item.summary.slice(0, 280)} ${item.feedCategories.join(' ')}`;
  const tags = new Set([sourceCat]);
  for (const [id, re] of Object.entries(TAG_RULES)) if (re.test(text)) tags.add(id);
  return [...tags].slice(0, 4);
}

// Curated watchlist: the themes a creative director tracks. Counted per day across headlines + summaries.
const WATCH = [
  ['AI & generative', /\b(ai|a\.i\.|generative|midjourney|openai|chatgpt|sora|firefly|gen-?ai|llm)\b/i],
  ['Immersive', /\b(immersive|multi-?sensory|sensory)\b/i],
  ['Pop-ups & activations', /\b(pop-?ups?|activations?|stunts?)\b/i],
  ['Installations', /\b(installations?|projection[- ]mapp\w*|light shows?)\b/i],
  ['AR / VR / XR', /\b(ar|vr|xr|augmented reality|virtual reality|mixed reality|vision pro|smart glasses|spatial computing)\b/i],
  ['Rebrands', /\b(rebrand\w*|new (?:logo|identity)|brand refresh|visual identity)\b/i],
  ['Type & lettering', /\b(typefaces?|fonts?|typograph\w*|lettering|variable fonts?)\b/i],
  ['Packaging', /\bpackaging\b/i],
  ['Sustainability', /\b(sustainab\w*|recycl\w*|circular|climate|carbon|biodegradable|eco-?friendly)\b/i],
  ['Nostalgia & retro', /\b(nostalgi\w*|retro|y2k|vintage|throwback|90s|80s|archive)\b/i],
  ['Sport & fandom', /\b(olympic\w*|world cup|super bowl|nfl|nba|wnba|f1|formula 1|fans?|fandom|stadium)\b/i],
  ['Music & festivals', /\b(music|festivals?|concerts?|tour|coachella|sxsw|album)\b/i],
  ['Fashion & luxury', /\b(fashion|luxury|couture|runway|sneakers?|streetwear|collab\w*)\b/i],
  ['Gaming', /\b(gaming|video games?|fortnite|roblox|minecraft|esports|nintendo|playstation|xbox)\b/i],
  ['Creators & social', /\b(creators?|influencers?|tiktok|youtube|instagram|ugc|social media)\b/i],
  ['Craft & handmade', /\b(handmade|hand-?drawn|handcrafted|craft|analog(?:ue)?|tactile|risograph)\b/i],
  ['3D & CGI', /\b(3d|cgi|faux ooh|ffooh|render\w*)\b/i],
  ['Accessibility & inclusion', /\b(accessib\w*|inclusive|inclusion|disabilit\w*|neurodiver\w*)\b/i],
  ['Retail experience', /\b(retail|flagship|store|shop-?in-?shop|concept store)\b/i],
  ['Food & drink', /\b(food|restaurant|beverage|coffee|beer|cocktail|snack|candy|fast food)\b/i],
];

const STOP = new Set(`a an the and or but if of to in on at by for with from as into onto over under about after before
 is are was were be been being has have had do does did not no yes this that these those it its it's their his her our your
 you we they he she i me my them us who whom which what when where why how than then so too very just also more most
 new news design designs designed designer designers brand brands branding first year years day days week weeks
 way ways make makes made get gets got take takes look looks one two three can could will would should may might
 up out off all any some every each other another s t vs via here there now today latest best top inside behind
 using use uses used says said see seen create creates created launch launches launched unveils unveiled reveals revealed
 introduces introduced celebrate celebrates celebrating brings bring set sets world global series project projects work works
 studio studios agency agencies campaign campaigns ad ads new york london`.split(/\s+/));

function words(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/'s\b/g, '').split(/[^a-z0-9&+-]+/)
    .map(w => w.replace(/^[-+]+|[-+]+$/g, '')).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

function computeTrends(items, now) {
  const DAY = 864e5;
  const days = 14;
  const dayIdx = it => Math.floor((now - Date.parse(it.published)) / DAY);

  // Watchlist: daily counts, oldest -> newest.
  const watch = WATCH.map(([label, re]) => {
    const series = new Array(days).fill(0);
    for (const it of items) {
      const d = dayIdx(it);
      if (d >= 0 && d < days && re.test(`${it.title} ${it.summary.slice(0, 280)}`)) series[days - 1 - d]++;
    }
    const recent = series.slice(-3).reduce((a, b) => a + b, 0);
    const prior = series.slice(0, -3).reduce((a, b) => a + b, 0);
    const momentum = (recent / 3) / ((prior + 1) / (days - 3));
    return { label, series, recent, total: recent + prior, momentum: +momentum.toFixed(2) };
  }).filter(w => w.total > 0).sort((a, b) => b.recent - a.recent || b.momentum - a.momentum);

  // Rising phrases: unigrams/bigrams over-represented in the last 3 days vs the 11 before.
  const recentC = new Map(), baseC = new Map(), example = new Map();
  for (const it of items) {
    const d = dayIdx(it);
    if (d < 0 || d >= days) continue;
    const w = words(it.title);
    const grams = new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
    const m = d < 3 ? recentC : baseC;
    for (const g of grams) {
      m.set(g, (m.get(g) || 0) + 1);
      if (d < 3 && !example.has(g)) example.set(g, it.id);
    }
  }
  let rising = [...recentC].filter(([, r]) => r >= 3).map(([term, r]) => {
    const b = baseC.get(term) || 0;
    return { term, recent: r, score: +((r / 3) / ((b + 1) / (days - 3))).toFixed(2), example: example.get(term) };
  }).sort((a, b) => b.score * Math.log2(b.recent + 1) - a.score * Math.log2(a.recent + 1));
  // Drop unigrams already covered by a stronger bigram.
  const kept = [];
  for (const r of rising) {
    if (kept.some(k => k.term.includes(' ') && k.term.split(' ').includes(r.term))) continue;
    kept.push(r);
    if (kept.length >= 16) break;
  }
  return { watch, rising: kept };
}

// ---------- main ----------

async function ogImage(url) {
  const { text, finalUrl } = await fetchText(url, { timeout: 12000, maxBytes: 400_000, accept: 'text/html' });
  const head = text.slice(0, 200_000);
  for (const re of [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi,
  ]) {
    let m;
    while ((m = re.exec(head))) {
      const u = absImg(attrs(m[0]).content, finalUrl);
      if (goodImage(u)) return u;
    }
  }
  return firstImgInHtml(head.split(/<body/i)[1] || '', finalUrl);
}

async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  let prev = { items: [] };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();

  const status = [];
  const fresh = [];
  await pool(cfg.sources, 8, async src => {
    let lastErr = 'no feed responded';
    for (const feedUrl of src.feeds) {
      try {
        const { text, finalUrl } = await fetchText(feedUrl);
        if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error('not a feed');
        const parsed = parseFeed(text, finalUrl).slice(0, PER_FEED);
        if (!parsed.length) throw new Error('feed had no items');
        // An abandoned feed URL can still answer; skip it so the next candidate gets a chance.
        const newest = Math.max(...parsed.map(p => Date.parse(p.published)).filter(Number.isFinite));
        if (Number.isFinite(newest) && now - newest > STALE_DAYS * 864e5) throw new Error(`stale (newest ${new Date(newest).toISOString().slice(0, 10)})`);
        for (const p of parsed) {
          let t = Date.parse(p.published);
          if (!Number.isFinite(t) || t > now + 36e5) t = now; // missing or future-dated
          fresh.push({
            id: hashId(normUrl(p.url)),
            title: p.title,
            url: p.url,
            source: src.name,
            site: src.site,
            category: src.category,
            weight: src.weight ?? 1,
            tags: tagsFor(p, src.category),
            summary: p.summary,
            image: p.image,
            published: new Date(t).toISOString(),
            firstSeen: fetchedAt,
          });
        }
        status.push({ name: src.name, ok: true, count: parsed.length, feed: feedUrl });
        return;
      } catch (e) {
        lastErr = `${feedUrl}: ${e.name === 'AbortError' ? 'timeout' : e.message}`;
        await sleep(200);
      }
    }
    status.push({ name: src.name, ok: false, error: lastErr });
  });

  // Merge with history; fresh copies win but keep the earliest firstSeen and any image found before.
  const byId = new Map();
  for (const it of prev.items || []) byId.set(it.id, it);
  const titleSeen = new Map([...byId.values()].map(it => [it.title.toLowerCase(), it.id]));
  for (const it of fresh) {
    const old = byId.get(it.id);
    if (!old) {
      const dupe = titleSeen.get(it.title.toLowerCase());
      if (dupe && dupe !== it.id) continue; // same story syndicated under another URL
    }
    byId.set(it.id, { ...it, firstSeen: old?.firstSeen || it.firstSeen, image: it.image || old?.image || '' });
    titleSeen.set(it.title.toLowerCase(), it.id);
  }
  const cutoff = now - KEEP_DAYS * 864e5;
  let items = [...byId.values()]
    .filter(it => Date.parse(it.published) >= cutoff)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_ITEMS);

  // Fill missing thumbnails from the article's og:image, newest first.
  const missing = items.filter(it => !it.image && !it.noImage).slice(0, OG_LOOKUPS);
  await pool(missing, 6, async it => {
    try { it.image = await ogImage(it.url); } catch {}
    if (!it.image) it.noImage = true; // don't retry every run
  });

  const trends = computeTrends(items, now);
  const ok = status.filter(s => s.ok).length;

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    generated: fetchedAt,
    categories: cfg.categories,
    sources: status.sort((a, b) => a.name.localeCompare(b.name)),
    trends,
    items,
  }));
  console.log(`Sources ok: ${ok}/${status.length}. Items: ${items.length} (${fresh.length} fetched this run). With images: ${items.filter(i => i.image).length}.`);
  for (const s of status.filter(s => !s.ok)) console.log(`  ✗ ${s.name} — ${s.error}`);
  if (ok === 0 && !(prev.items || []).length) process.exitCode = 1;
}

// Exported for the fixture test.
export { parseFeed, tagsFor, computeTrends, decode };

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
