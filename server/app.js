import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveRoute } from "./router.js";
import { installCaches } from "./cache.js";

const METHOD_EXPORT = { GET: "onRequestGet", HEAD: "onRequestGet", POST: "onRequestPost", PUT: "onRequestPut", DELETE: "onRequestDelete", PATCH: "onRequestPatch" };

export function createApp(env, routes, functionsDir) {
  installCaches();
  const moduleCache = new Map();
  async function loadModule(rel) {
    if (!moduleCache.has(rel))
      moduleCache.set(rel, import(pathToFileURL(join(functionsDir, rel)).href));
    return moduleCache.get(rel);
  }
  return {
    async handle(request) {
      const background = [];
      const url = new URL(request.url);
      let response;
      try {
        const hit = resolveRoute(routes, url.pathname);
        let handler = null, params = {};
        if (hit) {
          const mod = await loadModule(hit.modulePath);
          handler = mod[METHOD_EXPORT[request.method]] || mod.onRequest || null;
          params = hit.params;
        }
        if (!handler) {
          response = await env.ASSETS.fetch(request);
        } else {
          const context = {
            request, env, params,
            functionPath: hit.modulePath,
            waitUntil: (p) => background.push(Promise.resolve(p).catch((e) => console.error("waitUntil:", e))),
            next: () => env.ASSETS.fetch(request),
            data: {},
          };
          response = await handler(context);
        }
      } catch (e) {
        console.error(request.method, url.pathname, e);
        response = new Response("Internal Server Error", { status: 500 });
      }
      return { response, background };
    },
  };
}
