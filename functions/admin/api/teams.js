import { apiBase, requireStaff, json } from "./_auth.js";

export async function onRequestGet(context) {
  const token = await requireStaff(context.request, context.env);
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const teams = [];
    let next = `${apiBase(context.env)}/teams/`;
    let pageCount = 0;
    while (next && pageCount < 100) {
      const response = await fetch(next, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      let data;
      try {
        data = await response.json();
      } catch {
        if (response.ok) return json({ error: "Otra Guide returned an invalid teams response" }, 502);
        data = {};
      }
      if (!response.ok) return json({ error: data.detail || "could not load teams" }, response.status);
      if (Array.isArray(data)) {
        teams.push(...data);
        next = null;
      } else {
        teams.push(...(Array.isArray(data.results) ? data.results : []));
        next = typeof data.next === "string" && data.next ? data.next : null;
      }
      pageCount += 1;
    }
    if (next) return json({ error: "team list exceeded the pagination limit" }, 502);
    return json({ teams });
  } catch {
    return json({ error: "could not reach Otra Guide" }, 502);
  }
}
