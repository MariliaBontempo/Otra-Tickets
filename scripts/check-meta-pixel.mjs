import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { onRequestGet as fallback } from "../functions/api/meta-pageview.js";
import { onRequestGet as eventPage } from "../functions/[slug].js";

const source = readFileSync(new URL("../meta-pixel.js", import.meta.url), "utf8");
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
function browser({ url = "https://otratickets.com/an-event", localStorage = storage(), sessionStorage = storage(), framed = false, fbq } = {}) {
  const listeners = {}, scripts = [];
  const iframe = { contentWindow: {}, src: "https://otraguide.com/ticketing/stripe-checkout/6113/" };
  const window = {
    location: new URL(url), localStorage, sessionStorage, fbq,
    navigator: {}, addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  window.top = framed ? {} : window;
  const document = {
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore: s => scripts.push(s) } }],
    querySelector: () => iframe,
    querySelectorAll: () => [iframe],
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams });
  const run = () => vm.runInContext(source, context);
  run();
  return { window, scripts, run, iframe, listeners, api: window.OTRAMeta,
    events: () => Array.from(window.fbq?.queue || [], args => Array.from(args)) };
}

vm.runInNewContext(source); // SSR/import without a browser is harmless.
const b = browser();
b.run(); b.api.pageView();
assert.equal(b.scripts.length, 1);
assert.equal(b.scripts[0].src, "https://connect.facebook.net/en_US/fbevents.js");
assert.deepEqual(b.events().map(args => args.slice(0, 2)), [["init", "9500041730032996"], ["trackSingle", "9500041730032996"]]);
b.window.location = new URL("https://otratickets.com/canonical-name#book");
b.api.pageView();
assert.equal(b.events().length, 2, "canonical replacements and booking anchors are not route views");
b.api.viewContent({ id: 6113, title: "Tour", tickets: [{ price: 20, currency: "USD" }] });
b.api.viewContent({ id: 6113, title: "Tour" });
b.api.viewContent({ id: "draft-test", title: "Draft", isDraft: true });
assert.equal(b.events().length, 3);
assert.deepEqual(b.events().map(args => args[2]), [undefined, "PageView", "ViewContent"]);
assert.equal(b.events()[2][3].value, undefined, "do not guess tier price or currency");

for (const options of [
  { url: "http://localhost:8080/" }, { url: "https://staging.otratickets.com/" },
  { url: "https://otratickets.com/admin/" }, { url: "https://otratickets.com/?_preview=123" },
  { url: "https://otratickets.com/?adminView=1" }, { framed: true },
]) {
  const disabled = browser(options);
  disabled.api.viewContent({ id: 1, title: "Hidden" });
  assert.equal(disabled.scripts.length, 0);
}
const staffStorage = storage(); staffStorage.setItem("otra_admin_token", "staff");
assert.equal(browser({ sessionStorage: staffStorage }).scripts.length, 0);
assert.equal(browser({ url: "http://localhost:8080/?meta_debug=1" }).scripts.length, 1);

const OWN = "9500041730032996", PARTNER = "4561979437392335";
const named = (run, name) => run.events().filter(e => e[0] === "trackSingle" && e[2] === name);
const order = { orderId: "order_123", paymentStatus: "paid",
  value: 65.40, currency: "XCG", email: "must-not-be-forwarded@example.com",
  contents: [{ id: "adult", quantity: 2, item_price: 25, name: "PII must not pass" }, { id: "child", quantity: 1, item_price: 10 }] };
assert.equal(await b.api.purchase({ ...order, paymentStatus: "pending" }), false);
assert.equal(await b.api.purchase({ ...order, paymentStatus: "failed" }), false);
assert.equal(await b.api.purchase({ ...order, value: "65.40" }), false);
assert.equal(await b.api.purchase({ ...order, currency: "" }), false);
assert.equal(await b.api.purchase({ ...order, contents: [{ id: "adult", quantity: -1, item_price: 25 }] }), false);
assert.equal(await b.api.purchase({ ...order, orderId: undefined }), false);
assert.equal(await b.api.purchase(order), true);
assert.equal(await b.api.purchase(order), false);
const purchase = b.events().at(-1).slice(1);
assert.equal(purchase[0], OWN, "our purchase goes to our pixel only");
assert.equal(purchase[1], "Purchase");
assert.equal(purchase[2].value, 65.40, "use confirmed total including fees; do not recalculate from ticket prices");
assert.equal(purchase[2].currency, "XCG");
assert.equal(purchase[2].num_items, 3);
assert.equal(purchase[2].contents.length, 2);
assert.equal(purchase[2].email, undefined);
assert.equal(purchase[2].contents[0].name, undefined);
assert.equal(purchase[3].eventID, "otratickets:Purchase:order_123");
const refreshed = browser({ localStorage: b.window.localStorage, sessionStorage: b.window.sessionStorage });
assert.equal(await refreshed.api.purchase(order), false, "refresh/revisit must not repeat a purchase");
assert.equal(await refreshed.api.purchase({ ...order, orderId: "order_456" }), true, "a new order still counts");

const deniedStorage = { getItem() { throw new Error("Storage blocked"); } };
assert.equal(await browser({ localStorage: deniedStorage }).api.purchase(order), false);
const throwing = browser({ fbq() { throw new Error("Tracker blocked"); } });
assert.equal(await throwing.api.purchase(order), false);
assert.equal(throwing.window.localStorage.getItem("meta:9500041730032996:otratickets:Purchase:order_123"), null);
const missing = browser(); delete missing.window.fbq;
assert.equal(await missing.api.purchase(order), false);

const bridge = browser();
const message = { origin: "https://otraguide.com", source: bridge.iframe.contentWindow,
  data: { type: "OTRA_CHECKOUT_STARTED", data: { ...order, checkoutId: "attempt-123" } } };
bridge.listeners.message({ ...message, origin: "https://evil.example" });
bridge.listeners.message({ ...message, source: {} });
assert.equal(bridge.events().length, 2);
bridge.listeners.message(message); bridge.listeners.message(message);
assert.equal(named(bridge, "InitiateCheckout").length, 1);
assert.equal(bridge.events().at(-1)[4].eventID, "otratickets:InitiateCheckout:attempt-123");
const guide = browser({ url: "https://otraguide.com/event/123" });
guide.listeners.message({ ...message, source: guide.iframe.contentWindow });
assert.equal(guide.events().at(-1)[2], "InitiateCheckout", "Guide accepts its own checkout iframe");
guide.listeners.message({ ...message, source: {}, data: { ...message.data, data: { ...order, checkoutId: "forged" } } });
assert.equal(guide.events().length, 3, "unknown frames remain rejected");
assert.equal(await b.api.purchase({ ...order, orderId: "free-confirmed", value: 0,
  contents: [{ id: "adult", quantity: 1, item_price: 0 }] }), true);

// Organiser pixel: only confirmed conversions for that organiser's events, never our other events.
const shared = browser();
const partnerOrder = { ...order, orderId: "order_partner", partnerPixelId: PARTNER };
assert.equal(await shared.api.purchase(partnerOrder), true);
assert.deepEqual(shared.events().slice(2).map(e => e.slice(0, 3)), [
  ["trackSingle", OWN, "Purchase"], ["set", "autoConfig", false], ["init", PARTNER], ["trackSingle", PARTNER, "Purchase"]]);
assert.equal(shared.events()[3][3], PARTNER, "automatic events are switched off for the organiser pixel before init");
const [ours, theirs] = named(shared, "Purchase");
assert.deepEqual(theirs.slice(3), ours.slice(3), "same amount, currency, contents and event ID on both pixels");
assert.equal(theirs[4].eventID, "otratickets:Purchase:order_partner");
assert.equal(theirs[3].partnerPixelId, undefined);
assert.equal(await shared.api.purchase(partnerOrder), false);
assert.equal(named(shared, "Purchase").length, 2, "a refresh repeats neither pixel");
shared.api.viewContent({ id: 1, title: "Another organiser" });
assert.equal(await shared.api.purchase({ ...order, orderId: "order_other" }), true);
assert.equal(shared.events().filter(e => e[1] === PARTNER).length, 2, "the organiser pixel gets its init and that one purchase");
assert.equal(shared.events().some(e => e[0] === "track"), false, "broadcast track is never used");
const late = browser({ localStorage: shared.window.localStorage });
late.window.localStorage.removeItem(`meta:${PARTNER}:otratickets:Purchase:order_partner`);
assert.equal(await late.api.purchase(partnerOrder), false, "our own purchase stays deduplicated");
assert.equal(named(late, "Purchase").map(e => e[1]).join(), PARTNER, "the organiser pixel dedupes on its own key");
for (const partnerPixelId of ["", "abc", "123", OWN, "4561979437392335;alert(1)", {}]) {
  const invalid = browser();
  assert.equal(await invalid.api.purchase({ ...order, partnerPixelId }), true);
  assert.equal(invalid.events().some(e => e[0] === "init" && e[1] !== OWN), false, String(partnerPixelId));
  assert.equal(named(invalid, "Purchase").length, 1);
}
const partnerBridge = browser();
partnerBridge.listeners.message({ ...message, source: partnerBridge.iframe.contentWindow,
  data: { type: "OTRA_CHECKOUT_STARTED", data: { ...order, checkoutId: "attempt-9", partnerPixelId: PARTNER } } });
assert.deepEqual(named(partnerBridge, "InitiateCheckout").map(e => e[1]), [OWN, PARTNER]);
assert.equal(await browser({ framed: true }).api.purchase(partnerOrder), false, "no pixel runs inside an iframe");

for (const file of ["index.html", "event.html", "clearboat.html", "rnb.html"]) {
  const html = read(file);
  assert.equal((html.match(/src="\/meta-pixel.js"/g) || []).length, 1, file);
  assert.equal((html.match(/<noscript>.*\/api\/meta-pageview.*<\/noscript>/g) || []).length, 1, file);
}
assert(!read("admin/index.html").includes("meta-pixel.js"));
assert(read("scripts/build-pages.mjs").includes('"meta-pixel.js"'));
const dynamic = await eventPage({
  params: { slug: "future-event" }, request: new Request("https://otratickets.com/future-event"),
  env: { ASSETS: { fetch: async () => new Response(read("event.html")) } },
  getHomepageEvents: async () => Response.json({ events: [{ id: 99999, slug: "future-event", title: "Future Event" }] }),
});
const html = await dynamic.text();
assert(html.includes('data-event-id="99999"'));
assert.equal((html.match(/src="\/meta-pixel.js"/g) || []).length, 1, "future dynamic pages inherit the loader");
assert(html.includes("window.OTRAMeta?.viewContent(ev)"));
assert.equal(fallback({ request: new Request("http://localhost/api/meta-pageview") }).status, 204);
const noscript = fallback({ request: new Request("https://otratickets.com/api/meta-pageview") });
assert.equal(noscript.status, 302);
assert.equal(new URL(noscript.headers.get("location")).searchParams.get("id"), "9500041730032996");
console.log("Meta Pixel checks passed: loader, page coverage, previews, event data, deduplication and failure isolation.");
