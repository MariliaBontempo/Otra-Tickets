// Cloudflare Pages Function: POST /admin/api/login
//
// Staff/admin login for the editor. We proxy the Otra Guide JWT login
// server-side (the browser can't call otraguide.com directly — it isn't in
// otraguide's CORS allowlist), then confirm the account is staff/admin.

import { apiBase, checkStaff, json } from "./_auth.js";

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const email = (body.email || "").trim();
  const password = body.password || "";
  if (!email || !password) {
    return json({ error: "email and password are required" }, 400);
  }

  // Otra Guide's JWT endpoint uses the Simple JWT field name `username`; the
  // login value itself is email-shaped for staff accounts.
  let tokenResp;
  try {
    tokenResp = await fetch(`${apiBase(context.env)}/auth/token/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: email, password }),
    });
  } catch {
    return json({ error: "could not reach the login service" }, 502);
  }
  if (!tokenResp.ok) {
    return json({ error: "invalid email or password" }, 401);
  }

  const tokens = await tokenResp.json();
  const access = tokens.access;
  if (!access) return json({ error: "login failed" }, 401);

  if (!(await checkStaff(access, context.env))) {
    return json({ error: "this account is not a staff or admin user" }, 403);
  }

  return json({ token: access, refresh: tokens.refresh || null });
}
