// Oracle: homepage and All Events cards use the same first/hero photo that is
// visible on the event detail page, never a story, video, band, or gallery image.
// Run: node scripts/check-homepage-hero-image.mjs

import { buildPublishedSiteEvents, dedupeEvents, eventCardImage } from '../functions/_lib/homepage-feed.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const projects = {
  'site-event:draft-explicit-hero': {
    id: 'draft-explicit-hero',
    title: 'Explicit Hero Event',
    status: 'published',
    startDate: '2999-01-01T12:00:00-04:00',
    image: '/images/base-event.jpg',
  },
  'site-event:draft-legacy': {
    id: 'draft-legacy',
    title: 'Legacy Event',
    status: 'published',
    startDate: '2999-01-02T12:00:00-04:00',
    image: '/images/base-legacy.jpg',
  },
  'site-event:draft-story-only': {
    id: 'draft-story-only',
    title: 'Story Only Override',
    status: 'published',
    startDate: '2999-01-03T12:00:00-04:00',
    image: '/images/base-story-event.jpg',
  },
  'site-event:draft-bound-stale': {
    id: 'draft-bound-stale',
    otraGuideId: '6830',
    title: 'Published Draft With Stale Image',
    status: 'published',
    isPerennial: true,
    startDate: '2999-01-04T12:00:00-04:00',
    image: '/images/third-photo-captured-at-bind.jpg',
  },
};

const overrides = {
  'event:draft-explicit-hero': {
    // Reproduces the bug: a legacy/global image points at the third photo,
    // while the detail page's explicit field changes the visible first photo.
    image: '/images/third-photo.jpg',
    fields: {
      'image:#evStoryImg': { type: 'image', value: '/images/second-photo.jpg' },
      'image:#evPhotoBandImg': { type: 'image', value: '/images/third-photo.jpg' },
      'image:#evHeroImg': { type: 'image', value: '/images/first-hero.jpg' },
    },
  },
  'event:draft-legacy': {
    image: '/images/legacy-hero.jpg',
    fields: {
      'image:#evStoryImg': { type: 'image', value: '/images/legacy-story.jpg' },
    },
  },
  'event:draft-story-only': {
    fields: {
      'image:#evStoryImg': { type: 'image', value: '/images/story-only.jpg' },
      'image:#evVideoImg': { type: 'image', value: '/images/video-poster.jpg' },
      'image:#evPhotoBandImg': { type: 'image', value: '/images/third-gallery.jpg' },
    },
  },
};

const kv = {
  async list({ prefix }) {
    return {
      keys: prefix === 'site-event:' ? Object.keys(projects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return projects[key] || overrides[key] || null;
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/events/details/6830/')) {
    return new Response(JSON.stringify({
      id: 6830,
      full_web_image_url: '/images/current-first-detail-hero.jpg',
      half_web_image_url: '/images/third-photo-captured-at-bind.jpg',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};
const events = await buildPublishedSiteEvents({ OVERRIDES: kv, OTRA_API_URL: 'https://mock.invalid/api' });
globalThis.fetch = originalFetch;
const byId = new Map(events.map((event) => [String(event.id), event]));

assert(
  byId.get('draft-explicit-hero')?.img === '/images/first-hero.jpg',
  'an explicit detail hero must beat the legacy third-photo value regardless of field order'
);
assert(
  byId.get('draft-legacy')?.img === '/images/legacy-hero.jpg',
  'a legacy top-level image must remain the card hero when no explicit hero field exists'
);
assert(
  byId.get('draft-story-only')?.img === '/images/base-story-event.jpg',
  'story/video/band fields must never replace the event base hero on a card'
);
assert(
  byId.get('6830')?.img === '/images/current-first-detail-hero.jpg',
  'a bound perennial draft must refresh its bind-time image from the same current detail hero source'
);
assert(
  eventCardImage({
    id: 6832,
    full_web_image_url: '/images/first-hero.jpg',
    half_web_image_url: '/images/third-photo.jpg',
    card_image_url: '/images/another-gallery-photo.jpg',
  }) === '/images/first-hero.jpg',
  'Otra Guide full/first photo must beat half/card fields that may point at later gallery positions'
);
assert(
  eventCardImage({ id: 9000, half_web_image_url: '/images/half-fallback.jpg' }) === '/images/half-fallback.jpg',
  'the half image must remain a fallback when an event has no full hero'
);

const mergedBoundEvent = dedupeEvents([
  {
    id: '6830',
    title: 'Published Draft With Stale Image',
    img: '/images/third-photo-captured-at-bind.jpg',
  },
  {
    id: '6830',
    title: 'Otra Guide title',
    img: '/images/current-first-detail-hero.jpg',
    location: 'Current event location',
  },
])[0];
assert(
  mergedBoundEvent?.img === '/images/current-first-detail-hero.jpg',
  'a bound draft without a hero edit must use the current first detail photo, not its stale bind image'
);
assert(
  mergedBoundEvent?.title === 'Otra Guide title',
  'a bound draft without a title override must use the live Otra Guide title'
);

if (failures.length) {
  console.error('check-homepage-hero-image FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-homepage-hero-image OK (cards mirror detail hero; non-hero fields ignored)');
