#!/usr/bin/env node
/**
 * EEZZ -> Meta hotelcatalogus (XML-feed)
 *
 * Haalt alle accommodaties van eezz.nl op via de boekings-API van EEZZ (connect.eezz.nl),
 * bepaalt per accommodatie beschikbaarheid en een "vanaf"-prijs per nacht, koppelt een
 * adres en coördinaten per park/plaats en schrijft een XML-feed in het Meta-hotelformaat.
 *
 * hotel_id = de slug uit de URL (/accommodaties/<slug>). Dat is exact wat de Meta-pixel
 * van EEZZ als content_ids meestuurt (content_type "hotel"), zodat feed en pixel matchen.
 *
 * Gebruik:
 *   node eezz-meta-feed.mjs                volledige run
 *   node eezz-meta-feed.mjs --limit 50     testrun met de eerste 50 accommodaties
 *   node eezz-meta-feed.mjs --no-geocode   geen nieuwe adressen opzoeken
 *
 * Geen externe packages nodig (Node 18+).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.join(ROOT, ...p);
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = argVal('--limit') ? parseInt(argVal('--limit'), 10) : 0;
const NO_GEOCODE = args.includes('--no-geocode');

const DEFAULTS = {
  siteUrl: 'https://www.eezz.nl',
  apiBase: 'https://connect.eezz.nl/api/v1',
  apiKey: '', // leeg = automatisch uit de website halen (of env EEZZ_EMBED_KEY)
  language: 'nl-NL',
  fallbackLanguage: 'en-US',
  currency: 'EUR',
  windowDays: 365, // beschikbaarheid en vanaf-prijs over deze periode
  soonDays: 14, // last minute: eerste aankomstdag binnen zoveel dagen → intern label "lastminute"
  concurrency: 4,
  detailRefreshDays: 7, // details gemiddeld eens per week verversen (gespreid)
  quoteCacheDays: 7, // offerteprijzen (partners zonder kalenderprijs) een week bewaren
  quoteAdults: 2,
  quoteMinNights: 3, // offerte bij voorkeur voor ≥ 3 nachten, zodat vaste kosten de nachtprijs niet opblazen
  minPricePerNight: 15, // prijzen daarbuiten worden als onwaarschijnlijk genegeerd
  maxPricePerNight: 5000,
  maxImages: 20,
  imageSize: 'large',
  feedTitle: 'EEZZ accommodaties',
  outputFile: 'output/eezz-meta-hotel-feed.xml',
  geocodeUserAgent: 'eezz-feed-builder/1.0',
  geocodeMaxKm: 30,
  minFeedRatio: 0.7, // feed niet overschrijven als er < 70% van de vorige run in zit
};
const cfgPath = P('config.json');
const CFG = { ...DEFAULTS, ...(fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}) };
fs.mkdirSync(P('data'), { recursive: true });
fs.mkdirSync(path.dirname(P(CFG.outputFile)), { recursive: true });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, data) => { fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f); };
const writeAtomic = (f, content) => { fs.writeFileSync(f + '.tmp', content); fs.renameSync(f + '.tmp', f); };
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };

// ---------------------------------------------------------------- HTTP

async function httpGet(url, { headers = {}, retries = 4, timeoutMs = 30000, json = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok && !(json && res.status >= 400 && res.status < 500)) { const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e; }
      if (!json) return await res.text();
      const body = await res.json().catch(() => null);
      if (!res.ok && !body) { const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e; }
      return body;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

let API_KEY = '';
async function api(p) {
  const d = await httpGet(CFG.apiBase + p, { headers: { 'X-EEZZ-Auth': API_KEY, 'Content-Type': 'application/json' } });
  if (!d || !d.success) { const e = new Error(`API: ${(d && d.error && d.error.code) || 'onbekende fout'}`); e.code = d && d.error && d.error.code; throw e; }
  return d.data;
}

async function getApiKey(accommodationUrls) {
  if (process.env.EEZZ_EMBED_KEY) return process.env.EEZZ_EMBED_KEY.trim();
  if (CFG.apiKey) return CFG.apiKey.trim();
  for (const u of accommodationUrls.slice(0, 5)) {
    const html = await httpGet(u, { json: false }).catch(() => '');
    const m = html.match(/embed-key="([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error('Geen API-sleutel gevonden op de accommodatiepagina\'s. Zet "apiKey" in config.json of EEZZ_EMBED_KEY.');
}

async function pool(items, n, fn, label) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e.message || String(e) }; }
      done++;
      if (done % 250 === 0 || done === items.length) log(`${label}: ${done}/${items.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- tekst

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', eacute: 'é', egrave: 'è', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}
function htmlToText(html) {
  if (!html) return '';
  const s = String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h\d)>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}
const tr = (obj) => {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return String(obj[CFG.language] || obj[CFG.fallbackLanguage] || Object.values(obj).find(Boolean) || '');
};
const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.8 ? cut.slice(0, sp) : cut) + '…';
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------- landen

const countryEn = new Intl.DisplayNames(['en'], { type: 'region' });
const countryNl = new Intl.DisplayNames(['nl'], { type: 'region' });
const safeName = (dn, cc) => { try { return cc ? dn.of(cc.toUpperCase()) : ''; } catch { return cc; } };
// Verouderde of gereserveerde codes die dezelfde naam kunnen hebben als een huidig land (DD=Duitsland, FX=Frankrijk, AN=Curaçao …)
const NOT_COUNTRIES = new Set(['AC', 'AN', 'BU', 'CP', 'CQ', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'NT', 'QO', 'RH', 'SU', 'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'XK', 'YD', 'YU', 'ZR']);
const NL_TO_ISO = (() => {
  const m = new Map();
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const cc = String.fromCharCode(a, b);
    if (NOT_COUNTRIES.has(cc)) continue;
    try { const n = countryNl.of(cc); if (n && n !== cc && !m.has(norm(n))) m.set(norm(n), cc); } catch { /* geen geldige code */ }
  }
  return m;
})();

// ---------------------------------------------------------------- CSV (puntkomma, Excel-vriendelijk)

function csvParse(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLine = (arr) => arr.map(csvCell).join(';');

// ---------------------------------------------------------------- geocoding (OpenStreetMap Nominatim, gecachet)

const geoCachePath = P('data', 'geocache.json');
const geoCache = readJson(geoCachePath, {});
let lastGeo = 0;
async function nominatim(params, endpoint = 'search') {
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', ...(endpoint === 'search' ? { limit: '1' } : {}), ...params });
  const key = (endpoint === 'search' ? '' : endpoint + ':') + qs.toString();
  if (key in geoCache) return geoCache[key];
  const wait = lastGeo + 1100 - Date.now(); // max 1 verzoek per seconde (gebruiksbeleid Nominatim)
  if (wait > 0) await sleep(wait);
  lastGeo = Date.now();
  let res;
  try {
    const d = await httpGet(`https://nominatim.openstreetmap.org/${endpoint}?${qs}`, { headers: { 'User-Agent': CFG.geocodeUserAgent, 'Accept-Language': 'nl,en' }, retries: 2 });
    const x = Array.isArray(d) ? d[0] : d;
    res = x && x.lat ? { lat: +x.lat, lon: +x.lon, type: `${x.category}/${x.type}`, address: x.address || {} } : null;
  } catch { return undefined; } // fouten niet cachen
  geoCache[key] = res;
  return res;
}
// Postcode/regio aanvullen via omgekeerd zoeken op de coördinaten
async function fillFromReverse(o) {
  const lat = parseCoord(o.latitude, 90), lon = parseCoord(o.longitude, 180);
  if (lat == null || lon == null) return;
  const r = await nominatim({ lat: lat.toFixed(5), lon: lon.toFixed(5), zoom: '16' }, 'reverse');
  if (!r) return;
  if (!o.postcode && r.address.postcode) o.postcode = r.address.postcode;
  if (!o.regio) o.regio = r.address.state || r.address.province || r.address.county || '';
}
function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const AREA_TYPES = /^(place\/(city|town|village|hamlet|municipality|county|state|region|island)|boundary\/)/;
async function geocodeLocation({ park, plaats, landcode, regio, multi }) {
  const base = landcode ? { countrycodes: landcode.toLowerCase() } : {};
  const regioClean = (regio || '').replace(/\s*\([A-Z]{2}\)\s*$/, '');
  // Referentiepunt: de plaats (kan ook een provincie zijn), of anders de regio
  let anchor = null, anchorKind = '';
  if (plaats) { anchor = (await nominatim({ ...base, q: plaats })) || (await nominatim({ ...base, city: plaats })); anchorKind = 'osm-plaats'; }
  if (!anchor && regioClean) { anchor = await nominatim({ ...base, q: regioClean }); anchorKind = 'osm-regio'; }

  // Partners met veel losse adressen (geen vaste plaats/regio bij het park): niet op partnernaam zoeken
  const names = multi ? [] : [...new Set([park, park.includes(' - ') ? park.split(' - ').slice(1).join(' - ') : null].filter(Boolean))];
  const queries = [...names.map((n) => (plaats ? `${n}, ${plaats}` : n))];
  if (plaats) queries.push(...names);
  for (const q of queries) {
    const r = await nominatim({ ...base, q });
    if (!r || AREA_TYPES.test(r.type)) continue;
    const tourismy = /^(tourism|leisure)\//.test(r.type);
    const close = anchor ? km(r, anchor) <= CFG.geocodeMaxKm : tourismy; // zonder referentie alleen echte toeristische objecten
    if (!close) continue;
    const a = r.address;
    return {
      adres: [a.road, a.house_number].filter(Boolean).join(' ') || park,
      postcode: a.postcode || anchor?.address?.postcode || '',
      plaats: plaats || a.village || a.town || a.city || a.municipality || '',
      osmRegio: a.state || a.province || a.county || '',
      latitude: r.lat.toFixed(6), longitude: r.lon.toFixed(6), bron: 'osm-park',
    };
  }
  if (anchor) {
    const a = anchor.address;
    return {
      adres: park, postcode: a.postcode || '',
      plaats: plaats || a.village || a.town || a.city || a.municipality || regioClean,
      osmRegio: a.state || a.province || a.county || '',
      latitude: anchor.lat.toFixed(6), longitude: anchor.lon.toFixed(6), bron: anchorKind,
    };
  }
  return { adres: park, postcode: '', plaats: plaats || '', osmRegio: '', latitude: '', longitude: '', bron: 'niet-gevonden' };
}
const parseCoord = (v, max) => {
  const n = parseFloat(String(v || '').trim().replace(',', '.'));
  return Number.isFinite(n) && Math.abs(n) <= max && n !== 0 ? n : null;
};

// ---------------------------------------------------------------- beschikbaarheid & prijs

const plausible = (perNightCents) => perNightCents >= CFG.minPricePerNight * 100 && perNightCents <= CFG.maxPricePerNight * 100;

function summarizeAvailability(days, today) {
  const soon = addDays(today, CFG.soonDays);
  const bookable = days.filter((d) => d.available && d.check_in && d.date >= today);
  let best = null, implausible = 0;
  for (const d of bookable) {
    if (d.min_price_cents == null || d.min_price_cents <= 0) continue;
    const nights = d.min_stay || (Array.isArray(d.valid_durations) && d.valid_durations[0]) || 1;
    const perNight = d.min_price_cents / nights;
    if (!plausible(perNight)) { implausible++; continue; }
    if (!best || perNight < best.perNight) best = { perNight, date: d.date, nights, stayCents: d.min_price_cents, source: 'kalender' };
  }
  // kandidaten voor een offerte als de kalender geen prijs geeft (partners)
  const candidates = [];
  const earliest = addDays(today, 2);
  for (const d of bookable) {
    if (d.date < earliest) continue;
    if (candidates.length && d.date < addDays(candidates[candidates.length - 1].date, 30)) continue;
    const durs = Array.isArray(d.valid_durations) ? d.valid_durations.filter((n) => Number.isInteger(n) && n > 0) : [];
    const longEnough = durs.filter((n) => n >= CFG.quoteMinNights).sort((a, b) => a - b)[0];
    const nights = longEnough || d.min_stay || durs[0] || 1;
    candidates.push({ date: d.date, nights });
    if (candidates.length >= 3) break;
  }
  return {
    bookableDays: bookable.length,
    firstBookable: bookable[0]?.date || '',
    soon: bookable.some((d) => d.date <= soon),
    best,
    implausible,
    candidates,
  };
}

async function quotePrice(slug, candidates) {
  for (const c of candidates) {
    const qs = new URLSearchParams({ start_date: c.date, end_date: addDays(c.date, c.nights), adults: String(CFG.quoteAdults), children: '0', infants: '0', pets: '0', language: CFG.language });
    try {
      const q = await api(`/accommodations/${encodeURIComponent(slug)}/quote?${qs}`);
      if (q && q.total_cents > 0 && plausible(q.total_cents / c.nights)) {
        return { perNight: q.total_cents / c.nights, date: c.date, nights: c.nights, stayCents: q.total_cents, source: 'offerte' };
      }
    } catch (e) {
      if (!e.code) throw e; // netwerkfout: niet doorzoeken
    }
  }
  return null;
}

// ---------------------------------------------------------------- labels

const TYPES = [
  ['Lodge', /lodge/i], ['Chalet', /chalet/i], ['Stacaravan', /stacaravan|mobile ?home|mobilhome|mobilheim/i],
  ['Glamping', /glamping|safari|tent|kubus/i], ['Bungalow', /bungalow/i], ['Villa', /villa/i],
  ['Appartement', /apartment|appartement|flat|penthouse|loft|studio/i], ['Boerderij', /boerderij|hoeve|farm/i],
  ['Tiny house', /tiny/i], ['Vakantiehuis', /vakantiehuis|vakantiewoning|cottage|huisje|landhuis|house|haus|hytte|stuga/i],
];
const typeOf = (name) => (TYPES.find(([, re]) => re.test(name)) || ['Vakantieaccommodatie'])[0];
function personGroup(n) {
  if (n <= 2) return 'personen-1-2';
  if (n <= 4) return 'personen-3-4';
  if (n <= 6) return 'personen-5-6';
  if (n <= 8) return 'personen-7-8';
  return 'personen-9-plus';
}

// ---------------------------------------------------------------- hoofdprogramma

async function main() {
  const t0 = Date.now();
  const today = isoDate(new Date());

  log('Sitemap ophalen…');
  const sitemapXml = await httpGet(`${CFG.siteUrl}/dynamic-accommodaties-sitemap.xml`, { json: false });
  const siteUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  let slugs = [...new Set(siteUrls.map((u) => decodeURIComponent(u.split('/accommodaties/')[1] || '').replace(/\/$/, '')).filter(Boolean))];
  if (slugs.length < 100) throw new Error(`Sitemap bevat maar ${slugs.length} accommodaties; feed niet bijgewerkt.`);
  log(`Sitemap: ${slugs.length} accommodatiepagina's`);
  if (LIMIT) slugs = slugs.slice(0, LIMIT);

  API_KEY = await getApiKey(siteUrls);

  log('Locatiestructuur ophalen…');
  const hier = await api('/location-hierarchy');
  const landById = new Map((hier.lands || []).map((x) => [x.id, tr(x.name)]));
  const regioById = new Map((hier.regios || []).map((x) => [x.id, tr(x.name)]));
  const cityById = new Map((hier.cities || []).map((x) => [x.id, tr(x.name)]));
  const parkById = new Map((hier.parks || []).map((x) => [x.id, x]));

  // --- lijst (verse namen/teksten/foto's; de API-paginering is niet stabiel, dus aanvullen met details)
  log('Accommodatielijst ophalen…');
  const first = await api('/accommodations?page=1&per_page=25');
  const perPage = first.pagination.per_page, apiTotal = first.pagination.total;
  const pages = Math.ceil(apiTotal / perPage);
  const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), CFG.concurrency,
    (p) => api(`/accommodations?page=${p}&per_page=${perPage}`), 'Lijst');
  const fresh = new Map();
  for (const d of [first, ...rest]) for (const it of (d && d.items) || []) fresh.set(it.slug, it);

  // --- details (gecachet, gespreid ververst)
  const detailCachePath = P('data', 'cache-details.json');
  const detailCache = readJson(detailCachePath, {});
  const needDetail = slugs.filter((s) => !detailCache[s] || detailCache[s].expiresAt < Date.now());
  log(`Details: ${needDetail.length} op te halen, ${slugs.length - needDetail.length} uit cache`);
  let sinceSave = 0;
  const detailRes = await pool(needDetail, CFG.concurrency, async (slug) => {
    const d = await api(`/accommodations/${encodeURIComponent(slug)}?include_park=1`);
    detailCache[slug] = {
      expiresAt: Date.now() + CFG.detailRefreshDays * DAY * (0.5 + Math.random()),
      data: {
        name: d.name, description: d.description, image: d.image,
        max_occupancy: d.max_occupancy, bedrooms: d.bedrooms, pets_allowed: d.pets_allowed,
        city: d.city || '', country_code: d.country_code || '',
        park: d.park ? { id: d.park.id, slug: d.park.slug, name: tr(d.park.name) } : null,
        gallery: (d.gallery_images || []).map((g) => g[CFG.imageSize] || g.large).filter(Boolean),
      },
    };
    if (++sinceSave % 250 === 0) writeJson(detailCachePath, detailCache);
  }, 'Details');
  writeJson(detailCachePath, detailCache);
  const detailErrors = detailRes.filter((r) => r && r.error).length;

  // --- beschikbaarheid & prijzen
  const end = addDays(today, CFG.windowDays);
  const priceCachePath = P('data', 'cache-prijzen.json');
  const priceCache = readJson(priceCachePath, {});
  log(`Beschikbaarheid en prijzen ophalen (${today} t/m ${end})…`);
  let quotesDone = 0;
  const avail = await pool(slugs, CFG.concurrency, async (slug) => {
    const d = await api(`/accommodations/${encodeURIComponent(slug)}/availability?start_date=${today}&end_date=${end}`);
    const r = summarizeAvailability(d.days || [], today);
    const prev = priceCache[slug];
    if (!r.best && r.bookableDays > 0) {
      if (prev && prev.quote && Date.now() - prev.quote.at < CFG.quoteCacheDays * DAY) r.best = prev.quote.best;
      else {
        const qb = await quotePrice(slug, r.candidates);
        quotesDone++;
        r.best = qb;
        r.quote = { at: Date.now(), best: qb };
      }
    }
    priceCache[slug] = { at: Date.now(), bookableDays: r.bookableDays, firstBookable: r.firstBookable, soon: r.soon, best: r.best, quote: r.quote || (prev && prev.quote) };
    return r;
  }, 'Prijzen');
  writeJson(priceCachePath, priceCache);
  log(`Offertes opgevraagd: ${quotesDone}`);

  // --- per accommodatie: samengevoegde gegevens
  const recs = slugs.map((slug, idx) => {
    const det = detailCache[slug]?.data;
    const li = fresh.get(slug);
    if (!det && !li) return { slug, missing: true };
    const src = { ...(det || {}), ...(li || {}) };
    const parkId = det?.park?.id || li?.park;
    const pk = parkById.get(parkId);
    const landName = pk ? landById.get(pk.land?.id) : '';
    const ccFromPark = landName ? NL_TO_ISO.get(norm(landName)) : '';
    const cc = (ccFromPark || det?.country_code || '').toUpperCase();
    const plaats = (det?.city || (pk && cityById.get(pk.city)) || '').trim();
    const regio = (pk && regioById.get(pk.regio?.id)) || '';
    const parkName = det?.park?.name || (pk && tr(pk.name)) || '';
    const parkSlug = det?.park?.slug || pk?.slug || 'zonder-park';
    let av = avail[idx];
    let fromCache = false;
    if (!av || av.error) {
      const c = priceCache[slug];
      if (c && Date.now() - c.at < 7 * DAY) { av = c; fromCache = true; } else av = { bookableDays: 0, best: null, soon: false, error: true };
    }
    return {
      slug, idx, src, det, cc, plaats, regio, parkName, parkSlug, av, fromCache,
      multi: !!pk && !pk.city && !pk.regio,
      landNl: landName || safeName(countryNl, cc),
      locKey: `${parkSlug}|${plaats}|${cc}`,
    };
  });

  // --- locaties (adres + coördinaten per park/plaats), bewerkbaar in data/locaties.csv
  const locPath = P('data', 'locaties.csv');
  const LOC_COLS = ['sleutel', 'park', 'plaats', 'landcode', 'adres', 'postcode', 'regio', 'latitude', 'longitude', 'bron'];
  const locs = new Map();
  if (fs.existsSync(locPath)) {
    const rows = csvParse(fs.readFileSync(locPath, 'utf8'));
    const head = (rows.shift() || []).map((h) => h.trim());
    for (const r of rows) { const o = Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])); if (o.sleutel) locs.set(o.sleutel, o); }
  }
  const used = new Set();
  for (const r of recs) {
    if (r.missing) continue;
    used.add(r.locKey);
    if (!locs.has(r.locKey)) locs.set(r.locKey, { sleutel: r.locKey, park: r.parkName, plaats: r.plaats, landcode: r.cc, adres: '', postcode: '', regio: r.regio, latitude: '', longitude: '', bron: '' });
    if (r.multi) locs.get(r.locKey).multi = true; // niet opgeslagen; alleen voor het opzoeken
  }
  const pending = [...locs.values()].filter((o) => used.has(o.sleutel) && !o.bron);
  if (pending.length && !NO_GEOCODE) {
    log(`Adressen opzoeken voor ${pending.length} park/plaats-combinaties (±1 per seconde)…`);
    let i = 0;
    for (const o of pending) {
      const g = await geocodeLocation(o);
      Object.assign(o, { adres: o.adres || g.adres, postcode: o.postcode || g.postcode, plaats: o.plaats || g.plaats, regio: o.regio || g.osmRegio, latitude: g.latitude, longitude: g.longitude, bron: g.bron });
      if (++i % 20 === 0) { log(`Adressen: ${i}/${pending.length}`); writeJson(geoCachePath, geoCache); }
    }
    writeJson(geoCachePath, geoCache);
  }
  if (!NO_GEOCODE) {
    const incomplete = [...locs.values()].filter((o) => used.has(o.sleutel) && o.bron !== 'handmatig' && (!o.postcode || !o.regio) && parseCoord(o.latitude, 90) != null);
    if (incomplete.length) {
      log(`Postcode/regio aanvullen voor ${incomplete.length} locaties…`);
      for (const o of incomplete) await fillFromReverse(o);
      writeJson(geoCachePath, geoCache);
    }
  }
  // Bij een volledige run alleen gebruikte (en handmatige) regels bewaren
  const locRows = [...locs.values()].filter((o) => LIMIT || used.has(o.sleutel) || o.bron === 'handmatig').sort((a, b) => a.sleutel.localeCompare(b.sleutel));
  writeAtomic(locPath, '﻿' + [LOC_COLS.join(';'), ...locRows.map((o) => csvLine(LOC_COLS.map((c) => o[c])))].join('\r\n') + '\r\n');

  // --- feed opbouwen
  const listings = [];
  const report = [];
  const skipped = {};
  const skip = (rep, reason) => { rep.reden = reason; skipped[reason] = (skipped[reason] || 0) + 1; };
  const soonLimit = addDays(today, CFG.soonDays);
  const tally = { metPrijs: 0, prijsKalender: 0, prijsOfferte: 0, lastminute: 0, later: 0, nietBeschikbaar: 0, gearchiveerd: 0, uitCache: 0 };
  const addrQuality = {};

  for (const r of recs) {
    const rep = { hotel_id: r.slug, opgenomen: 'nee' };
    report.push(rep);
    if (r.missing) { skip(rep, 'gegevens niet op te halen'); continue; }
    const name = tr(r.src.name).trim();
    Object.assign(rep, { naam: name, park: r.parkName, plaats: r.plaats, land: r.cc });
    if (!name) { skip(rep, 'geen naam'); continue; }
    const loc = locs.get(r.locKey);
    const lat = loc && parseCoord(loc.latitude, 90), lng = loc && parseCoord(loc.longitude, 180);
    if (lat == null || lng == null) { skip(rep, 'geen coördinaten (vul data/locaties.csv aan)'); continue; }
    const images = [...new Set([r.src.image?.[CFG.imageSize] || r.src.image?.large, ...((r.det && r.det.gallery) || [])].filter(Boolean))].slice(0, CFG.maxImages);
    if (!images.length) { skip(rep, 'geen afbeelding'); continue; }
    if (!r.cc) { skip(rep, 'land onbekend'); continue; }

    const av = r.av;
    if (r.fromCache) tally.uitCache++;
    // last minute: eerste aankomstdag binnen soonDays na vandaag (ook juist bij cachegegevens)
    const lastminute = av.bookableDays > 0 && !!av.firstBookable && av.firstBookable <= soonLimit;
    // volgeboekt → gearchiveerd via standaardveld status; bij een ophaalfout niet archiveren
    const archived = !av.bookableDays && !av.error;
    const status = av.bookableDays > 0 ? (lastminute ? 'last minute' : 'beschikbaar') : (av.error ? 'onbekend (ophaalfout)' : 'niet beschikbaar');
    if (av.bookableDays > 0) (lastminute ? tally.lastminute++ : tally.later++); else tally.nietBeschikbaar++;
    if (archived) tally.gearchiveerd++;
    const price = av.best ? `${(Math.round(av.best.perNight) / 100).toFixed(2)} ${CFG.currency}` : '';
    if (price) { tally.metPrijs++; av.best.source === 'offerte' ? tally.prijsOfferte++ : tally.prijsKalender++; }
    addrQuality[loc.bron || 'onbekend'] = (addrQuality[loc.bron || 'onbekend'] || 0) + 1;

    const description = truncate(htmlToText(tr(r.src.description)), 5000) || name;
    const regio = loc.regio || r.regio || '';
    const plaats = loc.plaats || r.plaats || regio;
    const typ = typeOf(name);

    const L = [];
    L.push('  <listing>');
    L.push(`    <hotel_id>${xmlEsc(r.slug)}</hotel_id>`);
    L.push(`    <name>${xmlEsc(name)}</name>`);
    L.push(`    <description>${xmlEsc(description)}</description>`);
    if (r.parkName) L.push(`    <brand>${xmlEsc(r.parkName)}</brand>`);
    L.push('    <address format="simple">');
    L.push(`      <component name="addr1">${xmlEsc(loc.adres || r.parkName || plaats)}</component>`);
    L.push(`      <component name="city">${xmlEsc(plaats)}</component>`);
    if (regio) L.push(`      <component name="region">${xmlEsc(regio)}</component>`);
    if (loc.postcode) L.push(`      <component name="postal_code">${xmlEsc(loc.postcode)}</component>`);
    L.push(`      <component name="country">${xmlEsc(safeName(countryEn, r.cc))}</component>`);
    L.push('    </address>');
    L.push(`    <latitude>${lat}</latitude>`);
    L.push(`    <longitude>${lng}</longitude>`);
    L.push(`    <neighborhood>${xmlEsc(regio || plaats)}</neighborhood>`);
    if (price) L.push(`    <base_price>${price}</base_price>`);
    for (const url of images) L.push(`    <image><url>${xmlEsc(url)}</url></image>`);
    L.push(`    <url>${xmlEsc(`${CFG.siteUrl}/accommodaties/${r.slug}`)}</url>`);
    L.push(`    <category>${xmlEsc(typ)}</category>`);
    L.push(`    <status>${archived ? 'archived' : 'active'}</status>`);
    // interne labels alleen voor gegevens zonder standaardveld in de hotelcatalogus (één tag per label)
    const labels = [];
    if (r.src.max_occupancy) labels.push(personGroup(r.src.max_occupancy));
    if (r.src.bedrooms) labels.push(`slaapkamers-${r.src.bedrooms}`);
    if (r.src.pets_allowed) labels.push('huisdieren-toegestaan');
    if (lastminute) labels.push('lastminute');
    for (const lb of labels) L.push(`    <internal_label>${xmlEsc(lb)}</internal_label>`);
    L.push('  </listing>');
    listings.push(L.join('\n'));

    Object.assign(rep, {
      opgenomen: 'ja', reden: av.error ? 'beschikbaarheid niet op te halen' : '',
      beschikbaarheid: status, eerste_aankomst: av.firstBookable || '', beschikbare_aankomstdagen: av.bookableDays || 0,
      prijs_per_nacht: price, prijsbron: av.best?.source || '', prijs_aankomst: av.best?.date || '', nachten: av.best?.nights || '',
      verblijfsprijs: av.best ? (av.best.stayCents / 100).toFixed(2) : '', adres_bron: loc.bron, afbeeldingen: images.length, type: typ,
    });
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<listings>',
    `  <title>${xmlEsc(CFG.feedTitle)}</title>`,
    `  <link rel="self" href="${xmlEsc(CFG.siteUrl)}"/>`,
    ...listings,
    '</listings>',
    '',
  ].join('\n');

  // --- veiligheidscheck: nooit een half lege feed publiceren (Meta zou dan items verwijderen)
  const summaryPath = P('output', 'samenvatting.json');
  const prev = readJson(summaryPath, null);
  const outFile = P(CFG.outputFile);
  let written = outFile;
  if (LIMIT) written = outFile.replace(/\.xml$/, '.test.xml');
  else if (prev && prev.inFeed && listings.length < prev.inFeed * CFG.minFeedRatio) {
    written = outFile.replace(/\.xml$/, '.afgekeurd.xml');
    log(`LET OP: maar ${listings.length} items (vorige run ${prev.inFeed}). Feed NIET overschreven; zie ${path.basename(written)}.`);
    process.exitCode = 2;
  }
  writeAtomic(written, xml);

  const REP_COLS = ['hotel_id', 'naam', 'park', 'plaats', 'land', 'opgenomen', 'reden', 'beschikbaarheid', 'eerste_aankomst', 'beschikbare_aankomstdagen', 'prijs_per_nacht', 'prijsbron', 'prijs_aankomst', 'nachten', 'verblijfsprijs', 'adres_bron', 'afbeeldingen', 'type'];
  writeAtomic(P('output', LIMIT ? 'rapport.test.csv' : 'rapport.csv'), '﻿' + [REP_COLS.join(';'), ...report.map((r) => csvLine(REP_COLS.map((c) => r[c])))].join('\r\n') + '\r\n');

  const summary = {
    gegenereerd: new Date().toISOString(),
    accommodatiesOpSite: slugs.length, accommodatiesInApi: apiTotal, inFeed: listings.length,
    ...tally, detailFouten: detailErrors, offertesOpgevraagd: quotesDone,
    venster: `${today} t/m ${end}`, overgeslagen: skipped, adresbron: addrQuality,
    duurSeconden: Math.round((Date.now() - t0) / 1000), bestand: path.relative(ROOT, written),
  };
  if (!LIMIT && written === outFile) fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('FOUT:', e.message || e); process.exit(1); });
