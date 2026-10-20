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
// The page and the card separate the days from the times with the line's
// middle dot (functions/_lib/hero-meta-text.js); the stored edit keeps its colon.
const TJ_SHOWN = "Wednesday to Sunday · 1:00 PM & 3:00 PM";

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
  TJ_SHOWN,
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
  `${TJ_SHOWN} · 90 min`,
  "an edit to one item keeps the untouched authored items"
);
eq(
  projectDateLabel(waterBikes, { fields: { "text:#evMeta": text(TJ_LINE) } }),
  TJ_SHOWN,
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

// Legacy editor keys ("main > #evMeta ...") still apply on the page.
eq(
  projectDateLabel(waterBikes, { fields: { "text:main > #evMeta > span:nth-of-type(3)": text("2h") } }),
  "Tue-Sun · 2h",
  "legacy main > span key reaches the card, like site-overrides.js"
);
eq(projectDateLabel(waterBikes, { fields: { "text:main > #evMeta": text("Daily") } }), "Daily", "legacy main > host key reaches the card");
eq(
  projectDateLabel(waterBikes, { fields: { "text:main>#evMeta > span:nth-of-type(1)": text("Nope") } }),
  "Tue-Sun · 90 min",
  "a main prefix the page cannot resolve is ignored on the card too"
);

// Price only edits do not count as schedule edits.
assert(
  !scheduleEdited(waterBikes, { fields: { "text:#evMeta > span:nth-of-type(5)": text("From $60") } }),
  "a price only edit does not change the card schedule line"
);

// Malformed KV data never throws.
const hostile = { toString: 1 };
let malformed = "threw";
try {
  malformed = projectDateLabel(
    { isPerennial: true, claudeDesign: { meta: [hostile, null, 7, "Daily"], rates: [{ name: hostile }, null, "x"] } },
    { fields: { "text:#evMeta > span:nth-of-type(1)": { type: "text", value: hostile } } }
  );
} catch {
  malformed = "threw";
}
eq(malformed, "7 · Daily", "non string meta items and values are blank, numbers kept, nothing throws");
eq(projectDateLabel({ isPerennial: true, claudeDesign: { meta: "Daily" } }), "Flexible dates", "a non array meta is ignored");

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
    claudeDesign: { meta: ["Tue-Sun", "From $50"] },
  },
};
const overrides = {
  "event:draft-water-bikes": {
    fields: { "text:#evMeta > span:nth-of-type(1)": text(TJ_LINE), "text:#evMeta > span:nth-of-type(3)": text("") },
  },
  "event:draft-clearboat": { fields: { "text:#evMeta > span:nth-of-type(1)": text("Mon to Sat: 9:00 AM") } },
  "event:draft-local-plain": {
    fields: {
      "text:#evMeta > span:nth-of-type(7)": text("No such span"),
      "text:#evMeta > span": text("Tue-Sun"),
    },
  },
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
  eq(byId.get("7175")?.dateLabel, TJ_SHOWN, "feed card for Water Bikes follows the draft page edit");
  eq(byId.get("6113")?.dateLabel, "Mon to Sat · 9:00 AM · 3 hours", "a page edit beats the hard coded local card label");
  eq(byId.get("7176")?.dateLabel, "Daily", "without a visible hero line edit the hard coded local card label stays");

  // Upstream copy must not replace the site card line during dedupe.
  const merged = dedupeEvents([...site, { id: "7175", title: "Water Bikes", dateLabel: "Flexible dates", isPerennial: true }]);
  eq(merged.find((ev) => String(ev.id) === "7175")?.dateLabel, TJ_SHOWN, "dedupe keeps the site card line");

  // No override for the bound id: line unchanged.
  const applied = await applyOverrides(merged, env);
  eq(applied.find((ev) => String(ev.id) === "7175")?.dateLabel, TJ_SHOWN, "applyOverrides without event:<id> keeps the line");

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

  // Legacy override:<id> key is read the same way as event:<id>.
  const legacyEnv = {
    OVERRIDES: makeKv({ "override:7175": { fields: { "text:#evMeta > span:nth-of-type(3)": text("2 hours") } } }),
  };
  eq(
    (await applyOverrides(merged, legacyEnv)).find((ev) => String(ev.id) === "7175")?.dateLabel,
    "Tue-Sun · 2 hours",
    "override:<id> hero edit reaches the card"
  );

  // A visible edit on the bound id beats LOCAL_CARD_INFO in applyOverrides; a price only edit does not.
  const clearboatVisible = await applyOverrides(merged, {
    OVERRIDES: makeKv({ "event:6113": { fields: { "text:#evMeta > span:nth-of-type(3)": text("2.5 hours") } } }),
  });
  eq(clearboatVisible.find((ev) => String(ev.id) === "6113")?.dateLabel, "Daily · 2.5 hours", "event:6113 visible edit beats the local card label");
  const localPriceOnly = await applyOverrides(merged, {
    OVERRIDES: makeKv({ "event:7176": { fields: { "text:#evMeta > span:nth-of-type(3)": text("From $40") } } }),
  });
  eq(localPriceOnly.find((ev) => String(ev.id) === "7176")?.dateLabel, "Daily", "a price only edit keeps the local card label");

  // Upstream only events (no site project) are untouched by schedule logic.
  const upstreamOnly = await applyOverrides(
    [{ id: "999", title: "Upstream", dateLabel: "Flexible dates" }],
    { OVERRIDES: makeKv({ "event:999": { fields: { "text:#evMeta": text("Never") } } }) }
  );
  eq(upstreamOnly[0].dateLabel, "Flexible dates", "events without a site project keep their label");

  // Internal project reference never reaches the JSON payload.
  const json = JSON.stringify(boundApplied);
  assert(!json.includes("claudeDesign") && !json.includes("scheduleSource"), "schedule source must not leak into the feed JSON");
  const parsed = JSON.parse(json);
  const allowedKeys = new Set(["id", "title", "date", "endDate", "isPerennial", "hasTicketTypes", "venue", "location", "dateLabel", "img", "slug"]);
  assert(
    parsed.every((ev) => Object.keys(ev).every((key) => allowedKeys.has(key))),
    "feed JSON events carry only the public card fields: " + JSON.stringify(parsed.map((ev) => Object.keys(ev)))
  );
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
assert(
  /else if \(start && !ev\.isPerennial\) meta\.push\(start\.long\);/.test(eventHtml),
  "event page fallback for a dated event without meta must stay the start date (the card replays edits over it)"
);
assert(
  /if \(!meta\.length && ev\.isPerennial\) meta\.push\("Flexible dates"\);/.test(eventHtml),
  "event page fallback for a recurring tour without meta must stay Flexible dates"
);
const siteOverrides = readFileSync(new URL("../site-overrides.js", import.meta.url), "utf8");
assert(
  /if \(!el && selector\.startsWith\("main > #"\)\) \{\s*el = document\.querySelector\(selector\.slice\("main > "\.length\)\);/.test(siteOverrides),
  "site-overrides.js must keep the legacy main > retry the card mirrors"
);

// ---- Days · times: the colon between a run of day names and the times reads
// as the line's middle dot, on the card, in /api/override and in /api/event.
// Only that colon changes; colons in times, dates, labels and titles stay.
{
  const { heroMetaItemText, heroMetaItems, META_SEPARATOR } = await import("../functions/_lib/hero-meta-text.js");
  // Deep compare for the lists and fields below.
  const eq = (actual, expected, message) =>
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  eq(META_SEPARATOR, " · ", "days and times use the hero line separator");
  const itemCases = [
    // [input, shown, name]
    ["Wednesday to Sunday: 12:00 PM & 1:00 PM", "Wednesday to Sunday · 12:00 PM & 1:00 PM", "weekday range with times"],
    ["Wednesday to Sunday:12:00 PM", "Wednesday to Sunday · 12:00 PM", "no space after the colon"],
    ["Wednesday to Sunday : 12:00 PM", "Wednesday to Sunday · 12:00 PM", "space before the colon"],
    ["Saturday: 10:00 PM", "Saturday · 10:00 PM", "single day"],
    ["Sat: 9pm", "Sat · 9pm", "short day, compact time"],
    ["Mon-Fri: 9:00 AM", "Mon-Fri · 9:00 AM", "hyphen range"],
    ["Mon – Fri: 9 AM", "Mon – Fri · 9 AM", "en dash range"],
    ["Mon, Wed & Fri: 9 AM", "Mon, Wed & Fri · 9 AM", "day list"],
    ["Mondays: 7 PM", "Mondays · 7 PM", "plural day"],
    ["Every Friday: 6:00 PM", "Every Friday · 6:00 PM", "recurring every week"],
    ["Daily: 9:00 AM & 2:00 PM", "Daily · 9:00 AM & 2:00 PM", "daily"],
    ["Weekends: 10 AM", "Weekends · 10 AM", "weekends"],
    ["Mon to Fri: 9 AM · Sat: 10 AM", "Mon to Fri · 9 AM · Sat · 10 AM", "two schedules typed in one item"],
    ["WEDNESDAY TO SUNDAY: 12:00 PM", "WEDNESDAY TO SUNDAY · 12:00 PM", "upper case"],
    ["Miércoles a domingo: 12:00", "Miércoles a domingo · 12:00", "Spanish days"],
    ["Cada viernes: 18:00", "Cada viernes · 18:00", "Spanish every"],
    ["Woensdag t/m zondag: 12.00 uur", "Woensdag t/m zondag · 12.00 uur", "Dutch days"],
    ["Djarason te djadumingu: 12:00", "Djarason te djadumingu · 12:00", "Papiamentu days"],
    // Unchanged.
    ["12:00 PM & 1:00 PM", "12:00 PM & 1:00 PM", "times only keep their colons"],
    ["Wednesday to Sunday", "Wednesday to Sunday", "days only"],
    ["Saturday: Flexible", "Saturday: Flexible", "day with no time keeps its colon"],
    ["Saturday: The Party", "Saturday: The Party", "title after a day keeps its colon"],
    ["Monday: Movie night at 9", "Monday: Movie night at 9", "text after a day keeps its colon"],
    ["Doors: 8 PM", "Doors: 8 PM", "label before a time keeps its colon"],
    ["Note: 21+ only", "Note: 21+ only", "note keeps its colon"],
    ["Dec 31: 9 PM", "Dec 31: 9 PM", "dated colon keeps its colon"],
    ["Sat, Dec 13: 9 PM", "Sat, Dec 13: 9 PM", "day with a date keeps its colon"],
    ["Sunset: 6 PM", "Sunset: 6 PM", "a word starting with a day name"],
    ["Sunday Funday: 2 PM", "Sunday Funday: 2 PM", "an event name starting with a day name"],
    ["Cascada NYE: 10 PM till late", "Cascada NYE: 10 PM till late", "title with a colon"],
    ["", "", "empty item"],
    ["1 hour", "1 hour", "no colon"],
  ];
  for (const [input, shown, name] of itemCases) eq(heroMetaItemText(input), shown, `days·times item: ${name}`);
  eq(heroMetaItemText(null), null, "days·times: a non string item is kept");
  eq(heroMetaItems(["Saturday: 9 PM", 7, "From $60"]), ["Saturday · 9 PM", 7, "From $60"], "days·times: item lists map one by one");

  const tz = { timeZone: "America/Curacao" };
  const edits = (list) => ({ fields: Object.fromEntries(list.map((value, i) => [`text:${metaItemSelector(i)}`, text(value)])) });
  const cardCases = [
    // Recurring tour (Water Bikes): the live edit, then the same with items blanked.
    [{ ...waterBikes }, edits(["Wednesday to Sunday: 12:00 PM & 1:00 PM", "", "From $60"]), "Wednesday to Sunday · 12:00 PM & 1:00 PM", "Water Bikes live edit"],
    [{ ...waterBikes, claudeDesign: { meta: ["Wednesday to Sunday: 12:00 PM & 1:00 PM", "1 hour"] } }, null, "Wednesday to Sunday · 12:00 PM & 1:00 PM · 1 hour", "authored weekday range"],
    [{ ...waterBikes }, edits(["Saturday: 10:00 AM"]), "Saturday · 10:00 AM · 90 min", "single day on a recurring tour"],
    [{ ...waterBikes }, edits(["", "", ""]), "Flexible dates", "recurring tour with every item empty"],
    [{ ...waterBikes, claudeDesign: { meta: [] } }, null, "Flexible dates", "recurring tour with no items"],
    [{ ...waterBikes }, edits(["12:00 PM & 1:00 PM", "", ""]), "12:00 PM & 1:00 PM", "times only"],
    [{ ...waterBikes }, edits(["Wednesday to Sunday", "", ""]), "Wednesday to Sunday", "days only"],
    [{ ...waterBikes }, edits(["Weekends", "1 hour", ""]), "Weekends · 1 hour", "no times"],
    // Dated one time events: the real date leads and colons in times stay.
    [{ id: "d1", status: "published", startDate: "2026-12-13T21:00:00-04:00", claudeDesign: { meta: ["Sat, Dec 13", "9:00 PM", "From $95"], rates: [{ name: "Early Bird" }] } }, null, "Sun, December 13 · 9:00 PM", "dated one time event"],
    [{ id: "d2", status: "published", startDate: "2026-12-13T21:00:00-04:00", claudeDesign: { meta: ["Dec 13: 9 PM"] } }, null, "Sun, December 13: 9 PM", "dated colon stays"],
    [{ id: "d3", status: "published", startDate: "2026-12-12T21:00:00-04:00", claudeDesign: { meta: ["Saturday: 9:00 PM", "Cascada NYE: 10 PM till late"] } }, null, "Sat, December 12 · Saturday · 9:00 PM · Cascada NYE: 10 PM till late", "dated single day and a title colon"],
    [{ id: "d4", status: "published", startDate: "2026-12-13T21:00:00-04:00", claudeDesign: { meta: [] } }, null, "Sun, December 13", "dated event with no items"],
    [{ id: "d5", status: "published", startDate: "2026-12-13T21:00:00-04:00", claudeDesign: { meta: ["Dec 13", ""] } }, edits(["Dec 13", ""]), "Sun, December 13", "dated event with an empty item"],
    // Multiple dates without a start date keep the authored line.
    [{ id: "m1", status: "published", claudeDesign: { meta: ["Dec 13 & Dec 20", "8:00 PM"] } }, null, "Dec 13 & Dec 20 · 8:00 PM", "multiple dates"],
    [{ id: "m2", status: "published", claudeDesign: { meta: ["Fridays & Saturdays: 8:00 PM", "Doors: 7 PM"] } }, null, "Fridays & Saturdays · 8:00 PM · Doors: 7 PM", "days and a doors label"],
    [{ id: "m3", status: "published", claudeDesign: { meta: ["", ""] } }, null, "", "every item empty"],
  ];
  for (const [project, override, want, name] of cardCases) eq(cardScheduleLabel(project, override, tz), want, `card: ${name}`);
  eq(scheduleEdited({ ...waterBikes, claudeDesign: { meta: ["Saturday: 9 PM"] } }, edits(["Saturday · 9 PM"]), tz), false,
    "card: typing the dot by hand reads the same as the colon");

  // /api/override shows hero line edits the same way, and nothing else.
  const { onRequestGet: overrideGet } = await import("../functions/api/override.js");
  const kvFor = (records) => ({
    async get(key, type) { const v = records[key]; return v === undefined ? null : type === "json" ? v : JSON.stringify(v); },
    async list() { return { keys: [], list_complete: true }; },
  });
  const stored = {
    fields: {
      "text:#evMeta > span:nth-of-type(1)": text("Wednesday to Sunday: 12:00 PM & 1:00 PM"),
      "text:#evMeta > span:nth-of-type(3)": text(""),
      "text:#evMeta > span:nth-of-type(5)": text("From $60"),
      "text:main > #evMeta > span:nth-of-type(7)": text("Sat: 9 PM"),
      "text:#evTitle": text("Saturday: 10 PM"),
      "text:#evBody": text("Midday departure times: 12:00 PM and 1:00 PM.\nMonday: 9 AM"),
      "text:#evInfoGrid > div:nth-of-type(4)": text("otra-info-cell:{\"title\":\"Departures\",\"subtitle\":\"Daily: 12:00 PM\"}"),
      "image:#evHeroImg": { type: "image", value: "/override-images/a.jpg" },
    },
  };
  const read = async (records) => (await (await overrideGet({ request: new Request("https://x.test/api/override?id=7175"), env: { OVERRIDES: kvFor(records) } })).json()).override;
  const shown = await read({ "event:7175": stored, "override:7175": stored });
  eq(shown && shown.fields["text:#evMeta > span:nth-of-type(1)"], text("Wednesday to Sunday · 12:00 PM & 1:00 PM"), "/api/override: hero item days · times");
  eq(shown && shown.fields["text:#evMeta > span:nth-of-type(3)"], text(""), "/api/override: an empty hero item stays empty");
  eq(shown && shown.fields["text:#evMeta > span:nth-of-type(5)"], text("From $60"), "/api/override: price item unchanged");
  eq(shown && shown.fields["text:main > #evMeta > span:nth-of-type(7)"], text("Sat · 9 PM"), "/api/override: legacy main > hero key too");
  eq(shown && shown.fields["text:#evTitle"], text("Saturday: 10 PM"), "/api/override: a title colon stays");
  eq(shown && shown.fields["text:#evBody"], text("Midday departure times: 12:00 PM and 1:00 PM.\nMonday: 9 AM"), "/api/override: body text stays");
  eq(shown && shown.fields["text:#evInfoGrid > div:nth-of-type(4)"], stored.fields["text:#evInfoGrid > div:nth-of-type(4)"], "/api/override: info cells stay");
  eq(shown && shown.fields["image:#evHeroImg"], stored.fields["image:#evHeroImg"], "/api/override: images stay");
  const whole = await read({ "event:7175": { fields: { "text:#evMeta": text("Daily: 9 AM · From $60") } } });
  eq(whole && whole.fields["text:#evMeta"], text("Daily · 9 AM · From $60"), "/api/override: a whole line edit too");

  // /api/event shows authored hero items the same way without touching the stored design.
  const { onRequestGet: eventGet } = await import("../functions/api/event.js");
  const design = { meta: ["Wednesday to Sunday: 12:00 PM & 1:00 PM", "1 hour", "From $60"], rates: [] };
  const projectRecord = { id: "draft-days", title: "Water Bikes", status: "published", publishedAt: "2026-10-10T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z", otraGuideId: "7175", isPerennial: true, ticketTypeIds: [], claudeDesign: design };
  const eventKv = {
    async get(key, type) { const v = key === "site-event:draft-days" ? projectRecord : undefined; return v === undefined ? null : type === "json" ? v : JSON.stringify(v); },
    async list({ prefix }) { return { keys: "site-event:draft-days".startsWith(prefix) ? [{ name: "site-event:draft-days" }] : [], list_complete: true }; },
  };
  const savedFetch = globalThis.fetch;
  const savedCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/events/details/7175/")) return new Response(JSON.stringify({ id: 7175, title: "Water Bikes", description: "Upstream", start_date: "2026-06-01T09:00:00-04:00", end_date: "2027-06-26T19:59:00-04:00", is_perennial: true }), { headers: { "content-type": "application/json" } });
    if (url.includes("/ticket/purchase/tickets/7175/")) return new Response(JSON.stringify({ count: 0, results: [] }), { headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  };
  try {
    const response = await eventGet({ request: new Request("https://otratickets.com/api/event?id=7175"), env: { OVERRIDES: eventKv, OTRA_API_URL: "https://og.test/api" }, waitUntil() {} });
    const payload = await response.json();
    eq(payload.design && payload.design.meta, ["Wednesday to Sunday · 12:00 PM & 1:00 PM", "1 hour", "From $60"], "/api/event: authored hero items read days · times");
    eq(design.meta[0], "Wednesday to Sunday: 12:00 PM & 1:00 PM", "/api/event: the stored design keeps its text");
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.caches = savedCaches;
  }
}

if (failures.length) {
  console.error("check-search-card-schedule FAILED:");
  failures.forEach((failure) => console.error(" - " + failure));
  process.exit(1);
}
console.log("check-search-card-schedule OK (edited line wins, recurring has no single date, dated keeps date, fallbacks)");
