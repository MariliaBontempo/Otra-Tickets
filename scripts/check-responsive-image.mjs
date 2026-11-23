// Oracle: responsive storefront images (functions/_lib/responsive-image.js).
//   - allowlisted sources (override uploads, static uploads, Guide media)
//     become same-origin /img WebP variants; everything else passes through
//   - og:image / twitter:image stay JPEG or PNG, and the slug page preloads
//     the hero's WebP srcset
//   - event.html, index.html and site-overrides.js route images through the
//     helper instead of loading full size originals
// Run: node scripts/check-responsive-image.mjs

import { existsSync, readFileSync } from 'node:fs';
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
  viewportVariantUrl,
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
async function renderSlug(img, title = 'Strange Bird') {
  const eventHtml = read('event.html');
  const context = {
    params: { slug: 'strange-bird-dress-up-evening' },
    request: new Request('https://otratickets.com/strange-bird-dress-up-evening'),
    env: { ASSETS: { fetch: async () => new Response(eventHtml, { headers: { 'content-type': 'text/html' } }) } },
    getHomepageEvents: async () => Response.json({
      events: [{ id: '8267', slug: 'strange-bird-dress-up-evening', title, img }],
    }),
  };
  return (await slugPage(context)).text();
}
const heroTagIn = (html) => (html.match(/<img[^>]*id="evHeroImg"[^>]*>/) || [''])[0];
const attr = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
};
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

// ---- slug page body: above the fold hero and title in the first HTML ----------
{
  const tag = heroTagIn(jpegPage);
  const preload = jpegPage.match(/<link rel="preload" as="image"[^>]*imagesrcset="([^"]*)"[^>]*imagesizes="([^"]*)"/);
  assert(attr(tag, 'srcset') === srcset, 'slug hero <img> carries the WebP srcset');
  assert(preload && attr(tag, 'srcset') === preload[1] && attr(tag, 'sizes') === preload[2], 'slug hero srcset/sizes match the head preload exactly');
  assert(attr(tag, 'src') === OVERRIDE, 'slug hero src is the original (fallback, and what site-overrides compares)');
  assert(attr(tag, 'alt') === 'Strange Bird', 'slug hero alt is the event title');
  assert((tag.match(/\ssizes=/g) || []).length === 1 && (tag.match(/\salt=/g) || []).length === 1, 'slug hero has one sizes and one alt');
  assert(/fetchpriority="high"/.test(tag) && /width="1600"/.test(tag) && /height="900"/.test(tag) && !/loading="lazy"/.test(tag), 'slug hero keeps priority and dimensions, never lazy');
  assert(/<h1 id="evTitle">Strange Bird<\/h1>/.test(jpegPage), 'slug page writes the title into #evTitle');
  assert(/data-event-id="8267"/.test(jpegPage) && /data-override-id="8267"/.test(jpegPage), 'slug page keeps the event and override ids');
  assert(!/<meta[^>]+(og:image|twitter:image)[^>]+\/img\//.test(jpegPage), 'meta images never point at /img variants of a JPEG');

  const escaped = await renderSlug(OVERRIDE, 'Rock & "Roll" <Night>');
  assert(/<h1 id="evTitle">Rock &amp; &quot;Roll&quot; &lt;Night&gt;<\/h1>/.test(escaped), 'injected title is escaped');
  assert(attr(heroTagIn(escaped), 'alt') === 'Rock &amp; &quot;Roll&quot; &lt;Night&gt;', 'injected alt is escaped');

  const noImageTag = heroTagIn(noImagePage);
  assert(attr(noImageTag, 'src') === null && attr(noImageTag, 'srcset') === null, 'no image: hero stays empty for event.html to fill');
  assert(/<h1 id="evTitle">Strange Bird<\/h1>/.test(noImagePage), 'no image: the title is still written');

  const externalTag = heroTagIn(externalPage);
  assert(attr(externalTag, 'src') === 'https://example.com/x.jpg' && attr(externalTag, 'srcset') === null, 'unconvertible hero gets a plain src, no /img srcset');
  for (const unsafe of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/x.jpg', 'http://example.com/x.jpg']) {
    const tag = heroTagIn(await renderSlug(unsafe));
    assert(attr(tag, 'src') === null, `${unsafe} is never written into the hero src`);
  }
}

// ---- viewport sized CSS backgrounds -------------------------------------------
{
  const realWindow = globalThis.window;
  try {
    globalThis.window = { innerWidth: 412, devicePixelRatio: 1.75 };
    assert(viewportVariantUrl(OVERRIDE) === `/img/800${OVERRIDE}.webp`, 'Lighthouse mobile (412 x 1.75) gets the 800 background');
    globalThis.window = { innerWidth: 390, devicePixelRatio: 3 };
    assert(viewportVariantUrl(OVERRIDE) === `/img/1200${OVERRIDE}.webp`, 'a 3x phone gets the 1200 background');
    globalThis.window = { innerWidth: 360, devicePixelRatio: 1 };
    assert(viewportVariantUrl(OVERRIDE) === `/img/400${OVERRIDE}.webp`, 'a 1x phone gets the 400 background');
    globalThis.window = { innerWidth: 1920, devicePixelRatio: 1 };
    assert(viewportVariantUrl(OVERRIDE) === `/img/1600${OVERRIDE}.webp`, 'desktop gets the 1600 background');
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
}

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

assert(/if \(!hero\.getAttribute\("srcset"\) && !hero\.getAttribute\("src"\)\) setImage\(hero, ev\.image\)/.test(eventHtml),
  'event.html never replaces a server written or preloaded hero with the Guide original');
assert(/setText\(\$\("evTitle"\), /.test(eventHtml), 'event.html does not rewrite an unchanged title');
for (const id of ['story', 'evBandSection', 'evVideoSection', 'evPhotoBandSection']) {
  const rule = eventHtml.match(new RegExp(`#${id}\\b[^{]*\\{[^}]*content-visibility: auto[^}]*\\}`));
  assert(rule && /contain-intrinsic-size: auto /.test(rule[0]), `#${id} skips rendering below the fold (content-visibility: auto)`);
}
assert(/\.ev-hero-img\[src\] ~ \.sk-hero/.test(eventHtml), 'no skeleton shimmer over a server written hero');
assert(/images\.viewportVariantUrl\(design\.bandImage\)/.test(eventHtml), 'band background goes through the viewport sized helper');

const overrides = read('site-overrides.js');
assert(/setResponsiveImage\(img, value/.test(overrides), 'site-overrides applies image slots through the helper');
assert(!/pre\.src = value;/.test(overrides), 'site-overrides no longer pre-decodes the full original');
assert(/current === imageHelper\.srcsetFor\(value\)\) return;/.test(overrides), 'site-overrides skips a same image hero swap');
assert(/imageHelper\.viewportVariantUrl\(value\)/.test(overrides) && /imageHelperReady\.then\(applyBackground\)/.test(overrides),
  'site-overrides background slots wait for the viewport sized helper');

// ---- homepage wordmark: a valid LCP candidate on first paint --------------------
{
  const rule = indexHtml.match(/\.hero-wordmark \{[^}]*\}/);
  assert(rule && /animation: wordmarkIn [^;]*;/.test(rule[0]) && !/animation: wordmarkIn[^;]*backwards/.test(rule[0]), 'wordmark entrance has no backwards fill');
  const keyframes = indexHtml.match(/@keyframes wordmarkIn \{[\s\S]*?\n\}/);
  assert(keyframes && !/opacity/.test(keyframes[0]), 'wordmark entrance never hides the LCP image (no opacity)');
}

// ---- background texture: sized variants with the original as fallback ----------
for (const file of ['uploads/variants/bg-otra-black-texture-800.webp', 'uploads/variants/bg-otra-black-texture-1600.webp']) {
  assert(existsSync(new URL(`../${file}`, import.meta.url)), `${file} exists`);
}
for (const page of ['event.html', 'index.html', 'rnb.html', 'clearboat.html']) {
  const html = read(page);
  const body = html.match(/\nbody \{[^}]*\}/);
  const fallback = body && body[0].indexOf('url("uploads/BG_Otra_Black_Texture.webp")');
  const imageSet = body && body[0].indexOf('image-set(url("uploads/variants/bg-otra-black-texture-800.webp") 1x, url("uploads/variants/bg-otra-black-texture-1600.webp") 2x)');
  assert(body && fallback >= 0 && imageSet > fallback, `${page} body background uses image-set after the original fallback`);
  assert(body && /-webkit-image-set\(/.test(body[0]), `${page} keeps the -webkit-image-set form for older Safari`);
}

if (failures.length) {
  console.error('check-responsive-image FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('check-responsive-image OK');
