// Oracle: responsive storefront images (functions/_lib/responsive-image.js).
//   - allowlisted sources (override uploads, static uploads, Guide media)
//     become same-origin /img WebP variants; everything else passes through
//   - og:image / twitter:image stay JPEG or PNG, and the slug page preloads
//     the hero's WebP srcset
//   - event.html, index.html and site-overrides.js route images through the
//     helper instead of loading full size originals
// Run: node scripts/check-responsive-image.mjs

import { readFileSync } from 'node:fs';
import {
  VARIANT_WIDTHS,
  clampWidth,
  isTransformable,
  metaImageUrl,
  parseVariantPath,
  preloadLinkHtml,
  setResponsiveImage,
  srcsetAttributes,
  srcsetFor,
  variantUrl,
} from '../functions/_lib/responsive-image.js';
import { onRequestGet as slugPage } from '../functions/[slug].js';

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const OVERRIDE = '/override-images/8267/ff768619-89bd-426c-931e-b4fc1f3e467b.jpg';
const GUIDE = 'https://otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com/media/images/full/abc.jpg';

// ---- variantUrl / allowlist ------------------------------------------------
assert(variantUrl(OVERRIDE, { width: 800 }) === `/img/800${OVERRIDE}.webp`, 'override upload becomes a WebP variant');
assert(variantUrl(`https://otratickets.com${OVERRIDE}`, { width: 800 }) === `/img/800${OVERRIDE}.webp`, 'absolute same-site URL becomes a variant');
assert(variantUrl(GUIDE, { width: 400 }) === '/img/400/guide-media/media/images/full/abc.jpg.webp', 'Guide media becomes a same-origin variant');
assert(
  variantUrl('uploads/Otra Tickets Logo.webp', { width: 400 }) === '/img/400/uploads/Otra%20Tickets%20Logo.webp.webp',
  'relative upload with spaces is encoded',
);
assert(variantUrl('/uploads/6827-card.webp', { width: 800 }) === '/img/800/uploads/6827-card.webp.webp', 'already WebP still gets width variants');
assert(variantUrl(OVERRIDE, { width: 1200, format: 'jpg' }) === `/img/1200${OVERRIDE}.jpeg`, 'jpg is an alias of jpeg');

for (const value of ['', null, undefined]) {
  assert(variantUrl(value) === '', `missing image (${value}) stays empty, never a broken /img URL`);
  assert(srcsetFor(value) === '', `missing image (${value}) has no srcset`);
}
for (const value of [
  'data:image/png;base64,iVBORw0KGgo=',
  'blob:https://otratickets.com/123',
  'https://example.com/photo.jpg',
  'https://evil.otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com.example.com/x.jpg',
  'http://otraguide-prod-media-nyc3.nyc3.cdn.digitaloceanspaces.com/media/x.jpg',
  '/uploads/variants/mosaic-hero-800.webp',
  `/img/800${OVERRIDE}.webp`,
  '/override-images/8267/clip.mp4',
  '/uploads/animated.gif',
  '/assets/8088/presidente-photo.png',
  `${OVERRIDE}?v=2`,
]) {
  assert(variantUrl(value, { width: 800 }) === value, `${value} passes through unchanged`);
  assert(!isTransformable(value), `${value} is not transformable`);
  assert(srcsetFor(value) === '' && srcsetAttributes(value) === '' && preloadLinkHtml(value) === '', `${value} gets no srcset or preload`);
}
assert(variantUrl(OVERRIDE, { format: 'gif' }) === OVERRIDE, 'a format outside the allowlist returns the original');

// ---- widths ----------------------------------------------------------------
assert(clampWidth(1) === 400 && clampWidth(401) === 800 && clampWidth(800) === 800, 'widths round up to the next allowed width');
assert(clampWidth(99999) === 1600 && clampWidth('abc') === 400, 'widths outside the range clamp to the allowlist');
const srcset = srcsetFor(OVERRIDE);
assert(
  srcset === VARIANT_WIDTHS.map((w) => `/img/${w}${OVERRIDE}.webp ${w}w`).join(', '),
  'srcset lists every allowlisted width',
);
assert(srcsetAttributes(OVERRIDE, { sizes: '100vw' }) === ` srcset="${srcset}" sizes="100vw"`, 'srcset attributes for HTML strings');

// ---- route parsing (inverse of variantUrl) ----------------------------------
const segments = (url) => url.replace(/^\/img\//, '').split('/').map(decodeURIComponent);
for (const source of [OVERRIDE, GUIDE, '/uploads/Otra Tickets Logo.webp']) {
  const url = variantUrl(source, { width: 1200 });
  const parsed = parseVariantPath(segments(url));
  const expected = new URL(source, 'https://otratickets.com').href;
  assert(parsed && parsed.width === 1200 && parsed.format === 'webp', `${url} parses`);
  assert(parsed && new URL(parsed.source, 'https://otratickets.com').href === expected, `${url} maps back to ${source}`);
}
assert(parseVariantPath(['999', 'override-images', '1', 'a.jpg.webp']).width === 1200, 'route rounds widths up to the allowlist');
assert(parseVariantPath(['99999', 'override-images', '1', 'a.jpg.webp']).width === 1600, 'route clamps widths above the allowlist');
for (const bad of [
  ['800', 'example.com', 'a.jpg.webp'],
  ['800', 'override-images', '..', 'secret.jpg.webp'],
  ['800', 'override-images', '1', 'clip.mp4.webp'],
  ['800', 'override-images', '1', 'a.jpg.gif'],
  ['800', 'uploads', 'variants', 'mosaic-hero-800.webp.webp'],
  ['wide', 'override-images', '1', 'a.jpg.webp'],
  ['800', 'a.jpg.webp'],
]) {
  assert(parseVariantPath(bad) === null, `/img/${bad.join('/')} is rejected`);
}

// ---- meta images stay JPEG / PNG -------------------------------------------
assert(metaImageUrl(OVERRIDE) === OVERRIDE, 'JPEG og:image is unchanged');
assert(metaImageUrl(GUIDE) === GUIDE, 'Guide JPEG og:image is unchanged');
assert(metaImageUrl('/uploads/flyer.png') === '/uploads/flyer.png', 'PNG og:image is unchanged');
assert(metaImageUrl('/uploads/6827-card.webp') === '/img/1200/uploads/6827-card.webp.jpeg', 'WebP original becomes a JPEG for meta tags');
assert(metaImageUrl('') === '', 'missing meta image stays empty');
assert(metaImageUrl('https://example.com/x.webp') === 'https://example.com/x.webp', 'unconvertible meta image is unchanged');

// ---- setResponsiveImage -----------------------------------------------------
function fakeImg(attrs = {}) {
  const el = {
    attrs: { ...attrs },
    getAttribute: (name) => (name in el.attrs ? el.attrs[name] : null),
    removeAttribute: (name) => { delete el.attrs[name]; delete el[name]; },
  };
  return el;
}
const hero = fakeImg({ sizes: '100vw' });
setResponsiveImage(hero, OVERRIDE);
assert(hero.src === OVERRIDE && hero.srcset === srcset && hero.sizes === '100vw', 'img keeps the original src and gets the WebP srcset');
setResponsiveImage(hero, 'https://example.com/x.jpg');
assert(hero.src === 'https://example.com/x.jpg' && !hero.srcset, 'switching to an unconvertible URL drops the stale srcset');

// ---- slug page head ---------------------------------------------------------
async function renderSlug(img) {
  const eventHtml = read('event.html');
  const context = {
    params: { slug: 'strange-bird-dress-up-evening' },
    request: new Request('https://otratickets.com/strange-bird-dress-up-evening'),
    env: { ASSETS: { fetch: async () => new Response(eventHtml, { headers: { 'content-type': 'text/html' } }) } },
    getHomepageEvents: async () => Response.json({
      events: [{ id: '8267', slug: 'strange-bird-dress-up-evening', title: 'Strange Bird', img }],
    }),
  };
  return (await slugPage(context)).text();
}
const jpegPage = await renderSlug(OVERRIDE);
assert(jpegPage.includes(`<meta property="og:image" content="https://otratickets.com${OVERRIDE}" />`), 'slug og:image stays the original JPEG');
assert(jpegPage.includes(`<meta name="twitter:image" content="https://otratickets.com${OVERRIDE}" />`), 'slug twitter:image stays the original JPEG');
assert(!/<meta[^>]+(og:image|twitter:image)[^>]+\.(webp|avif)"/.test(jpegPage), 'no meta image points at WebP or AVIF');
assert(
  jpegPage.includes(`<link rel="preload" as="image" type="image/webp" imagesrcset="${srcset}" imagesizes="100vw" fetchpriority="high" />`),
  'slug page preloads the hero WebP srcset',
);
const webpPage = await renderSlug('/uploads/6827-card.webp');
assert(webpPage.includes('<meta property="og:image" content="https://otratickets.com/img/1200/uploads/6827-card.webp.jpeg" />'), 'a WebP hero gets a JPEG og:image');
const noImagePage = await renderSlug('');
assert(!noImagePage.includes('og:image') && !noImagePage.includes('rel="preload" as="image"'), 'no image: no og:image and no preload');
const externalPage = await renderSlug('https://example.com/x.jpg');
assert(!externalPage.includes('rel="preload" as="image"'), 'external hero is not preloaded through /img');

// ---- page wiring --------------------------------------------------------------
const eventHtml = read('event.html');
const heroTag = eventHtml.match(/<img[^>]*id="evHeroImg"[^>]*>/);
assert(heroTag && /sizes="100vw"/.test(heroTag[0]) && /fetchpriority="high"/.test(heroTag[0]), 'hero is high priority with sizes 100vw');
assert(heroTag && /width="\d+"/.test(heroTag[0]) && /height="\d+"/.test(heroTag[0]), 'hero has width and height');
assert(!heroTag || !/loading="lazy"/.test(heroTag[0]), 'hero is never lazy');
for (const id of ['evStoryImg', 'evVideoImg', 'evPhotoBandImg']) {
  const tag = eventHtml.match(new RegExp(`<img[^>]*id="${id}"[^>]*>`));
  assert(tag && /loading="lazy"/.test(tag[0]) && /sizes="/.test(tag[0]), `${id} is lazy with sizes`);
}
assert(!eventHtml.includes('src="uploads/Otra Tickets Logo.webp"'), 'event header no longer loads the 1.5 MB logo');
assert(eventHtml.includes('uploads/variants/otra-tickets-logo-84.webp'), 'event header uses the sized logo variant');
assert(!/\.src = (ev\.image|design\.(storyImage|videoImage|photoBandImage))/.test(eventHtml), 'event images go through setImage');
assert(/import\("\/responsive-image\.js\?v=1"\)/.test(eventHtml), 'event page loads the helper');

const indexHtml = read('index.html');
assert(/setResponsiveImage\(img, ev\.img, \{ sizes: CARD_SIZES \}\)/.test(indexHtml), 'homepage cards use the helper');
assert(!/link\.href = ev\.img;\s*document/.test(indexHtml), 'first row preload is not the full original');
assert(/img\.loading = rowIndex === 0 \? "eager" : "lazy"/.test(indexHtml), 'first row eager, later rows lazy');

const overrides = read('site-overrides.js');
assert(/setResponsiveImage\(img, value/.test(overrides), 'site-overrides applies image slots through the helper');
assert(!/pre\.src = value;/.test(overrides), 'site-overrides no longer pre-decodes the full original');

if (failures.length) {
  console.error('check-responsive-image FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('check-responsive-image OK');
