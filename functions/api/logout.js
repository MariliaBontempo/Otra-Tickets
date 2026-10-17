// Cloudflare Pages Function: POST /api/logout

import { json } from "../admin/api/_auth.js";
import { clearSessionCookie } from "../_lib/session.js";

export async function onRequestPost() {
  const res = json({ signedIn: false });
  res.headers.set("set-cookie", clearSessionCookie());
  return res;
}
