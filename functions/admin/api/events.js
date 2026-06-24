// Cloudflare Pages Function: GET /admin/api/events
//
// Staff-only proxy used by the Claude Design draft modal to find an existing
// Otra Guide event and hydrate its ticket types before creating an Otra Tickets
// draft that points at that event.

import { apiBase, requireStaff, json } from "./_auth.js";

const CATEGORY_ID = 339;
const PAGE_SIZE = 12;
const FEED_SCAN_PAGES = 8;
const MAX_HYDRATE = 40;

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

async function searchEvents(context, accessToken, query, region) {
  const ids = new Set();

  if (/^\d+$/.test(query)) ids.add(Number(query));

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
    if (event && event.id) ids.add(Number(event.id));
  }

  for (const event of await scanCategoryFeed(context, accessToken, query, region)) {
    if (event && event.id) ids.add(Number(event.id));
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
  const response = await fetch(`${apiBase(context.env)}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
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
