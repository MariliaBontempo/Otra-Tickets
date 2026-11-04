// Homepage and search cards must show venue text only, never links.
// Guide 8333 Daniel Unfolded carried a Google Maps short URL in its
// practical info Location, which leaked onto its card.
import assert from "node:assert/strict";
import { cardVenue, cardVenueText, dedupeEvents, projectVenue } from "../functions/_lib/homepage-feed.js";

const DANIEL = "Landhuis Daniel, Weg naar westpunt z/n · terrace · https://maps.app.goo.gl/SJ3uFcuxSQD8YftT6";
const DANIEL_CLEAN = "Landhuis Daniel, Weg naar westpunt z/n · terrace";

const cases = [
  [DANIEL, DANIEL_CLEAN],
  ["Mambo Beach · https://maps.app.goo.gl/abc · Bar", "Mambo Beach · Bar"],
  ["Kaya Kaya, Otrobanda", "Kaya Kaya, Otrobanda"],
  ["  Cascada Rooftop  ", "Cascada Rooftop"],
  ["St. Anna Bay · Punda", "St. Anna Bay · Punda"],
  ["Pietermaai www.example.com", "Pietermaai"],
  ["Daaibooi http://a.example/x https://b.example/y", "Daaibooi"],
  ["Westpunt (https://maps.app.goo.gl/x)", "Westpunt"],
  ["Westpunt, see https://maps.app.goo.gl/x.", "Westpunt, see"],
  ["Venue: Landhuis, https://maps.app.goo.gl/x", "Venue: Landhuis"],
  ["HTTPS://MAPS.APP.GOO.GL/X · Landhuis", "Landhuis"],
  ["https://maps.app.goo.gl/SJ3uFcuxSQD8YftT6", ""],
  [" · https://x.example · ", ""],
  ["", ""],
  [null, ""],
  [undefined, ""],
  [42, ""],
];
for (const [input, expected] of cases) {
  assert.equal(cardVenueText(input), expected, `cardVenueText(${JSON.stringify(input)})`);
}

// Published draft path: practical info Location (the live 8333 source).
const draft = (value, eyebrow = "") => ({
  claudeDesign: { practicalInfo: [{ key: "Location", value }], eyebrow },
});
assert.equal(projectVenue(draft(DANIEL)), DANIEL_CLEAN);
assert.equal(projectVenue(draft("Kaya Kaya")), "Kaya Kaya");
// Location that is only a link falls back to the eyebrow venue, then Curaçao.
assert.equal(projectVenue(draft("https://maps.app.goo.gl/x", "Dinner · Landhuis Daniel · Fri")), "Landhuis Daniel");
assert.equal(projectVenue(draft("https://maps.app.goo.gl/x", "Dinner · https://maps.app.goo.gl/y")), "Curaçao");
assert.equal(projectVenue({ claudeDesign: {} }), "Curaçao");

// Upstream Guide path: Event.location and the description fallback.
assert.equal(cardVenue({ id: "8333", title: "Daniel Unfolded", location: DANIEL }), DANIEL_CLEAN);
assert.equal(cardVenue({ id: "1", title: "T", location: "https://maps.app.goo.gl/x", group_name: "Landhuis Daniel" }), "Landhuis Daniel");
assert.equal(cardVenue({ id: "1", title: "T", location: "", description: "Venue: Landhuis Daniel https://maps.app.goo.gl/x" }), "Landhuis Daniel");
assert.equal(cardVenue({ id: "1", title: "T", location: "https://maps.app.goo.gl/x" }), "Curaçao");
assert.equal(cardVenue({ id: "1", title: "Kaya Kaya", location: "Kaya Kaya" }), "Curaçao");
assert.equal(cardVenue({ id: "1", title: "T", location: "Otrobanda" }), "Otrobanda");

// Dedupe: Guide location wins over a draft venue, cleaned; a location that is
// only a link never wipes the draft venue.
{
  const [ev] = dedupeEvents([
    { id: "8333", venue: DANIEL_CLEAN, location: "" },
    { id: "8333", venue: "Curaçao", location: `Landhuis Daniel · ${"https://maps.app.goo.gl/z"}` },
  ]);
  assert.equal(ev.venue, "Landhuis Daniel");
}
{
  const [ev] = dedupeEvents([
    { id: "8333", venue: DANIEL_CLEAN, location: "" },
    { id: "8333", venue: "Curaçao", location: "https://maps.app.goo.gl/z" },
  ]);
  assert.equal(ev.venue, DANIEL_CLEAN);
}
{
  const [ev] = dedupeEvents([
    { id: "8333", venue: DANIEL_CLEAN, location: "" },
    { id: "8333", venue: "Curaçao", location: "" },
  ]);
  assert.equal(ev.venue, DANIEL_CLEAN);
  assert.doesNotMatch(ev.venue, /https?:|www\./i);
}

console.log("card venue url strip checks passed");
