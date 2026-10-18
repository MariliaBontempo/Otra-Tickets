// Cloudflare Pages Function: POST /api/logout

import { json } from "../admin/api/_auth.js";
import { rejectCrossSite } from "../_lib/csrf.js";
import { clearSessionCookie } from "../_lib/session.js";

export async function onRequestPost(context) {
  const refused = rejectCrossSite(context.request);
  if (refused) return refused;
  const res = json({ signedIn: false });
  res.headers.set("set-cookie", clearSessionCookie());
  return res;
}
