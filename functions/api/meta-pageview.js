// No-JS fallback: keep localhost/staging out of the production pixel too.
export function onRequestGet({ request }) {
  const url = new URL(request.url);
  const headers = { "cache-control": "no-store" };
  if (url.protocol !== "https:" || !["otratickets.com", "www.otratickets.com"].includes(url.hostname)) {
    return new Response(null, { status: 204, headers });
  }
  const pixel = new URL("https://www.facebook.com/tr?id=9500041730032996&ev=PageView&noscript=1");
  try {
    const page = new URL(request.headers.get("referer"));
    if (page.origin === url.origin) {
      if (page.searchParams.has("_preview") || page.searchParams.get("adminView") === "1") {
        return new Response(null, { status: 204, headers });
      }
      pixel.searchParams.set("dl", page.origin + page.pathname);
    }
  } catch { /* Referrer may be withheld by the browser. */ }
  return new Response(null, {
    status: 302,
    headers: { ...headers, location: pixel.href },
  });
}
