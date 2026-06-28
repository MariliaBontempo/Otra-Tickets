// Cloudflare Pages Function: GET /admin/api/events
//
// Staff-only proxy used by the Claude Design draft modal to find an existing
// Otra Guide event and hydrate its ticket types before creating an Otra Tickets
// draft that points at that event.

import { apiBase, requireStaff, json } from "./_auth.js";

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
      await otraWrite(context, accessToken, `/ticket/create/tickets/${eventId}/${ticket.id}/`, {
        method: "PATCH",
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

async function searchEvents(context, accessToken, query, region) {
  const ids = new Set();

  if (/^\d+$/.test(query)) ids.add(Number(query));
  const addCandidate = (event) => {
    if (event && event.id && matchesQuery(event, query)) ids.add(Number(event.id));
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
  const [detail, ticketData] = await Promise.all([
    otraJson(context, accessToken, `/events/details/${eventId}/`),
    otraJson(context, accessToken, `/ticket/purchase/tickets/${eventId}/`),
  ]);
  if (!detail || !detail.id) return null;

  const tickets = (ticketData && Array.isArray(ticketData.results) ? ticketData.results : []).map((ticket) => ({
    id: ticket.id,
    name: ticket.name || "Ticket",
    description: ticket.description || "",
    price: ticket.price || "0.00",
    quantity: Number.isSafeInteger(Number(ticket.quantity)) && Number(ticket.quantity) > 0 ? Number(ticket.quantity) : 500,
    remainingQuantity: Number.isSafeInteger(Number(ticket.remaining_quantity)) ? Number(ticket.remaining_quantity) : null,
    currency: (ticket.base_currency && ticket.base_currency.code) || ticket.base_currency || "USD",
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
    isTicketed: !!detail.is_ticketed,
    published: typeof detail.published === "boolean" ? detail.published : null,
    image: detail.full_web_image_url || detail.half_web_image_url || detail.card_image_url || "",
    teamId: detail.team && detail.team.id ? detail.team.id : null,
    teamName: detail.team && detail.team.name ? detail.team.name : "",
    regionId: detail.team && detail.team.region ? detail.team.region : null,
    tickets,
  };
}

async function otraJson(context, accessToken, path) {
  try {
    const response = await fetch(`${apiBase(context.env)}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  } catch {
    return null;
  }
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
  if (!id || !existingById.has(String(id))) throw new Error("invalid ticket type");
  const name = String((ticket && ticket.name) || "").trim();
  if (!name) throw new Error("ticket name is required");
  const numericPrice = Number(ticket && ticket.price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) throw new Error(`invalid price for ${name}`);
  const quantity = cleanInteger(ticket && ticket.quantity);
  if (!quantity) throw new Error(`invalid quantity for ${name}`);
  const currency = String((ticket && ticket.currency) || "").toUpperCase();
  if (!["USD", "EUR", "ANG"].includes(currency)) throw new Error(`invalid currency for ${name}`);
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
