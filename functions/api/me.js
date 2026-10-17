// Cloudflare Pages Function: GET /api/me
//
// Reports whether the session cookie holds a live Otra Guide sign-in.

import { json } from "../admin/api/_auth.js";
import { clearSessionCookie, readSessionToken, resolveUser } from "../_lib/session.js";

export async function onRequestGet(context) {
  const token = readSessionToken(context.request);
  if (!token) return json({ signedIn: false });

  const result = await resolveUser(token, context.env);
  if (result.user) return json({ signedIn: true, user: result.user });

  const res = json({ signedIn: false });
  if (result.rejected) res.headers.set("set-cookie", clearSessionCookie());
  return res;
}
