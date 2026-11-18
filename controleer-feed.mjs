#!/usr/bin/env node
/**
 * Controleert de XML-feed op de verplichte velden van een Meta-hotelcatalogus.
 * Gebruik: node controleer-feed.mjs [pad/naar/feed.xml]
 */
import fs from 'node:fs';

const file = process.argv[2] || 'output/eezz-meta-hotel-feed.xml';
const xml = fs.readFileSync(file, 'utf8');
const errors = [];
const warn = {};
const w = (k) => { warn[k] = (warn[k] || 0) + 1; };

// 1. Goed gevormde XML (tags in balans, geen losse &)
if (!xml.startsWith('<?xml')) errors.push('Bestand begint niet met <?xml');
const stack = [];
for (const m of xml.matchAll(/<(\/?)([a-zA-Z_][\w.-]*)([^>]*?)(\/?)>/g)) {
  const [, close, tag, , selfClose] = m;
  if (m[0].startsWith('<?')) continue;
  if (selfClose) continue;
  if (close) { const top = stack.pop(); if (top !== tag) { errors.push(`Tag niet in balans bij </${tag}> (verwacht </${top}>)`); break; } }
  else stack.push(tag);
}
if (stack.length) errors.push(`Niet gesloten tags: ${stack.join(', ')}`);
const badAmp = xml.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g);
if (badAmp) errors.push(`${badAmp.length} niet-geëscapete &-tekens`);
if (!/<listings>/.test(xml)) errors.push('Root <listings> ontbreekt');

// 2. Per listing de verplichte velden
const listings = [...xml.matchAll(/<listing>([\s\S]*?)<\/listing>/g)].map((m) => m[1]);
const ids = new Set();
const get = (s, tag) => { const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1] : null; };
const comp = (s, name) => { const m = s.match(new RegExp(`<component name="${name}">([\\s\\S]*?)</component>`)); return m ? m[1] : null; };
let priced = 0;
for (const l of listings) {
  const id = get(l, 'hotel_id');
  if (!id) { errors.push('Listing zonder hotel_id'); continue; }
  if (id.length > 100) errors.push(`${id}: hotel_id langer dan 100 tekens`);
  if (ids.has(id)) errors.push(`Dubbele hotel_id: ${id}`);
  ids.add(id);
  for (const t of ['name', 'description', 'url', 'latitude', 'longitude', 'neighborhood']) if (!get(l, t)) errors.push(`${id}: ${t} ontbreekt`);
  const desc = get(l, 'description') || '';
  if (desc.length > 5000 * 1.3) errors.push(`${id}: description te lang`);
  const lat = +get(l, 'latitude'), lng = +get(l, 'longitude');
  if (!(Math.abs(lat) <= 90 && lat !== 0)) errors.push(`${id}: ongeldige latitude`);
  if (!(Math.abs(lng) <= 180 && lng !== 0)) errors.push(`${id}: ongeldige longitude`);
  for (const c of ['addr1', 'city', 'country']) if (!comp(l, c)) errors.push(`${id}: adres.${c} ontbreekt`);
  if (!comp(l, 'region')) w('adres.region ontbreekt');
  if (!comp(l, 'postal_code')) w('adres.postal_code ontbreekt');
  const imgs = [...l.matchAll(/<image><url>([^<]+)<\/url><\/image>/g)].length;
  if (!imgs) errors.push(`${id}: geen afbeelding`);
  if (imgs > 20) errors.push(`${id}: meer dan 20 afbeeldingen`);
  const bp = get(l, 'base_price');
  if (bp) { priced++; if (!/^\d+\.\d{2} [A-Z]{3}$/.test(bp)) errors.push(`${id}: base_price-formaat "${bp}"`); } else w('geen base_price (optioneel zonder kamerinfo)');
  const pageUrl = (l.match(/^\s*<url>([^<]+)<\/url>/m) || [])[1] || '';
  if (!/^https:\/\/www\.eezz\.nl\/accommodaties\//.test(pageUrl)) errors.push(`${id}: onverwachte url`);
  for (let i = 0; i <= 4; i++) { const v = get(l, `custom_label_${i}`); if (v && v.length > 100) errors.push(`${id}: custom_label_${i} > 100 tekens`); }
}

console.log(`Bestand: ${file} (${(xml.length / 1048576).toFixed(1)} MB)`);
console.log(`Listings: ${listings.length}, met prijs: ${priced}, unieke hotel_id's: ${ids.size}`);
console.log('Waarschuwingen:', Object.keys(warn).length ? warn : 'geen');
if (errors.length) {
  console.log(`FOUTEN (${errors.length}):`);
  for (const e of errors.slice(0, 30)) console.log('  - ' + e);
  process.exit(1);
}
console.log('OK: geen fouten gevonden.');
