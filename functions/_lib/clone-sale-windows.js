// Shared helpers for forced confirmation of ticket sale windows when cloning.
// Date-only admin inputs become Curacao-offset ISO timestamps for Otra Guide.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURACAO_OFFSET = "-04:00";

export function toDay(value) {
  const raw = String(value || "").trim();
  if (DAY_RE.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return "";
}

export function dayToSaleStartIso(day) {
  const normalized = toDay(day);
  if (!normalized) return "";
  return `${normalized}T00:00:00${CURACAO_OFFSET}`;
}

export function dayToSaleEndIso(day) {
  const normalized = toDay(day);
  if (!normalized) return "";
  return `${normalized}T23:59:59${CURACAO_OFFSET}`;
}

export function buildCloneSaleWindowsFromSource(tickets, rates, options = {}) {
  const today = toDay(options.today) || toDay(new Date().toISOString());
  const eventDay = toDay(options.eventDate) || "";
  const sourceTickets = Array.isArray(tickets) ? tickets : [];
  const sourceRates = Array.isArray(rates) ? rates : [];
  const count = Math.max(sourceTickets.length, sourceRates.length);
  const windows = [];

  for (let index = 0; index < count; index += 1) {
    const ticket = sourceTickets[index] || null;
    const rate = sourceRates[index] || null;
    const name = String((ticket && ticket.name) || (rate && rate.name) || `Ticket ${index + 1}`).trim();
    const saleStartDate = toDay(ticket && (ticket.saleStartDate || ticket.sale_start_time)) || today;
    const saleEndDate =
      toDay(ticket && (ticket.saleEndDate || ticket.sale_end_time)) || eventDay || today;
    const isActive = ticket ? ticket.isActive !== false : true;
    windows.push({
      name,
      saleStartDate,
      saleEndDate,
      isActive,
      sourceTicketId: ticket && ticket.id ? Number(ticket.id) : null,
    });
  }
  return windows;
}

export function normalizeCloneSaleWindow(input, index = 0) {
  const name = String((input && input.name) || "").trim() || `Ticket ${index + 1}`;
  const saleStartDate = toDay(input && input.saleStartDate);
  const saleEndDate = toDay(input && input.saleEndDate);
  if (!saleStartDate) throw new Error(`sale start is required for ${name}`);
  if (!saleEndDate) throw new Error(`sale end is required for ${name}`);
  if (saleEndDate < saleStartDate) {
    throw new Error(`sale end must be on or after sale start for ${name}`);
  }
  return {
    name,
    saleStartDate,
    saleEndDate,
    isActive: !input || input.isActive !== false,
    sale_start_time: dayToSaleStartIso(saleStartDate),
    sale_end_time: dayToSaleEndIso(saleEndDate),
  };
}

export function normalizeCloneSaleWindows(rawWindows) {
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) {
    throw new Error("confirm ticket sale start and end dates before cloning");
  }
  return rawWindows.map((window, index) => normalizeCloneSaleWindow(window, index));
}

export function cloneSaleWindowWarnings(windows, options = {}) {
  const today = toDay(options.today) || toDay(new Date().toISOString());
  const list = Array.isArray(windows) ? windows : [];
  const warnings = [];
  for (const window of list) {
    const end = toDay(window && window.saleEndDate);
    const active = !window || window.isActive !== false;
    if (end && end < today) {
      warnings.push(`${window.name || "Ticket"} sale end is in the past`);
    }
    if (!active) {
      warnings.push(`${window.name || "Ticket"} is marked inactive`);
    }
  }
  return warnings;
}
