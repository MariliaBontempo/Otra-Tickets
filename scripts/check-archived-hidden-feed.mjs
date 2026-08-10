// Oracle: events archived from the admin (ids stored in the KV
// "admin:hidden-pages" set) never appear in the public homepage feed,
// even when their published site-event KV record still exists.
// Run: node scripts/check-archived-hidden-feed.mjs

import { buildHomepageFeed } from "../functions/_lib/homepage-feed.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

const projects = {
  "site-event:draft-visible": {
    id: "draft-visible",
    otraGuideId: "7999",
    title: "Visible Event",
    status: "published",
    startDate: "2999-01-01T12:00:00-04:00",
    endDate: "2999-01-01T16:00:00-04:00",
    claudeDesign: { rates: [{ name: "General Admission", price: "25.00" }] },
  },
  "site-event:draft-archived-from-admin": {
    id: "draft-archived-from-admin",
    otraGuideId: "7514",
    title: "Archived From Admin",
    status: "published",
    startDate: "2999-01-02T12:00:00-04:00",
    endDate: "2999-01-02T16:00:00-04:00",
    claudeDesign: { rates: [{ name: "General Admission", price: "25.00" }] },
  },
};

const kv = {
  async list({ prefix }) {
    return {
      keys: prefix === "site-event:" ? Object.keys(projects).map((name) => ({ name })) : [],
      list_complete: true,
    };
  },
  async get(key, type) {
    void type;
    if (key === "admin:hidden-pages") return ["7514"];
    return projects[key] || null;
  },
};

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ results: [] }), {
    headers: { "content-type": "application/json" },
  });
globalThis.caches = {
  default: {
    async match() { return undefined; },
    async put() {},
  },
};

try {
  const context = {
    env: { OVERRIDES: kv },
    request: new Request("https://otratickets.com/api/homepage-events"),
    waitUntil() {},
  };
  const { events } = await buildHomepageFeed(context, {});
  const ids = events.map((event) => String(event.id));
  assert(ids.includes("7999"), "public feed must include the non-archived published event");
  assert(!ids.includes("7514"), "public feed must NOT include an event archived via admin:hidden-pages");
} finally {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}

if (failures.length) {
  console.error("check-archived-hidden-feed FAILED:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}
console.log("check-archived-hidden-feed OK (hidden-pages ids stay out of the public feed)");
