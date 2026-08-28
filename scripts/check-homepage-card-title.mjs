#!/usr/bin/env node
// Oracle: homepage card titles stay distinguishable; pretty URLs stay frozen.
//   1. text:#evTitle when an admin renamed the H1
//   2. else the live Django title for bound perennials
//   3. else projectCardTitle / curated title
// design.displayTitle is event-page H1 / brand copy, never a card title
// (sibling Iguana / Clearboat events share one brand line).
// Pretty URL stays on the curated / seed title already live
// (iguana-ride-e-scooter-..., bingo-bengo-sep-6). Never rebuild from Django.
// Run: node scripts/check-homepage-card-title.mjs

import {
  applyOverrides,
  buildPublishedSiteEvents,
  dedupeEvents,
  homepageEventSlugBase,
  homepageOverrideTitle,
} from "../functions/_lib/homepage-feed.js";
import { eventSlug } from "../functions/_lib/event-slug.js";
import { onRequestPut } from "../functions/admin/api/overrides.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

assert(
  homepageOverrideTitle({
    fields: { "text:#evTitle": { type: "text", value: "  New Tour Name  " } },
  }) === "New Tour Name",
  "homepageOverrideTitle must return the trimmed text:#evTitle value"
);
assert(
  homepageOverrideTitle({
    fields: { "text:#evTitle": { type: "text", value: "   " } },
  }) === "",
  "blank text:#evTitle must be ignored"
);
assert(
  homepageOverrideTitle({
    fields: { "text:#evOther": { type: "text", value: "Nope" } },
  }) === "",
  "unrelated text fields must not become the card title"
);
assert(homepageOverrideTitle(null) === "", "null override must yield empty title");
assert(homepageOverrideTitle({}) === "", "override without fields must yield empty title");
assert(
  homepageOverrideTitle({
    fields: { "text:#evTitle": { type: "image", value: "/images/not-a-title.jpg" } },
  }) === "",
  "homepageOverrideTitle must return empty when field.type is not text"
);
assert(
  homepageOverrideTitle({
    fields: { "text:#evTitle": { type: "text", value: 42 } },
  }) === "",
  "homepageOverrideTitle must return empty when field.value is a number"
);
assert(
  homepageOverrideTitle({
    fields: { "text:#evTitle": { type: "text", value: { title: "Nope" } } },
  }) === "",
  "homepageOverrideTitle must return empty when field.value is an object"
);
assert(
  homepageOverrideTitle({
    fields: [{ type: "text", value: "Array Title" }],
  }) === "",
  "homepageOverrideTitle must return empty when fields is an array"
);

const projects = {
  "site-event:draft-renamed": {
    id: "draft-renamed",
    title: "Original Tour Name",
    status: "published",
    startDate: "2999-02-01T12:00:00-04:00",
    image: "/images/tour.jpg",
  },
  "site-event:draft-plain": {
    id: "draft-plain",
    title: "Unchanged Tour",
    status: "published",
    startDate: "2999-02-02T12:00:00-04:00",
    image: "/images/plain.jpg",
  },
};

const overrides = {
  "event:draft-renamed": {
    fields: {
      "text:#evTitle": { type: "text", value: "Renamed Tour Card" },
      "image:#evHeroImg": { type: "image", value: "/images/renamed-hero.jpg" },
    },
  },
  "event:6113": {
    fields: {
      "text:#evTitle": { type: "text", value: "Clearboat West Renamed" },
    },
  },
};

const kv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(projects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return projects[key] || overrides[key] || null;
  },
};

const siteEvents = await buildPublishedSiteEvents({ OVERRIDES: kv });
const byId = new Map(siteEvents.map((event) => [String(event.id), event]));

assert(
  byId.get("draft-renamed")?.title === "Renamed Tour Card",
  "published site-event cards must follow text:#evTitle when present"
);
assert(
  byId.get("draft-plain")?.title === "Unchanged Tour",
  "cards without text:#evTitle must keep the curated project title"
);
assert(
  byId.get("draft-renamed")?.img === "/images/renamed-hero.jpg",
  "title override must not break the existing hero image override path"
);

const djangoEvents = [
  { id: 6113, title: "Clearboat West", img: "/images/clearboat.jpg" },
  { id: 9001, title: "No Override Event", img: "/images/other.jpg" },
];
const applied = await applyOverrides(djangoEvents, { OVERRIDES: kv });
const appliedById = new Map(applied.map((event) => [String(event.id), event]));

assert(
  appliedById.get("6113")?.title === "Clearboat West Renamed",
  "Django feed cards must follow text:#evTitle via applyOverrides"
);
assert(
  appliedById.get("9001")?.title === "No Override Event",
  "Django cards without an override must keep their feed title"
);

assert(
  appliedById.get("6113")?.title === "Clearboat West Renamed",
  "renamed display title must be visible on the card"
);
assert(
  homepageEventSlugBase(appliedById.get("6113")) === eventSlug("Clearboat West"),
  "slug must stay rooted in the pre-override Django title"
);
assert(
  homepageEventSlugBase(byId.get("draft-renamed")) === eventSlug("Original Tour Name"),
  "site-event slug must stay rooted in the curated title when text:#evTitle renames the card"
);
assert(
  homepageEventSlugBase(byId.get("draft-plain")) === eventSlug("Unchanged Tour"),
  "unchanged cards keep slug from their display title"
);

const legacyKv = {
  async get(key) {
    if (key === "override:6114") {
      return {
        fields: {
          "text:#evTitle": { type: "text", value: "Legacy Key Renamed" },
        },
      };
    }
    return null;
  },
};
const legacyApplied = await applyOverrides(
  [{ id: 6114, title: "Legacy Original", img: "/images/legacy.jpg" }],
  { OVERRIDES: legacyKv }
);
assert(
  legacyApplied[0]?.title === "Legacy Key Renamed",
  "applyOverrides must follow text:#evTitle from the legacy override:<id> key when event:<id> is missing"
);

const titleOnlyKv = {
  async get(key) {
    if (key === "event:6115") {
      return {
        fields: {
          "text:#evTitle": { type: "text", value: "Title Only Rename" },
        },
      };
    }
    return null;
  },
};
const titleOnlyApplied = await applyOverrides(
  [{ id: 6115, title: "Keep Image Event", img: "/images/keep-me.jpg" }],
  { OVERRIDES: titleOnlyKv }
);
assert(
  titleOnlyApplied[0]?.title === "Title Only Rename",
  "applyOverrides with only a title override must change the card title"
);
assert(
  titleOnlyApplied[0]?.img === "/images/keep-me.jpg",
  "applyOverrides with only a title override must keep the existing card image"
);

const seedTitle = "Iguana Ride [E-Scooter] Punda or Otrobanda Tour";
const djangoTitle = "Iguana Scooter Ride - Punda or Otrobanda Tour";
const seedImg = "/images/iguana-seed.jpg";
const djangoImg = "/images/iguana-live.jpg";

const [boundNoOverride] = dedupeEvents([
  { id: 6830, title: seedTitle, img: seedImg },
  { id: 6830, title: djangoTitle, img: djangoImg },
]);
assert(
  boundNoOverride?.title === djangoTitle,
  "bound site-event without text:#evTitle / displayTitle must take the Django title"
);
assert(
  boundNoOverride?.img === djangoImg,
  "refreshing a bound title from Django must still refresh img when there is no hero override"
);

const evTitleProjects = {
  "site-event:draft-prod-6830": {
    id: "draft-prod-6830",
    otraGuideId: 6830,
    title: seedTitle,
    status: "published",
    startDate: "2999-03-01T12:00:00-04:00",
    image: seedImg,
  },
};
const evTitleOverrides = {
  "event:draft-prod-6830": {
    fields: {
      "text:#evTitle": { type: "text", value: "Admin Renamed Iguana" },
    },
  },
};
const evTitleKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(evTitleProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return evTitleProjects[key] || evTitleOverrides[key] || null;
  },
};
const evTitleSite = await buildPublishedSiteEvents({ OVERRIDES: evTitleKv });
const [evTitleKept] = dedupeEvents([
  ...evTitleSite,
  { id: 6830, title: djangoTitle, img: djangoImg },
]);
assert(
  evTitleKept?.title === "Admin Renamed Iguana",
  "text:#evTitle must win over the Django title"
);
assert(
  evTitleKept?.img === djangoImg,
  "title-only override must still keep (and refresh) img when there is no hero override"
);
assert(
  homepageEventSlugBase(evTitleKept) === eventSlug(seedTitle),
  "after text:#evTitle rename, pretty URL must stay on the seed e-scooter slug"
);
assert(
  homepageEventSlugBase(evTitleKept) !== eventSlug(djangoTitle),
  "renamed bound card must not move the slug onto the live Django title"
);

const displayProjects = {
  "site-event:draft-prod-6831": {
    id: "draft-prod-6831",
    otraGuideId: 6831,
    title: "Iguana Ride [E-Scooter] Night Tour",
    status: "published",
    startDate: "2999-03-02T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: "Night Ride Display Title" },
  },
};
const displayKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(displayProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return displayProjects[key] || null;
  },
};
const displaySite = await buildPublishedSiteEvents({ OVERRIDES: displayKv });
const [displayKept] = dedupeEvents([
  ...displaySite,
  { id: 6831, title: "Iguana Scooter Ride Night Tour", img: djangoImg },
]);
assert(
  displayKept?.title === "Iguana Scooter Ride Night Tour",
  "design.displayTitle must not replace the Django / curated card title"
);
assert(
  displayKept?.title !== "Night Ride Display Title",
  "shared design.displayTitle must stay off the homepage card"
);

const unboundProjects = {
  "site-event:draft-unbound": {
    id: "draft-unbound",
    title: "Local Draft Only",
    status: "published",
    startDate: "2999-03-03T12:00:00-04:00",
    image: seedImg,
  },
};
const unboundKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(unboundProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return unboundProjects[key] || null;
  },
};
const unboundSite = await buildPublishedSiteEvents({ OVERRIDES: unboundKv });
assert(
  unboundSite[0]?.title === "Local Draft Only",
  "unbound site-event with no numeric otraGuideId must keep project.title"
);

const renamedAfterDedupeKv = {
  async get(key) {
    if (key === "event:6830") {
      return {
        fields: {
          "text:#evTitle": { type: "text", value: "Card Renamed After Dedupe" },
        },
      };
    }
    return null;
  },
};
const renamedAfterDedupe = await applyOverrides([boundNoOverride], { OVERRIDES: renamedAfterDedupeKv });
assert(
  renamedAfterDedupe[0]?.title === "Card Renamed After Dedupe",
  "applyOverrides text:#evTitle must still win after Django title refresh"
);
assert(
  homepageEventSlugBase(renamedAfterDedupe[0]) === eventSlug(seedTitle),
  "applyOverrides rename after dedupe must keep the seed e-scooter slug"
);
assert(
  homepageEventSlugBase(renamedAfterDedupe[0]) !== eventSlug(djangoTitle),
  "applyOverrides rename after dedupe must not move the slug onto Django"
);
assert(
  renamedAfterDedupe[0]?.img === djangoImg,
  "applyOverrides title-only rename after dedupe must keep img"
);

const perennialProjects = {
  "site-event:draft-prod-6830-live": {
    id: "draft-prod-6830-live",
    otraGuideId: 6830,
    title: seedTitle,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-04T12:00:00-04:00",
    image: seedImg,
  },
};
const perennialKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(perennialProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return perennialProjects[key] || null;
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/events/details/6830/")) {
    return new Response(JSON.stringify({
      id: 6830,
      title: djangoTitle,
      full_web_image_url: djangoImg,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
let perennialSite;
try {
  perennialSite = await buildPublishedSiteEvents({
    OVERRIDES: perennialKv,
    OTRA_API_URL: "https://mock.invalid/api",
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert(
  perennialSite[0]?.title === djangoTitle,
  "bound perennial without an upstream twin must take the Django detail title"
);
assert(
  perennialSite[0]?.img === djangoImg,
  "bound perennial Django title refresh must still use the current detail hero"
);
assert(
  homepageEventSlugBase(perennialSite[0]) === eventSlug(seedTitle),
  "bound perennial card may show Django but the pretty URL stays on the seed slug"
);
assert(
  homepageEventSlugBase(perennialSite[0]) !== eventSlug(djangoTitle),
  "bound perennial must not rebuild the slug from the live Django title"
);

const prodOverrideTitle = "OTROBANDA OR PUNDA RIDE";
const prodDjangoTitle = "Iguana Scooter Ride - Punda or Otrobanda Tour";
const prodProjects = {
  "site-event:draft-prod-6830-evtitle": {
    id: "draft-prod-6830-evtitle",
    otraGuideId: 6830,
    title: seedTitle,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-05T12:00:00-04:00",
    image: seedImg,
  },
};
const prodOverrides = {
  "event:draft-prod-6830-evtitle": {
    fields: {
      "text:#evTitle": { type: "text", value: prodOverrideTitle },
    },
  },
};
const prodKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(prodProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return prodProjects[key] || prodOverrides[key] || null;
  },
};
const prodFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/events/details/6830/")) {
    return new Response(JSON.stringify({
      id: 6830,
      title: prodDjangoTitle,
      full_web_image_url: djangoImg,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
let prodBound;
try {
  prodBound = await buildPublishedSiteEvents({
    OVERRIDES: prodKv,
    OTRA_API_URL: "https://mock.invalid/api",
  });
} finally {
  globalThis.fetch = prodFetch;
}
assert(
  prodBound[0]?.title === prodOverrideTitle,
  "bound perennial text:#evTitle must stay the visible card title"
);
assert(
  homepageEventSlugBase(prodBound[0]) === eventSlug(seedTitle),
  "bound perennial with text:#evTitle must keep the seed e-scooter slug"
);
assert(
  homepageEventSlugBase(prodBound[0]) !== eventSlug(prodOverrideTitle),
  "bound perennial slug must not follow OTROBANDA OR PUNDA RIDE"
);
assert(
  homepageEventSlugBase(prodBound[0]) !== eventSlug(prodDjangoTitle),
  "bound perennial slug must not follow the live Django title"
);

const fancyProjects = {
  "site-event:draft-fancy": {
    id: "draft-fancy",
    title: "Draft Tour",
    status: "published",
    startDate: "2999-03-06T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: "Fancy Name" },
  },
};
const fancyKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(fancyProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return fancyProjects[key] || null;
  },
};
const fancySite = await buildPublishedSiteEvents({ OVERRIDES: fancyKv });
assert(
  fancySite[0]?.title === "Draft Tour",
  "unbound draft card must stay on projectCardTitle, not shared displayTitle"
);
assert(
  fancySite[0]?.title !== "Fancy Name",
  "unbound draft homepage card must not promote design.displayTitle"
);
assert(
  homepageEventSlugBase(fancySite[0]) === eventSlug("Draft Tour"),
  "unbound draft pretty URL must stay on project.title, not displayTitle"
);

const overridesSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../functions/admin/api/overrides.js"),
  "utf8"
);
const snapKey = "_" + "_homepage_feed_snapshot__";
assert(
  overridesSrc.includes(snapKey) && overridesSrc.includes("kv.delete("),
  "override PUT must delete the homepage feed snapshot so titles/photos refresh"
);

{
  const deleted = [];
  const store = new Map([
    [snapKey, JSON.stringify({ events: [{ id: 1 }], rows: [], generatedAt: Date.now() })],
    ["event:6113", JSON.stringify({ id: "6113", image: "", fields: {} })],
  ]);
  const putKv = {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      deleted.push(key);
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true };
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/users/user-role/")) {
      return { ok: true, json: async () => ({ is_staff_or_admin: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const response = await onRequestPut({
      request: new Request("https://otratickets.com/admin/api/overrides?id=6113", {
        method: "PUT",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          fields: { "text:#evTitle": { type: "text", value: "Renamed After Save" } },
        }),
      }),
      env: { OVERRIDES: putKv, OTRA_API_URL: "https://og.test/api" },
    });
    assert(response.status === 200, "override PUT must succeed so the snapshot delete can be observed");
    assert(
      deleted.includes(snapKey),
      "override PUT must delete the homepage feed snapshot"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

const sharedBrand = "Iguana Ride Curaçao";
const nightDjango = "Iguana Scooter Ride - Night Tour";
const sunsetDjango = "Iguana Scooter Ride - Sunset Tour";
const nightSeed = "Iguana Ride [E-Scooter] Night Tour";
const sunsetSeed = "Iguana Ride [E-Scooter] Sunset Tour";
const nightRename = "Admin Night Rename";

const sharedBrandProjects = {
  "site-event:draft-night-brand": {
    id: "draft-night-brand",
    otraGuideId: 6831,
    title: nightSeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-07T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
  "site-event:draft-sunset-brand": {
    id: "draft-sunset-brand",
    otraGuideId: 6832,
    title: sunsetSeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-08T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
};
const sharedBrandOverrides = {
  "event:draft-night-brand": {
    fields: {
      "text:#evTitle": { type: "text", value: nightRename },
    },
  },
};
const sharedBrandKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(sharedBrandProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return sharedBrandProjects[key] || sharedBrandOverrides[key] || null;
  },
};
const sharedFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.endsWith("/events/details/6831/")) {
    return new Response(JSON.stringify({
      id: 6831,
      title: nightDjango,
      full_web_image_url: djangoImg,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (href.endsWith("/events/details/6832/")) {
    return new Response(JSON.stringify({
      id: 6832,
      title: sunsetDjango,
      full_web_image_url: djangoImg,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
let sharedSite;
try {
  sharedSite = await buildPublishedSiteEvents({
    OVERRIDES: sharedBrandKv,
    OTRA_API_URL: "https://mock.invalid/api",
  });
} finally {
  globalThis.fetch = sharedFetch;
}
const sharedById = new Map(sharedSite.map((event) => [String(event.id), event]));
assert(
  sharedById.get("6831")?.title === nightRename,
  "text:#evTitle still wins on a bound perennial that shares a brand displayTitle"
);
assert(
  sharedById.get("6832")?.title === sunsetDjango,
  "bound perennial without evTitle must show the live Django title, not the shared brand"
);
assert(
  sharedById.get("6831")?.title !== sharedBrand && sharedById.get("6832")?.title !== sharedBrand,
  "sibling bound perennials that share displayTitle Iguana Ride Curaçao must not both become that brand line"
);
assert(
  sharedById.get("6831")?.title !== sharedById.get("6832")?.title,
  "Night vs Sunset cards must stay distinguishable when they share a brand displayTitle"
);
assert(
  homepageEventSlugBase(sharedById.get("6831")) === eventSlug(nightSeed),
  "Night pretty URL must stay on the old e-scooter slug"
);
assert(
  homepageEventSlugBase(sharedById.get("6832")) === eventSlug(sunsetSeed),
  "Sunset pretty URL must stay on the old e-scooter slug"
);
assert(
  homepageEventSlugBase(sharedById.get("6831")) !== eventSlug(nightDjango),
  "Night slug must not move onto the live Django title"
);
assert(
  homepageEventSlugBase(sharedById.get("6832")) !== eventSlug(sunsetDjango),
  "Sunset slug must not move onto the live Django title"
);

const datedCurated = "Bingo Bengo Sep 6";
const datedProjects = {
  "site-event:draft-bingo-dated": {
    id: "draft-bingo-dated",
    otraGuideId: 7522,
    title: datedCurated,
    status: "published",
    isPerennial: false,
    startDate: "2999-09-06T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: "Bingo Night Brand" },
  },
};
const datedKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(datedProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return datedProjects[key] || null;
  },
};
const datedFetch = globalThis.fetch;
let datedDetailsFetched = false;
globalThis.fetch = async (url) => {
  if (String(url).includes("/events/details/7522/")) {
    datedDetailsFetched = true;
    return new Response(JSON.stringify({
      id: 7522,
      title: "Bingo Bengo Live Django",
      full_web_image_url: djangoImg,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
let datedSite;
try {
  datedSite = await buildPublishedSiteEvents({
    OVERRIDES: datedKv,
    OTRA_API_URL: "https://mock.invalid/api",
  });
} finally {
  globalThis.fetch = datedFetch;
}
assert(
  datedSite[0]?.title === datedCurated,
  "dated bound event card must stay on the curated title, not displayTitle or Django"
);
assert(
  datedSite[0]?.title !== "Bingo Night Brand",
  "dated bound event must not promote design.displayTitle onto the card"
);
assert(
  homepageEventSlugBase(datedSite[0]) === eventSlug(datedCurated),
  "dated (non-perennial) bound event must keep its curated slug even if displayTitle is set"
);
assert(
  homepageEventSlugBase(datedSite[0]) !== eventSlug("Bingo Bengo Live Django"),
  "dated bound event must not move SLUG_SOURCE onto the live Django title"
);
assert(
  datedDetailsFetched === false,
  "dated bound event must not fetch Django details just because displayTitle is set"
);

const citySeed = "Iguana Ride [E-Scooter] City Combo Tour";
const pundaSeed = "Iguana Ride [E-Scooter] Punda or Otrobanda Tour";
const cityDjango = "Iguana Scooter Ride - City Combo Tour";
const pundaDjango = "Iguana Scooter Ride - Punda or Otrobanda Tour";
const pundaEvTitle = "OTROBANDA OR PUNDA RIDE";
const iguanaFourProjects = {
  "site-event:draft-6827": {
    id: "draft-6827",
    otraGuideId: 6827,
    title: citySeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-09T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
  "site-event:draft-6830": {
    id: "draft-6830",
    otraGuideId: 6830,
    title: pundaSeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-10T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
  "site-event:draft-6831-four": {
    id: "draft-6831-four",
    otraGuideId: 6831,
    title: nightSeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-11T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
  "site-event:draft-6832-four": {
    id: "draft-6832-four",
    otraGuideId: 6832,
    title: sunsetSeed,
    status: "published",
    isPerennial: true,
    startDate: "2999-03-12T12:00:00-04:00",
    image: seedImg,
    claudeDesign: { displayTitle: sharedBrand },
  },
};
const iguanaFourOverrides = {
  "event:draft-6830": {
    fields: {
      "text:#evTitle": { type: "text", value: pundaEvTitle },
    },
  },
};
const iguanaFourKv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(iguanaFourProjects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key) {
    return iguanaFourProjects[key] || iguanaFourOverrides[key] || null;
  },
};
const fourFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const href = String(url);
  const titles = {
    "6827": cityDjango,
    "6830": pundaDjango,
    "6831": nightDjango,
    "6832": sunsetDjango,
  };
  for (const [id, title] of Object.entries(titles)) {
    if (href.endsWith(`/events/details/${id}/`)) {
      return new Response(JSON.stringify({
        id: Number(id),
        title,
        full_web_image_url: djangoImg,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  }
  return new Response("{}", { status: 404 });
};
let iguanaFour;
try {
  iguanaFour = await buildPublishedSiteEvents({
    OVERRIDES: iguanaFourKv,
    OTRA_API_URL: "https://mock.invalid/api",
  });
} finally {
  globalThis.fetch = fourFetch;
}
const fourById = new Map(iguanaFour.map((event) => [String(event.id), event]));
assert(fourById.get("6827")?.title === cityDjango, "6827 card must show the live Django title");
assert(fourById.get("6830")?.title === pundaEvTitle, "6830 card must show text:#evTitle when present");
assert(fourById.get("6831")?.title === nightDjango, "6831 card must show the live Django title");
assert(fourById.get("6832")?.title === sunsetDjango, "6832 card must show the live Django title");
assert(
  [6827, 6830, 6831, 6832].every((id) => fourById.get(String(id))?.title !== sharedBrand),
  "6827/6830/6831/6832 cards must not all become Iguana Ride Curaçao"
);
assert(homepageEventSlugBase(fourById.get("6827")) === eventSlug(citySeed), "6827 slug stays iguana-ride-e-scooter-city-combo-tour");
assert(homepageEventSlugBase(fourById.get("6830")) === eventSlug(pundaSeed), "6830 slug stays iguana-ride-e-scooter-punda-or-otrobanda-tour");
assert(homepageEventSlugBase(fourById.get("6831")) === eventSlug(nightSeed), "6831 slug stays iguana-ride-e-scooter-night-tour");
assert(homepageEventSlugBase(fourById.get("6832")) === eventSlug(sunsetSeed), "6832 slug stays iguana-ride-e-scooter-sunset-tour");

// Frozen slug field on a published row wins over a later admin/card title.
{
  const frozenProjects = {
    "site-event:draft-frozen-rename": {
      id: "draft-frozen-rename",
      otraGuideId: 6833,
      title: "Admin Renamed After Publish",
      frozenSlug: eventSlug(seedTitle),
      status: "published",
      startDate: "2999-03-13T12:00:00-04:00",
      image: seedImg,
    },
  };
  const frozenKv = {
    async list({ prefix }) {
      return {
        keys: prefix === "site-event:" ? Object.keys(frozenProjects).map((name) => ({ name })) : [],
        list_complete: true,
      };
    },
    async get(key) {
      return frozenProjects[key] || null;
    },
  };
  const frozenSite = await buildPublishedSiteEvents({ OVERRIDES: frozenKv });
  assert(
    frozenSite[0]?.title === "Admin Renamed After Publish",
    "published site-event with frozenSlug must still show the current card title"
  );
  assert(
    homepageEventSlugBase(frozenSite[0]) === eventSlug(seedTitle),
    "published site-event with frozenSlug must keep the pre-rename seed slug"
  );
  assert(
    homepageEventSlugBase(frozenSite[0]) !== eventSlug("Admin Renamed After Publish"),
    "frozenSlug must win over a later project.title when minting the pretty URL"
  );
}

// Old published Iguana rows without frozenSlug stay on the seed e-scooter slug.
{
  const legacyProjects = {
    "site-event:draft-legacy-iguana": {
      id: "draft-legacy-iguana",
      otraGuideId: 6831,
      title: nightSeed,
      status: "published",
      isPerennial: true,
      startDate: "2999-03-14T12:00:00-04:00",
      image: seedImg,
      claudeDesign: { displayTitle: sharedBrand },
    },
  };
  const legacyKv = {
    async list({ prefix }) {
      return {
        keys: prefix === "site-event:" ? Object.keys(legacyProjects).map((name) => ({ name })) : [],
        list_complete: true,
      };
    },
    async get(key) {
      return legacyProjects[key] || null;
    },
  };
  const legacyFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/events/details/6831/")) {
      return new Response(JSON.stringify({
        id: 6831,
        title: nightDjango,
        full_web_image_url: djangoImg,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  let legacySite;
  try {
    legacySite = await buildPublishedSiteEvents({
      OVERRIDES: legacyKv,
      OTRA_API_URL: "https://mock.invalid/api",
    });
  } finally {
    globalThis.fetch = legacyFetch;
  }
  assert(
    homepageEventSlugBase(legacySite[0]) === eventSlug(nightSeed),
    "old published Iguana without frozenSlug must implicitly freeze on the seed e-scooter title"
  );
  assert(
    homepageEventSlugBase(legacySite[0]) !== eventSlug(nightDjango),
    "old published Iguana without frozenSlug must not switch to the Django slug"
  );
  assert(
    legacySite[0]?.title === nightDjango,
    "old published Iguana card may still show the live Django title"
  );
}

assert(
  homepageEventSlugBase(null) === "",
  "homepageEventSlugBase must tolerate a null event"
);
assert(
  homepageEventSlugBase({ title: "Sunday Social (clone)" }) === eventSlug("Sunday Social"),
  "clone in the title string must not appear in the pretty URL"
);

if (failures.length) {
  console.error("check-homepage-card-title FAILED:");
  failures.forEach((failure) => console.error(" - " + failure));
  process.exit(1);
}

console.log("check-homepage-card-title OK (cards distinguishable; slugs frozen on seed; displayTitle off cards)");
