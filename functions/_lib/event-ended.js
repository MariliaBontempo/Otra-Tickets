// When an event is over. Past event pages stay visible (read only) but must
// never offer checkout.
//
// The end is the end date when it is valid and after the start. When it is
// missing, equal to the start (imports store end = start) or earlier than the
// start (a site project can store the end day at 00:00, e.g. 7567), the event
// counts as running for a day after it starts.
// With no valid date at all the event is never treated as ended.
export const ENDED_GRACE_MS = 24 * 60 * 60 * 1000;

export function eventEndTime(startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (end !== null && (start === null || end > start)) return end;
  return start === null ? null : start + ENDED_GRACE_MS;
}

export function hasEnded(startDate, endDate, now = Date.now()) {
  const end = eventEndTime(startDate, endDate);
  return end !== null && end < now;
}

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
