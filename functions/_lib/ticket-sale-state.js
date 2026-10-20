// Where each ticket type stands in its own sale window, worked out per
// response (the base payload is edge cached) so a page flips from "goes on
// sale" to on sale, and from on sale to ended, as soon as the window moves.
// A ticket without a window (a site design rate) counts as on sale.

function time(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function ticketSale(ticket, now = Date.now()) {
  const start = time(ticket && ticket.saleStartsAt);
  const end = time(ticket && ticket.saleEndsAt);
  if (end !== null && end <= now) return "ended";
  if (start !== null && start > now) return "upcoming";
  return "on_sale";
}

// The page level state: on sale when any ticket is; otherwise upcoming with
// the earliest opening; otherwise ended. No ticket types at all is "none".
export function ticketSaleState(tickets, now = Date.now()) {
  const list = Array.isArray(tickets) ? tickets : [];
  if (!list.length) return { state: "none", opensAt: null };
  const sales = list.map((t) => ticketSale(t, now));
  if (sales.includes("on_sale")) return { state: "on_sale", opensAt: null };
  const openings = list
    .filter((t, i) => sales[i] === "upcoming")
    .map((t) => time(t.saleStartsAt))
    .sort((a, b) => a - b);
  if (openings.length) return { state: "upcoming", opensAt: new Date(openings[0]).toISOString() };
  return { state: "ended", opensAt: null };
}

// Only Guide ticket types carry a window; site design rates pass through untouched.
export function withSaleState(tickets, now = Date.now()) {
  return (Array.isArray(tickets) ? tickets : []).map((t) =>
    t && ("saleStartsAt" in t || "saleEndsAt" in t) ? { ...t, sale: ticketSale(t, now) } : t,
  );
}
