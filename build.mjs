// Builds a static Stremio/Nuvio catalog addon into ./dist
// TMDB discover -> anime series per streaming service, MDBList -> IMDb ids + ratings.
// No dependencies. Node 20+.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));

// Tolerate a key pasted with quotes, a "Bearer " prefix or stray whitespace.
const clean = (v) => {
  let k = (v || '').trim();
  for (let i = 0; i < 4; i++) {
    const before = k;
    k = k
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    if (k === before) break;
  }
  return k;
};
const TMDB_KEY = clean(process.env.TMDB_API_KEY);
const MDB_KEY = clean(process.env.MDBLIST_API_KEY);
const mask = (k) => `${k.length} chars, "${k.slice(0, 4)}…${k.slice(-2)}"`;
const REGION = 'US'; // US only: Hulu has no data elsewhere and anime rights differ by country
const OUT = path.resolve(process.env.OUT_DIR || 'dist');
const PAGE = 100; // items per catalog page
const STATE_FILE = path.resolve(process.env.STATE_FILE || 'data/state.json');
const TODAY = new Date().toISOString().slice(0, 10);

// Permanent membership: { lists: { catalogId: { tmdbId: dateFirstSeen } } }. Entries are only ever added.
let state = { lists: {} };
try {
  state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  state.lists ||= {};
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`Refusing to build: ${STATE_FILE} is unreadable (${e.message})`);
  console.log('No state file yet: starting fresh');
}

if (!TMDB_KEY) throw new Error('TMDB_API_KEY is not set');
if (!MDB_KEY) console.warn('MDBLIST_API_KEY is not set: building without MDBList ratings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init = {}, tries = 4) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1000 * i);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || i >= tries) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      const err = new Error(`HTTP ${res.status} ${new URL(res.url || url).pathname} ${body}`);
      err.status = res.status;
      throw err;
    }
    await sleep((Number(res.headers.get('retry-after')) || 2 * i) * 1000);
  }
}

// ---------- TMDB ----------

// TMDB takes either the short v3 key (api_key query param) or the long v4
// "API Read Access Token" (bearer header). Which one this is gets settled by
// trying both against /configuration, not by guessing from its shape.
let tmdbAuth = null;

function tmdbCall(pathname, params, mode) {
  const u = new URL(`https://api.themoviedb.org/3${pathname}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  if (mode === 'query') u.searchParams.set('api_key', TMDB_KEY);
  const init = mode === 'bearer' ? { headers: { Authorization: `Bearer ${TMDB_KEY}` } } : {};
  return getJson(u, init);
}

function tmdb(pathname, params = {}) {
  return tmdbCall(pathname, params, tmdbAuth);
}

async function resolveTmdbAuth() {
  const order = TMDB_KEY.startsWith('eyJ') ? ['bearer', 'query'] : ['query', 'bearer'];
  const failures = [];
  for (const mode of order) {
    try {
      await tmdbCall('/configuration', {}, mode);
      tmdbAuth = mode;
      console.log(`TMDB key accepted as ${mode === 'bearer' ? 'a v4 read access token' : 'a v3 API key'}`);
      return;
    } catch (e) {
      failures.push(`as ${mode} -> ${e.message}`);
    }
  }
  throw new Error(
    `TMDB rejected this key both ways (${mask(TMDB_KEY)}).\n  ${failures.join('\n  ')}\n` +
      '  Check the TMDB_API_KEY secret: it should be either the 32-character v3 "API Key" ' +
      'or the long "API Read Access Token", pasted on its own with no quotes or "Bearer " prefix.',
  );
}

async function discover(extra) {
  const out = [];
  for (let page = 1; page <= cfg.maxPagesPerQuery; page++) {
    const r = await tmdb('/discover/tv', {
      language: cfg.language,
      include_adult: 'false',
      sort_by: 'popularity.desc',
      'vote_count.gte': cfg.minVotes,
      ...cfg.animeFilter,
      ...extra,
      page,
    });
    out.push(...(r.results || []));
    if (page >= (r.total_pages || 1)) break;
  }
  return out;
}

const originalsOf = (svc) => discover({ with_networks: svc.networks.join('|') });
const streamingOf = (svc) =>
  discover({
    with_watch_providers: svc.providers.join('|'),
    watch_region: REGION,
    with_watch_monetization_types: 'flatrate',
  });

// ---------- MDBList ----------

async function mdbBatch(ids) {
  const url = `https://api.mdblist.com/tmdb/show?apikey=${encodeURIComponent(MDB_KEY)}`;
  const r = await getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (Array.isArray(r)) return r;
  return r.results || r.items || r.data || [];
}

async function mdbEnrich(allIds) {
  const map = new Map();
  if (!MDB_KEY) return map;
  const queue = [];
  for (let i = 0; i < allIds.length; i += cfg.mdblistBatchSize) queue.push(allIds.slice(i, i + cfg.mdblistBatchSize));
  let calls = 0;
  while (queue.length) {
    const ids = queue.shift();
    try {
      calls++;
      for (const it of await mdbBatch(ids)) {
        const tmdbId = it?.ids?.tmdb ?? it?.tmdbid ?? it?.tmdb_id;
        if (tmdbId != null) map.set(Number(tmdbId), it);
      }
    } catch (e) {
      // Batch too large for this account tier -> split and retry. Anything else: skip, TMDB fills in.
      if ([400, 413, 422].includes(e.status) && ids.length > 1) {
        const mid = Math.ceil(ids.length / 2);
        queue.unshift(ids.slice(0, mid), ids.slice(mid));
      } else {
        console.warn(`MDBList batch of ${ids.length} failed: ${e.message}`);
        if (e.status === 401 || e.status === 403 || e.status === 429) break; // bad key / out of quota
      }
    }
    await sleep(250);
  }
  console.log(`MDBList: ${map.size}/${allIds.length} shows matched in ${calls} calls`);
  return map;
}

function mdbRatings(it) {
  const out = {};
  for (const r of it?.ratings || []) {
    if (r?.source && r.value != null && r.value !== 0) out[String(r.source).toLowerCase()] = r.value;
  }
  return out;
}

// ---------- build ----------

await resolveTmdbAuth();

// TMDB's TV genre vocabulary, used for meta.genres. Refreshed live when reachable.
const genreNames = new Map([
  [10759, 'Action & Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'],
  [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [10762, 'Kids'],
  [9648, 'Mystery'], [10763, 'News'], [10764, 'Reality'], [10765, 'Sci-Fi & Fantasy'],
  [10766, 'Soap'], [10767, 'Talk'], [10768, 'War & Politics'], [37, 'Western'],
]);
try {
  for (const g of (await tmdb('/genre/tv/list', { language: cfg.language })).genres || []) genreNames.set(g.id, g.name);
} catch (e) {
  console.warn(`Genre list unavailable, using built-in names: ${e.message}`);
}

// 1. Collect shows per service
const shows = new Map(); // tmdb id -> show
const lists = {}; // catalog id -> [tmdb ids]
const liveStreaming = new Map(); // provider-backed, current US streaming availability only

function remember(results) {
  const ids = [];
  for (const s of results) {
    if (!s.poster_path) continue;
    if (!shows.has(s.id)) shows.set(s.id, s);
    if (!ids.includes(s.id)) ids.push(s.id);
  }
  return ids;
}

for (const svc of cfg.services) {
  const originals = remember(await originalsOf(svc));
  const streaming = remember(await streamingOf(svc));
  liveStreaming.set(svc.id, streaming);
  lists[`${svc.id}-originals`] = originals;
  // "On <service>" = everything streaming there plus its originals (JustWatch data sometimes misses them)
  lists[`${svc.id}-all`] = [...new Set([...streaming, ...originals])];
  console.log(`${svc.name}: ${originals.length} originals, ${lists[`${svc.id}-all`].length} total`);
}

// 1b. Exclusives: anime whose only streaming home in this region is this service.
// Verdicts are cached in state so later builds only look up what is new or stale.
state.providers ||= {};
const ttlCut = new Date(Date.now() - (cfg.providerTtlDays ?? 21) * 864e5).toISOString().slice(0, 10);
const familyOf = (svc) => new Set(svc.exclusiveProviders || svc.providers);

const settled = new Set(); // already permanent in an originals row: never needs re-checking
for (const svc of cfg.services)
  for (const id of Object.keys(state.lists[`${svc.id}-originals`] || {})) settled.add(`${svc.id}:${id}`);

const toCheck = new Set();
for (const svc of cfg.services) {
  const own = new Set(lists[`${svc.id}-originals`]);
  for (const id of lists[`${svc.id}-all`]) {
    if (own.has(id) || settled.has(`${svc.id}:${id}`)) continue;
    if (!state.providers[id] || state.providers[id].d < ttlCut) toCheck.add(id);
  }
}
const budget = [...toCheck].slice(0, cfg.maxProviderLookups ?? 1500);
for (let i = 0; i < budget.length; i += 10) {
  await Promise.all(
    budget.slice(i, i + 10).map(async (id) => {
      try {
        const reg = (await tmdb(`/tv/${id}/watch/providers`)).results?.[REGION] || {};
        const ids = [...(reg.flatrate || []), ...(reg.ads || []), ...(reg.free || [])].map((x) => x.provider_id);
        state.providers[id] = { d: TODAY, p: [...new Set(ids)].sort((a, b) => a - b) };
      } catch (e) {
        console.warn(`watch/providers ${id}: ${e.message}`);
      }
    }),
  );
}
if (toCheck.size > budget.length)
  console.log(`Provider lookups: ${budget.length} done, ${toCheck.size - budget.length} queued for the next build`);

let exclusiveCount = 0;
for (const svc of cfg.services) {
  const fam = familyOf(svc);
  const row = lists[`${svc.id}-originals`];
  const own = new Set(row);
  for (const id of lists[`${svc.id}-all`]) {
    if (own.has(id)) continue;
    const seen = state.providers[id]?.p;
    if (seen?.length && seen.every((x) => fam.has(x))) {
      row.push(id);
      own.add(id);
      exclusiveCount++;
    }
  }
}
console.log(`Exclusives added to originals rows: ${exclusiveCount} (${budget.length} provider lookups)`);

// 1c. Merge with permanent state: add new shows, never drop old ones
let addedNow = 0;
for (const [id, current] of Object.entries(lists)) {
  const known = (state.lists[id] ||= {});
  for (const tmdbId of current) {
    if (!known[tmdbId]) {
      known[tmdbId] = TODAY;
      addedNow++;
    }
  }
  lists[id] = Object.keys(known).map(Number);
}
const addedOn = (catalogId, tmdbId) => state.lists[catalogId][tmdbId];

// Shows that left the service (or fell out of the discover results) still need metadata
const retained = [...new Set(Object.values(lists).flat())].filter((id) => !shows.has(id));
const retainedImdb = new Map();
for (let i = 0; i < retained.length; i += 10) {
  await Promise.all(
    retained.slice(i, i + 10).map(async (id) => {
      try {
        const d = await tmdb(`/tv/${id}`, { language: cfg.language, append_to_response: 'external_ids' });
        if (!d.poster_path) return;
        shows.set(id, { ...d, genre_ids: (d.genres || []).map((g) => g.id) });
        if (d.external_ids?.imdb_id) retainedImdb.set(id, d.external_ids.imdb_id);
      } catch (e) {
        console.warn(`retained show ${id}: ${e.message}`); // stays in state, skipped this build
      }
    }),
  );
}
for (const id of Object.keys(lists)) lists[id] = lists[id].filter((x) => shows.has(x));
console.log(`State: ${addedNow} new entries today, ${retained.length} retained shows no longer in live results`);

// Derived catalogs deliberately DO NOT enter permanent state. They represent the
// latest snapshot of US subscription streaming availability, not historical membership.
for (const svc of cfg.services) {
  const active = liveStreaming.get(svc.id).filter((id) => shows.has(id));
  lists[`${svc.id}-latest`] = active.filter((id) => {
    const date = shows.get(id).first_air_date || '';
    return date && date <= TODAY; // no undated or future-premiere titles
  });
  lists[`${svc.id}-top-rated`] = active.filter((id) =>
    (shows.get(id).vote_count || 0) >= (cfg.topRatedMinVotes ?? 25)
  );
}


// 2. Enrich
const allIds = [...shows.keys()];
const mdb = await mdbEnrich(allIds);

// IMDb id fallback from TMDB for anything MDBList did not return
const imdbOf = new Map(retainedImdb);
for (const id of allIds) {
  const it = mdb.get(id);
  const imdb = it?.ids?.imdb ?? it?.imdbid ?? it?.imdb_id;
  if (typeof imdb === 'string' && imdb.startsWith('tt')) imdbOf.set(id, imdb);
}
const missing = allIds.filter((id) => !imdbOf.has(id));
for (let i = 0; i < missing.length; i += 10) {
  await Promise.all(
    missing.slice(i, i + 10).map(async (id) => {
      try {
        const x = await tmdb(`/tv/${id}/external_ids`);
        if (x.imdb_id) imdbOf.set(id, x.imdb_id);
      } catch (e) {
        console.warn(`external_ids ${id}: ${e.message}`);
      }
    }),
  );
}
if (missing.length) console.log(`TMDB external_ids lookups: ${missing.length}`);

// 3. Meta previews
const score = (id) => {
  const it = mdb.get(id);
  const s = it?.score ?? it?.score_average;
  return typeof s === 'number' && s > 0 ? s : (shows.get(id).vote_average || 0) * 10;
};

function toMeta(id) {
  const s = shows.get(id);
  const r = mdbRatings(mdb.get(id));
  const line = [
    r.imdb && `IMDb ${r.imdb}`,
    r.myanimelist && `MAL ${r.myanimelist}`,
    r.tomatoes && `RT ${r.tomatoes}%`,
    r.trakt && `Trakt ${r.trakt}%`,
    !r.imdb && s.vote_average ? `TMDB ${s.vote_average.toFixed(1)}` : null,
  ].filter(Boolean);
  const meta = {
    id: imdbOf.get(id) || `tmdb:${id}`,
    type: 'series',
    name: s.name || s.original_name,
    poster: `https://image.tmdb.org/t/p/w500${s.poster_path}`,
    posterShape: 'poster',
    description: [line.length ? `⭐ ${line.join(' · ')}` : '', s.overview || ''].filter(Boolean).join('\n\n'),
    genres: (s.genre_ids || []).map((g) => genreNames.get(g)).filter(Boolean),
  };
  if (s.backdrop_path) meta.background = `https://image.tmdb.org/t/p/w1280${s.backdrop_path}`;
  if (s.first_air_date) meta.releaseInfo = s.first_air_date.slice(0, 4);
  const rating = r.imdb ?? (s.vote_average ? s.vote_average.toFixed(1) : null);
  if (rating) meta.imdbRating = String(rating);
  return meta;
}

// 4. Write files
const byAir = (a, b) => (shows.get(b).first_air_date || '').localeCompare(shows.get(a).first_air_date || '');
// Default order: most recently added to the service first, then newest air date
const recentlyAdded = (catalogId) => (ids) =>
  [...ids].sort((a, b) => addedOn(catalogId, b).localeCompare(addedOn(catalogId, a)) || byAir(a, b));
const byScore = (a, b) => score(b) - score(a) || byAir(a, b);
const SORTS = {
  Popular: (ids) => ids, // TMDB popularity order
  Top: (ids) => [...ids].sort(byScore),
  New: (ids) => [...ids].sort(byAir),
};

await rm(OUT, { recursive: true, force: true });
const write = async (rel, obj) => {
  const f = path.join(OUT, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
};

const catalogs = [];
for (const svc of cfg.services) {
  // Extra rows appear individually in Nuvio's "Add catalog source" selector.
  // Existing rows keep their per-catalog Popular / Top / New sorting controls.
  for (const [suffix, label, defaultSorter, offerSortFilters] of [
    ['all', `Anime on ${svc.name}`, recentlyAdded(`${svc.id}-all`), true],
    ['originals', `${svc.name} Originals & Exclusives`, recentlyAdded(`${svc.id}-originals`), true],
    ['latest', `Latest ${svc.name} Anime`, (ids) => [...ids].sort(byAir), false],
    ['top-rated', `Top Rated ${svc.name} Anime`, (ids) => [...ids].sort(byScore), false],
  ]) {
    const id = `${svc.id}-${suffix}`;
    const ids = [...lists[id]].sort((a, b) => (shows.get(b).popularity || 0) - (shows.get(a).popularity || 0));
    if (!ids.length) {
      console.log(`Skipping empty catalog ${label}`);
      continue;
    }
    catalogs.push({
      type: 'series',
      id,
      name: label,
      extra: [
        ...(offerSortFilters ? [{ name: 'genre', options: Object.keys(SORTS), isRequired: false }] : []),
        { name: 'skip' },
      ],
    });
    for (const [sortName, sorter] of [['', defaultSorter], ...(offerSortFilters ? Object.entries(SORTS) : [])]) {
      const metas = sorter(ids).map(toMeta);
      const pages = Math.max(1, Math.ceil(metas.length / PAGE));
      for (let p = 0; p <= pages; p++) {
        // one extra empty page so clients get a clean end-of-list instead of a 404
        const body = { metas: metas.slice(p * PAGE, (p + 1) * PAGE) };
        const skip = p * PAGE;
        const name = sortName
          ? skip ? `${id}/genre=${sortName}&skip=${skip}.json` : `${id}/genre=${sortName}.json`
          : skip ? `${id}/skip=${skip}.json` : `${id}.json`;
        await write(`catalog/series/${name}`, body);
      }
    }
  }
}

const manifest = {
  id: cfg.addon.id,
  version: cfg.addon.version,
  name: cfg.addon.name,
  description: `${cfg.addon.description} Region: ${REGION}. Updated ${new Date().toISOString().slice(0, 10)}.`,
  resources: ['catalog'],
  types: ['series'],
  catalogs,
  behaviorHints: { configurable: false },
};
await write('manifest.json', manifest);
await write('.nojekyll', '');
await write(
  'index.html',
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cfg.addon.name}</title>
<body style="font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1>${cfg.addon.name}</h1>
<p>${manifest.description}</p>
<p>Add this URL in Nuvio or Stremio under Addons:</p>
<pre id="u" style="padding:1rem;background:#8882;border-radius:8px;overflow:auto"></pre>
<ul>${catalogs.map((c) => `<li>${c.name} (${lists[c.id].length})</li>`).join('')}</ul>
<p><small>Uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by JustWatch. Ratings by MDBList.</small></p>
<script>document.getElementById('u').textContent=new URL('manifest.json',location.href).href</script>`,
);

// 5. Save state (sorted keys so git diffs stay small). The month stamp guarantees at least one commit a month.
const sorted = {};
for (const k of Object.keys(state.lists).sort()) {
  sorted[k] = Object.fromEntries(Object.entries(state.lists[k]).sort((a, b) => a[0] - b[0]));
}
await mkdir(path.dirname(STATE_FILE), { recursive: true });
const providers = Object.fromEntries(Object.entries(state.providers).sort((a, b) => a[0] - b[0]));
await writeFile(
  STATE_FILE,
  JSON.stringify({ heartbeat: TODAY.slice(0, 7), lists: sorted, providers }, null, 1) + '\n',
);

console.log(`Done: ${shows.size} shows, ${catalogs.length} catalogs -> ${OUT}`);
