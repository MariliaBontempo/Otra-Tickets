// Oracle: editing a photo on an already-published event re-syncs the photo
// set to Otra Guide; text-only edits, unpublished drafts, existing-event
// drafts and manual pages never trigger the round trip, and a sync failure
// never fails the override save.
// Run: node scripts/check-published-photo-edit-sync.mjs

import { onRequestPut } from '../functions/admin/api/overrides.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function makeKv(records) {
  const store = new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix }) {
      return {
        keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

const bucket = {
  async get() {
    return { arrayBuffer: async () => jpegBytes.buffer.slice(0), httpMetadata: { contentType: 'image/jpeg' } };
  },
};

async function putOverride({ overrideId, project, body, failEndpoint = false }) {
  const kv = makeKv({
    ...(project ? { [`site-event:${project.id}`]: project } : {}),
    [`event:${overrideId}`]: { id: overrideId, image: '', fields: { 'image:#evHeroImg': { type: 'image', value: '/override-images/d/old.jpg' } } },
  });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url.endsWith('/users/user-role/')) return { ok: true, json: async () => ({ is_staff_or_admin: true }) };
    if (url.includes('/otra-tickets/media/event-images/')) {
      if (failEndpoint) return { ok: false, status: 502, json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({ count: 1 }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const response = await onRequestPut({
      request: new Request(`https://otratickets.com/admin/api/overrides?id=${overrideId}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env: { OVERRIDES: kv, OVERRIDE_IMAGES: bucket, OTRA_API_URL: 'https://og.test/api' },
    });
    return { status: response.status, body: await response.json(), photoCalls: calls.filter((c) => c.url.includes('/event-images/')) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const publishedProject = {
  id: 'draft-edit-1',
  status: 'published',
  otraGuideId: '9100',
  usesExistingOtraGuideEvent: false,
  ticketTypeIds: [],
  image: '',
  claudeDesign: { rates: [], galleryImages: [] },
};

const photoEdit = { description: '', image: '', fields: { 'image:#evHeroImg': { type: 'image', value: '/override-images/d/new.jpg' } } };
const textEdit = { description: 'novo texto', image: '', fields: { 'image:#evHeroImg': { type: 'image', value: '/override-images/d/old.jpg' } } };

// 1. photo edit on a published draft (override saved under the draft id) syncs
let result = await putOverride({ overrideId: 'draft-edit-1', project: publishedProject, body: photoEdit });
assert(result.status === 200, 'photo edit save must succeed');
assert(result.photoCalls.length === 1, 'a photo edit on a published draft must re-sync to Otra Guide');
assert(result.photoCalls[0]?.url.includes('/event-images/9100/'), 'the re-sync must target the bound Otra Guide event');

// 2. the editor may save under the Otra Guide event id instead of the draft id
result = await putOverride({ overrideId: '9100', project: publishedProject, body: photoEdit });
assert(result.photoCalls.length === 1, 'overrides saved under the Otra Guide id must re-sync too');

// 3. text-only edits skip the round trip
result = await putOverride({ overrideId: 'draft-edit-1', project: publishedProject, body: textEdit });
assert(result.photoCalls.length === 0, 'text-only edits must not re-upload photos');

// 4. unpublished drafts stay silent (publish will sync later)
result = await putOverride({ overrideId: 'draft-edit-1', project: { ...publishedProject, status: 'draft' }, body: photoEdit });
assert(result.photoCalls.length === 0, 'unpublished drafts must not sync on edit');

// 5. drafts bound to a pre-existing Otra Guide event are never touched
result = await putOverride({
  overrideId: 'draft-edit-1',
  project: { ...publishedProject, usesExistingOtraGuideEvent: true },
  body: photoEdit,
});
assert(result.photoCalls.length === 0, 'existing-event drafts must never have their gallery overwritten');

// 6. manual pages (no project record) are a no-op
result = await putOverride({ overrideId: '424242', project: null, body: photoEdit });
assert(result.photoCalls.length === 0, 'manual pages have no Otra Guide event to sync');

// 7. a sync failure warns but never fails the save
result = await putOverride({ overrideId: 'draft-edit-1', project: publishedProject, body: photoEdit, failEndpoint: true });
assert(result.status === 200, 'a failed re-sync must not fail the override save');
assert(String(result.body.warning || '').includes('photo sync failed'), 'the editor must see the re-sync warning');

if (failures.length) {
  console.error(`check-published-photo-edit-sync: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('check-published-photo-edit-sync: all assertions passed');
