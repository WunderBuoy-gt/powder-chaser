(() => {
"use strict";

// ---------- Tunables ----------
const STORM_INCOMING_CM = 15;   // ~6": a storm worth chasing
const STORM_INCOMING_HOURS = 72; // flag if it starts within this window
const STORM_RADAR_CM = 10;       // smaller or further-out storms get the amber "on radar" flag
const STORM_RADAR_HOURS = 168;
const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FAVORITES = ["jackson-hole", "alta", "mammoth-mountain", "whistler-blackcomb", "chamonix", "niseko-united"];

const API = "https://api.open-meteo.com/v1/forecast";
const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const HOURLY = "temperature_2m,snowfall,rain,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,freezing_level_height,snow_depth,cloud_cover";
const CURRENT = "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m";
const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,rain_sum,wind_gusts_10m_max";

const RESORTS = window.RESORTS;
const byId = new Map(RESORTS.map(r => [r.id, r]));

// ---------- Storage (per-browser conveniences; everything works without it) ----------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};

const state = {
  view: "dash",
  units: store.get("pc-units", "imperial"),
  favorites: store.get("pc-favorites", null) || DEFAULT_FAVORITES.map(id => byId.get(id)),
  selected: null,
  watchRegion: "all",
  demo: false,
  forecasts: new Map(), // key -> processed forecast
  watch: null,
};

const keyOf = loc => loc.id || `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
const isFav = loc => state.favorites.some(f => keyOf(f) === keyOf(loc));

// ---------- Units & formatting ----------
const imperial = () => state.units === "imperial";
function fmtSnow(cm, unit = true) {
  if (cm == null || Number.isNaN(cm)) return "—";
  if (imperial()) { const v = cm / 2.54; return (v < 9.95 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)) + (unit ? '"' : ""); }
  return (cm < 9.95 ? cm.toFixed(1).replace(/\.0$/, "") : Math.round(cm)) + (unit ? " cm" : "");
}
const fmtTemp = c => c == null ? "—" : Math.round(imperial() ? c * 9 / 5 + 32 : c) + "°";
const fmtWind = k => k == null ? "—" : Math.round(imperial() ? k / 1.609 : k) + (imperial() ? " mph" : " km/h");
const fmtElev = m => m == null ? "—" : Math.round(imperial() ? m * 3.281 : m).toLocaleString() + (imperial() ? " ft" : " m");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// All times are kept as "resort-local clock, stored in UTC fields", so getUTC* reads local wall time.
const dayName = ms => DAYS[new Date(ms).getUTCDay()];
const dayLabel = ms => { const d = new Date(ms); return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const hourLabel = ms => { const h = new Date(ms).getUTCHours(); return h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Weather codes ----------
function wxInfo(code) {
  if (code == null) return ["cloud", "—"];
  if (code === 0) return ["sun", "Clear"];
  if (code === 1) return ["sun", "Mostly clear"];
  if (code === 2) return ["partly", "Partly cloudy"];
  if (code === 3) return ["cloud", "Overcast"];
  if (code === 45 || code === 48) return ["fog", "Fog"];
  if (code >= 51 && code <= 57) return ["rain", "Drizzle"];
  if (code >= 61 && code <= 67) return ["rain", code >= 65 ? "Heavy rain" : "Rain"];
  if (code === 71) return ["snow", "Light snow"];
  if (code === 73) return ["snow", "Snow"];
  if (code === 75) return ["snow", "Heavy snow"];
  if (code === 77) return ["snow", "Snow grains"];
  if (code >= 80 && code <= 82) return ["rain", "Rain showers"];
  if (code === 85 || code === 86) return ["snow", code === 86 ? "Heavy snow showers" : "Snow showers"];
  if (code >= 95) return ["storm", "Thunderstorm"];
  return ["cloud", "Cloudy"];
}
const ICONS = {
  sun: '<circle cx="16" cy="16" r="6" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 3v4M16 25v4M3 16h4M25 16h4M6.8 6.8l2.8 2.8M22.4 22.4l2.8 2.8M6.8 25.2l2.8-2.8M22.4 9.6l2.8-2.8"/></g>',
  partly: '<circle cx="12" cy="11" r="5" fill="currentColor" opacity=".55"/><path d="M10 25h14a5 5 0 0 0 0-10 7 7 0 0 0-13.4 2A4 4 0 0 0 10 25z" fill="currentColor"/>',
  cloud: '<path d="M8 24h16a6 6 0 0 0 0-12 8 8 0 0 0-15.4 2.5A5 5 0 0 0 8 24z" fill="currentColor"/>',
  fog: '<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 11h22M8 16h18M5 21h22M10 26h14"/></g>',
  rain: '<path d="M8 18h16a5.5 5.5 0 0 0 0-11 7.5 7.5 0 0 0-14.5 2.2A4.5 4.5 0 0 0 8 18z" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 22l-2 5M17 22l-2 5M23 22l-2 5"/></g>',
  snow: '<path d="M8 18h16a5.5 5.5 0 0 0 0-11 7.5 7.5 0 0 0-14.5 2.2A4.5 4.5 0 0 0 8 18z" fill="currentColor"/><g fill="currentColor"><circle cx="10" cy="23" r="1.8"/><circle cx="16" cy="26" r="1.8"/><circle cx="22" cy="23" r="1.8"/><circle cx="13" cy="29" r="1.5"/><circle cx="19" cy="29.5" r="1.5"/></g>',
  storm: '<path d="M8 17h16a5.5 5.5 0 0 0 0-11 7.5 7.5 0 0 0-14.5 2.2A4.5 4.5 0 0 0 8 17z" fill="currentColor"/><path d="M17 18l-4 7h4l-2 6 6-9h-4l2-4z" fill="currentColor"/>',
};
const wxIcon = (code, cls = "wx") => `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true">${ICONS[wxInfo(code)[0]]}</svg>`;
const PIN_ICON = on => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.1l-5.7 3.2 1.2-6.4-4.7-4.4 6.4-.8z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

// ---------- Snow science ----------
// Open-Meteo derives snowfall from precipitation at a fixed ~7:1 ratio. Cold storms produce
// much fluffier snow, so we re-estimate depth with a Kuchera-style, temperature-dependent ratio.
function snowRatio(tempC) {
  const r = tempC < -2 ? 12 + 2 * (-2 - tempC) : 12 + (-2 - tempC);
  return Math.max(6, Math.min(20, r));
}
const estSnowCm = (modelSnowCm, tempC) => modelSnowCm > 0 ? (modelSnowCm / 0.7) * snowRatio(tempC ?? -3) / 10 : 0;

function stormClass(cm) {
  if (cm >= 60) return "Epic";
  if (cm >= 30) return "Major";
  if (cm >= 15) return "Significant";
  if (cm >= 5) return "Moderate";
  return "Light";
}
function powderQuality(ratio) {
  if (ratio >= 16) return "Cold smoke, ultra-light";
  if (ratio >= 12) return "Dry, light powder";
  if (ratio >= 9) return "Average density";
  return "Dense, heavy snow";
}

// Group consecutive snowy steps into storm events. gapSteps lets a short lull stay in one storm.
function detectStorms(times, snow, { minStep, gapSteps, minTotal }) {
  const events = [];
  let cur = null, gap = 0;
  for (let i = 0; i < snow.length; i++) {
    const s = snow[i] || 0;
    if (s >= minStep) {
      if (!cur) cur = { startIdx: i, endIdx: i, total: 0, peak: 0 };
      cur.endIdx = i; cur.total += s; cur.peak = Math.max(cur.peak, s); gap = 0;
    } else if (cur) {
      cur.total += s;
      if (++gap > gapSteps) { events.push(cur); cur = null; gap = 0; }
    }
  }
  if (cur) events.push(cur);
  return events.filter(e => e.total >= minTotal).map(e => ({ ...e, start: times[e.startIdx], end: times[e.endIdx] }));
}

// ---------- Processing a forecast ----------
function process(loc, raw) {
  const off = (raw.utc_offset_seconds || 0) * 1000;
  const now = Date.now() + off;
  const H = raw.hourly;
  const t = H.time.map(s => Date.parse(s + "Z"));
  const temp = H.temperature_2m;
  const snow = H.snowfall.map((s, i) => estSnowCm(s || 0, temp[i]));
  const nowIdx = Math.max(0, t.findIndex(x => x > now) - 1);
  const sumRange = (a, b) => { let s = 0; for (let i = Math.max(0, a); i < Math.min(snow.length, b); i++) s += snow[i]; return s; };

  const storms = detectStorms(t, snow, { minStep: 0.05, gapSteps: 6, minTotal: 2 })
    .filter(e => t[e.endIdx] >= now)
    .map(e => {
      let precip = 0, rainHrs = 0, tsum = 0, n = 0, gust = 0, fl = Infinity, modelSnow = 0;
      for (let i = e.startIdx; i <= e.endIdx; i++) {
        precip += H.precipitation[i] || 0; modelSnow += H.snowfall[i] || 0;
        if ((H.rain[i] || 0) > 0.2) rainHrs++;
        tsum += temp[i]; n++; gust = Math.max(gust, H.wind_gusts_10m[i] || 0);
        if (H.freezing_level_height[i] != null) fl = Math.min(fl, H.freezing_level_height[i]);
      }
      const remaining = sumRange(Math.max(e.startIdx, nowIdx + 1), e.endIdx + 1);
      const ratio = modelSnow > 0 ? (e.total * 10) / (modelSnow / 0.7) : 10;
      return { ...e, ongoing: e.start <= now, remaining, rainHrs, avgTemp: tsum / n, gust, freezing: Number.isFinite(fl) ? fl : null, ratio, hoursAway: (e.start - now) / 3.6e6, cls: stormClass(e.total) };
    });

  const incoming = storms.find(s => (s.ongoing ? s.remaining : s.total) >= STORM_INCOMING_CM && s.hoursAway <= STORM_INCOMING_HOURS) || null;
  const radar = !incoming ? storms.find(s => s.total >= STORM_RADAR_CM && s.hoursAway <= STORM_RADAR_HOURS) || null : null;

  // Daily rollup and powder-day scoring, using lift hours (9am–4pm local).
  const days = [];
  const dayStart = ms => ms - (ms % 86400000);
  const firstDay = dayStart(now);
  for (let d = 0; d < 16; d++) {
    const d0 = firstDay + d * 86400000;
    const i0 = t.indexOf(d0);
    if (i0 < 0 || i0 + 24 > t.length) break;
    const lift = []; for (let h = 9; h <= 15; h++) lift.push(i0 + h);
    const overnight = sumRange(i0 - 9, i0 + 9);      // 3pm yesterday → 9am
    const during = sumRange(i0 + 9, i0 + 16);
    const prior48 = sumRange(i0 - 39, i0 + 9);
    const total = sumRange(i0, i0 + 24);
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const liftTemp = avg(lift.map(i => temp[i]));
    const gust = Math.max(...lift.map(i => H.wind_gusts_10m[i] || 0));
    const sunFrac = avg(lift.map(i => (H.weather_code[i] ?? 3) <= 2 ? 1 : 0));
    const rainHrs = lift.filter(i => (H.rain[i] || 0) > 0.2).length;
    const codes = []; for (let i = i0; i < i0 + 24; i++) codes.push(H.weather_code[i]);
    const dayCode = codes.includes(75) || codes.includes(86) ? 75 : codes.find(c => c >= 71 && c <= 86) ?? codes.find(c => c >= 61) ?? codes[12];
    const dow = new Date(d0).getUTCDay();
    const bluebird = overnight >= 8 && sunFrac >= 0.5;
    let score = overnight * 2.5 + during * 1.0 + Math.max(0, prior48 - overnight) * 0.6 + sunFrac * 6 + (bluebird ? 10 : 0)
      - Math.max(0, gust - 50) * 0.35 - rainHrs * 4 - Math.max(0, liftTemp - 3) * 2 - Math.max(0, -18 - liftTemp) * 0.7
      - (dow === 0 || dow === 6 ? 3 : 0);
    const tags = [];
    if (overnight >= 2) tags.push(`${fmtSnow(overnight)} overnight`);
    else if (prior48 >= 8) tags.push(`${fmtSnow(prior48)} in the last 48h`);
    if (during >= 3) tags.push(`${fmtSnow(during)} more falling`);
    if (bluebird) tags.push("bluebird after the storm");
    else if (sunFrac >= 0.7) tags.push("sunny");
    if (gust >= 70) tags.push("wind holds likely");
    else if (gust < 35) tags.push("light wind");
    if (rainHrs >= 2) tags.push("rain at mid-mountain");
    if (liftTemp > 4) tags.push("soft spring snow");
    if (liftTemp < -20) tags.push("bitter cold");
    const past = d0 + 16 * 3600000 < now; // lifts closed for today
    days.push({ d0, i0, overnight, during, prior48, total, tmax: Math.max(...codes.map((_, k) => temp[i0 + k])), tmin: Math.min(...codes.map((_, k) => temp[i0 + k])), gust, sunFrac, rainHrs, code: dayCode, score, tags, past });
  }
  for (const d of days) d.rating = d.score >= 40 ? "Epic" : d.score >= 25 ? "Great" : d.score >= 12 ? "Good" : d.score >= 4 ? "Fair" : "Poor";
  const ranked = days.filter(d => !d.past).slice(0, 14).sort((a, b) => b.score - a.score);

  const depth = H.snow_depth?.[nowIdx];
  return {
    loc, raw, now, t, temp, snow, nowIdx, storms, incoming, radar, days, best: ranked[0] || null, picks: ranked.slice(0, 3),
    current: raw.current || {},
    past24: sumRange(nowIdx - 23, nowIdx + 1),
    next72: sumRange(nowIdx + 1, nowIdx + 73),
    next7d: sumRange(nowIdx + 1, nowIdx + 169),
    depthCm: depth != null ? depth * 100 : null,
    freezing: H.freezing_level_height?.[nowIdx] ?? null,
  };
}

// ---------- Fetching (with cache and an offline sample fallback) ----------
function setBanner(msg) { const b = document.getElementById("banner"); b.hidden = !msg; b.textContent = msg || ""; }
function goDemo(reason) {
  if (state.demo) return;
  state.demo = true;
  setBanner(`${reason} Showing simulated sample forecasts so you can explore the app. Storms, totals and dates below are not real.`);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 429 ? "rate" : "http " + res.status);
  return res.json();
}

async function loadForecasts(locs) {
  const need = [];
  for (const loc of locs) {
    const k = keyOf(loc);
    if (state.forecasts.has(k)) continue;
    const cached = !state.demo && store.get("pc-fc:" + k, null);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) state.forecasts.set(k, process(loc, cached.raw));
    else need.push(loc);
  }
  if (!need.length) return;
  if (!state.demo) {
    try {
      for (let i = 0; i < need.length; i += 20) {
        const chunk = need.slice(i, i + 20);
        const url = `${API}?latitude=${chunk.map(l => l.lat).join(",")}&longitude=${chunk.map(l => l.lon).join(",")}&elevation=${chunk.map(l => l.elev ?? "nan").join(",")}` +
          `&current=${CURRENT}&hourly=${HOURLY}&past_days=2&forecast_days=16&timezone=auto`;
        let data = await fetchJSON(url);
        if (!Array.isArray(data)) data = [data];
        chunk.forEach((loc, j) => {
          store.set("pc-fc:" + keyOf(loc), { at: Date.now(), raw: data[j] });
          state.forecasts.set(keyOf(loc), process(loc, data[j]));
        });
      }
      return;
    } catch (e) {
      goDemo(e.message === "rate" ? "The forecast service is rate-limiting requests right now." : "Live forecasts couldn't be reached from here.");
    }
  }
  for (const loc of need) state.forecasts.set(keyOf(loc), process(loc, demoForecast(loc)));
}

async function loadWatch() {
  if (state.watch) return state.watch;
  let rows = [];
  const cached = !state.demo && store.get("pc-watch", null);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) rows = cached.data;
  else if (!state.demo) {
    try {
      for (let i = 0; i < RESORTS.length; i += 50) {
        const chunk = RESORTS.slice(i, i + 50);
        const url = `${API}?latitude=${chunk.map(l => l.lat).join(",")}&longitude=${chunk.map(l => l.lon).join(",")}&elevation=${chunk.map(l => l.elev).join(",")}` +
          `&daily=${DAILY}&forecast_days=10&timezone=auto`;
        let data = await fetchJSON(url);
        if (!Array.isArray(data)) data = [data];
        rows.push(...data.map(d => d.daily));
      }
      store.set("pc-watch", { at: Date.now(), data: rows });
    } catch (e) {
      goDemo(e.message === "rate" ? "The forecast service is rate-limiting requests right now." : "Live forecasts couldn't be reached from here.");
      rows = [];
    }
  }
  if (!rows.length) rows = RESORTS.map(r => demoDaily(demoForecast(r)));
  state.watch = RESORTS.map((loc, i) => {
    const D = rows[i];
    const t = D.time.map(s => Date.parse(s + "T00:00Z"));
    const snow = D.snowfall_sum.map((s, k) => estSnowCm(s || 0, ((D.temperature_2m_max[k] ?? 0) + (D.temperature_2m_min[k] ?? 0)) / 2));
    const storms = detectStorms(t, snow, { minStep: 1, gapSteps: 0, minTotal: 2 });
    const incoming = storms.find(s => s.startIdx <= 2 && s.total >= STORM_INCOMING_CM) || null;
    const radar = !incoming ? storms.find(s => s.startIdx <= 7 && s.total >= STORM_RADAR_CM) || null : null;
    return { loc, t, snow, next72: snow.slice(0, 3).reduce((a, b) => a + b, 0), next7: snow.slice(0, 7).reduce((a, b) => a + b, 0), incoming, radar };
  });
  return state.watch;
}

// ---------- Sample data (used only when Open-Meteo can't be reached) ----------
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function demoForecast(loc) {
  const seedKey = keyOf(loc);
  const r = rng(hash(seedKey));
  const off = Math.round(loc.lon / 15) * 3600;
  const nowLocal = Date.now() + off * 1000;
  const start = nowLocal - (nowLocal % 86400000) - 2 * 86400000;
  const N = 18 * 24;
  const nowH = Math.floor((nowLocal - start) / 3600000);
  const elev = loc.elev ?? 1500;
  const south = loc.lat < 0;
  const baseT = 9 - 0.0065 * elev - (Math.abs(loc.lat) - 38) * 0.3 + (south ? 5 : -3);
  const storms = [];
  const forced = ["alta", "niseko-united", "revelstoke", "chamonix", "zermatt", "palisades-tahoe"].includes(seedKey) || hash(seedKey) % 7 === 0;
  if (forced) storms.push({ c: nowH + 36 + r() * 24, w: 9 + r() * 6, p: 0.6 + r() * 0.5 });
  const n = 1 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) { const c = r() * N; if (Math.abs(c - nowH) < 30) continue; storms.push({ c, w: 5 + r() * 8, p: 0.1 + r() * 0.45 }); }
  const H = { time: [], temperature_2m: [], snowfall: [], rain: [], precipitation: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], freezing_level_height: [], snow_depth: [], cloud_cover: [] };
  let depth = baseT < -1 ? 0.2 + r() * 0.6 : 0;
  for (let i = 0; i < N; i++) {
    const ms = start + i * 3600000;
    const hod = i % 24;
    let intensity = 0;
    for (const s of storms) intensity += s.p * Math.exp(-(((i - s.c) / s.w) ** 2));
    const temp = baseT + 4 * Math.sin(((hod - 9) / 24) * 2 * Math.PI) - Math.min(4, intensity * 2.5) + (r() - 0.5);
    const precip = intensity > 0.08 ? +(intensity * (0.7 + r() * 0.6)).toFixed(2) : 0;
    const isSnow = temp < 0.8;
    const snowfall = isSnow ? +(precip * 0.7).toFixed(2) : 0;
    const rain = isSnow ? 0 : precip;
    const wind = 8 + r() * 12 + intensity * 18;
    depth = Math.max(0, depth + snowfall / 100 - (temp > 2 ? 0.004 : 0.0004));
    const cloud = Math.min(100, Math.round(intensity * 160 + r() * 30));
    const code = precip > 0 ? (isSnow ? (precip > 1.6 ? 75 : precip > 0.6 ? 73 : 71) : (precip > 1.5 ? 65 : 61)) : cloud > 80 ? 3 : cloud > 45 ? 2 : cloud > 20 ? 1 : 0;
    const iso = new Date(ms).toISOString().slice(0, 16);
    H.time.push(iso); H.temperature_2m.push(+temp.toFixed(1)); H.snowfall.push(snowfall); H.rain.push(rain); H.precipitation.push(precip);
    H.weather_code.push(code); H.wind_speed_10m.push(+wind.toFixed(1)); H.wind_gusts_10m.push(+(wind * 1.6).toFixed(1));
    H.freezing_level_height.push(Math.max(0, Math.round(elev + temp * 160))); H.snow_depth.push(+depth.toFixed(2)); H.cloud_cover.push(cloud);
  }
  const ci = Math.min(N - 1, Math.max(0, nowH));
  return {
    utc_offset_seconds: off,
    current: { temperature_2m: H.temperature_2m[ci], apparent_temperature: H.temperature_2m[ci] - H.wind_speed_10m[ci] / 6, weather_code: H.weather_code[ci], wind_speed_10m: H.wind_speed_10m[ci], wind_gusts_10m: H.wind_gusts_10m[ci] },
    hourly: H,
  };
}
function demoDaily(raw) {
  const H = raw.hourly, D = { time: [], snowfall_sum: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let i = 48; i + 24 <= H.time.length && D.time.length < 10; i += 24) {
    D.time.push(H.time[i].slice(0, 10));
    D.snowfall_sum.push(H.snowfall.slice(i, i + 24).reduce((a, b) => a + b, 0));
    const ts = H.temperature_2m.slice(i, i + 24);
    D.temperature_2m_max.push(Math.max(...ts)); D.temperature_2m_min.push(Math.min(...ts));
  }
  return D;
}

// ---------- Small charts ----------
function dailyBars(days, w = 320, h = 64) {
  if (!days.length) return "";
  const max = Math.max(5, ...days.map(d => d.total));
  const bw = w / days.length;
  const bars = days.map((d, i) => {
    const bh = d.total > 0 ? Math.max(2, (d.total / max) * (h - 18)) : 0;
    const fill = d.total >= 15 ? "var(--storm)" : "var(--snow)";
    return `<rect x="${(i * bw + 1.5).toFixed(1)}" y="${(h - 14 - bh).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${fill}"><title>${dayLabel(d.d0)}: ${fmtSnow(d.total)}</title></rect>` +
      (i % 2 === 0 ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${h - 2}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="var(--font-data)">${dayName(d.d0)[0]}</text>` : "");
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily snowfall, next ${days.length} days"><line x1="0" x2="${w}" y1="${h - 14}" y2="${h - 14}" stroke="var(--line)"/>${bars}</svg>`;
}
function miniBars(snow) {
  const w = 140, h = 28, max = Math.max(5, ...snow), bw = w / snow.length;
  return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${snow.map((s, i) => {
    const bh = s > 0 ? Math.max(1.5, (s / max) * (h - 2)) : 0;
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${s >= 10 ? "var(--storm)" : "var(--snow)"}"/>`;
  }).join("")}<line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}" stroke="var(--line)"/></svg>`;
}
function hourlyChart(f) {
  const W = 960, H = 240, L = 44, R = 44, T = 16, B = 30;
  const from = f.nowIdx, to = Math.min(f.t.length, from + 168);
  const n = to - from; if (n < 2) return "";
  const x = i => L + ((i - from) / (n - 1)) * (W - L - R);
  const snowMax = Math.max(0.5, ...f.snow.slice(from, to));
  const temps = f.temp.slice(from, to).map(c => imperial() ? c * 9 / 5 + 32 : c);
  const tMin = Math.floor(Math.min(...temps, imperial() ? 32 : 0) / 5) * 5, tMax = Math.ceil(Math.max(...temps, imperial() ? 32 : 0) / 5) * 5 || 5;
  const ty = v => T + (1 - (v - tMin) / (tMax - tMin || 1)) * (H - T - B);
  const sy = v => (v / snowMax) * (H - T - B);
  let out = "";
  // Day separators and labels
  for (let i = from; i < to; i++) {
    if (new Date(f.t[i]).getUTCHours() === 0) {
      out += `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="var(--line)"/>`;
      if (i + 12 < to) out += `<text x="${x(i + 12)}" y="${H - 10}" text-anchor="middle">${dayLabel(f.t[i])}</text>`;
    }
  }
  const bw = Math.max(1, (W - L - R) / n - 0.6);
  for (let i = from; i < to; i++) {
    const s = f.snow[i]; if (s <= 0) continue;
    out += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(H - B - sy(s)).toFixed(1)}" width="${bw.toFixed(1)}" height="${sy(s).toFixed(1)}" fill="var(--snow)" opacity="0.85"/>`;
  }
  const fz = imperial() ? 32 : 0;
  out += `<line x1="${L}" x2="${W - R}" y1="${ty(fz)}" y2="${ty(fz)}" stroke="var(--temp)" stroke-dasharray="4 4" opacity="0.6"/>`;
  out += `<polyline fill="none" stroke="var(--temp)" stroke-width="2" points="${temps.map((v, k) => `${x(from + k).toFixed(1)},${ty(v).toFixed(1)}`).join(" ")}"/>`;
  // Axes: temperature left, snow rate right
  for (let v = tMin; v <= tMax; v += (tMax - tMin) > 30 ? 10 : 5) out += `<text x="${L - 6}" y="${ty(v) + 4}" text-anchor="end">${v}°</text>`;
  const rateTop = imperial() ? snowMax / 2.54 : snowMax;
  out += `<text x="${W - R + 6}" y="${T + 8}">${rateTop.toFixed(rateTop < 1 ? 2 : 1)}${imperial() ? '"' : "cm"}/h</text>`;
  out += `<text x="${W - R + 6}" y="${H - B}">0</text>`;
  out += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="var(--line)"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly snowfall and temperature, next 7 days">${out}</svg>`;
}

// ---------- Rendering ----------
const $view = () => document.getElementById("view");
const ratingChip = d => `<span class="chip r-${d.rating.toLowerCase()}">${d.rating}</span>`;
const stormWindow = s => `${dayName(s.start)} ${hourLabel(s.start)} → ${dayName(s.end)} ${hourLabel(s.end)}`;
const pinBtn = loc => `<button class="pin" data-pin="${esc(keyOf(loc))}" aria-pressed="${isFav(loc)}" aria-label="${isFav(loc) ? "Unpin" : "Pin"} ${esc(loc.name)}" title="${isFav(loc) ? "Unpin from" : "Pin to"} My Mountains">${PIN_ICON(isFav(loc))}</button>`;
const subtitle = loc => [loc.region, loc.country].filter(Boolean).map(esc).join(", ");

function card(f) {
  const { loc, current: c } = f;
  const s = f.incoming, cls = s ? "incoming" : f.radar ? "radar" : "";
  const [, condLabel] = wxInfo(c.weather_code);
  const flag = s ? `<div class="storm-flag" role="status"><strong>${s.ongoing ? "STORM HITTING NOW" : "STORM INCOMING"}</strong><span>${fmtSnow(s.ongoing ? s.remaining : s.total)} · ${s.ongoing ? "through " + dayName(s.end) + " " + hourLabel(s.end) : stormWindow(s)}</span></div>` : "";
  const radar = f.radar ? `<div class="radar-flag">On the radar: ${fmtSnow(f.radar.total)} ${dayName(f.radar.start)}–${dayName(f.radar.end)}</div>` : "";
  return `<article class="card ${cls}">
    ${flag}${radar}
    <div class="card-body">
      <div class="card-head">
        <button class="title" data-open="${esc(keyOf(loc))}"><h3>${esc(loc.name)}</h3><small>${subtitle(loc)}${loc.elev ? " · forecast at " + fmtElev(loc.elev) : ""}</small></button>
        ${pinBtn(loc)}
      </div>
      <div class="now">
        ${wxIcon(c.weather_code)}
        <div class="temp num">${fmtTemp(c.temperature_2m)}</div>
        <div class="cond"><b>${condLabel}</b><span>Feels ${fmtTemp(c.apparent_temperature)} · wind ${fmtWind(c.wind_speed_10m)}</span></div>
      </div>
      <dl class="stats">
        <div><dt>Past 24h</dt><dd>${fmtSnow(f.past24)}</dd></div>
        <div><dt>Next 72h</dt><dd>${fmtSnow(f.next72)}</dd></div>
        <div><dt>Next 7 days</dt><dd>${fmtSnow(f.next7d)}</dd></div>
        <div><dt>Snow depth</dt><dd>${f.depthCm != null ? fmtSnow(f.depthCm) : "—"}</dd></div>
      </dl>
      <div class="bars">${dailyBars(f.days)}</div>
      ${f.best ? `<p class="best"><span class="eyebrow">Best day</span><b>${dayLabel(f.best.d0)}</b>${ratingChip(f.best)}<span class="muted">${esc(f.best.tags.slice(0, 3).join(" · ") || "quiet conditions")}</span></p>` : ""}
    </div>
  </article>`;
}

async function renderDash() {
  const favs = state.favorites;
  if (!favs.length) {
    $view().innerHTML = `<section class="empty-state panel">
      <h1>Pin your mountains</h1>
      <p class="muted">Search for a resort above and tap the star to add it here. A few places to start:</p>
      <div class="suggest">${DEFAULT_FAVORITES.map(id => `<button data-pin="${id}">${esc(byId.get(id).name)}</button>`).join("")}</div>
    </section>`;
    return;
  }
  $view().innerHTML = `<p class="loading">Loading forecasts for ${favs.length} mountains…</p>`;
  await loadForecasts(favs);
  if (state.view !== "dash") return;
  const fcs = favs.map(l => state.forecasts.get(keyOf(l))).filter(Boolean);
  const order = f => f.incoming ? 0 : f.radar ? 1 : 2;
  fcs.sort((a, b) => order(a) - order(b) || b.next7d - a.next7d);
  const incoming = fcs.filter(f => f.incoming);
  const chase = fcs.filter(f => f.best).sort((a, b) => b.best.score - a.best.score).slice(0, 4);

  $view().innerHTML = `
    <section class="summary">
      <div class="panel">
        <div class="eyebrow">Where to chase next</div>
        <ul class="chase-list">${chase.map(f => `<li>
          <span class="day">${dayName(f.best.d0)} ${new Date(f.best.d0).getUTCDate()}</span>
          <button data-open="${esc(keyOf(f.loc))}">${esc(f.loc.name)}<small>${esc(f.best.tags.slice(0, 3).join(" · ") || "quiet conditions")}</small></button>
          ${ratingChip(f.best)}</li>`).join("")}</ul>
      </div>
      <div class="panel">
        <div class="eyebrow">Storms incoming, next 72 hours</div>
        <div class="storm-count ${incoming.length ? "hot" : ""}">${incoming.length}</div>
        <p class="muted" style="margin:6px 0 0">${incoming.length
          ? incoming.map(f => `${esc(f.loc.name)}: ${fmtSnow(f.incoming.ongoing ? f.incoming.remaining : f.incoming.total)}`).join(" · ")
          : `None of your mountains has ${fmtSnow(STORM_INCOMING_CM)}+ on the way. Check Storm Watch for where it's dumping worldwide.`}</p>
      </div>
    </section>
    <section>
      <div class="section-head"><h2>My Mountains</h2><span class="muted">${favs.length} pinned · storm targets first</span></div>
      <div class="grid" style="margin-top:12px">${fcs.map(card).join("")}</div>
    </section>`;
}

const REGIONS = {
  all: () => true,
  na: l => ["USA", "Canada"].includes(l.country),
  eu: l => l.lon > -12 && l.lon < 50 && l.lat > 35,
  asia: l => l.lon >= 60 && l.lat > 0,
  south: l => l.lat < 0,
};
const REGION_LABELS = { all: "Worldwide", na: "North America", eu: "Europe", asia: "Japan & Asia", south: "Southern Hemisphere" };

async function renderWatch() {
  $view().innerHTML = `<p class="loading">Scanning ${RESORTS.length} resorts for incoming storms…</p>`;
  const rows = await loadWatch();
  if (state.view !== "watch") return;
  const list = rows.filter(r => REGIONS[state.watchRegion](r.loc)).sort((a, b) => (b.incoming ? 1 : 0) - (a.incoming ? 1 : 0) || b.next7 - a.next7);
  const nIncoming = list.filter(r => r.incoming).length;
  $view().innerHTML = `
    <section class="section-head">
      <div><div class="eyebrow">Global storm watch · next 7 days</div><h1>${nIncoming ? `${nIncoming} storm${nIncoming > 1 ? "s" : ""} incoming` : "No big storms incoming"}</h1></div>
      <div class="filters" role="group" aria-label="Region">${Object.entries(REGION_LABELS).map(([k, v]) => `<button data-region="${k}" aria-pressed="${state.watchRegion === k}">${v}</button>`).join("")}</div>
    </section>
    <section class="watch">
      <div class="watch-head"><span>#</span><span>Resort</span><span>Daily snow, 7 days</span><span>Next 72h</span><span>Next 7d</span><span></span></div>
      ${list.map((r, i) => `<div class="watch-row ${r.incoming ? "incoming" : ""}">
        <span class="rank">${i + 1}</span>
        <button class="who" data-open="${esc(keyOf(r.loc))}"><b>${esc(r.loc.name)}</b><small>${subtitle(r.loc)}</small>
          ${r.incoming ? `<div><span class="badge-storm">STORM INCOMING</span></div>` : r.radar ? `<div><span class="badge-radar">On the radar · ${dayName(r.radar.start)}</span></div>` : ""}</button>
        <span class="mini">${miniBars(r.snow.slice(0, 7))}</span>
        <span class="total t3"><b>${fmtSnow(r.next72)}</b><small>72h</small></span>
        <span class="total"><b>${fmtSnow(r.next7)}</b><small>7 days</small></span>
        ${pinBtn(r.loc)}
      </div>`).join("")}
    </section>
    <p class="note">Ranked by estimated new snow at mid-mountain. STORM INCOMING means at least ${fmtSnow(STORM_INCOMING_CM)} starting within 72 hours.</p>`;
}

async function renderDetail() {
  const loc = state.selected;
  $view().innerHTML = `<p class="loading">Loading ${esc(loc.name)}…</p>`;
  await loadForecasts([loc]);
  if (state.view !== "detail" || state.selected !== loc) return;
  const f = state.forecasts.get(keyOf(loc));
  const c = f.current, s = f.incoming;
  const [, condLabel] = wxInfo(c.weather_code);
  const stormDays = new Set(); f.storms.forEach(st => { for (let i = st.startIdx; i <= st.endIdx; i++) stormDays.add(f.t[i] - (f.t[i] % 86400000)); });
  $view().innerHTML = `
    <button class="back" data-view="${state.prevView}">← Back to ${state.prevView === "watch" ? "Storm Watch" : "My Mountains"}</button>
    <section class="detail-head">
      <div><div class="eyebrow">${subtitle(loc)}</div><h1>${esc(loc.name)}</h1>
        <div class="meta">${loc.base ? `Base ${fmtElev(loc.base)} · Summit ${fmtElev(loc.summit)} · ` : ""}Forecast at ${fmtElev(loc.elev)}</div></div>
      ${pinBtn(loc)}
    </section>
    ${s ? `<section class="storm-banner" role="status"><strong>${s.ongoing ? "STORM HITTING NOW" : "STORM INCOMING"}</strong>
      <span>${s.cls} storm · ${fmtSnow(s.total)} expected ${stormWindow(s)}${s.ongoing ? ` (${fmtSnow(s.remaining)} still to fall)` : s.hoursAway > 0 ? `, starting in ${Math.round(s.hoursAway)} hours` : ""} · ${powderQuality(s.ratio)}</span></section>` : ""}
    <section class="detail-grid">
      <div class="panel">
        <div class="eyebrow">Right now</div>
        <div class="now" style="margin-top:8px">${wxIcon(c.weather_code)}<div class="temp num">${fmtTemp(c.temperature_2m)}</div>
          <div class="cond"><b>${condLabel}</b><span>Feels ${fmtTemp(c.apparent_temperature)}</span></div></div>
        <dl class="kv">
          <div><dt>Wind / gusts</dt><dd>${fmtWind(c.wind_speed_10m)}<span class="muted" style="font-size:16px"> / ${fmtWind(c.wind_gusts_10m)}</span></dd></div>
          <div><dt>Freezing level</dt><dd>${fmtElev(f.freezing)}</dd></div>
          <div><dt>Past 24h</dt><dd>${fmtSnow(f.past24)}</dd></div>
          <div><dt>Snow depth (model)</dt><dd>${f.depthCm != null ? fmtSnow(f.depthCm) : "—"}</dd></div>
        </dl>
      </div>
      <div class="panel">
        <div class="eyebrow">Best days to go</div>
        <ul class="picks">${f.picks.map(d => `<li><span class="day">${dayLabel(d.d0)}</span><span>${ratingChip(d)} ${esc(d.tags.join(" · ") || "quiet conditions")}</span></li>`).join("") || "<li>No forecast days available.</li>"}</ul>
        <p class="note">Scored on overnight snow before the lifts open, sun after the storm, wind holds, rain and temperature. Weekends lose a little for crowds.</p>
      </div>
    </section>
    <section class="panel">
      <div class="section-head"><h2>Storm tracker</h2><span class="muted">next 16 days</span></div>
      ${f.storms.length ? `<ul class="storms">${f.storms.map(st => `<li class="${st.total >= 15 ? "major" : st.total >= 5 ? "moderate" : ""}">
        <b>${fmtSnow(st.total)}</b> ${st.cls} · ${stormWindow(st)} <span class="muted">${dayLabel(st.start)}</span><br>
        <span class="muted">${powderQuality(st.ratio)} (about ${Math.round(st.ratio)}:1) · avg ${fmtTemp(st.avgTemp)} · gusts to ${fmtWind(st.gust)}${st.freezing != null ? ` · freezing level down to ${fmtElev(st.freezing)}` : ""}${st.rainHrs ? ` · ${st.rainHrs}h of rain mixed in` : ""}</span></li>`).join("")}</ul>`
        : `<p class="muted">No storms over ${fmtSnow(2)} in the forecast. Dry spell: look for groomers and sun, or check Storm Watch.</p>`}
    </section>
    <section class="panel">
      <div class="section-head"><h2>Next 7 days, hourly</h2></div>
      <div class="chart-box">${hourlyChart(f)}</div>
      <div class="legend"><span><i style="background:var(--snow)"></i>Snowfall per hour</span><span><i style="background:var(--temp)"></i>Temperature (dashed: freezing)</span></div>
    </section>
    <section class="panel">
      <div class="section-head"><h2>16-day outlook</h2><span class="muted">outlined: best day · tinted: storm</span></div>
      <div class="days">${f.days.map(d => `<div class="daycol ${f.best && d.d0 === f.best.d0 ? "best" : ""} ${stormDays.has(d.d0) ? "stormday" : ""}">
        <span class="dname">${dayName(d.d0)} ${new Date(d.d0).getUTCDate()}</span>${wxIcon(d.code)}
        <span class="snowv">${fmtSnow(d.total)}</span><small>${fmtTemp(d.tmax)} / ${fmtTemp(d.tmin)}</small><small>gust ${fmtWind(d.gust)}</small>${d.past ? "" : ratingChip(d)}</div>`).join("")}</div>
      <p class="note">Forecasts beyond about 7 days are low confidence; treat them as a heads-up, not a plan.</p>
    </section>`;
}

function render() {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-current", b.dataset.view === state.view ? "page" : "false");
  for (const b of document.querySelectorAll(".units button")) b.setAttribute("aria-pressed", b.dataset.units === state.units);
  if (state.view === "dash") return renderDash();
  if (state.view === "watch") return renderWatch();
  return renderDetail();
}

// ---------- Search ----------
let geoTimer = null, geoSeq = 0;
function resortMatches(q) {
  const n = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return RESORTS.filter(r => `${r.name} ${r.region} ${r.country}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(n)).slice(0, 8);
}
const resultRow = loc => `<div class="result"><button class="open" data-open="${esc(keyOf(loc))}"><b>${esc(loc.name)}</b><small>${subtitle(loc)}${loc.elev != null ? " · " + fmtElev(loc.elev) : ""}</small></button>${pinBtn(loc)}</div>`;
const geoLocs = new Map();

function renderResults(q, geo) {
  const box = document.getElementById("results");
  if (!q) { box.hidden = true; return; }
  const local = resortMatches(q);
  let html = `<h4>Ski resorts</h4>` + (local.length ? local.map(resultRow).join("") : `<div class="empty">No resorts in our list match “${esc(q)}”.</div>`);
  html += `<h4>Any place worldwide</h4>`;
  if (geo === "loading") html += `<div class="empty">Searching…</div>`;
  else if (geo === "error") html += `<div class="empty">Place search is unavailable right now.</div>`;
  else if (geo && geo.length) html += geo.map(resultRow).join("");
  else if (geo) html += `<div class="empty">No places found.</div>`;
  box.innerHTML = html;
  box.hidden = false;
}

function onSearch(q) {
  q = q.trim();
  renderResults(q, q.length >= 3 ? "loading" : null);
  clearTimeout(geoTimer);
  if (q.length < 3) return;
  const seq = ++geoSeq;
  geoTimer = setTimeout(async () => {
    let geo;
    try {
      const data = await fetchJSON(`${GEO}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
      geo = (data.results || []).map(g => ({ id: null, name: g.name, region: g.admin1 || "", country: g.country || "", lat: g.latitude, lon: g.longitude, elev: g.elevation ?? null, custom: true }));
      geo.forEach(g => geoLocs.set(keyOf(g), g));
    } catch { geo = "error"; }
    if (seq === geoSeq) renderResults(document.getElementById("q").value.trim(), geo);
  }, 300);
}

// ---------- Actions ----------
function findLoc(key) {
  return byId.get(key) || geoLocs.get(key) || state.favorites.find(f => keyOf(f) === key) || null;
}
function togglePin(key) {
  const loc = findLoc(key); if (!loc) return;
  if (isFav(loc)) state.favorites = state.favorites.filter(f => keyOf(f) !== key);
  else state.favorites = [...state.favorites, loc];
  store.set("pc-favorites", state.favorites);
  for (const b of document.querySelectorAll(`[data-pin="${CSS.escape(key)}"]`)) {
    if (!b.classList.contains("pin")) continue;
    const on = isFav(loc);
    b.setAttribute("aria-pressed", on); b.innerHTML = PIN_ICON(on);
    b.setAttribute("aria-label", `${on ? "Unpin" : "Pin"} ${loc.name}`);
  }
  if (state.view === "dash") render();
}
function open(key) {
  const loc = findLoc(key); if (!loc) return;
  if (state.view !== "detail") state.prevView = state.view;
  state.selected = loc; state.view = "detail";
  document.getElementById("results").hidden = true;
  window.scrollTo(0, 0);
  render();
}

document.addEventListener("click", e => {
  const pin = e.target.closest("[data-pin]");
  if (pin) { togglePin(pin.dataset.pin); return; }
  const o = e.target.closest("[data-open]");
  if (o) { open(o.dataset.open); return; }
  const v = e.target.closest("[data-view]");
  if (v) { state.view = v.dataset.view; window.scrollTo(0, 0); render(); return; }
  const r = e.target.closest("[data-region]");
  if (r) { state.watchRegion = r.dataset.region; render(); return; }
  const u = e.target.closest("[data-units]");
  if (u) { state.units = u.dataset.units; store.set("pc-units", state.units); render(); return; }
  if (!e.target.closest(".search")) document.getElementById("results").hidden = true;
});
const q = document.getElementById("q");
q.addEventListener("input", () => onSearch(q.value));
q.addEventListener("focus", () => { if (q.value.trim()) onSearch(q.value); });
q.addEventListener("keydown", e => {
  if (e.key === "Escape") { document.getElementById("results").hidden = true; q.blur(); }
  if (e.key === "Enter") { const first = document.querySelector("#results [data-open]"); if (first) open(first.dataset.open); }
});

state.prevView = "dash";
render();
})();
