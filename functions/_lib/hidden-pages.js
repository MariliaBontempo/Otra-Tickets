// Shared access to the archived ("hidden") page ids. The admin Archive button
// adds a published event's id to this KV set; both the admin Edit dropdown and
// the public homepage feed must respect it.

export const HIDDEN_PAGES_KEY = "admin:hidden-pages";

export async function readHiddenPageIds(env) {
  const kv = env && env.OVERRIDES;
  if (!kv) return new Set();
  try {
    const ids = await kv.get(HIDDEN_PAGES_KEY, "json");
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}
