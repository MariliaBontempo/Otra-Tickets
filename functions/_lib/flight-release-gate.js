// Held tiers that stay off the page until Guide itself starts selling them.
//
// Strange Bird Saturday 28 Nov (Guide 8270): Flight 3 stays off sale until
// Flight 1 AND Flight 2 sell out. Calendar owns that rule (PR #1828): Guide's
// sale list holds Flight 3 (types 543/544/549) back until the Flight 1 pool
// (538) and the Flight 2 pool (541) are sold out, so the checkout embed does
// not offer it and a direct purchase is rejected.
//
// Release signal (agreed with Calendar): a Flight 3 tier appears in the live
// public feed GET /api/ticket/purchase/tickets/8270/. OT does not judge sold
// out itself. remaining_quantity on Flight 1/Flight 2 is NOT a release
// signal: once the parent sale window closes on 13 Nov it can read 0 while
// Flight 3 must stay held, which would show Flight 3 rate cards the checkout
// cannot sell. Guide is the source of truth: whatever it lists, the page shows.

export const FLIGHT_RELEASE_GATES = Object.freeze({
  "8270": Object.freeze({
    // Parent 543, Early Bird 544, Regular 549. The page payload carries
    // names only (Guide feed tickets and site design rates), so hiding goes
    // by name; the release check also accepts these ids.
    held: Object.freeze({
      label: "Flight 3",
      namePattern: /^\s*flight\s*3(?!\d)/i,
      ticketTypeIds: Object.freeze([543, 544, 549]),
    }),
  }),
});

export function flightReleaseGate(guideEventId) {
  const key = String(guideEventId ?? "");
  return Object.prototype.hasOwnProperty.call(FLIGHT_RELEASE_GATES, key) ? FLIGHT_RELEASE_GATES[key] : null;
}

function paidPrice(price) {
  const n = typeof price === "string" && price.trim() !== "" ? Number(price) : price;
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

// One feed row is a sellable held tier: a paid row named like the held tier,
// or carrying one of its ids (as id or parent).
function feedRowIsHeldTier(gate, row) {
  if (!row || typeof row !== "object") return false;
  const ids = new Set(gate.held.ticketTypeIds.map(Number));
  const byName = typeof row.name === "string" && gate.held.namePattern.test(row.name);
  const byId = ids.has(Number(row.id)) || (row.parent_ticket_type != null && ids.has(Number(row.parent_ticket_type)));
  return (byName || byId) && paidPrice(row.price);
}

// True only when the live Guide feed lists the held tier for sale. A missing,
// failed, empty or unreadable feed keeps it held (fail closed).
export function heldTierReleased(feed, gate) {
  if (!gate) return true;
  if (!feed || !Array.isArray(feed.results) || !feed.results.length) return false;
  return feed.results.some((row) => feedRowIsHeldTier(gate, row));
}

function isHeld(gate, item) {
  return !!item && typeof item === "object" && typeof item.name === "string" && gate.held.namePattern.test(item.name);
}

// The page payload with the held tier taken out of its rate cards and its
// site design rates. Released (or ungated) payloads come back unchanged.
export function withHeldTiersHidden(payload, gate, released) {
  if (!gate || released || !payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  if (Array.isArray(out.tickets)) out.tickets = out.tickets.filter((t) => !isHeld(gate, t));
  if (out.design && typeof out.design === "object" && Array.isArray(out.design.rates)) {
    out.design = { ...out.design, rates: out.design.rates.filter((r) => !isHeld(gate, r)) };
  }
  return out;
}
