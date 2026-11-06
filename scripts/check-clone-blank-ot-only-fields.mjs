// Oracle: POST /admin/api/projects?action=clone honors blankOtOnlyFields.
// Studio sends blankOtOnlyFields: true so OT only fields with no Studio mapping
// start blank, while Guide mapped fields (title, description, image) fill the
// project and design after the existingEventId bind;
// without the flag the clone still copies the source page so it looks identical.
// Exercises the real handler with in-memory KV and a mocked Guide API.
// Run: node scripts/check-clone-blank-ot-only-fields.mjs
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/admin/api/projects.js';
import {
  BLANKED_DESIGN_KEYS,
  blankOtOnlyCloneDesign,
  blankOtOnlyCloneOverride,
  blankOtOnlyMappedDesignFromGuide,
  GUIDE_MAPPED_DESIGN_KEYS,
  wantsBlankOtOnlyFields,
} from '../functions/_lib/clone-blank-ot-only.js';

const originalFetch = globalThis.fetch;
let checked = 0;

function memoryKV(seed = {}) {
  const values = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async list({ prefix = '' } = {}) {
      return { keys: [...values.keys()].filter(n => n.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
    async delete(key) { values.delete(key); },
  };
}

const SOURCE_ID = 'draft-1790000000000-abcd1234';
const fullDesign = () => ({
  title: 'Sunday Social Club - Old', displayTitle: 'Sunday Social Club', subtitle: 'Old edition',
  eyebrow: 'Social · Curaçao', tag: 'Every Sunday', meta: ['Sun', '4 PM'],
  description: 'Old story paragraph.', image: '/override-images/x/hero.jpg', heroKey: 'k', heroName: 'hero.jpg',
  storyImage: '/override-images/x/story.jpg', pullQuote: 'Old quote', storyEyebrow: 'Our story',
  videoImage: '/override-images/x/video.jpg',
  bandImage: '/override-images/x/band.jpg', bandEyebrow: 'Perks', bandTitle: 'What you get', bandText: 'Old perks',
  appreciates: [{ name: 'Drink', description: 'Welcome drink', image: '' }],
  perkLayout: 'cards', sponsorLayout: 'compact',
  sponsorTitle: 'Thanks', sponsorText: 'Old sponsor', sponsorGroups: [{ name: 'Gold', sponsors: 'Old Co' }],
  photoBandImage: '/override-images/x/photo.jpg',
  practicalTitle: 'Before You Go', practicalInfo: [{ key: 'Venue', value: 'Old venue' }],
  ratesTitle: 'Rates', rates: [{ name: 'Entrance', price: '20.00', currency: 'USD', description: '' }],
  galleryImages: ['/override-images/x/g1.jpg'], assets: ['/override-images/x/g1.jpg'],
});
const sourceProject = (extra = {}) => ({
  id: SOURCE_ID, title: 'Sunday Social Club', description: 'Old story paragraph.', source: 'claude-design',
  status: 'draft', createdAt: '2026-01-01T00:00:00Z', image: '/override-images/x/hero.jpg',
  claudeDesign: fullDesign(), teamId: 1, regionId: 1, startDate: '2026-01-04T20:00:00Z',
  endDate: '2026-01-05T01:00:00Z', location: 'Old venue', ticketQuantities: [100], ticketTypeIds: [11],
  otraGuideId: '7514', otraGuideSlug: 'sunday-social-club', ...extra,
});
const sourceOverride = (extra = {}) => ({
  id: SOURCE_ID, pageEditsVersion: 2, description: 'Override story', image: '/override-images/x/o.jpg',
  accentColor: '#aa3366',
  fields: {
    'text:#evStoryText': { type: 'text', value: 'Override story text' },
    'video:#evVideo': { type: 'video', value: '/override-media/x/v.mp4' },
    'remove:#evInfoSection': { type: 'remove', value: true },
  },
  ...extra,
});

const guideTicket = { id: 491, name: 'Entrance', price: '25.00', quantity: 150, description: '', currency: 'USD', isActive: true };
const baseDetail = {
  id: 8800, slug: 'sunday-social-club-nov-9', title: 'Sunday Social Club Nov 9', description: 'New Guide description.',
  start_date: '2026-11-09T20:00:00Z', end_date: '2026-11-10T01:00:00Z', team: { id: 1, name: 'Otra Guide', region: 1 },
  location: 'New venue', full_web_image_url: 'https://cdn.test/new.jpg',
};
let detail = { ...baseDetail };

function mockGuide() {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://backend.test', 'all Guide calls must be mocked');
    const path = url.pathname + url.search;
    if (path === '/api/users/user-role/') return Response.json({ is_staff_or_admin: true });
    if (path.startsWith('/api/otra-tickets/media/event-slug/')) return Response.json({id:Number(path.match(/event-slug\/(\d+)/)[1]),title:'Sunday Social Club - Old',slug:'sunday-social-club'});
    if (path === '/api/users/profile/') return Response.json({ first_name: 'Local', last_name: 'Fixture' });
    if (path === '/api/events/details/8800/') return Response.json(detail);
    if (path === '/api/events/admin-ticketed-search/?id=8800') return Response.json({ events: [{ ...detail, tickets: [guideTicket] }] });
    throw new Error(`Unexpected mock call: ${options.method || 'GET'} ${path}`);
  };
}

async function clone({ kv, id = SOURCE_ID, body }) {
  const env = { OVERRIDES: kv, OTRA_API_URL: 'https://backend.test/api' };
  const response = await onRequestPost({ env, request: new Request(`https://tickets.test/admin/api/projects?action=clone&id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) });
  return { status: response.status, data: await response.json() };
}

const windows = [{ name: 'Entrance', saleStartDate: '2026-11-03', saleEndDate: '2026-11-09', isActive: true }];
const studioBody = (extra = {}) => ({ existingEventId: 8800, title: 'Sunday Social Club Nov 9', ticketSaleWindows: windows, ...extra });

// Bound Studio clones: mapped keys hold the Guide values, everything else blank.
function assertMappedFromGuide(design, label, expected = {
  displayTitle: 'Sunday Social Club Nov 9', description: 'New Guide description.', image: 'https://cdn.test/new.jpg',
}) {
  for (const key of GUIDE_MAPPED_DESIGN_KEYS) {
    assert.equal(design[key], expected[key], `${label}: design.${key} comes from the Guide event`);
  }
}

function assertBlankDesign(design, label, { bound = false } = {}) {
  if (bound) assertMappedFromGuide(design, label);
  else {
    assert.equal(design.displayTitle, '', `${label}: displayTitle must be blank`);
    assert.equal(design.description, '', `${label}: description must be blank`);
    assert.equal(design.image, '', `${label}: image must be blank`);
  }
  for (const key of ['subtitle', 'eyebrow', 'tag', 'storyImage', 'pullQuote', 'storyEyebrow',
    'videoImage', 'bandImage', 'bandEyebrow', 'bandTitle', 'bandText', 'sponsorTitle', 'sponsorText', 'photoBandImage', 'practicalTitle']) {
    assert.equal(design[key], '', `${label}: ${key} must be blank`);
  }
  for (const key of ['meta', 'appreciates', 'sponsorGroups', 'practicalInfo', 'galleryImages', 'assets']) {
    assert.deepEqual(design[key], [], `${label}: ${key} must be empty`);
  }
  assert.equal(design.perkLayout, 'cards', `${label}: perk layout shell kept`);
  assert.equal(design.sponsorLayout, 'compact', `${label}: sponsor layout shell kept`);
  assert.ok(!JSON.stringify(design).includes('Old'), `${label}: no source text may survive`);
}

try {
  mockGuide();

  // Pure helpers.
  assert.equal(wantsBlankOtOnlyFields({ blankOtOnlyFields: true }), true);
  for (const value of [false, 'true', 1, null, undefined]) {
    assert.equal(wantsBlankOtOnlyFields({ blankOtOnlyFields: value }), false, `only boolean true opts in (${value})`);
  }
  assert.equal(wantsBlankOtOnlyFields(null), false);
  assertBlankDesign(blankOtOnlyCloneDesign(fullDesign()), 'helper');
  {
    const mapped = blankOtOnlyMappedDesignFromGuide({ title: 'T', description: '', image: 'https://cdn.test/i.jpg', claudeDesign: blankOtOnlyCloneDesign(fullDesign()) });
    assertMappedFromGuide(mapped.claudeDesign, 'mapped helper', { displayTitle: 'T', description: '', image: 'https://cdn.test/i.jpg' });
    assert.equal(mapped.claudeDesign.bandTitle, '', 'mapped helper leaves OT only keys blank');
    assert.equal(mapped.claudeDesign.perkLayout, 'cards');
  }
  assert.deepEqual(blankOtOnlyCloneDesign(null).rates, [], 'missing design gives empty rates');
  assert.deepEqual(blankOtOnlyCloneOverride(sourceOverride(), 'draft-x'), { accentColor: '#aa3366', id: 'draft-x' });
  assert.equal(blankOtOnlyCloneOverride({ fields: { a: 1 } }, 'draft-x'), null, 'override without style keys is dropped');
  assert.equal(blankOtOnlyCloneOverride(null, 'draft-x'), null);
  assert.ok(BLANKED_DESIGN_KEYS.includes('practicalInfo') && BLANKED_DESIGN_KEYS.includes('appreciates'));
  checked += 1;

  // 1. Studio: flag true, existing override, existingEventId + title bind.
  {
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject(), [`event:${SOURCE_ID}`]: sourceOverride() });
    const { status, data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(status, 201, `blank clone must bind: ${JSON.stringify(data)}`);
    const p = data.project;
    assert.match(p.id, /^draft-\d+-[0-9a-f]{8}$/);
    assert.notEqual(p.id, SOURCE_ID);
    assert.equal(p.otraGuideId, '8800', 'existingEventId binds the clone');
    assert.equal(p.usesExistingOtraGuideEvent, true);
    assert.deepEqual(p.ticketTypeIds, [491]);
    assert.equal(p.title, 'Sunday Social Club Nov 9', 'Guide title binds');
    assert.equal(p.description, 'New Guide description.', 'description comes from the bound Guide event, not the source');
    assert.equal(p.image, 'https://cdn.test/new.jpg', 'hero comes from the bound Guide event');
    assert.equal(p.status, 'draft');
    assert.equal(p.blankOtOnlyFields, true);
    assertBlankDesign(p.claudeDesign, 'studio clone', { bound: true });
    assert.equal(p.claudeDesign.rates[0].price, '25.00', 'rates come from the bound Guide event');
    assert.equal(p.claudeDesign.ratesTitle, 'Rates', 'blank bind keeps the template ratesTitle');
    assert.notEqual(p.claudeDesign.ratesTitle, 'Tickets from Otra Guide', 'blank bind never overwrites ratesTitle');
    const doc = JSON.parse(kv.values.get(`event:${p.id}`));
    assert.deepEqual(doc, { accentColor: '#aa3366', id: p.id }, 'only accent color survives; no fields, video, story or hides');
    const stored = JSON.parse(kv.values.get(`site-event:${p.id}`));
    assert.ok(!JSON.stringify(stored.claudeDesign).includes('Old'), 'stored clone has no source content');
    assertMappedFromGuide(stored.claudeDesign, 'stored studio clone');
    assert.equal(stored.description, 'New Guide description.');
    assert.equal(stored.image, 'https://cdn.test/new.jpg');
    const src = JSON.parse(kv.values.get(`event:${SOURCE_ID}`));
    assert.equal(src.fields['text:#evStoryText'].value, 'Override story text', 'source override untouched');
    checked += 1;
  }

  // 2. Flag true without any source override: no override doc for the clone.
  {
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject() });
    const { status, data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(status, 201);
    assert.equal(kv.values.has(`event:${data.project.id}`), false, 'nothing to copy, nothing written');
    assertBlankDesign(data.project.claudeDesign, 'no override', { bound: true });
    checked += 1;
  }

  // 3. Flag true with override holding no style keys: no override doc.
  {
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject(), [`event:${SOURCE_ID}`]: sourceOverride({ accentColor: '' }) });
    const { data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(kv.values.has(`event:${data.project.id}`), false, 'field edits never copied');
    checked += 1;
  }

  // 4. Flag false and absent: today's behavior, override and design copied.
  for (const extra of [{ blankOtOnlyFields: false }, {}, { blankOtOnlyFields: 'true' }]) {
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject(), [`event:${SOURCE_ID}`]: sourceOverride() });
    const { status, data } = await clone({ kv, body: studioBody(extra) });
    assert.equal(status, 201);
    const p = data.project;
    assert.equal(p.blankOtOnlyFields, undefined, 'default clone is not marked blank');
    assert.equal(p.claudeDesign.bandTitle, 'What you get', 'default clone keeps perks');
    assert.equal(p.claudeDesign.practicalInfo[0].value, 'Old venue', 'default clone keeps Before You Go');
    assert.equal(p.claudeDesign.sponsorText, 'Old sponsor', 'default clone keeps sponsors');
    assert.equal(p.claudeDesign.displayTitle, undefined, 'owned source displayTitle is not retained by an unrelated clone');
    assert.equal(p.claudeDesign.description, 'Old story paragraph.', 'default bind keeps the source design description');
    assert.equal(p.claudeDesign.image, '/override-images/x/hero.jpg', 'default bind keeps the source design image');
    assert.equal(p.claudeDesign.ratesTitle, 'Tickets from Otra Guide', 'default bind keeps today\'s rates heading');
    const doc = JSON.parse(kv.values.get(`event:${p.id}`));
    assert.equal(doc.id, p.id);
    assert.equal(doc.fields['text:#evStoryText'].value, 'Override story text', 'default clone copies override fields');
    assert.equal(doc.fields['video:#evVideo'].value, '/override-media/x/v.mp4', 'default clone copies video');
    assert.equal(doc.pageEditsVersion, undefined, 'merge markers still stripped');
    checked += 1;
  }

  // 5. Live page source (numeric id): the merged live override is not copied.
  {
    const kv = memoryKV({
      [`site-event:${SOURCE_ID}`]: sourceProject({ status: 'published', publishedAt: '2026-01-02T00:00:00Z' }),
      [`event:${SOURCE_ID}`]: sourceOverride(),
      'event:7514': sourceOverride({ id: '7514', draftEditsFrom: SOURCE_ID }),
    });
    const { status, data } = await clone({ kv, id: '7514', body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(status, 201);
    assertBlankDesign(data.project.claudeDesign, 'live source', { bound: true });
    assert.deepEqual(JSON.parse(kv.values.get(`event:${data.project.id}`)), { accentColor: '#aa3366', id: data.project.id });
    checked += 1;
  }

  // 6. ticketSaleWindows still validated with the flag.
  {
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject() });
    let r = await clone({ kv, body: studioBody({ blankOtOnlyFields: true, ticketSaleWindows: undefined }) });
    assert.equal(r.status, 400, 'missing windows must fail');
    assert.match(r.data.error, /confirm ticket sale/i);
    r = await clone({ kv, body: studioBody({ blankOtOnlyFields: true, ticketSaleWindows: [...windows, ...windows] }) });
    assert.equal(r.status, 400, 'one window per Guide TicketType');
    assert.match(r.data.error, /all 1 ticket types/i);
    r = await clone({ kv, body: studioBody({ blankOtOnlyFields: true, ticketSaleWindows: [{ name: 'Entrance', saleStartDate: '2026-11-09', saleEndDate: '2026-11-03', isActive: true }] }) });
    assert.equal(r.status, 400, 'end before start fails');
    r = await clone({ kv, body: studioBody({ blankOtOnlyFields: true, ticketSaleWindows: [{ name: 'Entrance', saleStartDate: '', saleEndDate: '', isActive: false }] }) });
    assert.equal(r.status, 201, 'blank dates allowed with existingEventId');
    assert.equal([...kv.values.keys()].filter(k => k.startsWith('site-event:')).length, 2, 'rejected requests create no draft');
    checked += 1;
  }

  // 7. Guide event with empty description and image: mapped fields stay
  // blank, never the template's content; title still maps.
  {
    detail = { ...baseDetail, description: '', full_web_image_url: '', half_web_image_url: '', card_image_url: '' };
    try {
      const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject(), [`event:${SOURCE_ID}`]: sourceOverride() });
      const { status, data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
      assert.equal(status, 201);
      const p = data.project;
      assert.equal(p.title, 'Sunday Social Club Nov 9');
      assert.equal(p.description, '', 'empty Guide description stays blank');
      assert.equal(p.image, '', 'empty Guide image stays blank');
      assertMappedFromGuide(p.claudeDesign, 'empty guide', { displayTitle: 'Sunday Social Club Nov 9', description: '', image: '' });
      assert.ok(!JSON.stringify(p.claudeDesign).includes('Old'), 'no template content fallback');
    } finally {
      detail = { ...baseDetail };
    }
    checked += 1;
  }

  // 8. Guide image priority: half web then card image when full is missing.
  {
    detail = { ...baseDetail, full_web_image_url: '', half_web_image_url: 'https://cdn.test/half.jpg', card_image_url: 'https://cdn.test/card.jpg' };
    try {
      const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject() });
      const { data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
      assert.equal(data.project.image, 'https://cdn.test/half.jpg');
      assert.equal(data.project.claudeDesign.image, 'https://cdn.test/half.jpg', 'design image follows the same priority');
    } finally {
      detail = { ...baseDetail };
    }
    checked += 1;
  }

  // 9. Blank bind with a template that has no ratesTitle: today's heading.
  {
    const design = fullDesign();
    delete design.ratesTitle;
    const kv = memoryKV({ [`site-event:${SOURCE_ID}`]: sourceProject({ claudeDesign: design }) });
    const { status, data } = await clone({ kv, body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(status, 201);
    assert.equal(data.project.claudeDesign.ratesTitle, 'Tickets from Otra Guide', 'no template heading falls back to today');
    checked += 1;
  }

  // 10. Unknown source.
  {
    const kv = memoryKV();
    const r = await clone({ kv, id: 'draft-0-deadbeef', body: studioBody({ blankOtOnlyFields: true }) });
    assert.equal(r.status, 404);
    checked += 1;
  }

  console.log(`check-clone-blank-ot-only-fields: ${checked} groups passed`);
} catch (error) {
  console.error('check-clone-blank-ot-only-fields FAILED:', error.message);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
