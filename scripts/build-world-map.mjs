// Builds static/geo/world.json: one SVG path per country, keyed by the lowercase ISO alpha-3 code Search Console uses, with the
// country's English name and alpha-2 code (for its flag). Run once when the map should change; the output is committed, so the app
// has no map dependency at runtime.
//
//   npm install --no-save world-atlas@2.0.2 topojson-client@3.1.0 i18n-iso-countries@7.14.0
//   node scripts/build-world-map.mjs
//
// Shapes: world-atlas (ISC), from Natural Earth's 1:110m countries (public domain). Codes and names: i18n-iso-countries (MIT).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'));
const { feature } = require('topojson-client');
const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

// Equirectangular, cut at 58°S (no Antarctica) and 84°N: 1000 units wide.
const W = 1000, TOP = 84, BOTTOM = -58, H = Math.round(((TOP - BOTTOM) / 360) * W);
const px = (lon) => ((lon + 180) / 360) * W;
const py = (lat) => ((TOP - Math.max(BOTTOM, Math.min(TOP, lat))) / 360) * W;
// A ring that crosses the 180th meridian (Russia's far east, Fiji) would draw a line across the whole map: its western points are moved
// 360° east instead, past the right edge, where the map's frame cuts them off.
const ring = (r) => {
	const lons = r.map(([lon]) => lon);
	const wraps = Math.max(...lons) - Math.min(...lons) > 180;
	return r.map(([lon, lat], i) => `${i ? 'L' : 'M'}${px(wraps && lon < 0 ? lon + 360 : lon).toFixed(1)} ${py(lat).toFixed(1)}`).join('') + 'Z';
};
const out = {};
for (const f of feature(topo, topo.objects.countries).features) {
	const num = String(f.id ?? '').padStart(3, '0');
	const a3 = countries.numericToAlpha3(num);
	if (!a3 || a3 === 'ATA') continue;
	const g = f.geometry;
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
	const d = polys.map((p) => p.map(ring).join('')).join('');
	if (!d) continue;
	out[a3.toLowerCase()] = { n: countries.getName(a3, 'en', { select: 'official' }) ?? f.properties?.name ?? a3, a2: (countries.alpha3ToAlpha2(a3) ?? '').toLowerCase(), d };
}
// Every other country Search Console may report, without a shape (too small for 1:110m), so names and flags still work.
for (const [a3] of Object.entries(countries.getAlpha3Codes())) {
	const k = a3.toLowerCase();
	if (!out[k]) out[k] = { n: countries.getName(a3, 'en', { select: 'official' }) ?? a3, a2: (countries.alpha3ToAlpha2(a3) ?? '').toLowerCase(), d: '' };
}
mkdirSync('static/geo', { recursive: true });
writeFileSync('static/geo/world.json', JSON.stringify({ w: W, h: H, c: out }));
console.log(`static/geo/world.json: ${Object.keys(out).length} countries, ${Object.values(out).filter((x) => x.d).length} with shapes, ${H} high`);
