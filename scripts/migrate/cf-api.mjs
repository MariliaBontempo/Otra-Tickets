// Minimal Cloudflare REST client for the migration. Read-only.
const BASE = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) throw new Error("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID required");

export async function cf(path, opts = {}) {
  const backoffs = [1000, 4000];
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          const retryAfter = res.headers.get("Retry-After");
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : backoffs[attempt];
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw new Error(`CF ${path}: ${res.status} ${await res.text()}`);
    } catch (e) {
      if (attempt < 3 && (e instanceof TypeError || e.message.includes("fetch"))) {
        const delay = backoffs[attempt];
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}
export async function cfJson(path) {
  const data = await (await cf(path)).json();
  if (!data.success) throw new Error(`CF ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}
export async function discoverBindings() {
  const projects = await cfJson(`/accounts/${ACCOUNT}/pages/projects`);
  const project = projects.find((p) =>
    (p.domains || []).some((d) => d.includes("otratickets.com"))) || projects[0];
  if (!project) throw new Error("no Pages project found");
  const conf = (project.deployment_configs || {}).production || {};
  const kv = conf.kv_namespaces && conf.kv_namespaces.OVERRIDES;
  const r2 = conf.r2_buckets && conf.r2_buckets.OVERRIDE_IMAGES;
  if (!kv || !r2) throw new Error(`bindings missing on project ${project.name}: ${JSON.stringify(conf)}`);
  return { pagesProjectName: project.name, kvNamespaceId: kv.namespace_id, r2BucketName: r2.name, account: ACCOUNT };
}
