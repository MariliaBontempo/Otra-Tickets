import { apiBase, requireStaff, json } from "./_auth.js";

export async function onRequestGet(context) {
  const token = await requireStaff(context.request, context.env);
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const response = await fetch(`${apiBase(context.env)}/teams/regions/`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const data = await response.json().catch(() => []);
    if (!response.ok) return json({ error: data.detail || "could not load regions" }, response.status);
    return json({ regions: Array.isArray(data) ? data : data.results || [] });
  } catch {
    return json({ error: "could not reach Otra Guide" }, 502);
  }
}
