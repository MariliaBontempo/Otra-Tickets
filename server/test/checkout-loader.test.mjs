import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Runs event.html's real loadCheckout against a small fake DOM and embed, so
// the loader, error and retry behaviour is exercised, not only matched as text.
const html = readFileSync(new URL("../../event.html", import.meta.url), "utf8");
const start = html.indexOf("      function loadCheckout(");
const source = html.slice(start, html.indexOf("\n    })();", start));

function el(id = "") {
  const node = {
    id, hidden: false, className: "", style: {}, children: [], parentNode: null, listeners: {}, dataset: {}, attrs: {}, _html: "",
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; },
    insertBefore(child) { return this.appendChild(child); },
    querySelector(sel) { return this.children.find((c) => matches(c, sel)) || null; },
    querySelectorAll(sel) { return this.children.filter((c) => matches(c, sel)); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
  };
  return node;
}
function matches(node, sel) {
  return sel === "iframe" ? node.tag === "iframe" : sel === ".otra-loading" ? node.className === "otra-loading" : false;
}

function setup({ scriptLoads = true, embedPresent = true } = {}) {
  const section = el("book");
  const container = section.appendChild(el("otra-checkout-container"));
  const ids = () => {
    const all = [container, ...section.children];
    return (id) => {
      const hit = all.find((n) => n.id === id);
      if (hit) return hit;
      // The retry button lives in the error note's markup.
      if (id === "evCheckoutRetry") return section.children.find((n) => n.id === "evCheckoutError")?.button || null;
      return null;
    };
  };
  const timers = [];
  const observers = [];
  const winListeners = [];
  const created = [];
  const destroyed = [];
  const head = el("head");
  const embed = {
    create(config) {
      const instance = { config, destroy() { destroyed.push(instance); } };
      created.push(instance);
      container.innerHTML = "";
      const frame = el(); frame.tag = "iframe"; frame.contentWindow = { frame: created.length };
      container.appendChild(frame);
      instance.iframe = frame;
      observers.forEach((o) => o.live && o.fn());
      return instance;
    },
  };
  const window = {
    OtraStripeCheckoutEmbed: embedPresent ? embed : undefined,
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); },
    removeEventListener(type, fn) { const i = winListeners.indexOf(fn); if (i >= 0) winListeners.splice(i, 1); },
    scrollY: 0,
  };
  const document = {
    head,
    getElementById: (id) => ids()(id),
    createElement(tag) {
      const node = el();
      if (tag === "script") { node.tag = "script"; }
      Object.defineProperty(node, "innerHTML", {
        get() { return this._html; },
        set(v) { this._html = v; if (/evCheckoutRetry/.test(v)) { this.button = el("evCheckoutRetry"); } },
      });
      return node;
    },
  };
  head.appendChild = function (child) {
    child.parentNode = head;
    if (child.tag === "script") {
      queueMicrotask(() => {
        if (scriptLoads) { window.OtraStripeCheckoutEmbed = embed; child.onload(); } else child.onerror();
      });
    }
    return child;
  };
  class MutationObserver {
    constructor(fn) { this.fn = fn; this.live = false; observers.push(this); }
    observe() { this.live = true; }
    disconnect() { this.live = false; }
  }
  const context = {
    window, document, MutationObserver, URL, console: { log() {}, error() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].live = false; },
    $: (id) => document.getElementById(id),
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.loadCheckout = loadCheckout;`, context);
  const fire = () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
  const lateLoader = () => { const box = el(); box.className = "otra-loading"; container.appendChild(box); observers.forEach((o) => o.live && o.fn()); };
  const note = () => section.children.find((n) => n.id === "evCheckoutError") || null;
  return { context, container, section, created, destroyed, winListeners, fire, lateLoader, note };
}

const load = (h) => h.context.loadCheckout("7524", "https://otraguide.com", "", false);

test("a loading box the embed adds after the checkout loaded is removed", () => {
  const h = setup();
  load(h);
  const frame = h.container.querySelector("iframe");
  frame.listeners.load.forEach((fn) => fn());
  h.lateLoader();
  assert.equal(h.container.querySelectorAll(".otra-loading").length, 0);
  h.fire();
  assert.equal(h.note(), null);
  assert.equal(h.container.hidden, false);
});

test("a resize message from the checkout frame counts as ready; one from another frame does not", () => {
  const h = setup();
  load(h);
  const frame = h.container.querySelector("iframe");
  h.winListeners[0]({ origin: "https://otraguide.com", source: { other: true }, data: { type: "OTRA_IFRAME_RESIZE", height: 900 } });
  h.lateLoader();
  assert.equal(h.container.querySelectorAll(".otra-loading").length, 1);
  h.winListeners[0]({ origin: "https://otraguide.com", source: frame.contentWindow, data: { type: "OTRA_IFRAME_RESIZE", height: 900 } });
  assert.equal(h.container.querySelectorAll(".otra-loading").length, 0);
  assert.equal(frame.style.height, "900px");
});

test("a checkout that never gets ready shows the error, keeps the iframe, and comes back if it loads late", () => {
  const h = setup();
  load(h);
  const frame = h.container.querySelector("iframe");
  h.fire();
  assert.ok(h.note());
  assert.equal(h.container.hidden, true);
  assert.equal(h.container.querySelector("iframe"), frame);
  frame.listeners.load.forEach((fn) => fn());
  assert.equal(h.note(), null);
  assert.equal(h.container.hidden, false);
});

test("Try again destroys the old embed instance, mounts a new one and swaps the resize listener", () => {
  const h = setup();
  load(h);
  assert.equal(h.winListeners.length, 1);
  const firstListener = h.winListeners[0];
  h.fire();
  h.note().button.listeners.click[0]();
  assert.equal(h.note(), null);
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.destroyed, [h.created[0]]);
  assert.equal(h.winListeners.length, 1);
  assert.notEqual(h.winListeners[0], firstListener);
  assert.equal(h.container.hidden, false);
});

test("an embed script that fails to load shows the error", async () => {
  const h = setup({ embedPresent: false, scriptLoads: false });
  load(h);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.note());
  assert.equal(h.created.length, 0);
});

test("only a load error from the embed shows the error; other checkout errors do not", () => {
  const h = setup();
  load(h);
  h.created[0].config.onError({ type: "payment_failed" });
  assert.equal(h.note(), null);
  h.created[0].config.onError({ type: "iframe_load_error" });
  assert.ok(h.note());
});
