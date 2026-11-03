// Held tiers that open only once other tiers sell out (the Kaya Kaya way:
// quantity sold out -> next tier, no manual switch).
//
// Strange Bird Saturday 28 Nov (Guide 8270): Flight 3 stays off sale until
// Flight 1 AND Flight 2 have no sellable tickets left. Calendar applies the
// same rule to the checkout embed from the same live Guide feed; nothing is
// shared between the two sides but that feed.
//
// Same predicate as Calendar's Kaya style release (TicketType
// release_after_sold_out / release_after_pools_sold_out): Flight 3 (top level
// type 543) releases after the Flight 1 pool (parent 538) and the Flight 2
// pool (parent 541) are sold out. Tiers 539/547 and 542/548 sell from those
// parent pools; a Regular that is not active yet does not sell.

import { ticketSale } from "./ticket-sale-state.js";

export const FLIGHT_RELEASE_GATES = Object.freeze({
  "8270": Object.freeze({
    // Parent 543, Early Bird 544, Regular 549. Matched by name because the
    // page payload carries names only (Guide feed and site design rates).
    held: Object.freeze({ label: "Flight 3", namePattern: /^\s*flight\s*3(?!\d)/i }),
    releaseWhenSoldOut: Object.freeze([
      // Parent pool first, then the tiers that sell from it.
      Object.freeze({ label: "Flight 1", parentPool: 538, ticketTypeIds: Object.freeze([538, 539, 547]) }),
      Object.freeze({ label: "Flight 2", parentPool: 541, ticketTypeIds: Object.freeze([541, 542, 548]) }),
    ]),
  }),
});

export function flightReleaseGate(guideEventId) {
  const key = String(guideEventId ?? "");
  return Object.prototype.hasOwnProperty.call(FLIGHT_RELEASE_GATES, key) ? FLIGHT_RELEASE_GATES[key] : null;
}

// Sellable tickets left in one group, from the public Guide ticket feed: the
// group's paid ticket types that the feed lists (only active, released types
// are listed) and whose sale window is open. A tier sells from its parent's
// pool, so a tier counts when its id or its parent's id is in the group.
// null means unknown (the caller keeps the held tier hidden).
// This is the one place the sold out rule lives; swap it here if Calendar
// exposes a named field for it.
export function groupSellableRemaining(feed, group, now = Date.now()) {
  if (!feed || !Array.isArray(feed.results)) return null;
  const ids = new Set(group.ticketTypeIds.map(Number));
  let total = 0;
  for (const t of feed.results) {
    if (!t || typeof t !== "object") continue;
    if (!ids.has(Number(t.id)) && !(t.parent_ticket_type != null && ids.has(Number(t.parent_ticket_type)))) continue;
    if (!(Number(t.price) > 0)) continue;
    if (ticketSale({ saleStartsAt: t.sale_start_time || null, saleEndsAt: t.sale_end_time || null }, now) !== "on_sale") continue;
    const left = t.remaining_quantity;
    if (typeof left !== "number" || !Number.isFinite(left)) return null;
    total += Math.max(0, left);
  }
  return total;
}

// True only when the feed is live and every group it waits on is sold out.
export function heldTierReleased(feed, gate, now = Date.now()) {
  if (!gate) return true;
  if (!feed || !Array.isArray(feed.results) || !feed.results.length) return false;
  return gate.releaseWhenSoldOut.every((group) => groupSellableRemaining(feed, group, now) === 0);
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
