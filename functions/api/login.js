// Cloudflare Pages Function: POST /api/login
//
// Sign in with any Otra Guide account. The Guide JWT goes into an HttpOnly
// cookie and is never returned in the body.

import { apiBase, json } from "../admin/api/_auth.js";
import { rejectCrossSite } from "../_lib/csrf.js";
import { resolveUser, sessionCookie } from "../_lib/session.js";

export async function onRequestPost(context) {
  const refused = rejectCrossSite(context.request, { requireJson: true });
  if (refused) return refused;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const email = String((body && body.email) || "").trim();
  const password = (body && body.password) || "";
  if (!email || !password) return json({ error: "email and password are required" }, 400);

  let tokenResp;
  try {
    tokenResp = await fetch(`${apiBase(context.env)}/auth/token/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: email, password }),
    });
  } catch {
    return json({ error: "Could not reach the sign-in service." }, 502);
  }
  if (tokenResp.status >= 500) return json({ error: "Could not reach the sign-in service." }, 502);
  if (tokenResp.status === 429) return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  if (!tokenResp.ok) return json({ error: "Wrong email or password." }, 401);

  const tokens = await tokenResp.json().catch(() => ({}));
  if (!tokens.access) return json({ error: "Wrong email or password." }, 401);

  const result = await resolveUser(tokens.access, context.env);
  if (!result.user) return json({ error: "Could not reach the sign-in service." }, 502);

  const res = json({ user: result.user });
  res.headers.set("set-cookie", sessionCookie(tokens.access));
  return res;
}
