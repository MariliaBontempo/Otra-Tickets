// Pages-convention router over a functions/ file listing. Pure logic.
export function buildRouteTable(fileList) {
  const routes = [];
  for (const rel of fileList) {
    if (!rel.endsWith(".js")) continue;
    const parts = rel.split("/");
    if (parts.some((p) => p.startsWith("_"))) continue;
    const base = parts.pop().slice(0, -3); // drop .js
    const segments = [...parts, base].map((seg) => {
      if (seg.startsWith("[[") && seg.endsWith("]]"))
        return { kind: "catchall", name: seg.slice(2, -2) };
      if (seg.startsWith("[") && seg.endsWith("]"))
        return { kind: "param", name: seg.slice(1, -1) };
      return { kind: "static", value: seg };
    });
    routes.push({ modulePath: rel, segments });
  }
  // Most-specific first: more static segments, then fewer dynamic ones.
  routes.sort((a, b) => score(b) - score(a));
  return routes;
}
function score(route) {
  let s = 0;
  for (const seg of route.segments) {
    if (seg.kind === "static") s += 100;
    else if (seg.kind === "param") s += 10;
    else s += 1;
  }
  return s;
}
export function resolveRoute(routes, pathname) {
  const segs = pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
  outer: for (const route of routes) {
    const params = {};
    let i = 0;
    for (let r = 0; r < route.segments.length; r++) {
      const pat = route.segments[r];
      if (pat.kind === "catchall") {
        if (r !== route.segments.length - 1) continue outer;
        params[pat.name] = segs.slice(i);
        return { modulePath: route.modulePath, params };
      }
      if (i >= segs.length) continue outer;
      if (pat.kind === "static") {
        if (segs[i] !== pat.value) continue outer;
      } else {
        params[pat.name] = segs[i];
      }
      i++;
    }
    if (i !== segs.length) continue outer;
    return { modulePath: route.modulePath, params };
  }
  return null;
}
