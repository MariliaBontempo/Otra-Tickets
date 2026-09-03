#!/usr/bin/env node
// Oracle: admin rename updates the card/name; the live pretty URL stays frozen.
// A draft renamed before first publish may mint from the new title.
// Run: node scripts/check-admin-rename-slug.mjs

import { onRequestPost } from "../functions/admin/api/projects.js";
import {
  assignUniqueSlugs,
  buildPublishedSiteEvents,
  homepageEventSlugBase,
  projectCardTitle,
} from "../functions/_lib/homepage-feed.js";
import { eventSlug, eventSlugFromTitle, mintFrozenSlug, liveSlugBase } from "../functions/_lib/event-slug.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const SNAP_KEY = "__homepage_feed_snapshot__";
const seedTitle = "Iguana Ride [E-Scooter] Night Tour";
const seedSlug = eventSlug(seedTitle);
const seedImg = "/images/iguana-seed.jpg";

assert(mintFrozenSlug(null) === "", "mintFrozenSlug(null) must be empty");
assert(mintFrozenSlug(undefined) === "", "mintFrozenSlug(undefined) must be empty");
assert(mintFrozenSlug({}) === "", "mintFrozenSlug({}) must be empty");
assert(
  mintFrozenSlug({ title: seedTitle }) === seedSlug,
  "missing frozenSlug mints from the seed / curated title"
);
assert(
  mintFrozenSlug({ title: "Renamed Later", frozenSlug: seedSlug }) === seedSlug,
  "persisted frozenSlug wins over a later title"
);
assert(
  mintFrozenSlug({ title: "Bingo Bengo (clone)" }) === eventSlug("Bingo Bengo"),
  "clone suffix must not be minted into the pretty URL"
);
assert(
  !eventSlugFromTitle("Sunday Social (clone)").includes("clone"),
  "eventSlugFromTitle must strip clone from the title string"
);
assert(
  homepageEventSlugBase(null) === "",
  "homepageEventSlugBase(null) must be empty"
);
assert(
  homepageEventSlugBase({ title: "Bingo Bengo (clone)" }) === eventSlug("Bingo Bengo (clone)"),
  "homepageEventSlugBase on a raw title keeps the pre-4fb799d eventSlug, including clone"
);
assert(
  liveSlugBase({ title: "Sunday Social (clone)" }) === "sunday-social-clone",
  "liveSlugBase for a legacy clone title is eventSlug of that title, not clone-stripped"
);
assert(
  liveSlugBase({
    title: "Brand - Night Tour",
    claudeDesign: { displayTitle: "Brand", subtitle: "Night Tour" },
  }) === "brand",
  "liveSlugBase for Brand - Night Tour with displayTitle Brand stays brand"
);
assert(
  liveSlugBase({ title: seedTitle }) === seedSlug,
  "liveSlugBase for an Iguana seed title stays on the e-scooter slug"
);
assert(
  liveSlugBase({ title: "Renamed Later", frozenSlug: seedSlug }) === seedSlug,
  "liveSlugBase prefers the persisted frozenSlug over a later title"
);

function makeKv(records) {
  const store = new Map(Object.entries(records));
  const deleted = [];
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(JSON.stringify(value)) : value;
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? JSON.parse(value) : value);
    },
    async delete(key) {
      deleted.push(key);
      store.delete(key);
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    store,
    deleted,
  };
}

function staffFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/users/user-role/")) {
      return { ok: true, json: async () => ({ is_staff_or_admin: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    globalThis.fetch = real;
  };
}

async function renameProject(kv, id, name) {
  const restore = staffFetch();
  try {
    const response = await onRequestPost({
      request: new Request(`https://otratickets.com/admin/api/projects?action=rename&id=${id}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(name === undefined ? {} : { name }),
      }),
      env: { OVERRIDES: kv, OTRA_API_URL: "https://og.test/api" },
    });
    return { response, body: await response.json() };
  } finally {
    restore();
  }
}

async function publishProject(kv, id) {
  const restore = staffFetch();
  try {
    const response = await onRequestPost({
      request: new Request(`https://otratickets.com/admin/api/projects?action=publish&id=${id}`, {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      }),
      env: { OVERRIDES: kv, OTRA_API_URL: "https://og.test/api" },
    });
    return { response, body: await response.json() };
  } finally {
    restore();
  }
}

function publishedDraft(overrides = {}) {
  return {
    id: "draft-night",
    title: seedTitle,
    status: "published",
    publishedAt: "2026-08-01T12:00:00.000Z",
    otraGuideId: "6831",
    otraGuideSlug: "6831",
    usesExistingOtraGuideEvent: true,
    startDate: "2999-03-02T12:00:00-04:00",
    image: seedImg,
    ...overrides,
  };
}

// 1. Admin rename of a published site-event: title changes, slug stays.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft(),
    [SNAP_KEY]: { events: [{ id: 6831 }], rows: [], generatedAt: Date.now() },
  });
  const { response, body } = await renameProject(kv, "draft-night", "Night Ride Renamed");
  assert(response.status === 200, `published rename must succeed (got ${response.status})`);
  assert(body.project?.title === "Night Ride Renamed", "published rename must update the card/name title");
  assert(
    body.project?.frozenSlug === seedSlug,
    "published rename must stamp frozenSlug from the pre-rename seed title"
  );
  assert(kv.deleted.includes(SNAP_KEY), "published rename must drop the homepage feed snapshot");

  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Night Ride Renamed", "feed card title must follow the admin rename");
  assert(
    homepageEventSlugBase(site[0]) === seedSlug,
    "homepageEventSlugBase must stay on the pre-rename seed slug after admin rename"
  );
  assert(
    homepageEventSlugBase(site[0]) !== eventSlug("Night Ride Renamed"),
    "admin rename of a published event must not mint a new pretty URL"
  );
}

// Published row that already has frozenSlug: rename must not rewrite it.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({
      title: "Already Renamed Once",
      frozenSlug: seedSlug,
    }),
  });
  const { body } = await renameProject(kv, "draft-night", "Renamed Again");
  assert(body.project?.title === "Renamed Again", "second rename must still update the title");
  assert(body.project?.frozenSlug === seedSlug, "second rename must leave the frozen slug untouched");
}

// 2. Rename before publish: slug may follow the new title.
{
  const draft = publishedDraft({ status: "draft", publishedAt: "", frozenSlug: "" });
  const kv = makeKv({ "site-event:draft-night": draft });
  const renamed = await renameProject(kv, "draft-night", "Brand New Draft Title");
  assert(renamed.response.status === 200, "draft rename must succeed");
  assert(renamed.body.project?.title === "Brand New Draft Title", "draft rename must update the title");
  assert(
    !renamed.body.project?.frozenSlug,
    "rename before first publish must not stamp frozenSlug yet"
  );

  const published = await publishProject(kv, "draft-night");
  assert(published.response.status === 200, `publish after draft rename must succeed (got ${published.response.status})`);
  assert(
    published.body.project?.frozenSlug === eventSlugFromTitle("Brand New Draft Title"),
    "first publish after a draft rename must mint frozenSlug from the new title"
  );
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(
    homepageEventSlugBase(site[0]) === eventSlugFromTitle("Brand New Draft Title"),
    "pretty URL may follow the pre-publish rename because nothing was live yet"
  );
}

// Publish path stamps frozenSlug when missing.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({ status: "draft", publishedAt: "", frozenSlug: "" }),
  });
  const published = await publishProject(kv, "draft-night");
  assert(published.response.status === 200, "publish must succeed so frozenSlug can be observed");
  assert(
    published.body.project?.frozenSlug === seedSlug,
    "publish must stamp frozenSlug from the seed title used for the URL"
  );
}

// Publish must not overwrite an already-frozen slug.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({
      status: "draft",
      publishedAt: "",
      title: "Changed Before Republish",
      frozenSlug: seedSlug,
    }),
  });
  const published = await publishProject(kv, "draft-night");
  assert(
    published.body.project?.frozenSlug === seedSlug,
    "re-publish must keep an already-stamped frozenSlug"
  );
}

// 3. Blank / whitespace name rejected.
{
  const kv = makeKv({ "site-event:draft-night": publishedDraft() });
  const blank = await renameProject(kv, "draft-night", "");
  assert(blank.response.status === 400, "empty name must be rejected");
  assert(blank.body.error === "name is required", "empty name must return name is required");
  const spaces = await renameProject(kv, "draft-night", "   ");
  assert(spaces.response.status === 400, "whitespace-only name must be rejected");
  const missing = await renameProject(kv, "draft-night", undefined);
  assert(missing.response.status === 400, "missing name must be rejected");
  const stored = await kv.get("site-event:draft-night", "json");
  assert(stored.title === seedTitle, "rejected rename must not change the stored title");
}

// 4. text:#evTitle still wins the card title; slug stays frozen.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({ frozenSlug: seedSlug, title: "Admin Card Name" }),
    "event:draft-night": {
      fields: { "text:#evTitle": { type: "text", value: "Tickets H1 Wins" } },
    },
  });
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Tickets H1 Wins", "text:#evTitle must win the card title");
  assert(homepageEventSlugBase(site[0]) === seedSlug, "text:#evTitle must not thaw the frozen slug");
}

// 5. Django title change does not change slug.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({
      frozenSlug: seedSlug,
      isPerennial: true,
      title: seedTitle,
    }),
  });
  const djangoTitle = "Iguana Scooter Ride - Night Tour";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/events/details/6831/")) {
      return new Response(JSON.stringify({
        id: 6831,
        title: djangoTitle,
        full_web_image_url: "/images/iguana-live.jpg",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  let site;
  try {
    site = await buildPublishedSiteEvents({
      OVERRIDES: kv,
      OTRA_API_URL: "https://mock.invalid/api",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(site[0]?.title === djangoTitle, "bound perennial card may show the live Django title");
  assert(homepageEventSlugBase(site[0]) === seedSlug, "Django title change must not change the frozen slug");
  assert(
    homepageEventSlugBase(site[0]) !== eventSlug(djangoTitle),
    "slug must not move onto the live Django title"
  );
}

// 6. Shared displayTitle is not the card title; two Iguanas stay distinguishable.
{
  const nightSeed = "Iguana Ride [E-Scooter] Night Tour";
  const sunsetSeed = "Iguana Ride [E-Scooter] Sunset Tour";
  const brand = "Iguana Ride Curaçao";
  const kv = makeKv({
    "site-event:draft-night": {
      id: "draft-night",
      otraGuideId: 6831,
      title: nightSeed,
      status: "published",
      isPerennial: true,
      startDate: "2999-03-07T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: brand },
    },
    "site-event:draft-sunset": {
      id: "draft-sunset",
      otraGuideId: 6832,
      title: sunsetSeed,
      status: "published",
      isPerennial: true,
      startDate: "2999-03-08T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: brand },
    },
  });
  const nightDjango = "Iguana Scooter Ride - Night Tour";
  const sunsetDjango = "Iguana Scooter Ride - Sunset Tour";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/events/details/6831/")) {
      return new Response(JSON.stringify({ id: 6831, title: nightDjango, full_web_image_url: seedImg }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href.endsWith("/events/details/6832/")) {
      return new Response(JSON.stringify({ id: 6832, title: sunsetDjango, full_web_image_url: seedImg }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };
  let site;
  try {
    site = await buildPublishedSiteEvents({
      OVERRIDES: kv,
      OTRA_API_URL: "https://mock.invalid/api",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const byId = new Map(site.map((event) => [String(event.id), event]));
  assert(byId.get("6831")?.title === nightDjango, "Night card must show Django, not the shared brand");
  assert(byId.get("6832")?.title === sunsetDjango, "Sunset card must show Django, not the shared brand");
  assert(
    byId.get("6831")?.title !== brand && byId.get("6832")?.title !== brand,
    "shared displayTitle must not become either card title"
  );
  assert(byId.get("6831")?.title !== byId.get("6832")?.title, "two Iguanas must stay distinguishable");
  assert(homepageEventSlugBase(byId.get("6831")) === eventSlug(nightSeed), "Night slug stays on the e-scooter seed");
  assert(homepageEventSlugBase(byId.get("6832")) === eventSlug(sunsetSeed), "Sunset slug stays on the e-scooter seed");
}

// 7. Two same-title events: oldest keeps the clean slug, newer gets a date suffix.
{
  const events = [
    { id: 200, title: "Sunday Social", date: "2026-09-06T17:00:00-04:00" },
    { id: 100, title: "Sunday Social", date: "2026-08-23T17:00:00-04:00" },
  ];
  assignUniqueSlugs(events);
  const older = events.find((event) => event.id === 100);
  const newer = events.find((event) => event.id === 200);
  assert(older?.slug === "sunday-social", "oldest same-title event keeps the clean slug");
  assert(newer?.slug === "sunday-social-sep-6", "newer same-title event gets a date suffix");
  assert(!newer?.slug.includes("clone"), "date-suffix slug must not contain clone");
}

{
  const kv = makeKv({
    "site-event:draft-old": {
      id: "draft-old",
      otraGuideId: 100,
      title: "Sunday Social",
      status: "published",
      startDate: "2026-08-23T17:00:00-04:00",
      image: seedImg,
    },
    "site-event:draft-clone": {
      id: "draft-clone",
      otraGuideId: 200,
      title: "Sunday Social (clone)",
      frozenSlug: "sunday-social",
      status: "published",
      startDate: "2026-09-06T17:00:00-04:00",
      image: seedImg,
    },
  });
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assignUniqueSlugs(site);
  const older = site.find((event) => String(event.id) === "100");
  const cloned = site.find((event) => String(event.id) === "200");
  assert(homepageEventSlugBase(older) === "sunday-social", "oldest site-event keeps the clean sunday-social slug");
  assert(
    homepageEventSlugBase(cloned) === "sunday-social",
    "clone title must slug to the same base as the original, without the word clone"
  );
  assert(!String(cloned?.slug || "").includes("clone"), "assigned unique slug must never contain clone");
  assert(older?.slug === "sunday-social", "oldest assigned slug stays clean");
  assert(cloned?.slug === "sunday-social-sep-6", "clone with the same title gets the date suffix");
}

// 9. Title-only override keeps img.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({ frozenSlug: seedSlug }),
    "event:draft-night": {
      fields: { "text:#evTitle": { type: "text", value: "Title Only" } },
    },
  });
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Title Only", "title-only override must change the card title");
  assert(site[0]?.img === seedImg, "title-only override must keep the existing card image");
  assert(homepageEventSlugBase(site[0]) === seedSlug, "title-only override must keep the frozen slug");
}

// Old published Iguana rows with no frozen field stay on the e-scooter slug.
{
  const kv = makeKv({
    "site-event:draft-legacy": {
      id: "draft-legacy",
      otraGuideId: 6831,
      title: seedTitle,
      status: "published",
      isPerennial: true,
      startDate: "2999-03-02T12:00:00-04:00",
      image: seedImg,
    },
  });
  const djangoTitle = "Iguana Scooter Ride - Night Tour";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/events/details/6831/")) {
      return new Response(JSON.stringify({
        id: 6831,
        title: djangoTitle,
        full_web_image_url: "/images/iguana-live.jpg",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  let site;
  try {
    site = await buildPublishedSiteEvents({
      OVERRIDES: kv,
      OTRA_API_URL: "https://mock.invalid/api",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(
    homepageEventSlugBase(site[0]) === seedSlug,
    "old published Iguana without frozenSlug must implicitly freeze on the seed e-scooter title"
  );
  assert(
    homepageEventSlugBase(site[0]) !== eventSlug(djangoTitle),
    "old published Iguana must not switch to the Django slug"
  );
}

// Legacy Sunday Social (clone) without frozenSlug stays sunday-social-clone.
{
  const kv = makeKv({
    "site-event:draft-clone-legacy": {
      id: "draft-clone-legacy",
      otraGuideId: 201,
      title: "Sunday Social (clone)",
      status: "published",
      startDate: "2026-09-13T17:00:00-04:00",
      image: seedImg,
    },
  });
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assignUniqueSlugs(site);
  assert(
    homepageEventSlugBase(site[0]) === "sunday-social-clone",
    "legacy Sunday Social (clone) without frozenSlug must stay sunday-social-clone"
  );
  assert(
    homepageEventSlugBase(site[0]) !== "sunday-social",
    "legacy Sunday Social (clone) must not remint to the clone-stripped sunday-social"
  );
  assert(site[0]?.slug === "sunday-social-clone", "assigned legacy clone slug stays sunday-social-clone");
}

// Legacy Brand - Night Tour + displayTitle Brand without frozenSlug stays brand.
{
  const kv = makeKv({
    "site-event:draft-brand": {
      id: "draft-brand",
      otraGuideId: 8801,
      title: "Brand - Night Tour",
      status: "published",
      startDate: "2999-04-01T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: "Brand", subtitle: "Night Tour" },
    },
  });
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Brand - Night Tour", "Brand card must show the event-specific title, not displayTitle");
  assert(site[0]?.title !== "Brand", "shared displayTitle Brand must stay off the card");
  assert(
    homepageEventSlugBase(site[0]) === "brand",
    "legacy Brand - Night Tour + displayTitle Brand without frozenSlug stays brand"
  );
  assert(
    homepageEventSlugBase(site[0]) !== "brand-night-tour",
    "legacy Brand row must not remint from project.title"
  );
  assert(
    projectCardTitle({
      title: "Brand - Night Tour",
      claudeDesign: { displayTitle: "Brand", subtitle: "Night Tour" },
    }) === "Brand - Night Tour",
    "projectCardTitle must not collapse displayTitle - subtitle into the shared brand"
  );
}

// Published rename of a legacy clone stamps the live sunday-social-clone base.
{
  const kv = makeKv({
    "site-event:draft-clone-rename": {
      id: "draft-clone-rename",
      title: "Sunday Social (clone)",
      status: "published",
      publishedAt: "2026-08-01T12:00:00.000Z",
      otraGuideId: "202",
      otraGuideSlug: "202",
      usesExistingOtraGuideEvent: true,
      startDate: "2026-09-13T17:00:00-04:00",
      image: seedImg,
    },
  });
  const { body } = await renameProject(kv, "draft-clone-rename", "Sunday Social Renamed");
  assert(body.project?.title === "Sunday Social Renamed", "legacy clone rename must update the title");
  assert(
    body.project?.frozenSlug === "sunday-social-clone",
    "published rename of a legacy clone must stamp the pre-rename live base sunday-social-clone"
  );
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Sunday Social Renamed", "feed card title follows the rename");
  assert(
    homepageEventSlugBase(site[0]) === "sunday-social-clone",
    "feed slug stays on the pre-rename live base after the rename stamp"
  );
}

// Published rename of a legacy Brand row stamps brand, not brand-night-tour.
{
  const kv = makeKv({
    "site-event:draft-brand-rename": {
      id: "draft-brand-rename",
      title: "Brand - Night Tour",
      status: "published",
      publishedAt: "2026-08-01T12:00:00.000Z",
      otraGuideId: "8802",
      otraGuideSlug: "8802",
      usesExistingOtraGuideEvent: true,
      startDate: "2999-04-02T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: "Brand", subtitle: "Night Tour" },
    },
  });
  const { body } = await renameProject(kv, "draft-brand-rename", "Brand Night Renamed");
  assert(body.project?.frozenSlug === "brand", "published rename of a legacy Brand row stamps the live brand base");
  const site = await buildPublishedSiteEvents({ OVERRIDES: kv });
  assert(site[0]?.title === "Brand Night Renamed", "Brand rename updates the card title");
  assert(homepageEventSlugBase(site[0]) === "brand", "Brand feed slug stays brand after the rename stamp");
}

// Later publish of a legacy Sunday Social (clone) stamps the live base.
{
  const kv = makeKv({
    "site-event:draft-clone-republish": {
      id: "draft-clone-republish",
      title: "Sunday Social (clone)",
      status: "published",
      publishedAt: "2026-08-01T12:00:00.000Z",
      otraGuideId: "203",
      otraGuideSlug: "203",
      usesExistingOtraGuideEvent: true,
      startDate: "2026-09-13T17:00:00-04:00",
      image: seedImg,
    },
  });
  const published = await publishProject(kv, "draft-clone-republish");
  assert(published.response.status === 200, `legacy clone later publish must succeed (got ${published.response.status})`);
  assert(
    published.body.project?.frozenSlug === "sunday-social-clone",
    "later publish of a legacy Sunday Social (clone) must stamp sunday-social-clone"
  );
  assert(
    published.body.project?.frozenSlug !== "sunday-social",
    "later publish of a legacy clone must not remint to sunday-social"
  );
}

// Later publish of a legacy Brand row stamps brand, not brand-night-tour.
{
  const kv = makeKv({
    "site-event:draft-brand-republish": {
      id: "draft-brand-republish",
      title: "Brand - Night Tour",
      status: "published",
      publishedAt: "2026-08-01T12:00:00.000Z",
      otraGuideId: "8803",
      otraGuideSlug: "8803",
      usesExistingOtraGuideEvent: true,
      startDate: "2999-04-03T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: "Brand", subtitle: "Night Tour" },
    },
  });
  const published = await publishProject(kv, "draft-brand-republish");
  assert(published.response.status === 200, `legacy Brand later publish must succeed (got ${published.response.status})`);
  assert(
    published.body.project?.frozenSlug === "brand",
    "later publish of a legacy Brand row must stamp the live brand base"
  );
  assert(
    published.body.project?.frozenSlug !== "brand-night-tour",
    "later publish of a legacy Brand row must not remint to brand-night-tour"
  );
}

// Homepage row with status published and no publishedAt still stamps liveSlugBase.
{
  const kv = makeKv({
    "site-event:draft-home-republish": {
      id: "draft-home-republish",
      title: "Sunday Social (clone)",
      status: "published",
      publishedAt: "",
      otraGuideId: "204",
      otraGuideSlug: "204",
      usesExistingOtraGuideEvent: true,
      startDate: "2026-09-20T17:00:00-04:00",
      image: seedImg,
    },
  });
  const published = await publishProject(kv, "draft-home-republish");
  assert(
    published.body.project?.frozenSlug === "sunday-social-clone",
    "a homepage row with status published and no publishedAt must stamp sunday-social-clone"
  );
}

// Later publish of a published row that already has frozenSlug does not overwrite.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({
      title: "Changed After Going Live",
      frozenSlug: seedSlug,
    }),
  });
  const published = await publishProject(kv, "draft-night");
  assert(
    published.body.project?.frozenSlug === seedSlug,
    "later publish must keep an already stamped frozenSlug"
  );
}

// Clone clears frozenSlug; first publish of the clone mints without the word clone.
{
  const kv = makeKv({
    "site-event:draft-night": publishedDraft({ frozenSlug: seedSlug, title: "Sunday Social" }),
  });
  const restore = staffFetch();
  let cloneBody;
  let cloneResponse;
  try {
    cloneResponse = await onRequestPost({
      request: new Request("https://otratickets.com/admin/api/projects?action=clone&id=draft-night", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          ticketSaleWindows: [
            { name: "General Admission", saleStartDate: "2026-09-03", saleEndDate: "2026-09-20", isActive: true },
          ],
        }),
      }),
      env: { OVERRIDES: kv, OTRA_API_URL: "https://og.test/api" },
    });
    cloneBody = await cloneResponse.json();
  } finally {
    restore();
  }
  assert(
    cloneResponse.status === 201 || cloneResponse.status === 202,
    `clone must persist a draft (got ${cloneResponse.status})`
  );
  const cloneProject = cloneBody.project;
  assert(cloneProject && cloneProject.id, "clone must return a project");
  assert(!cloneProject.frozenSlug, "clone must clear frozenSlug");
  assert(
    String(cloneProject.title || "").toLowerCase().includes("clone"),
    "default clone title still carries the clone marker"
  );
  const cloneId = cloneProject.id;
  const stored = await kv.get(`site-event:${cloneId}`, "json");
  stored.otraGuideId = "9099";
  stored.otraGuideSlug = "9099";
  stored.usesExistingOtraGuideEvent = true;
  stored.frozenSlug = "";
  await kv.put(`site-event:${cloneId}`, JSON.stringify(stored));
  const published = await publishProject(kv, cloneId);
  assert(published.response.status === 200, `clone first publish must succeed (got ${published.response.status})`);
  assert(published.body.project?.frozenSlug, "clone first publish must mint frozenSlug");
  assert(
    !String(published.body.project.frozenSlug).includes("clone"),
    "new mint after clone must never contain the word clone"
  );
}

if (failures.length) {
  console.error("check-admin-rename-slug FAILED:");
  failures.forEach((failure) => console.error(" - " + failure));
  process.exit(1);
}

console.log("check-admin-rename-slug OK (published rename freezes URL; draft rename may remint; clone stays out of slugs)");
