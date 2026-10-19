#!/usr/bin/env node
// Oracle: the homepage/search card schedule line follows the event page hero
// line (#evMeta) after page editor edits, a recurring tour never shows a
// single date, a dated event keeps its real date, and missing or empty edits
// fall back to the authored line.
// Run: node scripts/check-search-card-schedule.mjs

import { readFileSync } from "node:fs";
import {
  applyOverrides,
  buildPublishedSiteEvents,
  dedupeEvents,
  projectDateLabel,
} from "../functions/_lib/homepage-feed.js";
import {
  cardScheduleLabel,
  editedScheduleParts,
  scheduleEdited,
  metaItemSelector,
} from "../functions/_lib/schedule-line.js";

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const eq = (actual, expected, message) =>
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
const text = (value) => ({ type: "text", value });

// Water Bikes (Otra Guide 7175): recurring tour with a first start date.
const waterBikes = {
  id: "draft-water-bikes",
  otraGuideId: "7175",
  title: "Water Bikes Curaçao Ocean Adventure",
  status: "published",
  isPerennial: true,
  startDate: "2026-06-19T18:00:00-04:00",
  endDate: "2027-06-26T19:59:00-04:00",
  claudeDesign: { meta: ["Tue-Sun", "90 min", "From $50"], rates: [{ name: "Adults", price: 85 }] },
};
const TJ_LINE = "Wednesday to Sunday: 1:00 PM & 3:00 PM";

// Selector convention matches the rendered spans (item, dot, item, dot, item).
eq(metaItemSelector(0), "#evMeta > span:nth-of-type(1)", "first hero item selector");
eq(metaItemSelector(1), "#evMeta > span:nth-of-type(3)", "second hero item skips the dot span");
eq(metaItemSelector(2), "#evMeta > span:nth-of-type(5)", "third hero item selector");

// 1. Edited schedule wins.
eq(
  projectDateLabel(waterBikes, {
    fields: {
      ["text:" + metaItemSelector(0)]: text(TJ_LINE),
      ["text:" + metaItemSelector(1)]: text(""),
      ["text:" + metaItemSelector(2)]: text("From $60"),
    },
  }),
  TJ_LINE,
  "Water Bikes card must read exactly the edited hero line"
);
eq(
  projectDateLabel(waterBikes, {
    fields: {
      "text:#evMeta > span:nth-of-type(1)": text("Midday tours"),
      "text:#evMeta > span:nth-of-type(3)": text("1 hour"),
      "text:#evMeta > span:nth-of-type(5)": text("From $60"),
    },
  }),
  "Midday tours · 1 hour",
  "current live edits reach the card (price item stays off the card)"
);
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(1)": text(TJ_LINE) } }),
  `${TJ_LINE} · 90 min`,
  "an edit to one item keeps the untouched authored items"
);
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta": text(TJ_LINE) } }),
  TJ_LINE,
  "replacing the whole hero line replaces every item"
);
eq(
  projectDateLabel(waterBikes, {
    fields: {
      "text:#evMeta": text("Whole line"),
      "text:#evMeta > span:nth-of-type(1)": text("Ignored"),
    },
  }),
  "Whole line",
  "after the host text is replaced there are no spans left to edit, same as the page"
);
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(2)": text("Nope") } }),
  "Tue-Sun · 90 min",
  "editing a separator dot never adds a card item"
);
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(9)": text("Nope") } }),
  "Tue-Sun · 90 min",
  "a selector with no rendered span does nothing, same as the page"
);

// 2. Perennial shows no single date.
eq(projectDateLabel(waterBikes), "Tue-Sun · 90 min", "recurring tour must not show its first start date");
eq(
  projectDateLabel({ ...waterBikes, claudeDesign: { meta: [] } }),
  "Flexible dates",
  "recurring tour with no hero line shows Flexible dates, not a date"
);
eq(
  projectDateLabel({ ...waterBikes, claudeDesign: { meta: ["Fri, June 19", "Daily"] } }),
  "Fri, June 19 · Daily",
  "recurring tour keeps authored text as written (no date sync)"
);

// 3. Non recurring event keeps its date.
const dated = {
  isPerennial: false,
  startDate: "2026-09-06T17:00:00-04:00",
  claudeDesign: { meta: ["Sun, July 5", "5PM to 8PM", "Early Bird $95"], rates: [{ name: "Early Bird" }] },
};
eq(projectDateLabel(dated), "Sun, September 6 · 5PM to 8PM", "dated event keeps its real date");
eq(
  projectDateLabel(dated, { fields: { "text:#evMeta > span:nth-of-type(3)": text("6PM to 10PM") } }),
  "Sun, September 6 · 6PM to 10PM",
  "dated event edit changes the time but the date still follows the real start"
);
eq(
  projectDateLabel(dated, { fields: { "text:#evMeta > span:nth-of-type(1)": text("Doors open 6PM") } }),
  "Sun, September 6 · Doors open 6PM · 5PM to 8PM",
  "dated event whose edit removes the date text still shows the real date"
);
eq(
  projectDateLabel({ isPerennial: false, claudeDesign: { meta: ["Saturdays"] } }),
  "Saturdays",
  "dated event with no start date keeps its authored line"
);

// 4. Missing or empty edits fall back to the original.
for (const [label, override] of [
  ["null override", null],
  ["override without fields", {}],
  ["array fields", { fields: [text("x")] }],
  ["unrelated fields", { fields: { "text:#evTitle": text("Renamed") } }],
  ["image field on a hero item", { fields: { "image:#evMeta > span:nth-of-type(1)": { type: "image", value: "/x.jpg" } } }],
  ["non text field type", { fields: { "text:#evMeta > span:nth-of-type(1)": { type: "image", value: "x" } } }],
  ["null field", { fields: { "text:#evMeta > span:nth-of-type(1)": null } }],
]) {
  eq(projectDateLabel(waterBikes, override), "Tue-Sun · 90 min", `${label} falls back to the authored line`);
}
eq(
  projectDateLabel(waterBikes, {
    fields: {
      "text:#evMeta > span:nth-of-type(1)": text("   "),
      "text:#evMeta > span:nth-of-type(3)": text(""),
    },
  }),
  "Flexible dates",
  "a fully blanked hero line on a recurring tour shows Flexible dates"
);
eq(cardScheduleLabel(null), "", "missing project yields an empty line");
eq(editedScheduleParts(undefined, null).length, 0, "no meta and no edits yields no parts");
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(1)": { type: "text", value: 42 } } }),
  "90 min",
  "a non string value is blank on the page (/api/override turns it into \"\"), so the card drops that item too"
);
assert(!scheduleEdited(waterBikes, { fields: { "text:#evTitle": text("x") } }), "a title edit is not a schedule edit");
assert(scheduleEdited(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(3)": text("") } }), "a blanked item is a schedule edit");
assert(scheduleEdited(waterBikes, { fields: { "text:#evMeta": text("x") } }), "a host edit is a schedule edit");
assert(!scheduleEdited(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(2)": text("|") } }), "a dot edit changes nothing on the page");
assert(!scheduleEdited(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(9)": text("x") } }), "an edit of a missing span changes nothing on the page");
assert(!scheduleEdited(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(1)": text("Tue-Sun") } }), "saving the same text is not a change");

// One item hero line: the editor saves the bare "#evMeta > span" selector.
const oneItem = { ...waterBikes, claudeDesign: { meta: ["Daily"] } };
eq(projectDateLabel(oneItem, { fields: { "text:#evMeta > span": text("Mon-Sat 9AM") } }), "Mon-Sat 9AM", "bare span selector edits a one item line");
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta > span": text("First") } }),
  "First · 90 min",
  "bare span selector targets the first span, like querySelector"
);

// No design.meta: the page renders a fallback span the editor can edit.
const noMetaTour = { ...waterBikes, claudeDesign: {} };
eq(projectDateLabel(noMetaTour), "Flexible dates", "recurring tour without meta shows the page fallback");
eq(projectDateLabel(noMetaTour, { fields: { "text:#evMeta > span": text("Daily 9AM") } }), "Daily 9AM", "edit of the recurring fallback span reaches the card");
const noMetaDated = { isPerennial: false, startDate: "2026-11-07T20:00:00-04:00", claudeDesign: { meta: [] } };
eq(projectDateLabel(noMetaDated), "Sat, November 7", "dated event without meta shows its real date");
eq(
  projectDateLabel(noMetaDated, { fields: { "text:#evMeta > span": text("Doors 7PM") } }),
  "Sat, November 7 · Doors 7PM",
  "edit of the dated fallback span reaches the card and the real date stays"
);
eq(
  projectDateLabel({ isPerennial: false, claudeDesign: {} }, { fields: { "text:#evMeta > span": text("Nope") } }),
  "",
  "no meta, no date: the page renders no span, so the edit does nothing"
);
eq(
  projectDateLabel({ ...waterBikes, claudeDesign: { meta: ["", " "] } }, { fields: { "text:#evMeta > span:nth-of-type(3)": text("Weekends") } }),
  "Weekends",
  "a meta array of blanks still renders spans on the page, so their edits apply"
);

// 5. Feed integration: draft override, event:<id> precedence, LOCAL_CARD_INFO.
const projects = {
  "site-event:draft-water-bikes": waterBikes,
  "site-event:draft-clearboat": {
    id: "draft-clearboat",
    otraGuideId: "6113",
    title: "Clearboat",
    status: "published",
    isPerennial: true,
    startDate: "2026-06-01T10:00:00-04:00",
    claudeDesign: { meta: ["Daily", "3 hours"] },
  },
  "site-event:draft-local-plain": {
    id: "draft-local-plain",
    otraGuideId: "7176",
    title: "Barber",
    status: "published",
    isPerennial: true,
    claudeDesign: { meta: ["Tue-Sun"] },
  },
};
const overrides = {
  "event:draft-water-bikes": {
    fields: { "text:#evMeta > span:nth-of-type(1)": text(TJ_LINE), "text:#evMeta > span:nth-of-type(3)": text("") },
  },
  "event:draft-clearboat": { fields: { "text:#evMeta > span:nth-of-type(1)": text("Mon to Sat: 9:00 AM") } },
  "event:draft-local-plain": { fields: { "text:#evMeta > span:nth-of-type(7)": text("No such span") } },
};
const makeKv = (extra = {}) => ({
  async list({ prefix }) {
    return { keys: prefix === "site-event:" ? Object.keys(projects).map((name) => ({ name })) : [], list_complete: true };
  },
  async get(key) { return projects[key] || extra[key] || overrides[key] || null; },
});
const origFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, json: async () => null });
try {
  const env = { OVERRIDES: makeKv(), OTRA_API_URL: "https://mock.invalid/api" };
  const site = await buildPublishedSiteEvents(env);
  const byId = new Map(site.map((ev) => [String(ev.id), ev]));
  eq(byId.get("7175")?.dateLabel, TJ_LINE, "feed card for Water Bikes follows the draft page edit");
  eq(byId.get("6113")?.dateLabel, "Mon to Sat: 9:00 AM · 3 hours", "a page edit beats the hard coded local card label");
  eq(byId.get("7176")?.dateLabel, "Daily", "without a visible hero line edit the hard coded local card label stays");

  // Upstream copy must not replace the site card line during dedupe.
  const merged = dedupeEvents([...site, { id: "7175", title: "Water Bikes", dateLabel: "Flexible dates", isPerennial: true }]);
  eq(merged.find((ev) => String(ev.id) === "7175")?.dateLabel, TJ_LINE, "dedupe keeps the site card line");

  // No override for the bound id: line unchanged.
  const applied = await applyOverrides(merged, env);
  eq(applied.find((ev) => String(ev.id) === "7175")?.dateLabel, TJ_LINE, "applyOverrides without event:<id> keeps the line");

  // The page reads event:<id> first, so the card follows it too.
  const boundEnv = {
    OVERRIDES: makeKv({ "event:7175": { fields: { "text:#evMeta > span:nth-of-type(1)": text("Bound edit") } } }),
  };
  const boundApplied = await applyOverrides(merged, boundEnv);
  eq(
    boundApplied.find((ev) => String(ev.id) === "7175")?.dateLabel,
    "Bound edit · 90 min",
    "event:<otraGuideId> override wins like it does on the event page"
  );
  const titleOnlyEnv = { OVERRIDES: makeKv({ "event:7175": { fields: { "text:#evTitle": text("Renamed") } } }) };
  const titleOnly = (await applyOverrides(merged, titleOnlyEnv)).find((ev) => String(ev.id) === "7175");
  eq(titleOnly?.dateLabel, "Tue-Sun · 90 min", "a bound override without hero edits shows the authored line, like the page");
  eq(titleOnly?.title, "Renamed", "title override still applies");

  // Upstream only events (no site project) are untouched by schedule logic.
  const upstreamOnly = await applyOverrides(
    [{ id: "999", title: "Upstream", dateLabel: "Flexible dates" }],
    { OVERRIDES: makeKv({ "event:999": { fields: { "text:#evMeta": text("Never") } } }) }
  );
  eq(upstreamOnly[0].dateLabel, "Flexible dates", "events without a site project keep their label");

  // Internal project reference never reaches the JSON payload.
  const json = JSON.stringify(boundApplied);
  assert(!json.includes("claudeDesign") && !json.includes("scheduleSource"), "schedule source must not leak into the feed JSON");
} finally {
  globalThis.fetch = origFetch;
}

// 6. event.html hero line structure the selector convention depends on.
const eventHtml = readFileSync(new URL("../event.html", import.meta.url), "utf8");
assert(/id="evMeta"/.test(eventHtml), "event.html must keep the #evMeta hero line host");
const renderMeta = eventHtml.match(/function renderMeta\(host, parts\) \{[\s\S]*?\n {6}\}/);
assert(renderMeta, "event.html must keep renderMeta");
if (renderMeta) {
  const body = renderMeta[0];
  assert(/if \(i\)[\s\S]*createElement\("span"\)[\s\S]*className = "dot"/.test(body), "renderMeta must put a span.dot between items");
  assert(/const s = document\.createElement\("span"\);[\s\S]*s\.textContent = p;/.test(body), "renderMeta must render each item as a span");
}
assert(
  /if \(Array\.isArray\(design\.meta\) && design\.meta\.length\) meta\.push\(\.\.\.design\.meta\);/.test(eventHtml),
  "event page hero line must render design.meta as the card does"
);

if (failures.length) {
  console.error("check-search-card-schedule FAILED:");
  failures.forEach((failure) => console.error(" - " + failure));
  process.exit(1);
}
console.log("check-search-card-schedule OK (edited line wins, recurring has no single date, dated keeps date, fallbacks)");
