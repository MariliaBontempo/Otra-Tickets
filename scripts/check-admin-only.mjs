// Checks that adminOnly site events are excluded from the public homepage
// feed and included only when the staff preview opts in.
// Run: node scripts/check-admin-only.mjs

import { buildPublishedSiteEvents } from "../functions/_lib/homepage-feed.js";

const PROJECTS = {
  "site-event:draft-public": {
    id: "draft-public",
    title: "Public Event",
    status: "published",
    startDate: "2999-01-01T10:00:00.000Z",
    endDate: "2999-01-01T14:00:00.000Z",
    claudeDesign: { rates: [{ name: "General Admission", price: "25.00" }] },
  },
  "site-event:draft-admin-only": {
    id: "draft-admin-only",
    title: "Admin Only Event",
    status: "published",
    adminOnly: true,
    startDate: "2999-01-02T10:00:00.000Z",
    endDate: "2999-01-02T14:00:00.000Z",
  },
  "site-event:draft-unpublished": {
    id: "draft-unpublished",
    title: "Unpublished Event",
    status: "draft",
  },
  "site-event:draft-archived": {
    id: "draft-archived",
    title: "Archived Published Event",
    status: "published",
    archivedAt: "2026-08-03T17:00:00.000Z",
    startDate: "2026-07-01T10:00:00.000Z",
    endDate: "2026-07-01T14:00:00.000Z",
  },
};

const kvStub = {
  async list({ cursor }) {
    void cursor;
    return { keys: Object.keys(PROJECTS).map((name) => ({ name })), list_complete: true };
  },
  async get(name) {
    return PROJECTS[name] || null;
  },
};

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const publicEvents = await buildPublishedSiteEvents({ OVERRIDES: kvStub });
const publicIds = publicEvents.map((event) => event.id);
assert(publicIds.includes("draft-public"), "public feed must include the published public event");
assert(
  publicEvents.find((event) => event.id === "draft-public")?.hasTicketTypes === true,
  "published drafts must preserve ticket types stored in claudeDesign.rates"
);
assert(!publicIds.includes("draft-admin-only"), "public feed must NOT include an adminOnly event");
assert(!publicIds.includes("draft-unpublished"), "public feed must NOT include an unpublished draft");
assert(!publicIds.includes("draft-archived"), "public feed must NOT include an archived published draft");

const adminEvents = await buildPublishedSiteEvents({ OVERRIDES: kvStub }, { includeAdminOnly: true });
const adminIds = adminEvents.map((event) => event.id);
assert(adminIds.includes("draft-public"), "admin preview must include the published public event");
assert(adminIds.includes("draft-admin-only"), "admin preview must include the adminOnly event");
assert(!adminIds.includes("draft-unpublished"), "admin preview must NOT include an unpublished draft");
assert(!adminIds.includes("draft-archived"), "admin preview must NOT include an archived published draft");

if (failures.length) {
  console.error("check-admin-only FAILED:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}
console.log("check-admin-only OK (public excludes adminOnly; admin preview includes it)");
