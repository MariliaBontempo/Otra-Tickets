import assert from "node:assert/strict";
import { applyFixedRows, filterHomepageEvents, isHomepageEventExcluded } from "../functions/_lib/homepage-feed.js";

const now = new Date("2026-07-18T12:00:00-04:00").getTime();

const rows = applyFixedRows([
  {
    id: 1,
    title: "Past one-off event",
    date: "2026-07-01T20:00:00-04:00",
    endDate: "2026-07-01T23:00:00-04:00",
    isPerennial: false,
  },
  {
    id: 2,
    title: "Recurring tour with old date",
    date: "2026-07-01T20:00:00-04:00",
    endDate: "2026-07-01T23:00:00-04:00",
    isPerennial: true,
  },
  {
    id: 3,
    title: "Recurring card mislabeled as non-perennial",
    date: "2026-07-01T20:00:00-04:00",
    endDate: "2026-07-01T23:00:00-04:00",
    isPerennial: false,
    dateLabel: "Two daily departures · About 1 hour",
  },
  {
    id: 4,
    title: "Past perennial event with ticket types",
    date: "2026-07-04T18:00:00-04:00",
    endDate: "2026-07-05T02:00:00-04:00",
    isPerennial: true,
    hasTicketTypes: true,
  },
], [], now);

const past = rows.find((row) => row.id === "past-events");

assert.deepEqual(past?.eventIds, ["4", "1"]);

assert.equal(isHomepageEventExcluded(7464), true);
assert.equal(isHomepageEventExcluded("7465"), true);
assert.equal(isHomepageEventExcluded(7466), true);
assert.equal(isHomepageEventExcluded(6832), false);
assert.deepEqual(
  filterHomepageEvents([{ id: 7464 }, { id: "7465" }, { id: 7466 }, { id: 6832 }]),
  [{ id: 6832 }]
);

// ── This Week: rolling 7 day window (today through today + 6, Curaçao) ──
const curacaoTime = (iso) => new Date(iso).getTime();
const rowIds = (fixedRows, id) => fixedRows.find((row) => row.id === id)?.eventIds || [];
const datedEvent = (id, date) => ({ id, title: `Dated ${id}`, date, endDate: date, isPerennial: false });
// Fed in reverse rank order so the test proves the tour sort, not the input.
const tours = [
  { id: 6827, title: "Pietermaai Walking Tour", isPerennial: true },
  { id: 7176, title: "Iguana Ride Curaçao", isPerennial: true },
  { id: 6113, title: "Clear Boat Curaçao", date: "2026-01-01T10:00:00-04:00", endDate: "2027-12-31T18:00:00-04:00", isPerennial: true },
];
const tourIds = ["6113", "7176", "6827"];
// Out of date order so the test proves the soonest-first sort.
const novemberEvents = [
  { id: 7479, title: "Bingo Bengo", date: "2026-12-13T19:00:00-04:00", endDate: "2026-12-13T23:00:00-04:00", isPerennial: false },
  { id: 8270, title: "Francis Sling", date: "2026-11-28T17:00:00-04:00", endDate: "2026-11-28T23:00:00-04:00", isPerennial: false },
  { id: 8267, title: "Francis Sling", date: "2026-11-27T19:00:00-04:00", endDate: "2026-11-27T23:00:00-04:00", isPerennial: false },
  ...tours,
];
const sundayAfternoon = curacaoTime("2026-11-22T15:00:00-04:00");

// 1. Sunday 22 Nov: Francis leads This Week, tours follow in rank order, and
// Francis is not repeated in Upcoming.
{
  const fixedRows = applyFixedRows(novemberEvents, [], sundayAfternoon);
  assert.deepEqual(rowIds(fixedRows, "this-week"), ["8267", "8270", ...tourIds]);
  assert.deepEqual(rowIds(fixedRows, "upcoming"), ["7479"]);
  assert.deepEqual(rowIds(fixedRows, "tours-adventures"), tourIds);
}

// 2. A same day dated event leads This Week.
{
  const fixedRows = applyFixedRows(
    [...novemberEvents, datedEvent(9001, "2026-11-22T20:00:00-04:00")],
    [],
    sundayAfternoon
  );
  assert.deepEqual(rowIds(fixedRows, "this-week"), ["9001", "8267", "8270", ...tourIds]);
  assert.deepEqual(rowIds(fixedRows, "upcoming"), ["7479"]);
}

// 3. Monday 23 Nov: Francis stays in This Week; an event that ended on 22 Nov
// is past, not This Week.
{
  const fixedRows = applyFixedRows(
    [...novemberEvents, datedEvent(9002, "2026-11-22T20:00:00-04:00")],
    [],
    curacaoTime("2026-11-23T10:00:00-04:00")
  );
  assert.deepEqual(rowIds(fixedRows, "this-week"), ["8267", "8270", ...tourIds]);
  assert.deepEqual(rowIds(fixedRows, "past-events"), ["9002"]);
}

// 4. Boundary: day 6 (28 Nov) is in, day 7 (29 Nov) goes to Upcoming.
{
  const fixedRows = applyFixedRows(
    [datedEvent(9006, "2026-11-28T21:00:00-04:00"), datedEvent(9007, "2026-11-29T09:00:00-04:00"), ...tours],
    [],
    sundayAfternoon
  );
  assert.deepEqual(rowIds(fixedRows, "this-week"), ["9006", ...tourIds]);
  assert.deepEqual(rowIds(fixedRows, "upcoming"), ["9007"]);
}

// 5. The window turns over at Curaçao midnight, not UTC midnight.
{
  const midnightEvents = [
    datedEvent(9022, "2026-11-22T20:00:00-04:00"),
    datedEvent(9028, "2026-11-28T21:00:00-04:00"),
    datedEvent(9029, "2026-11-29T09:00:00-04:00"),
  ];
  const lastMinute = applyFixedRows(midnightEvents, [], curacaoTime("2026-11-22T23:59:00-04:00"));
  assert.deepEqual(rowIds(lastMinute, "this-week"), ["9022", "9028"]);
  assert.deepEqual(rowIds(lastMinute, "upcoming"), ["9029"]);
  const nextDay = applyFixedRows(midnightEvents, [], curacaoTime("2026-11-23T00:00:00-04:00"));
  assert.deepEqual(rowIds(nextDay, "this-week"), ["9028", "9029"]);
  assert.deepEqual(rowIds(nextDay, "past-events"), ["9022"]);
}

console.log("homepage feed tests passed");
