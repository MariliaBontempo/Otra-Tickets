import assert from "node:assert/strict";
import { applyFixedRows } from "../functions/_lib/homepage-feed.js";

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
], [], now);

const past = rows.find((row) => row.id === "past-events");

assert.deepEqual(past?.eventIds, ["1"]);
