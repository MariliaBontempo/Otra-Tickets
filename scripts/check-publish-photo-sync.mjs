// Oracle: publishing a draft mirrors the ticket page's photos (hero first,
// up to 5, videos excluded) onto the Otra Guide event, and a photo failure
// never blocks the publish itself.
// Run: node scripts/check-publish-photo-sync.mjs

import { collectProjectPhotoUrls, onRequestPost } from '../functions/admin/api/projects.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

// --- collectProjectPhotoUrls behavior ---------------------------------------

const override = {
  image: '/override-images/draft-1/legacy.jpg',
  fields: {
    'image:#evStoryImg': { type: 'image', value: '/override-images/draft-1/story.jpg' },
    'image:#evHeroImg': { type: 'image', value: '/override-images/draft-1/hero.jpg' },
    'image:#evVideoImg': { type: 'image', value: '/override-images/draft-1/clip.mp4' },
    'image:#evBandImg': { type: 'image', value: '/override-images/draft-1/band.jpg' },
  },
};
const project = {
  image: '/override-images/draft-1/hero.jpg',
  claudeDesign: {
    galleryImages: [
      '/override-images/draft-1/hero.jpg',
      '/override-images/draft-1/g1.jpg',
      '/override-images/draft-1/g2.jpg',
      '/override-images/draft-1/g3.jpg',
      '/override-images/draft-1/g4.jpg',
    ],
  },
};

const collected = collectProjectPhotoUrls(override, project);
assert(collected[0] === '/override-images/draft-1/hero.jpg', 'the hero override must come first');
assert(!collected.some((url) => url.endsWith('.mp4')), 'videos must never sync as photos');
assert(new Set(collected).size === collected.length, 'photo urls must be deduplicated');
assert(collected.length === 5, `at most 5 photos sync (got ${collected.length})`);
assert(collected.includes('/override-images/draft-1/story.jpg'), 'override slots must be included');
assert(collected.includes('/override-images/draft-1/g1.jpg'), 'design gallery must fill remaining slots');

const legacyOnly = collectProjectPhotoUrls({ image: '/override-images/draft-2/old.jpg' }, {});
assert(
  legacyOnly.length === 1 && legacyOnly[0] === '/override-images/draft-2/old.jpg',
  'legacy overrides with a single global image must still sync'
);

assert(collectProjectPhotoUrls(null, {}).length === 0, 'no photos means nothing to sync');

// --- publish action wiring ---------------------------------------------------

function makeKv(records) {
  const store = new Map(Object.entries(records));
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(JSON.stringify(value)) : value;
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? JSON.parse(value) : value);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

function makeBucket(objects) {
  return {
    async get(key) {
      const entry = objects[key];
      if (!entry) return null;
      return {
        arrayBuffer: async () => entry.bytes.buffer.slice(0),
        httpMetadata: { contentType: entry.type },
      };
    },
  };
}

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const photoKeys = ['hero.jpg', 'story.jpg', 'band.jpg', 'g1.jpg', 'g2.jpg'];

async function runPublish({ failPhotoEndpoint = false } = {}) {
  const draft = {
    id: 'draft-photos-1',
    title: 'Photo Sync Event',
    status: 'draft',
    otraGuideId: '9001',
    otraGuideSlug: 'photo-sync-event',
    usesExistingOtraGuideEvent: false,
    ticketTypeIds: [],
    ticketQuantities: [],
    image: '/override-images/draft-photos-1/hero.jpg',
    claudeDesign: {
      rates: [],
      galleryImages: photoKeys.slice(1).map((key) => `/override-images/draft-photos-1/${key}`),
    },
  };
  const kv = makeKv({
    'site-event:draft-photos-1': draft,
    'event:draft-photos-1': {
      id: 'draft-photos-1',
      fields: {
        'image:#evHeroImg': { type: 'image', value: '/override-images/draft-photos-1/hero.jpg' },
      },
    },
  });
  const bucket = makeBucket(
    Object.fromEntries(
      photoKeys.map((key) => [`draft-photos-1/${key}`, { bytes: jpegBytes, type: 'image/jpeg' }])
    )
  );

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url.endsWith('/users/user-role/')) {
      return { ok: true, json: async () => ({ is_staff_or_admin: true }) };
    }
    if (url.includes('/otra-tickets/media/event-images/')) {
      if (failPhotoEndpoint) return { ok: false, status: 502, json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({ count: 5 }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const response = await onRequestPost({
      request: new Request('https://otratickets.com/admin/api/projects?action=publish&id=draft-photos-1', {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      }),
      env: { OVERRIDES: kv, OVERRIDE_IMAGES: bucket, OTRA_API_URL: 'https://og.test/api' },
    });
    return { response, body: await response.json(), calls, kv };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ok = await runPublish();
assert(ok.response.status === 200, `publish must succeed (got ${ok.response.status})`);
assert(ok.body.project && ok.body.project.status === 'published', 'draft must be marked published');

const photoCall = ok.calls.find((call) => call.url.includes('/otra-tickets/media/event-images/9001/'));
assert(photoCall, 'publish must call the Otra Guide photo sync endpoint with the event id');
if (photoCall) {
  const form = photoCall.options.body;
  assert(form instanceof FormData, 'photos must be sent as multipart form data');
  const hero = form.get('image');
  const gallery = form.getAll('gallery_images');
  assert(hero && hero.name === 'hero.jpg', 'the hero photo must be the primary image');
  assert(gallery.length === 4, `the remaining photos ride along as gallery (got ${gallery.length})`);
  assert(
    hero && [hero, ...gallery].every((file) => file.type === 'image/jpeg'),
    'photo content types must survive the trip'
  );
}

const failed = await runPublish({ failPhotoEndpoint: true });
assert(failed.response.status === 200, 'a photo sync failure must not block the publish');
assert(failed.body.project.status === 'published', 'the draft still goes live when photos fail');
assert(
  String(failed.body.warning || '').includes('photo sync failed'),
  'the editor must see a photo sync warning'
);

if (failures.length) {
  console.error(`check-publish-photo-sync: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('check-publish-photo-sync: all assertions passed');
