// Signal: daily design intelligence. Static app; reads data/feed.json built by scripts/build-feed.mjs.
(() => {
  'use strict';

  const LIB = window.SIGNAL_LIBRARY;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const H = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Category hues for dots, placeholders and bars.
  const HUE = { experiential: 12, brand: 265, graphic: 330, type: 45, advertising: 200, content: 160, spatial: 30, motion: 290, digital: 220, tech: 185, culture: 95 };
  // How much each category counts toward the lead and brief. Tuned for a creative director's priorities.
  const BOOST = { experiential: 1.3, brand: 1.15, advertising: 1.12, graphic: 1.1, type: 1.05, content: 1.05 };
  const BRIEF_ORDER = ['experiential', 'brand', 'advertising', 'graphic', 'content', 'spatial', 'type', 'motion', 'tech', 'digital', 'culture'];
  const BRIEF_SIZE = 8;
  const PAGE = 36;

  // ---------- storage (per-viewer conveniences; the app works without it) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('signal.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('signal.' + k, JSON.stringify(v)); } catch {} },
  };
  let readMap = store.get('read', {});
  let saved = store.get('saved', {});
  let notes = store.get('notes', []);

  const now = Date.now();
  const dayKey = (t = now) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = dayKey();
  const dayNumber = Math.floor((new Date(today + 'T00:00:00') - new Date('2024-01-01T00:00:00')) / 864e5);

  // ---------- app state ----------
  let data = null;
  let items = [];
  let byId = new Map();
  let cats = [];
  let catLabel = {};
  const ui = { view: 'today', cat: 'all', source: 'all', sort: 'latest', q: '', shown: PAGE, lessonOffset: 0, libKind: 'all' };
  let peekList = [];
  let peekIdx = 0;

  // ---------- helpers ----------
  function ago(iso) {
    const s = Math.max(0, (now - Date.parse(iso)) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }
  const ageH = it => (now - Date.parse(it.published)) / 36e5;
  function score(it) {
    const fresh = Math.exp(-Math.max(0, ageH(it)) / 30);
    return (it.weight || 1) * fresh * (it.image ? 1 : 0.5) * (BOOST[it.category] || 1) * (it.tags.length > 2 ? 1.1 : 1);
  }
  const hue = c => HUE[c] ?? 0;
  const isRead = id => !!readMap[id];
  function markRead(id) {
    if (readMap[id]) return;
    readMap[id] = now;
    store.set('read', readMap);
    $$(`[data-id="${id}"]`).forEach(el => el.classList.add('read'));
    updateStats();
    updateBriefProgress();
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function hashNum(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

  function media(it, cls = '') {
    const label = it.source.replace(/^The /, '');
    return `<div class="media ${cls}" style="--h:${hue(it.category)}">` +
      (it.image ? `<img src="${H(it.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '') +
      `<div class="ph">${H(label)}</div></div>`;
  }
  const catTag = c => `<span class="cat" style="--h:${hue(c)}">${H(catLabel[c] || c)}</span>`;
  const metaLine = it => `<div class="meta"><span class="src">${H(it.source)}</span><span>·</span><span>${ago(it.published)}</span></div>`;
  const saveIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>';
  const saveBtn = it => `<button class="save-btn" data-save="${it.id}" aria-pressed="${!!saved[it.id]}" aria-label="Save story" title="Save">${saveIcon}</button>`;

  // Images: fade in on load; on error retry once through an image proxy, then fall back to the placeholder.
  document.addEventListener('load', e => { if (e.target.tagName === 'IMG' && e.target.closest('.media')) e.target.classList.add('loaded'); }, true);
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.closest('.media')) return;
    if (!img.dataset.retried) {
      img.dataset.retried = '1';
      img.src = `https://wsrv.nl/?url=${encodeURIComponent(img.src.replace(/^https?:\/\//, ''))}&w=1000&output=webp`;
    } else img.remove();
  }, true);

  // ---------- data ----------
  async function load() {
    renderSkeleton();
    try {
      const res = await fetch('data/feed.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (e) {
      data = null;
    }
    items = (data?.items || []).filter(it => it.title && it.url);
    byId = new Map(items.map(it => [it.id, it]));
    cats = data?.categories || [];
    catLabel = Object.fromEntries(cats.map(c => [c.id, c.label]));
    // Saved stories may have aged out of the feed; keep the snapshot.
    for (const [id, snap] of Object.entries(saved)) if (!byId.has(id) && snap?.title) byId.set(id, snap);

    const lastVisit = store.get('lastVisit', 0);
    ui.newSince = lastVisit ? items.filter(it => Date.parse(it.firstSeen || it.published) > lastVisit).length : null;
    store.set('lastVisit', now);
    trackVisit();
    updateStats();
    footer();
    route();
  }

  function trackVisit() {
    const visits = new Set(store.get('visits', []));
    visits.add(today);
    const list = [...visits].sort().slice(-400);
    store.set('visits', list);
    let streak = 0;
    for (let d = new Date(today + 'T12:00:00'); visits.has(dayKey(d)); d.setDate(d.getDate() - 1)) streak++;
    $('#streak').textContent = streak;
  }

  function updateStats() {
    $('#readcount').textContent = Object.keys(readMap).length;
    const n = Object.keys(saved).length;
    $('#savedcount').textContent = n ? n : '';
  }

  function footer() {
    const el = $('#foot-status');
    if (!data) { el.textContent = 'No feed data yet.'; return; }
    const ok = (data.sources || []).filter(s => s.ok).length;
    el.textContent = `Updated ${ago(data.generated)} · ${items.length} stories from ${ok} of ${(data.sources || []).length} sources.`;
  }

  // ---------- routing ----------
  function route() {
    const [view, arg] = (location.hash.slice(1) || 'today').split('/');
    ui.view = ['today', 'feed', 'trends', 'library', 'saved'].includes(view) ? view : 'today';
    if (ui.view === 'feed' && arg) ui.cat = decodeURIComponent(arg);
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === ui.view)));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + ui.view));
    render();
  }
  function go(view, arg) {
    const h = '#' + view + (arg ? '/' + encodeURIComponent(arg) : '');
    if (location.hash === h) route(); else location.hash = h;
    window.scrollTo({ top: Math.min(window.scrollY, $('.nav').offsetTop), behavior: 'smooth' });
  }

  function render() {
    if (!items.length && ui.view !== 'library') return renderEmpty($('#view-' + ui.view));
    ({ today: renderToday, feed: renderFeed, trends: renderTrends, library: renderLibrary, saved: renderSaved })[ui.view]();
  }

  function renderSkeleton() {
    $('#view-today').innerHTML = `<div class="hero"><div class="skeleton" style="aspect-ratio:16/10"></div><div class="skeleton" style="min-height:320px"></div></div>`;
    $('#view-today').classList.add('on');
  }

  function renderEmpty(el) {
    const local = location.protocol === 'file:';
    el.innerHTML = `<div class="empty"><h3>No stories yet</h3>
      <p>${local
        ? 'Browsers block local files from loading data. Serve the folder instead: <code>python3 -m http.server</code> and open <code>localhost:8000/signal/</code>.'
        : 'The feed hasn’t been built yet. Run the <strong>Signal feed</strong> workflow in GitHub Actions, or run <code>node signal/scripts/build-feed.mjs</code> locally.'}</p>
      <p><button class="btn ghost" data-go="library">Explore the Level up library meanwhile</button></p></div>`;
  }

  // ---------- Today ----------
  function pickLead() {
    const pool = items.filter(it => it.image && ageH(it) < 36);
    const list = (pool.length ? pool : items.filter(it => it.image)).sort((a, b) => score(b) - score(a));
    return list[0] || items[0];
  }

  function pickStack(lead) {
    const used = new Set([lead.source]);
    const out = [];
    for (const it of items.filter(i => i.image && i.id !== lead.id).sort((a, b) => score(b) - score(a))) {
      if (used.has(it.source) || it.category === lead.category && out.some(o => o.category === it.category)) continue;
      out.push(it);
      used.add(it.source);
      if (out.length === 5) break;
    }
    return out;
  }

  // One strong story per category, stable for the day.
  function pickBrief(exclude) {
    const cachedBrief = store.get('brief', null);
    if (cachedBrief?.day === today && cachedBrief.ids.every(id => byId.has(id))) return cachedBrief.ids.map(id => byId.get(id));
    const used = new Set(exclude);
    const srcCount = {};
    const out = [];
    for (const windowH of [48, 24 * 7]) {
      for (const c of BRIEF_ORDER) {
        if (out.length >= BRIEF_SIZE || out.some(o => o._slot === c)) continue;
        const best = items
          .filter(it => !used.has(it.id) && ageH(it) < windowH && (it.category === c || it.tags.includes(c)) && (srcCount[it.source] || 0) < 2)
          .sort((a, b) => score(b) - score(a))[0];
        if (best) { out.push({ ...best, _slot: c }); used.add(best.id); srcCount[best.source] = (srcCount[best.source] || 0) + 1; }
      }
    }
    const ids = out.slice(0, BRIEF_SIZE).map(o => o.id);
    store.set('brief', { day: today, ids });
    return ids.map(id => byId.get(id));
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function renderToday() {
    const lead = pickLead();
    const stack = pickStack(lead);
    const brief = pickBrief([lead.id, ...stack.map(s => s.id)]);
    ui.brief = brief;
    const n = LIB.lessons.length;
    const lesson = LIB.lessons[(((dayNumber + ui.lessonOffset) % n) + n) % n];
    const prompt = LIB.prompts[dayNumber % LIB.prompts.length];
    const todaysNote = notes.find(n => n.day === today);
    const watch = (data.trends?.watch || []).slice(0, 6);

    const newLine = ui.newSince != null
      ? `<strong>${ui.newSince}</strong> new ${ui.newSince === 1 ? 'story' : 'stories'} since your last visit`
      : `<strong>${items.filter(it => ageH(it) < 24).length}</strong> stories in the last 24 hours`;

    const rows = [
      ['experiential', 'Experiential & activations'],
      ['brand', 'Brand & identity'],
      ['advertising', 'Campaigns worth stealing from'],
      ['graphic', 'Graphic design & type', ['type']],
      ['content', 'Content & social'],
      ['spatial', 'Spaces, objects & architecture'],
      ['motion', 'Motion, 3D & film'],
    ];

    $('#view-today').innerHTML = `
      <div class="sec">
        <div class="sec-head"><span class="sec-kicker">${greeting()} · ${newLine}</span><span class="sec-kicker">Updated ${ago(data.generated)}</span></div>
        <div class="hero">
          <article class="lead" data-open="${lead.id}" data-id="${lead.id}">
            ${media(lead)}
            <div class="lead-body">
              ${catTag(lead.category)}
              <h2>${H(lead.title)}</h2>
              ${lead.summary ? `<p>${H(lead.summary.slice(0, 260))}${lead.summary.length > 260 ? '…' : ''}</p>` : ''}
              ${metaLine(lead)}
            </div>
          </article>
          <div class="stack">
            ${stack.map(it => `
              <article class="stack-item" data-open="${it.id}" data-id="${it.id}">
                <div>${catTag(it.category)}<h3>${H(it.title)}</h3>${metaLine(it)}</div>
                ${media(it)}
              </article>`).join('')}
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head">
          <h2 class="sec-title">Your <em>${brief.length}-story</em> brief</h2>
          <div class="progress"><span class="sec-kicker" id="brief-count"></span><div class="bar"><i id="brief-bar"></i></div></div>
        </div>
        <div class="brief">
          ${brief.map(it => `
            <article class="brief-item ${isRead(it.id) ? 'read' : ''}" data-open="${it.id}" data-id="${it.id}" data-list="brief">
              <div>${catTag(it.category)}<h3>${H(it.title)}</h3>${metaLine(it)}</div>
              ${media(it)}
            </article>`).join('')}
        </div>
      </div>

      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">Level <em>up</em></h2><button class="link-btn" data-go="library">Open the library</button></div>
        <div class="duo">
          <div class="lesson">
            <span class="kind">${H(kindLabel(lesson.kind))} · ${ui.lessonOffset === 0 ? 'Today’s lesson' : 'Bonus lesson'}</span>
            <h3>${H(lesson.title)}</h3>
            <div class="lmeta">${H(lesson.meta)}</div>
            <p>${H(lesson.body)}</p>
            <p class="take">${H(lesson.takeaway)}</p>
            <div class="lesson-nav">
              <button data-lesson="-1">← Previous</button>
              <button data-lesson="1">Another one →</button>
            </div>
          </div>
          <div class="prompt">
            <span class="sec-kicker">Today’s creative director prompt</span>
            <q>${H(prompt)}</q>
            <textarea id="note" placeholder="Jot your answer. It stays on this device.">${H(todaysNote?.text || '')}</textarea>
            <p class="hint">Saved as you type. Past answers live under Level up.</p>
          </div>
        </div>
      </div>

      ${watch.length ? `
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">Trend <em>radar</em></h2><button class="link-btn" data-go="trends">All trends</button></div>
        <div class="radar">${watch.map(trendCard).join('')}</div>
      </div>` : ''}

      ${rows.map(([c, title, extra]) => {
        const list = items.filter(it => it.category === c || it.tags.includes(c) || (extra || []).some(x => it.category === x))
          .filter(it => it.id !== lead.id).slice(0, 12);
        if (list.length < 3) return '';
        return `<div class="sec">
          <div class="sec-head"><h2 class="sec-title">${H(title)}</h2><button class="link-btn" data-go="feed" data-arg="${c}">See all</button></div>
          <div class="row">${list.map(it => `
            <article class="row-card ${isRead(it.id) ? 'read' : ''}" data-open="${it.id}" data-id="${it.id}" data-list="row:${c}">
              ${media(it)}<h3>${H(it.title)}</h3>${metaLine(it)}
            </article>`).join('')}</div>
        </div>`;
      }).join('')}
    `;
    updateBriefProgress();
  }

  function updateBriefProgress() {
    if (!ui.brief || !$('#brief-bar')) return;
    const n = ui.brief.filter(it => isRead(it.id)).length;
    $('#brief-count').textContent = n === ui.brief.length ? 'Brief complete ✓' : `${n} of ${ui.brief.length} read`;
    $('#brief-bar').style.width = `${(n / ui.brief.length) * 100}%`;
  }

  const kindLabel = k => ({ case: 'Case study', principle: 'Principle', icon: 'Icon', craft: 'Craft', term: 'Vocabulary' }[k] || k);

  // ---------- sparkline ----------
  function spark(series) {
    const w = 100, h = 30, max = Math.max(1, ...series), n = series.length - 1;
    const pts = series.map((v, i) => [(i / n) * w, h - 2 - (v / max) * (h - 6)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path class="a" d="${d}L${w},${h}L0,${h}Z"/><path class="l" d="${d}"/></svg>`;
  }

  function momentumLabel(t) {
    if (t.momentum >= 1.5) return `<span class="up">▲ ${t.momentum >= 5 ? '5×+' : t.momentum.toFixed(1) + '×'}</span>`;
    if (t.momentum <= 0.6) return '▼ cooling';
    return 'steady';
  }

  function trendCard(t) {
    return `<button class="trend" data-trend="${H(t.label)}">
      <div class="trend-top"><span class="trend-name">${H(t.label)}</span><span class="trend-num">${t.recent} in 3 days</span></div>
      ${spark(t.series)}
      <span class="trend-num">${momentumLabel(t)} vs. prior 11 days</span>
    </button>`;
  }

  // ---------- Feed ----------
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let list = items;
    if (ui.trend) {
      const re = TREND_RE[ui.trend];
      if (re) list = list.filter(it => re.test(`${it.title} ${it.summary.slice(0, 280)}`));
    } else if (q) {
      const terms = q.split(/\s+/);
      list = list.filter(it => {
        const hay = `${it.title} ${it.summary} ${it.source} ${it.tags.map(t => catLabel[t] || t).join(' ')}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }
    if (ui.cat !== 'all') list = list.filter(it => it.category === ui.cat || it.tags.includes(ui.cat));
    if (ui.source !== 'all') list = list.filter(it => it.source === ui.source);
    if (ui.sort === 'top') list = [...list].sort((a, b) => score(b) - score(a));
    if (ui.sort === 'unread') list = [...list].sort((a, b) => isRead(a.id) - isRead(b.id));
    return list;
  }

  // Mirrors the watchlist in build-feed.mjs so a radar card filters to the same stories.
  const TREND_RE = {
    'AI & generative': /\b(ai|a\.i\.|generative|midjourney|openai|chatgpt|sora|firefly|gen-?ai|llm)\b/i,
    'Immersive': /\b(immersive|multi-?sensory|sensory)\b/i,
    'Pop-ups & activations': /\b(pop-?ups?|activations?|stunts?)\b/i,
    'Installations': /\b(installations?|projection[- ]mapp\w*|light shows?)\b/i,
    'AR / VR / XR': /\b(ar|vr|xr|augmented reality|virtual reality|mixed reality|vision pro|smart glasses|spatial computing)\b/i,
    'Rebrands': /\b(rebrand\w*|new (?:logo|identity)|brand refresh|visual identity)\b/i,
    'Type & lettering': /\b(typefaces?|fonts?|typograph\w*|lettering|variable fonts?)\b/i,
    'Packaging': /\bpackaging\b/i,
    'Sustainability': /\b(sustainab\w*|recycl\w*|circular|climate|carbon|biodegradable|eco-?friendly)\b/i,
    'Nostalgia & retro': /\b(nostalgi\w*|retro|y2k|vintage|throwback|90s|80s|archive)\b/i,
    'Sport & fandom': /\b(olympic\w*|world cup|super bowl|nfl|nba|wnba|f1|formula 1|fans?|fandom|stadium)\b/i,
    'Music & festivals': /\b(music|festivals?|concerts?|tour|coachella|sxsw|album)\b/i,
    'Fashion & luxury': /\b(fashion|luxury|couture|runway|sneakers?|streetwear|collab\w*)\b/i,
    'Gaming': /\b(gaming|video games?|fortnite|roblox|minecraft|esports|nintendo|playstation|xbox)\b/i,
    'Creators & social': /\b(creators?|influencers?|tiktok|youtube|instagram|ugc|social media)\b/i,
    'Craft & handmade': /\b(handmade|hand-?drawn|handcrafted|craft|analog(?:ue)?|tactile|risograph)\b/i,
    '3D & CGI': /\b(3d|cgi|faux ooh|ffooh|render\w*)\b/i,
    'Accessibility & inclusion': /\b(accessib\w*|inclusive|inclusion|disabilit\w*|neurodiver\w*)\b/i,
    'Retail experience': /\b(retail|flagship|store|shop-?in-?shop|concept store)\b/i,
    'Food & drink': /\b(food|restaurant|beverage|coffee|beer|cocktail|snack|candy|fast food)\b/i,
  };

  function card(it, i) {
    const big = i % 9 === 0 && it.image;
    const r = big ? 'r-a' : ['r-b', 'r-c', 'r-c', 'r-a'][hashNum(it.id) % 4];
    return `<article class="card ${big ? 'big' : ''} ${isRead(it.id) ? 'read' : ''}" data-open="${it.id}" data-id="${it.id}" data-list="feed">
      ${media(it, r)}
      <div class="card-top">${catTag(it.category)}${saveBtn(it)}</div>
      <h3>${H(it.title)}</h3>
      ${it.summary && (big || !it.image) ? `<p>${H(it.summary)}</p>` : ''}
      ${metaLine(it)}
    </article>`;
  }

  function renderFeed() {
    const counts = {};
    for (const it of items) for (const t of new Set([it.category, ...it.tags])) counts[t] = (counts[t] || 0) + 1;
    const sources = [...new Set(items.map(it => it.source))].sort();
    const list = filtered();
    ui.feedList = list;
    const heading = ui.trend ? `Trend: ${ui.trend}` : ui.q ? `Results for “${ui.q}”` : ui.cat === 'all' ? 'Everything, newest first' : catLabel[ui.cat] || ui.cat;

    $('#view-feed').innerHTML = `
      <div class="sec-head" style="border:0;padding:0">
        <h2 class="sec-title">${H(heading)}</h2>
        <span class="sec-kicker">${list.length} ${list.length === 1 ? 'story' : 'stories'}${ui.q || ui.trend ? ` · <button class="link-btn" data-clear>clear</button>` : ''}</span>
      </div>
      <div class="toolbar">
        <div class="chips">
          <button class="chip" data-cat="all" aria-pressed="${ui.cat === 'all'}">All <small>${items.length}</small></button>
          ${cats.filter(c => counts[c.id]).map(c => `<button class="chip cat-chip" style="--h:${hue(c.id)}" data-cat="${c.id}" aria-pressed="${ui.cat === c.id}">${H(c.label)} <small>${counts[c.id]}</small></button>`).join('')}
        </div>
        <div class="chips">
          <select id="source" aria-label="Source"><option value="all">All sources</option>${sources.map(s => `<option ${s === ui.source ? 'selected' : ''}>${H(s)}</option>`).join('')}</select>
          <select id="sort" aria-label="Sort">
            <option value="latest" ${ui.sort === 'latest' ? 'selected' : ''}>Latest</option>
            <option value="top" ${ui.sort === 'top' ? 'selected' : ''}>Top picks</option>
            <option value="unread" ${ui.sort === 'unread' ? 'selected' : ''}>Unread first</option>
          </select>
        </div>
      </div>
      ${list.length ? `<div class="grid" id="grid">${list.slice(0, ui.shown).map(card).join('')}</div>
        ${list.length > ui.shown ? `<div class="more"><button class="btn ghost" id="more">Show more</button></div>` : ''}`
        : `<div class="empty"><h3>Nothing matches</h3><p>Try another word, or clear the filters.</p></div>`}
    `;
    const more = $('#more');
    if (more && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); showMore(); } }, { rootMargin: '600px' });
      io.observe(more);
    }
  }

  function showMore() {
    ui.shown += PAGE;
    const y = window.scrollY;
    renderFeed();
    window.scrollTo(0, y);
  }

  // ---------- Trends ----------
  function renderTrends() {
    const t = data.trends || { watch: [], rising: [] };
    const week = items.filter(it => ageH(it) < 24 * 7);
    const catCounts = cats.map(c => ({ ...c, n: week.filter(it => it.category === c.id || it.tags.includes(c.id)).length })).filter(c => c.n).sort((a, b) => b.n - a.n);
    const maxC = Math.max(1, ...catCounts.map(c => c.n));
    const srcCounts = Object.entries(week.reduce((m, it) => (m[it.source] = (m[it.source] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).slice(0, 10);

    $('#view-trends').innerHTML = `
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">What’s <em>rising</em></h2><span class="sec-kicker">Words showing up more in the last 3 days</span></div>
        ${t.rising.length ? `<div class="chips">${t.rising.map(r => `<button class="chip" data-search="${H(r.term)}">${H(r.term)} <small>${r.recent} stories</small></button>`).join('')}</div>`
          : `<p class="hint">Rising terms appear once a few days of history have built up.</p>`}
      </div>
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">The watchlist</h2><span class="sec-kicker">Mentions per day, last 14 days</span></div>
        <div class="trend-table">
          ${t.watch.map(w => `<div class="trend-line" data-trend="${H(w.label)}" role="button" tabindex="0">
            <span class="trend-name">${H(w.label)}</span>${spark(w.series)}
            <span class="trend-num">${w.recent} / 3d</span><span class="trend-num">${momentumLabel(w)}</span></div>`).join('')}
        </div>
      </div>
      <div class="sec duo">
        <div>
          <div class="sec-head"><h2 class="sec-title">Category pulse</h2><span class="sec-kicker">Last 7 days</span></div>
          <div class="cat-bars">${catCounts.map(c => `<div class="cat-bar" style="--h:${hue(c.id)}" data-go="feed" data-arg="${c.id}">
            <span>${H(c.label)}</span><span class="track"><i style="width:${(c.n / maxC) * 100}%"></i></span><span class="n">${c.n}</span></div>`).join('')}</div>
        </div>
        <div>
          <div class="sec-head"><h2 class="sec-title">Most active sources</h2><span class="sec-kicker">Last 7 days</span></div>
          <div class="cat-bars">${srcCounts.map(([s, n]) => `<div class="cat-bar" style="--h:0" data-source="${H(s)}">
            <span>${H(s)}</span><span class="track"><i style="width:${(n / srcCounts[0][1]) * 100}%;background:var(--ink-2)"></i></span><span class="n">${n}</span></div>`).join('')}</div>
        </div>
      </div>`;
  }

  // ---------- Library ----------
  function renderLibrary() {
    const kinds = ['all', ...new Set(LIB.lessons.map(l => l.kind))];
    const lessons = LIB.lessons.filter(l => ui.libKind === 'all' || l.kind === ui.libKind);
    $('#view-library').innerHTML = `
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">The <em>library</em></h2><span class="sec-kicker">${LIB.lessons.length} lessons · one new each day on Today</span></div>
        <div class="chips" style="margin-bottom:18px">${kinds.map(k => `<button class="chip" data-kind="${k}" aria-pressed="${ui.libKind === k}">${k === 'all' ? 'All' : H(kindLabel(k))}</button>`).join('')}</div>
        <div class="lib-grid">${lessons.map(l => `<article class="lib-card">
          <span class="kind">${H(kindLabel(l.kind))}</span><h3>${H(l.title)}</h3><span class="lmeta">${H(l.meta)}</span>
          <p>${H(l.body)}</p><p class="take">${H(l.takeaway)}</p></article>`).join('')}</div>
      </div>
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">Your notes</h2><span class="sec-kicker">Answers to daily prompts, on this device</span></div>
        ${notes.length ? `<div class="notes">${[...notes].reverse().map(n => `<div class="note"><div class="meta"><span class="src">${H(n.day)}</span><span>·</span><span>${H(n.prompt)}</span></div><p>${H(n.text)}</p></div>`).join('')}</div>`
          : `<p class="hint">Answer the prompt on the Today page and your notes will collect here.</p>`}
      </div>
      <div class="sec">
        <div class="sec-head"><h2 class="sec-title">Beyond the feed</h2><span class="sec-kicker">Bookmark these</span></div>
        <div class="dir">${LIB.directory.map(g => `<div><h3>${H(g.group)}</h3>${g.items.map(([n, u, d]) => `<a href="${H(u)}" target="_blank" rel="noopener"><strong>${H(n)} ↗</strong><span>${H(d)}</span></a>`).join('')}</div>`).join('')}</div>
      </div>`;
  }

  // ---------- Saved ----------
  function renderSaved() {
    const list = Object.keys(saved).map(id => byId.get(id)).filter(Boolean).sort((a, b) => (saved[b.id]?.savedAt || 0) - (saved[a.id]?.savedAt || 0));
    ui.savedList = list;
    $('#view-saved').innerHTML = `
      <div class="sec-head" style="border:0;padding:0"><h2 class="sec-title">Saved for <em>later</em></h2><span class="sec-kicker">${list.length} saved on this device</span></div>
      ${list.length ? `<div class="grid">${list.map((it, i) => card(it, i + 1).replace('data-list="feed"', 'data-list="saved"')).join('')}</div>`
        : `<div class="empty"><h3>Nothing saved yet</h3><p>Tap the bookmark on any story to build your swipe file.</p></div>`}`;
  }

  function toggleSave(id) {
    const it = byId.get(id);
    if (!it) return;
    if (saved[id]) { delete saved[id]; toast('Removed from saved'); }
    else {
      const { title, url, source, site, category, tags, summary, image, published } = it;
      saved[id] = { id, title, url, source, site, category, tags, summary, image, published, savedAt: Date.now() };
      toast('Saved to your swipe file');
    }
    store.set('saved', saved);
    $$(`[data-save="${id}"]`).forEach(b => b.setAttribute('aria-pressed', String(!!saved[id])));
    updateStats();
    if (ui.view === 'saved') renderSaved();
  }

  // ---------- Peek ----------
  function listFor(name) {
    if (name === 'brief') return ui.brief || [];
    if (name === 'feed') return ui.feedList || [];
    if (name === 'saved') return ui.savedList || [];
    if (name?.startsWith('row:')) { const c = name.slice(4); return items.filter(it => it.category === c || it.tags.includes(c)).slice(0, 12); }
    return [];
  }

  function openPeek(id, listName) {
    const list = listFor(listName);
    peekList = list.length ? list : [byId.get(id)];
    peekIdx = Math.max(0, peekList.findIndex(it => it.id === id));
    showPeek();
  }

  function showPeek() {
    const it = peekList[peekIdx];
    if (!it) return;
    const dlg = $('#peek');
    const canShare = !!navigator.share;
    dlg.innerHTML = `
      <button class="peek-close" data-close aria-label="Close">×</button>
      ${media(it, 'peek-media')}
      <div class="peek-body">
        ${catTag(it.category)}
        <h2>${H(it.title)}</h2>
        ${it.summary ? `<p>${H(it.summary)}</p>` : ''}
        <div class="peek-actions">
          <a class="btn" href="${H(it.url)}" target="_blank" rel="noopener">Read on ${H(it.source)} ↗</a>
          <button class="btn ghost" data-save="${it.id}" aria-pressed="${!!saved[it.id]}">${saved[it.id] ? 'Saved' : 'Save'}</button>
          <button class="btn ghost" data-copy="${H(it.url)}">${canShare ? 'Share' : 'Copy link'}</button>
          ${peekList.length > 1 ? `<div class="peek-nav">
            <button class="btn ghost" data-step="-1" aria-label="Previous story" ${peekIdx === 0 ? 'disabled' : ''}>←</button>
            <button class="btn ghost" data-step="1" aria-label="Next story" ${peekIdx === peekList.length - 1 ? 'disabled' : ''}>→</button></div>` : ''}
        </div>
        <div class="peek-tags">${it.tags.map(catTag).join('')}<span class="meta"><span class="src">${H(it.source)}</span><span>·</span><span>${new Date(it.published).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></span></div>
      </div>`;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    markRead(it.id);
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const t = e.target;
    const save = t.closest('[data-save]');
    if (save) { e.stopPropagation(); toggleSave(save.dataset.save); const dlgBtn = save.closest('dialog'); if (dlgBtn) save.textContent = saved[save.dataset.save] ? 'Saved' : 'Save'; return; }
    const copy = t.closest('[data-copy]');
    if (copy) {
      const url = copy.dataset.copy;
      if (navigator.share) { try { await navigator.share({ url, title: peekList[peekIdx]?.title }); } catch {} }
      else { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Couldn’t copy the link'); } }
      return;
    }
    if (t.closest('[data-close]')) return $('#peek').close();
    const step = t.closest('[data-step]');
    if (step) { peekIdx += +step.dataset.step; return showPeek(); }
    if (t === $('#peek')) return $('#peek').close(); // click on backdrop
    const open = t.closest('[data-open]');
    if (open && !t.closest('a')) return openPeek(open.dataset.open, open.dataset.list);
    const goEl = t.closest('[data-go]');
    if (goEl) { if (goEl.dataset.arg) { ui.cat = goEl.dataset.arg; ui.q = ''; ui.trend = null; $('#q').value = ''; ui.shown = PAGE; } return go(goEl.dataset.go, goEl.dataset.arg); }
    const tr = t.closest('[data-trend]');
    if (tr) { ui.trend = tr.dataset.trend; ui.q = ''; $('#q').value = ''; ui.cat = 'all'; ui.source = 'all'; ui.shown = PAGE; return go('feed'); }
    const srch = t.closest('[data-search]');
    if (srch) { ui.q = srch.dataset.search; ui.trend = null; $('#q').value = ui.q; ui.cat = 'all'; ui.shown = PAGE; return go('feed'); }
    const src = t.closest('[data-source]');
    if (src) { ui.source = src.dataset.source; ui.cat = 'all'; ui.q = ''; ui.trend = null; $('#q').value = ''; ui.shown = PAGE; return go('feed'); }
    const chip = t.closest('[data-cat]');
    if (chip) { ui.cat = chip.dataset.cat; ui.shown = PAGE; return go('feed', ui.cat === 'all' ? '' : ui.cat); }
    if (t.closest('[data-clear]')) { ui.q = ''; ui.trend = null; $('#q').value = ''; ui.shown = PAGE; return renderFeed(); }
    if (t.id === 'more') return showMore();
    const lesson = t.closest('[data-lesson]');
    if (lesson) { ui.lessonOffset += +lesson.dataset.lesson; return renderToday(); }
    const kind = t.closest('[data-kind]');
    if (kind) { ui.libKind = kind.dataset.kind; return renderLibrary(); }
    const tab = t.closest('.tab');
    if (tab) {
      if (tab.dataset.view === 'feed') { ui.trend = null; }
      return go(tab.dataset.view);
    }
  });

  // Mark read when someone clicks through to the original.
  document.addEventListener('click', e => {
    const a = e.target.closest('#peek a.btn');
    if (a) markRead(peekList[peekIdx]?.id);
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'source') { ui.source = e.target.value; ui.shown = PAGE; renderFeed(); }
    if (e.target.id === 'sort') { ui.sort = e.target.value; ui.shown = PAGE; renderFeed(); }
  });

  let qTimer;
  $('#q').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      ui.q = e.target.value;
      ui.trend = null;
      ui.shown = PAGE;
      if (!items.length) return;
      if (ui.view !== 'feed') { ui.cat = 'all'; go('feed'); } else renderFeed();
    }, 180);
  });

  document.addEventListener('input', e => {
    if (e.target.id !== 'note') return;
    const text = e.target.value;
    const prompt = LIB.prompts[dayNumber % LIB.prompts.length];
    notes = notes.filter(n => n.day !== today);
    if (text.trim()) notes.push({ day: today, prompt, text });
    store.set('notes', notes);
  });

  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    if ($('#peek').open && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const d = e.key === 'ArrowRight' ? 1 : -1;
      if (peekList[peekIdx + d]) { peekIdx += d; showPeek(); }
    }
    if ((e.key === 'Enter' || e.key === ' ') && !typing && document.activeElement?.matches('[data-open],[data-trend]')) {
      e.preventDefault(); document.activeElement.click();
    }
  });

  window.addEventListener('hashchange', route);

  // ---------- theme ----------
  const savedTheme = store.get('theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#theme').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  });

  $('#dateline').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Make story cards keyboard-reachable.
  new MutationObserver(() => $$('[data-open]:not([tabindex])').forEach(el => { el.tabIndex = 0; el.setAttribute('role', 'button'); }))
    .observe($('#main'), { childList: true, subtree: true });

  load();
})();
