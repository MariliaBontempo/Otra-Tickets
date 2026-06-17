// Cloudflare Pages Function: POST /admin/api/login
//
// Staff/admin login for the editor. We proxy the Otra Guide JWT login
// server-side (the browser can't call otraguide.com directly — it isn't in
// otraguide's CORS allowlist), then confirm the account is staff/admin.
//
// Body: { email, password }
// Returns: { token, refresh } on success, or { error } with a 4xx status.
// The returned access token is what the admin page sends back (as a Bearer)
// to the other /admin/api/* functions, which re-verify it on every call.

const API = "https://otraguide.com/api";

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

  // 1) Obtain a JWT from Otra Guide. Their JWT endpoint uses the Simple JWT
  // field name `username`; Otra Guide accounts can still use an email-shaped
  // login value.
  let tokenResp;
  try {
    tokenResp = await fetch(`${API}/auth/token/`, {
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
  if (!access) {
    return json({ error: "login failed" }, 401);
  }

  // 2) Confirm the account is staff or admin before letting them in.
  const isStaffOrAdmin = await checkStaff(access);
  if (!isStaffOrAdmin) {
    return json({ error: "this account is not a staff or admin user" }, 403);
  }

  return json({ token: access, refresh: tokens.refresh || null });
}

// Verify a JWT belongs to a staff/admin account. Exported-style helper reused
// by the other admin functions (they import their own copy to stay isolated).
export async function checkStaff(accessToken) {
  try {
    const resp = await fetch(`${API}/users/user-role/`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.is_staff_or_admin;
  } catch {
    return false;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
