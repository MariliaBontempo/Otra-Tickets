// In-memory stand-in for the Workers Cache API. Best-effort: correctness
// does not depend on hits (functions rebuild on miss), only on not serving
// expired entries.
function makeCache() {
  const store = new Map(); // urlKey -> { body: Buffer, status, headers, expires }
  function keyOf(k) { return typeof k === "string" ? k : (k && k.url) || String(k); }
  return {
    async match(k) {
      const hit = store.get(keyOf(k));
      if (!hit) return undefined;
      if (hit.expires && Date.now() > hit.expires) { store.delete(keyOf(k)); return undefined; }
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    },
    async put(k, response) {
      const body = Buffer.from(await response.clone().arrayBuffer());
      const cc = response.headers.get("cache-control") || "";
      const m = cc.match(/max-age=(\d+)/);
      if (store.size >= 200) store.delete(store.keys().next().value);
      store.set(keyOf(k), {
        body, status: response.status,
        headers: Object.fromEntries(response.headers),
        expires: m ? Date.now() + Number(m[1]) * 1000 : 0,
      });
    },
    async delete(k) { return store.delete(keyOf(k)); },
  };
}
export function installCaches() {
  if (globalThis.caches && globalThis.caches.default) return;
  const def = makeCache();
  const named = new Map();
  globalThis.caches = {
    default: def,
    async open(name) {
      if (!named.has(name)) named.set(name, makeCache());
      return named.get(name);
    },
  };
}
