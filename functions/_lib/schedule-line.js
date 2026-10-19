// One schedule line for an event, shared by the homepage/search card and the
// event page hero line (#evMeta).
//
// event.html renders design.meta as <span> items with a <span class="dot">
// between them, so item i is "#evMeta > span:nth-of-type(2i+1)". The page
// editor saves hero line edits under those selectors (text:<selector>), and
// site-overrides.js applies them over the rendered spans. The card reads the
// same design.meta and the same override fields here, so whatever the page
// shows on its hero line is what the card shows.

export const META_HOST_SELECTOR = "#evMeta";

// Selector the page editor uses for the i-th (0 based) hero line item.
export function metaItemSelector(index) {
  return `${META_HOST_SELECTOR} > span:nth-of-type(${index * 2 + 1})`;
}

const META_SPAN_RE = /^#evMeta\s*>\s*span:nth-of-type\((\d+)\)$/;

function textField(field) {
  if (!field || typeof field !== "object" || field.type !== "text") return null;
  return typeof field.value === "string" ? field.value : null;
}

function overrideFields(override) {
  const fields = override && typeof override === "object" ? override.fields : null;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields : null;
}

// True when the page override edits the hero line at all.
export function hasEditedSchedule(override) {
  const fields = overrideFields(override);
  if (!fields) return false;
  return Object.entries(fields).some(([key, field]) => {
    if (textField(field) === null) return false;
    const selector = key.startsWith("text:") ? key.slice(5).trim() : "";
    return selector === META_HOST_SELECTOR || META_SPAN_RE.test(selector);
  });
}

// The hero line items exactly as the page shows them after edits.
// meta: the authored design.meta list. override: the page override object
// ({ fields }) or null. Items are trimmed and blanks are dropped.
export function editedScheduleParts(meta, override) {
  const items = (Array.isArray(meta) ? meta : []).map((item) => String(item == null ? "" : item));
  const fields = overrideFields(override);
  if (fields) {
    // Rendered spans: item, dot, item, dot, item ... (1 based nth-of-type).
    const spans = [];
    items.forEach((text, i) => {
      if (i) spans.push({ dot: true, text: "·" });
      spans.push({ dot: false, text });
    });
    let replaced = null;
    for (const [key, field] of Object.entries(fields)) {
      const value = textField(field);
      if (value === null || !key.startsWith("text:")) continue;
      const selector = key.slice(5).trim();
      if (selector === META_HOST_SELECTOR) {
        // Setting textContent on the host replaces every span.
        replaced = value;
        spans.length = 0;
        continue;
      }
      const match = selector.match(META_SPAN_RE);
      if (!match) continue;
      const span = spans[Number(match[1]) - 1];
      // Same as the page: a selector with no rendered span does nothing.
      // Separator dots stay separators on the card.
      if (span && !span.dot) span.text = value;
    }
    const parts = replaced !== null ? [replaced] : spans.filter((span) => !span.dot).map((span) => span.text);
    return parts.map((part) => part.trim()).filter(Boolean);
  }
  return items.map((item) => item.trim()).filter(Boolean);
}

const CARD_DATE_RE = /(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi;

function isTicketMetadata(value, rateNames) {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (rateNames.some((name) => text === name || text.startsWith(`${name} `))) return true;
  if (/(?:[$€£ƒ]|\b(?:usd|ang|xcg|awg|eur|naf|fl\.?)\b)\s*\d/i.test(value)) return true;
  return /\b(?:early bird|general admission|ticket(?:s| type)?|presale|door price)\b/i.test(value);
}

function validDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

// Card schedule line for a site event project.
//   project.claudeDesign.meta   authored hero line items
//   project.claudeDesign.rates  ticket names (kept off the card)
//   project.startDate           real start of a dated event
//   project.isPerennial         recurring tour: never pinned to one date
// override: the page override the event page applies (may be null).
export function cardScheduleLabel(project, override = null, { timeZone = "America/Curacao" } = {}) {
  const source = project && typeof project === "object" ? project : {};
  const design = source.claudeDesign && typeof source.claudeDesign === "object" ? source.claudeDesign : {};
  const rateNames = Array.isArray(design.rates)
    ? design.rates.map((rate) => String((rate && rate.name) || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const schedule = editedScheduleParts(design.meta, override).filter((item) => !isTicketMetadata(item, rateNames));
  const perennial = source.isPerennial === true;

  // A recurring tour runs on many days; its first start date is not a
  // schedule, so the card shows only the authored line.
  if (perennial) return schedule.length ? schedule.join(" · ") : "Flexible dates";

  const actualDate = validDate(source.startDate);
  if (actualDate) {
    const label = new Date(actualDate).toLocaleDateString("en-US", {
      weekday: "short", month: "long", day: "numeric", timeZone,
    });
    let replaced = false;
    const synchronized = schedule.map((item) => {
      CARD_DATE_RE.lastIndex = 0;
      if (!CARD_DATE_RE.test(item)) return item;
      replaced = true;
      CARD_DATE_RE.lastIndex = 0;
      return item.replace(CARD_DATE_RE, label);
    });
    if (!replaced) synchronized.unshift(label);
    return synchronized.join(" · ");
  }
  // A dated event with no start date keeps its authored schedule.
  return schedule.join(" · ");
}
