// Oracle: homepage cards use text:#evTitle when an admin renamed the detail
// title, and keep the curated/Django title when that field is absent. Slug
// stays rooted in the pre-override title so existing pretty URLs keep working.
// Run: node scripts/check-homepage-card-title.mjs

import {
  applyOverrides,
  buildPublishedSiteEvents,
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

if (failures.length) {
  console.error("check-homepage-card-title FAILED:");
  failures.forEach((failure) => console.error(" - " + failure));
  process.exit(1);
}

console.log("check-homepage-card-title OK (cards follow text:#evTitle; slug stays on original title)");
