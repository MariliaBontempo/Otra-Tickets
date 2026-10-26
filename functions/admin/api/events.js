// Cloudflare Pages Function: GET /admin/api/events
//
// Staff-only proxy used by the Claude Design draft modal to find an existing
// Otra Guide event and hydrate its ticket types before creating an Otra Tickets
// draft that points at that event.

import { apiBase, otraGet, requireStaff, staffSession, json } from "./_auth.js";
import { actorForAudit, appendAudit } from "./_audit.js";

const CATEGORY_ID = 339;
const PAGE_SIZE = 12;
const FEED_SCAN_PAGES = 8;
const MAX_HYDRATE = 16;

export async function onRequestGet(context) {
  const accessToken = await requireStaff(context.request, context.env);
  if (!accessToken) return json({ error: "unauthorized" }, 401);

  const url = new URL(context.request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const region = (url.searchParams.get("region") || "").trim();
  const id = cleanInteger(url.searchParams.get("id"));

  if (id) {
    const event = await hydrateEvent(context, accessToken, id);
    return event ? json({ events: [event] }) : json({ error: "event not found" }, 404);
  }

  if (query.length < 2) return json({ events: [] });

  const events = await searchEvents(context, accessToken, query, region);
  return json({ events });
}

export async function onRequestPut(context) {
  const accessToken = await requireStaff(context.request, context.env);
  if (!accessToken) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  // Date sync: {eventId, startDate: "YYYY-MM-DD"} moves the real event to a
  // new day, preserving the original start time and duration so the checkout
  // calendar, feeds and emails follow the page edit.
  if (body && body.startDate && !body.tickets) {
    return updateEventDate(context, accessToken, body);
  }

  const eventId = cleanInteger(body && body.eventId);
  const submitted = body && Array.isArray(body.tickets) ? body.tickets : [];
  if (!eventId) return json({ error: "event id is required" }, 400);
  if (!submitted.length) return json({ error: "at least one ticket type is required" }, 400);

  const current = await hydrateEvent(context, accessToken, eventId);
  if (!current) return json({ error: "event not found" }, 404);
  const existingById = new Map(current.tickets.map((ticket) => [String(ticket.id), ticket]));

  let tickets;
  try {
    tickets = submitted.map((ticket) => normalizeTicketInput(ticket, existingById));
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  try {
    for (const ticket of tickets) {
      const path = ticket.id
        ? `/ticket/create/tickets/${eventId}/${ticket.id}/`
        : `/ticket/create/tickets/${eventId}/`;
      await otraWrite(context, accessToken, path, {
        method: ticket.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: ticket.name,
          description: ticket.description,
          price: ticket.price,
          quantity: ticket.quantity,
          base_currency: ticket.currency,
        }),
      });
    }
    await syncDraftTickets(context.env, body && body.draftId, eventId, tickets);
    const updated = await hydrateEvent(context, accessToken, eventId);
    return json({ event: updated });
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}

// DELETE /admin/api/events  {eventId, ticketTypeId, confirmName, draftId}
//
// Deletes one ticket type on Otra Guide, then drops it from every Otra
// Tickets page bound to that event. Built to never delete the wrong thing:
// - the ticket type must still belong to the event Otra Guide reports now
// - the caller must retype the exact ticket name
// - the last ticket type of a checkout is never deleted
// - a ticket type with any sold ticket, or with no readable ticket count, is
//   refused here, and Otra Guide refuses a sold type again on its side
// - "Nothing was deleted" is only said when Otra Guide gave a final answer
//   (a 4xx) and a full re-read still shows the type; a timeout, a network
//   error, a 5xx or a partial re-read leaves the result unknown
// - page changes are planned and saved as a pending cleanup before the Otra
//   Guide call, so a cleanup that fails after the delete can be finished by
//   sending the same request again
export async function onRequestDelete(context) {
  const session = await staffSession(context.request, context.env);
  if (!session) return json({ error: "unauthorized" }, 401);
  const accessToken = session.token;

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const eventId = cleanInteger(body && body.eventId);
  const ticketTypeId = cleanInteger(body && body.ticketTypeId);
  if (!eventId) return json({ error: "event id is required" }, 400);
  if (!ticketTypeId) return json({ error: "ticket type id is required" }, 400);
  const kv = context.env && context.env.OVERRIDES;
  const typed = String((body && body.confirmName) || "").trim();

  const before = await readCheckout(context, accessToken, eventId);
  const current = before.event;
  if (!current || String(current.id) !== String(eventId)) return json({ error: "event not found. Nothing was deleted." }, 404);
  const ticket = current.tickets.find((item) => String(item.id) === String(ticketTypeId));
  if (!ticket) {
    // The type is gone on Otra Guide. If an earlier delete of it left its page
    // cleanup unfinished, finish that cleanup (no Otra Guide call).
    const pending = kv ? await kv.get(pendingDeleteKey(eventId, ticketTypeId), "json").catch(() => null) : null;
    if (pending && String(pending.eventId) === String(eventId) && String(pending.ticketTypeId) === String(ticketTypeId)) {
      if (!typed || typed !== String(pending.name || "").trim()) {
        return json({ error: `Type the exact ticket name "${pending.name}" to finish updating the pages.`, code: "confirm_name" }, 409);
      }
      if (!trustedReread(before, pending)) {
        return json({
          error: `Otra Tickets could not re-read the full checkout from Otra Guide, so the pages for ${pending.name} were not updated yet. Wait a minute, then press Delete again.`,
          code: "guide_delete_unknown",
        }, 502);
      }
      return finishDeleteCleanup(context, session, kv, pending, current, true);
    }
    return json({ error: "This ticket type is no longer on this event. Reload the checkout. Nothing was deleted." }, 409);
  }
  if (current.tickets.length <= 1) {
    return json({ error: "A checkout needs at least one ticket type. Add the replacement first, then delete this one. Nothing was deleted." }, 400);
  }
  if (!typed || typed !== String(ticket.name || "").trim()) {
    return json({ error: `Type the exact ticket name "${ticket.name}" to confirm. Nothing was deleted.` }, 400);
  }
  // The staff search reports no remaining count, so read the counts from the
  // public rate list (same list the page renders). That list also fixes the row the
  // type sits on, so page edits pinned to later rate rows move up one.
  const rateList = await publicRateList(context, accessToken, eventId);
  const rateIndex = rateList.findIndex((item) => String(item && item.id) === String(ticketTypeId));
  const rateRow = rateIndex >= 0 ? rateIndex + 1 : 0;
  const listed = rateIndex >= 0 ? rateList[rateIndex] : null;
  // Both counts come from that one list (the hydrated quantity may be a 500
  // default). A type off sale is missing from it, so its count is unknown.
  // Fail closed: without a consistent count Otra Tickets never sends the delete.
  const sold = listedSoldCount(listed);
  if (sold === null) {
    return json({
      error: `Otra Tickets can't confirm that ${ticket.name} has no sold tickets, because Otra Guide shows no usable ticket count for it (it may not be on sale right now). Nothing was deleted. Delete it in the Otra Guide ticketing dashboard, which checks sold tickets itself.`,
      code: "ticket_type_sold_unknown",
    }, 409);
  }
  if (sold > 0) {
    return json({
      error: `${ticket.name} already has ${sold} sold ticket${sold === 1 ? "" : "s"}. It can't be deleted. Nothing was deleted.`,
      code: "ticket_type_sold",
      sold,
    }, 409);
  }

  // Plan every page change and save it before Otra Guide is called. If that
  // save fails, nothing is sent to Otra Guide.
  let plan;
  try {
    plan = await planSiteEventCleanup(kv, { draftId: body && body.draftId, eventId, ticketTypeId });
  } catch {
    return json({ error: "Otra Tickets could not read its pages to plan the update. Nothing was deleted. Try again." }, 503);
  }
  if (plan.ambiguous.length) {
    return json({
      error: `The Otra Tickets page ${plan.ambiguous[0]} lists ${ticket.name} more than once, so Otra Tickets can't tell which price row to drop. Fix that page's ticket list first. Nothing was deleted.`,
      code: "draft_ambiguous",
    }, 409);
  }
  // One delete of a type at a time: a second request while one is open
  // would move the same page edits twice.
  const open = kv ? await kv.get(pendingDeleteKey(eventId, ticketTypeId), "json").catch(() => null) : null;
  if (open && Date.now() - Date.parse(open.createdAt || 0) < PENDING_DELETE_LOCK_MS) {
    return json({
      error: `A delete of ${ticket.name} is already running. Wait a minute, then press Delete again with the same name. Nothing was deleted by this request.`,
      code: "delete_in_progress",
    }, 409);
  }
  let pending;
  try {
    pending = {
      eventId: String(eventId),
      ticketTypeId: String(ticketTypeId),
      name: ticket.name,
      price: ticket.price,
      currency: ticket.currency,
      guideRow: rateRow,
      otherIds: current.tickets.filter((item) => String(item.id) !== String(ticketTypeId)).map((item) => String(item.id)),
      siteKeys: plan.siteKeys,
      draftRows: plan.draftRows,
      auditPageId: plan.auditPageId,
      done: [],
      stamps: {},
      createdAt: new Date().toISOString(),
    };
    if (kv) await kv.put(pendingDeleteKey(eventId, ticketTypeId), JSON.stringify(pending));
  } catch {
    return json({ error: "Otra Tickets could not prepare the page updates. Nothing was deleted. Try again." }, 503);
  }
  const forgetPending = async () => {
    if (kv && typeof kv.delete === "function") await kv.delete(pendingDeleteKey(eventId, ticketTypeId)).catch(() => {});
  };

  const result = await guideDeleteTicketType(context, accessToken, eventId, ticketTypeId);
  // Re-read the checkout. It is only trusted when every other ticket type
  // from before the delete is still listed (a failed ticket read can come
  // back as an empty list, which must never count as "deleted").
  const reread = await readCheckout(context, accessToken, eventId).catch(() => ({ event: null, complete: false }));
  const after = reread.event;
  const unknown = (why) => json({
    error: `${why} so Otra Tickets can't tell yet whether ${ticket.name} was deleted. Otra Tickets pages were not changed. Wait a minute, then press Delete again with the same name: Otra Tickets checks Otra Guide again first and only updates its pages once ${ticket.name} is gone.`,
    code: "guide_delete_unknown",
  }, 502);
  if (!trustedReread(reread, pending)) return unknown("Otra Tickets could not re-read the full checkout from Otra Guide,");
  const stillThere = after.tickets.some((item) => String(item.id) === String(ticketTypeId));
  if (stillThere) {
    // A 4xx is Otra Guide's final answer: it refused, and the type is still there.
    if (result.status >= 400 && result.status < 500) {
      await forgetPending();
      if (result.status === 404 || result.status === 405) {
        return json({
          error: "Otra Guide does not accept ticket type deletes from Otra Tickets yet. Nothing was deleted. Delete it in the Otra Guide ticketing dashboard for now.",
          code: "guide_delete_unavailable",
        }, 501);
      }
      if (result.status === 400) {
        return json({
          error: `${result.message || "Otra Guide refused the delete."} Nothing was deleted.`,
          code: /sold/i.test(result.message) ? "ticket_type_sold" : "guide_refused",
        }, 409);
      }
      return json({ error: `${result.message || "Otra Guide refused the delete."} Nothing was deleted.`, code: "guide_refused" }, 502);
    }
    // OK while still listed, no answer, a timeout or a 5xx: the delete may
    // still finish on Otra Guide, so the pending cleanup is kept.
    if (result.ok) return unknown("Otra Guide answered OK but the ticket type still shows on the checkout,");
    return unknown(`Otra Guide did not give a clear answer (${result.status ? `error ${result.status}` : "no answer"}),`);
  }

  return finishDeleteCleanup(context, session, kv, pending, after);
}

// Longer than the 30 s Otra Guide timeout plus the re-read.
const PENDING_DELETE_LOCK_MS = 2 * 60 * 1000;

export function pendingDeleteKey(eventId, ticketTypeId) {
  return `ticket-delete:${eventId}:${ticketTypeId}`;
}

// A re-read is trusted only when the staff search answered (the public
// fallback hides types that are off sale), it is the same event, and it lists
// every other ticket type that was there before the delete.
export function trustedReread(read, pending) {
  const event = read && read.complete ? read.event : null;
  if (!event || !Array.isArray(event.tickets) || !pending) return false;
  if (String(event.id) !== String(pending.eventId)) return false;
  const ids = new Set(event.tickets.map((item) => String(item.id)));
  const others = Array.isArray(pending.otherIds) ? pending.otherIds : [];
  return others.length > 0 && others.every((id) => ids.has(String(id)));
}

// Runs the saved page cleanup. Every step is recorded as done in the pending
// cleanup, so sending the request again only runs what is left.
async function finishDeleteCleanup(context, session, kv, pending, after, finishedEarlierDelete = false) {
  let pagesUpdated = 0;
  let pageEditsMoved = 0;
  try {
    ({ pagesUpdated, pageEditsMoved } = await runPageCleanup(kv, pending));
    if (kv && typeof kv.delete === "function") await kv.delete(pendingDeleteKey(pending.eventId, pending.ticketTypeId));
  } catch {
    return json({
      error: `${pending.name} was deleted on Otra Guide, but Otra Tickets pages were not fully updated yet. Press Delete again with the same name to finish updating the pages.`,
      code: "pages_not_updated",
      deletedOnGuide: true,
      event: after,
      deleted: { id: Number(pending.ticketTypeId), name: pending.name },
    }, 500);
  }
  // The public page caches the event's rate list; drop it so the page and
  // the moved page edits change together.
  try {
    if (typeof caches !== "undefined" && caches.default) {
      await caches.default.delete(new Request(new URL(`/api/event-base-v2?id=${pending.eventId}`, context.request.url)));
    }
  } catch {}
  await appendAudit(kv, {
    actor: await actorForAudit(session.token, session.role, context.env),
    action: "save",
    pageId: pending.auditPageId || String(pending.eventId),
    changedFields: [`ticket-type-deleted:${pending.ticketTypeId}:${pending.name}`],
  });
  return json({
    event: after,
    deleted: { id: Number(pending.ticketTypeId), name: pending.name, price: pending.price, currency: pending.currency },
    pagesUpdated,
    pageEditsMoved,
    finishedEarlierDelete,
  });
}

export async function runPageCleanup(kv, pending) {
  if (!kv) return { pagesUpdated: 0, pageEditsMoved: 0 };
  const key = pendingDeleteKey(pending.eventId, pending.ticketTypeId);
  const done = new Set(Array.isArray(pending.done) ? pending.done : []);
  const stamps = { ...(pending.stamps || {}) };
  const save = () => kv.put(key, JSON.stringify({ ...pending, done: [...done], stamps }));
  const mark = async (step) => {
    done.add(step);
    await save();
  };
  let pagesUpdated = 0;
  for (const siteKey of pending.siteKeys || []) {
    const step = `site:${siteKey}`;
    if (done.has(step)) continue;
    const project = await kv.get(siteKey, "json");
    if (project && String(project.otraGuideId || "") === String(pending.eventId)) {
      const next = withoutTicketType(project, pending.ticketTypeId);
      if (next) {
        await kv.put(siteKey, JSON.stringify(next));
        pagesUpdated += 1;
      }
    }
    await mark(step);
  }
  const draftRows = new Map(Object.entries(pending.draftRows || {}));
  const pageEditsMoved = await shiftRateOverrides(kv, {
    eventId: pending.eventId,
    guideRow: pending.guideRow,
    draftRows,
    // A page edit move is recorded with the version stamp it writes before
    // it is written, so a retry after a lost progress save never moves it twice.
    skip: (overrideKey, doc) => done.has(`edit:${overrideKey}`)
      || Boolean(stamps[overrideKey] && doc && doc.updatedAt === stamps[overrideKey]),
    beforeWrite: async (overrideKey, stamp) => {
      stamps[overrideKey] = stamp;
      await save();
    },
    onDone: (overrideKey) => mark(`edit:${overrideKey}`),
  });
  return { pagesUpdated, pageEditsMoved };
}

// A count Otra Guide may leave out. null (not 0) when it is missing, so an
// unknown remaining count never reads as "0 remaining, all sold".
export function optionalCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Sold tickets of one public rate list row (quantity minus remaining), or
// null when the counts are missing or inconsistent (no positive quantity, or
// more remaining than the quantity). null always blocks the delete.
export function listedSoldCount(listed) {
  const quantity = optionalCount(listed && listed.quantity);
  const remaining = optionalCount(listed && listed.remaining_quantity);
  if (quantity === null || quantity <= 0 || remaining === null || remaining > quantity) return null;
  return quantity - remaining;
}

async function guideDeleteTicketType(context, accessToken, eventId, ticketTypeId) {
  let response;
  try {
    response = await fetch(`${apiBase(context.env)}/ticket/create/tickets/${eventId}/${ticketTypeId}/`, {
      method: "DELETE",
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return { ok: false, status: 0, message: "could not reach Otra Guide" };
  }
  const data = await response.json().catch(() => ({}));
  const message = (data && (data.error || data.detail)) || "";
  return { ok: response.ok, status: response.status, message: String(message) };
}

// Drop the deleted type from a page bound to the event so the page price list
// and a later publish never bring it back. reconcileTickets pairs
// claudeDesign.rates[i], ticketTypeIds[i] and ticketQuantities[i] by index, so
// the same index is removed from each list that has it; every other type keeps
// its rate and quantity. Matches on the exact ticket type id only.
export function withoutTicketType(project, ticketTypeId) {
  const ids = Array.isArray(project && project.ticketTypeIds) ? project.ticketTypeIds : [];
  const index = ids.findIndex((id) => String(id) === String(ticketTypeId));
  if (index < 0) return null;
  const keep = (list) => (Array.isArray(list) ? list.filter((_, i) => i !== index) : list);
  const design = project.claudeDesign && typeof project.claudeDesign === "object" ? project.claudeDesign : null;
  const next = {
    ...project,
    ticketTypeIds: keep(ids),
    ticketQuantities: keep(project.ticketQuantities),
  };
  if (design && Array.isArray(design.rates)) {
    next.claudeDesign = { ...design, rates: keep(design.rates) };
  }
  return next;
}

// The rate row (1 based) a draft page shows this type on. A draft page renders
// its claudeDesign.rates, and rates[i] belongs to ticketTypeIds[i]; 0 means
// the draft shows no row for the type, so its rate rows do not move.
export function draftRateRow(project, ticketTypeId) {
  const ids = Array.isArray(project && project.ticketTypeIds) ? project.ticketTypeIds : [];
  const index = ids.findIndex((id) => String(id) === String(ticketTypeId));
  const design = project && project.claudeDesign && typeof project.claudeDesign === "object" ? project.claudeDesign : null;
  if (index < 0 || !design || !Array.isArray(design.rates) || index >= design.rates.length) return 0;
  return index + 1;
}

// Read only: which draft pages are bound to the event and list the type, and
// the rate row each one shows it on.
export async function planSiteEventCleanup(kv, { draftId, eventId, ticketTypeId }) {
  const plan = { siteKeys: [], draftRows: {}, ambiguous: [], auditPageId: String(eventId) };
  if (!kv) return plan;
  const seen = new Set();
  const consider = async (key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const project = await kv.get(key, "json");
    if (!project || String(project.otraGuideId || "") !== String(eventId)) return;
    if (!withoutTicketType(project, ticketTypeId)) return;
    const ids = Array.isArray(project.ticketTypeIds) ? project.ticketTypeIds : [];
    if (ids.filter((id) => String(id) === String(ticketTypeId)).length > 1) {
      plan.ambiguous.push(key.slice("site-event:".length));
      return;
    }
    plan.siteKeys.push(key);
    const row = draftRateRow(project, ticketTypeId);
    if (row) plan.draftRows[key.slice("site-event:".length)] = row;
  };
  const ownDraft = /^draft-[a-zA-Z0-9-]+$/.test(String(draftId || "")) ? String(draftId) : "";
  if (ownDraft) await consider(`site-event:${ownDraft}`);
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) await consider(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (ownDraft && plan.siteKeys.includes(`site-event:${ownDraft}`)) plan.auditPageId = ownDraft;
  return plan;
}

async function publicRateList(context, accessToken, eventId) {
  const data = await otraJson(context, accessToken, `/ticket/purchase/tickets/${eventId}/`);
  return data && Array.isArray(data.results) ? data.results : [];
}

// Page edits on rate rows are pinned by position (#evRates > div:nth-of-type(N)).
// Once a type is gone every later row moves up one, so its edits must move
// with it: drop the deleted row's edits, renumber the rows after it. Without
// this a price edit of the next row would show on (and a later price pencil
// sync would target) the wrong ticket type.
const RATE_ROW_KEY_RE = /^([a-z]+:(?:main > )?#evRates > div:nth-of-type\()(\d+)(\).*)$/;

export function shiftRateFields(fields, row) {
  if (!fields || typeof fields !== "object") return { fields, changed: false };
  const next = {};
  let changed = false;
  for (const [key, field] of Object.entries(fields)) {
    const match = RATE_ROW_KEY_RE.exec(key);
    const n = match ? Number(match[2]) : 0;
    if (!match || n < row) {
      next[key] = field;
    } else if (n === row) {
      changed = true;
    } else {
      next[`${match[1]}${n - 1}${match[3]}`] = field;
      changed = true;
    }
  }
  return { fields: next, changed };
}

// Each page renders its own rate list, so each moves by its own row:
// - a draft page (event:draft-...) renders its claudeDesign.rates, so it moves
//   only when that draft lost the type, by the row it had there;
// - an Otra Guide event page renders the checkout event's public rate list, so
//   it moves by that row, and only when it sells through this event.
// skip/onDone let a resumed cleanup leave alone the pages it already moved.
export async function shiftRateOverrides(kv, { eventId, guideRow, draftRows, skip, beforeWrite, onDone }) {
  if (!kv) return 0;
  const rows = draftRows instanceof Map ? draftRows : new Map();
  if (!guideRow && rows.size === 0) return 0;
  const keys = new Set([`event:${eventId}`, ...[...rows.keys()].map((id) => `event:${id}`)]);
  // A page may sell through this event without being bound to it.
  if (guideRow) {
    let cursor;
    do {
      const page = await kv.list({ prefix: "event:", cursor });
      for (const key of page.keys || []) keys.add(key.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  let moved = 0;
  for (const key of keys) {
    if (typeof skip === "function" && skip(key, null)) continue;
    const id = key.slice("event:".length);
    let row = 0;
    if (/^draft-/.test(id)) {
      row = rows.get(id) || 0;
    } else if (/^\d+$/.test(id)) {
      // Read the doc only for event pages; the checkout event decides the rates.
      row = guideRow;
    }
    if (!row) continue;
    const doc = await kv.get(key, "json");
    if (!doc || typeof doc !== "object") continue;
    if (!/^draft-/.test(id)) {
      const checkout = /^\d+$/.test(String(doc.checkoutEventId || "")) ? String(doc.checkoutEventId) : id;
      if (checkout !== String(eventId)) continue;
    }
    if (typeof skip === "function" && skip(key, doc)) continue;
    const { fields, changed } = shiftRateFields(doc.fields, row);
    if (!changed) continue;
    let stamp = new Date().toISOString();
    if (stamp === doc.updatedAt) stamp = new Date(Date.parse(stamp) + 1).toISOString();
    if (typeof beforeWrite === "function") await beforeWrite(key, stamp);
    await kv.put(key, JSON.stringify({ ...doc, fields, updatedAt: stamp }));
    if (typeof onDone === "function") await onDone(key);
    moved += 1;
  }
  return moved;
}

async function searchEvents(context, accessToken, query, region) {
  const adminParams = new URLSearchParams({ q: query });
  if (region) adminParams.set("region", region);
  const adminResults = await fetchAdminTicketedEvents(context, accessToken, adminParams);
  if (adminResults) {
    return adminResults.filter((event) => matchesQuery(event, query)).slice(0, PAGE_SIZE);
  }

  const ids = new Set();

  if (/^\d+$/.test(query)) ids.add(Number(query));
  const addCandidate = (event) => {
    if (event && event.id && !isPaymentLinkEvent(event) && matchesQuery(event, query)) ids.add(Number(event.id));
  };

  const nonPerennialParams = new URLSearchParams({
    category_id: String(CATEGORY_ID),
    filter_search: query,
    page: "1",
    page_size: String(PAGE_SIZE),
  });
  const perennialParams = new URLSearchParams({
    filter_search: query,
    page: "1",
    page_size: String(PAGE_SIZE),
  });
  const filteredParams = new URLSearchParams({
    filter_search: query,
    page: "1",
    page_size: String(PAGE_SIZE),
  });
  if (region) {
    nonPerennialParams.set("region", region);
    perennialParams.set("region", region);
    filteredParams.set("region", region);
  }

  const [nonPerennialFeed, perennialFeed, filteredFeed] = await Promise.all([
    otraJson(context, accessToken, `/events/nonperennial/?${nonPerennialParams.toString()}`),
    otraJson(context, accessToken, `/events/perennial/?${perennialParams.toString()}`),
    otraJson(context, accessToken, `/events/filtered/?${filteredParams.toString()}`),
  ]);
  for (const event of [
    ...feedResults(nonPerennialFeed),
    ...feedResults(perennialFeed),
    ...feedResults(filteredFeed),
  ]) {
    addCandidate(event);
  }

  for (const event of await scanCategoryFeed(context, accessToken, query, region)) {
    addCandidate(event);
  }

  const hydrated = await Promise.all([...ids].slice(0, MAX_HYDRATE).map((eventId) => hydrateEvent(context, accessToken, eventId)));
  return hydrated
    .filter((event) => event && Array.isArray(event.tickets) && event.tickets.length > 0 && matchesQuery(event, query))
    .slice(0, PAGE_SIZE);
}

async function scanCategoryFeed(context, accessToken, query, region) {
  const pages = await Promise.all(
    Array.from({ length: FEED_SCAN_PAGES }, (_, index) => {
      const params = new URLSearchParams({
        category_id: String(CATEGORY_ID),
        page: String(index + 1),
        page_size: "50",
      });
      if (region) params.set("region", region);
      return otraJson(context, accessToken, `/events/nonperennial/?${params.toString()}`);
    })
  );
  const byId = new Map();
  for (const page of pages) {
    for (const event of feedResults(page)) {
      if (event && event.id && matchesQuery(event, query)) byId.set(Number(event.id), event);
    }
  }
  return [...byId.values()];
}

async function hydrateEvent(context, accessToken, eventId) {
  return (await readCheckout(context, accessToken, eventId)).event;
}

// complete: the staff search answered, which lists every ticket type of the
// event (the public fallback hides types that are off sale).
async function readCheckout(context, accessToken, eventId) {
  const adminResults = await fetchAdminTicketedEvents(
    context,
    accessToken,
    new URLSearchParams({ id: String(eventId) })
  );
  if (adminResults && adminResults.length) return { event: adminResults[0], complete: true };
  return { event: await hydrateFromPublic(context, accessToken, eventId), complete: false };
}

async function hydrateFromPublic(context, accessToken, eventId) {

  const [detail, ticketData] = await Promise.all([
    otraJson(context, accessToken, `/events/details/${eventId}/`),
    otraJson(context, accessToken, `/ticket/purchase/tickets/${eventId}/`),
  ]);
  if (!detail || !detail.id) return null;
  if (isPaymentLinkEvent(detail)) return null;

  const tickets = (ticketData && Array.isArray(ticketData.results) ? ticketData.results : []).map((ticket) => ({
    id: ticket.id,
    name: ticket.name || "Ticket",
    description: ticket.description || "",
    price: ticket.price || "0.00",
    quantity: Number.isSafeInteger(Number(ticket.quantity)) && Number(ticket.quantity) > 0 ? Number(ticket.quantity) : 500,
    remainingQuantity: optionalCount(ticket.remaining_quantity),
    currency: (ticket.base_currency && ticket.base_currency.code) || ticket.base_currency || "USD",
    isActive: ticket.is_active !== false && ticket.isActive !== false,
    saleStartDate: ticket.sale_start_time || ticket.saleStartDate || "",
    saleEndDate: ticket.sale_end_time || ticket.saleEndDate || "",
  }));

  return {
    id: detail.id,
    title: detail.title || `Event ${eventId}`,
    description: detail.description || "",
    slug: detail.slug || "",
    startDate: detail.start_date || "",
    endDate: detail.end_date || "",
    location: detail.location || "",
    isPerennial: !!detail.is_perennial,
    isRecurring: !!detail.is_recurring,
    isTicketed: !!detail.is_ticketed,
    published: typeof detail.published === "boolean" ? detail.published : null,
    image: detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    teamId: detail.team && detail.team.id ? detail.team.id : null,
    teamName: detail.team && detail.team.name ? detail.team.name : "",
    regionId: detail.team && detail.team.region ? detail.team.region : null,
    isPast: isPastEvent(detail.end_date || detail.start_date),
    tickets,
  };
}

async function fetchAdminTicketedEvents(context, accessToken, params) {
  const data = await otraJson(
    context,
    accessToken,
    `/events/admin-ticketed-search/?${params.toString()}`
  );
  if (!data || !Array.isArray(data.events)) return null;
  return data.events.map(normalizeAdminEvent).filter(Boolean);
}

function normalizeAdminEvent(event) {
  if (!event || !event.id) return null;
  if (isPaymentLinkEvent(event)) return null;
  return {
    id: event.id,
    title: event.title || `Event ${event.id}`,
    description: event.description || "",
    slug: event.slug || "",
    startDate: event.startDate || "",
    endDate: event.endDate || "",
    location: event.location || "",
    isPerennial: !!event.isPerennial,
    isRecurring: !!event.isRecurring,
    isTicketed: !!event.isTicketed,
    published: typeof event.published === "boolean" ? event.published : null,
    image: event.image || "",
    teamId: cleanInteger(event.teamId),
    teamName: event.teamName || "",
    regionId: cleanInteger(event.regionId),
    isPast: typeof event.isPast === "boolean" ? event.isPast : isPastEvent(event.endDate || event.startDate),
    tickets: (Array.isArray(event.tickets) ? event.tickets : []).map((ticket) => ({
      id: ticket.id,
      name: ticket.name || "Ticket",
      description: ticket.description || "",
      price: ticket.price || "0.00",
      quantity: Number.isSafeInteger(Number(ticket.quantity)) && Number(ticket.quantity) > 0 ? Number(ticket.quantity) : 500,
      remainingQuantity: optionalCount(ticket.remainingQuantity),
      currency: ticket.currency || "USD",
      isActive: ticket.isActive !== false,
      saleStartDate: ticket.saleStartDate || "",
      saleEndDate: ticket.saleEndDate || "",
    })),
  };
}

function isPaymentLinkEvent(event) {
  return String((event && event.slug) || "").toLowerCase().startsWith("payment-");
}

function isPastEvent(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) && date.getTime() < Date.now();
}


async function updateEventDate(context, accessToken, body) {
  const eventId = cleanInteger(body && body.eventId);
  const draftId = String((body && body.draftId) || "").trim();
  const startDate = String((body && body.startDate) || "").trim();
  if (!eventId) return json({ error: "event id is required" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return json({ error: "startDate must be YYYY-MM-DD" }, 400);

  const detail = await otraJson(context, accessToken, `/events/details/${eventId}/`);
  if (!detail || !detail.id) return json({ error: "event not found" }, 404);
  if (detail.is_perennial || detail.is_recurring) {
    return json({ error: "recurring events keep their schedule in the tickets dashboard - date NOT changed" }, 400);
  }
  // The public serializers don't expose slug (the update endpoint's address);
  // the isolated Otra Tickets media app provides it by id.
  const slugData = await otraJson(context, accessToken, `/otra-tickets/media/event-slug/${eventId}/`);
  const slug = (slugData && slugData.slug) || detail.slug;
  if (!slug) return json({ error: "event has no slug - date NOT changed" }, 400);
  const oldStart = new Date(detail.start_date);
  const oldEnd = new Date(detail.end_date || detail.start_date);
  if (Number.isNaN(oldStart.getTime())) return json({ error: "event has no valid start date" }, 400);

  // Keep the event's local wall-clock time: swap only the date portion of the
  // ISO string (start_date comes back like 2026-08-09T12:00:00-04:00).
  const swapDay = (iso, day) => String(iso).replace(/^\d{4}-\d{2}-\d{2}/, day);
  const durationMs = oldEnd.getTime() - oldStart.getTime();
  const newStartIso = swapDay(detail.start_date, startDate);
  const newEnd = new Date(new Date(newStartIso).getTime() + Math.max(0, durationMs));
  const endDay = newEnd.toISOString().slice(0, 10);
  // End keeps its own wall-clock time too; shift its date by the same number
  // of days the start moved.
  const dayMs = 86400000;
  const dayDelta = Math.round((new Date(startDate + "T00:00:00Z") - new Date(String(detail.start_date).slice(0, 10) + "T00:00:00Z")) / dayMs);
  const oldEndDay = new Date(String(detail.end_date || detail.start_date).slice(0, 10) + "T00:00:00Z");
  const newEndDay = new Date(oldEndDay.getTime() + dayDelta * dayMs).toISOString().slice(0, 10);
  const newEndIso = swapDay(detail.end_date || detail.start_date, newEndDay);

  const updated = await otraWrite(context, accessToken, `/events/update/${encodeURIComponent(slug)}/`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ start_date: newStartIso, end_date: newEndIso }),
  });

  // Ticket sale windows end at the event start; moving the event without
  // moving them leaves tickets "Currently Unavailable" (or closes sales too
  // late). Keep every ticket sellable right up to the new start.
  // Clone confirmation can skip this so a just-confirmed sale end is not wiped.
  if (!body.skipTicketSaleSync) {
    try {
      const ticketData = await otraJson(context, accessToken, `/ticket/purchase/tickets/${eventId}/`);
      const ticketList = (ticketData && Array.isArray(ticketData.results)) ? ticketData.results : [];
      for (const ticket of ticketList) {
        await otraWrite(context, accessToken, `/ticket/create/tickets/${eventId}/${ticket.id}/`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sale_end_time: newStartIso }),
        });
      }
    } catch {}
  }

  // The event page hero and the homepage cards read the site's own copies
  // (KV site-event dates + cached feed), not Django - keep them in step and
  // refresh the public feed so every date display moves together.
  try {
    const kv = context.env.OVERRIDES;
    if (kv) {
      await syncSiteEventDates(kv, { draftId, eventId, newStartIso, newEndIso });
    }
    const origin = new URL(context.request.url).origin;
    context.waitUntil(fetch(`${origin}/api/homepage-events?fresh=1`));
  } catch {}
  return json({ event: { id: detail.id, start_date: updated.start_date || newStartIso, end_date: updated.end_date || newEndIso } });
}

const PROJECT_DATE_RE = /(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi;

export function rewriteProjectDate(project, newStartIso, newEndIso) {
  const next = { ...project, startDate: newStartIso, endDate: newEndIso };
  const design = next.claudeDesign;
  if (!design || !Array.isArray(design.meta)) return next;
  const target = new Date(newStartIso);
  const label = target.toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/Curacao",
  });
  next.claudeDesign = {
    ...design,
    meta: design.meta.map((item) => String(item).replace(PROJECT_DATE_RE, label)),
  };
  return next;
}

export async function syncSiteEventDates(kv, { draftId, eventId, newStartIso, newEndIso }) {
  const touched = new Set();
  const updateKey = async (key) => {
    if (!key || touched.has(key)) return;
    const project = await kv.get(key, "json");
    if (!project) return;
    if (String(project.otraGuideId || "") !== String(eventId)) return;
    await kv.put(key, JSON.stringify(rewriteProjectDate(project, newStartIso, newEndIso)));
    touched.add(key);
  };

  // KV list() is eventually consistent. The clone response already gives us
  // the exact new draft id, so update that key directly before scanning for
  // any older copies bound to the same event.
  if (/^draft-[a-zA-Z0-9-]+$/.test(String(draftId || ""))) {
    await updateKey(`site-event:${draftId}`);
  }
  let cursor;
  do {
    const page = await kv.list({ prefix: "site-event:", cursor });
    for (const key of page.keys || []) await updateKey(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return touched.size;
}

async function otraJson(context, accessToken, path) {
  return (await otraGet(context.env, accessToken, path)).data;
}

async function otraWrite(context, accessToken, path, options) {
  let response;
  try {
    response = await fetch(`${apiBase(context.env)}${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("could not reach Otra Guide");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail || data.error || Object.values(data).flat().join(" ");
    throw new Error(detail || `Otra Guide request failed (${response.status})`);
  }
  return data;
}

function normalizeTicketInput(ticket, existingById) {
  const id = cleanInteger(ticket && ticket.id);
  if (id && !existingById.has(String(id))) throw new Error("invalid ticket type");
  const name = String((ticket && ticket.name) || "").trim();
  if (!name) throw new Error("ticket name is required");
  const numericPrice = Number(ticket && ticket.price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) throw new Error(`invalid price for ${name}`);
  const quantity = cleanInteger(ticket && ticket.quantity);
  if (!quantity) throw new Error(`invalid quantity for ${name}`);
  const currency = String((ticket && ticket.currency) || "").toUpperCase();
  if (!["USD", "EUR", "ANG", "XCG"].includes(currency)) throw new Error(`invalid currency for ${name}`);
  return {
    id,
    name,
    description: String((ticket && ticket.description) || "").trim(),
    price: numericPrice.toFixed(2),
    quantity,
    currency,
  };
}

async function syncDraftTickets(env, draftId, eventId, tickets) {
  const id = String(draftId || "").trim();
  const kv = env && env.OVERRIDES;
  if (!kv || !/^draft-[a-zA-Z0-9-]+$/.test(id)) return;
  const key = `site-event:${id}`;
  const project = await kv.get(key, "json");
  if (!project || String(project.otraGuideId || "") !== String(eventId)) return;
  const next = {
    ...project,
    claudeDesign: {
      ...(project.claudeDesign || {}),
      rates: tickets.map((ticket) => ({
        name: ticket.name,
        description: ticket.description,
        price: ticket.price,
        currency: ticket.currency,
      })),
    },
    ticketQuantities: tickets.map((ticket) => ticket.quantity),
    ticketTypeIds: tickets.map((ticket) => ticket.id),
  };
  await kv.put(key, JSON.stringify(next));
}

function cleanInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function feedResults(feed) {
  if (feed && Array.isArray(feed.results)) return feed.results;
  return Array.isArray(feed) ? feed : [];
}

function matchesQuery(event, query) {
  const normalizedTitle = normalizeSearchText(event && event.title);
  const normalizedId = String((event && event.id) || "");
  const terms = searchTerms(query);
  if (!terms.length) return false;
  return normalizedId.includes(String(query).trim()) || terms.every((term) => normalizedTitle.includes(term));
}

function searchTerms(value) {
  return normalizeSearchText(value)
    .split(" ")
    .map((term) => (term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term))
    .filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
