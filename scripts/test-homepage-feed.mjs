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
