import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet } from "../../functions/api/event.js";

test("a published site project can render its staff-only Guide checkout without exposing other events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const project = {
    id: "draft-1791253678425-26c548a5",
    otraGuideId: "8088",
    status: "published",
    adminOnly: false,
    title: "Finish Line Party",
    frozenSlug: "finish-line-party",
    claudeDesign: { perkLayout: "cards", rates: [{ name: "Finish Line Ticket", price: "20.00", currency: "USD" }] },
  };
  const other = { ...project, id: "draft-other", otraGuideId: "8089" };
  const kv = {
    async list() { return { keys: [{ name: `site-event:${project.id}` }, { name: `site-event:${other.id}` }], list_complete: true }; },
    async get(key) { return key === `site-event:${project.id}` ? project : key === `site-event:${other.id}` ? other : null; },
  };
  globalThis.caches = { default: { async match() { return null; } } };
  globalThis.fetch = async input => {
    const path = new URL(input).pathname;
    if (/^\/api\/events\/details\/808[89]\/$/.test(path)) return new Response(null, { status: 404 });
    if (/^\/api\/ticket\/purchase\/tickets\/808[89]\/$/.test(path)) return Response.json({ results: [{ id: 491, name: "Finish Line Ticket" }] });
    if (/^\/ticketing\/stripe-external-iframe\/calendar\/808[89]\/$/.test(path)) return new Response("", { status: 200 });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const env = { OVERRIDES: kv, OTRA_API_URL: "https://guide.test/api" };
    const response = await onRequestGet({ request: new Request("https://tickets.test/api/event?id=8088"), env });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.isDraft, false);
    assert.equal(body.checkoutEventId, "8088");
    assert.equal(body.checkoutBaseUrl, "https://guide.test");
    assert.equal(body.slug, "finish-line-party");
    assert.equal(body.design.perkLayout, "cards");

    const unrelated = await onRequestGet({ request: new Request("https://tickets.test/api/event?id=8089"), env });
    assert.equal(unrelated.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
