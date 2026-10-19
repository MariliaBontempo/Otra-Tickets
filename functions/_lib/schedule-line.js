// Card schedule line for the homepage/search cards, computed from the same
// inputs the event page hero line (#evMeta) uses.
//
// event.html renderMeta() renders its hero line items as <span> elements with
// a <span class="dot"> between them, so item i is
// "#evMeta > span:nth-of-type(2i+1)". The admin page editor saves hero line
// edits under those selectors (text:<selector>; a one item line has no
// siblings, so its selector is the bare "#evMeta > span"), and
// site-overrides.js applies them over the rendered spans in the browser. This
// module replays the same edits over the same items, so the card says what
// the page shows. The page itself still renders through event.html.

export const META_HOST_SELECTOR = "#evMeta";

// Selector the page editor uses for the i-th (0 based) hero line item when
// the line has more than one item.
export function metaItemSelector(index) {
  return `${META_HOST_SELECTOR} > span:nth-of-type(${index * 2 + 1})`;
}

const META_SPAN_RE = /^#evMeta\s*>\s*span(?::nth-of-type\((\d+)\))?$/;

// Which hero line node a field key targets, or null when it is not a hero
// line text edit. { host: true } for the whole line, { span: n } (1 based)
// for one rendered span.
function metaTarget(key) {
  if (typeof key !== "string" || !key.startsWith("text:")) return null;
  const selector = key.slice(5).trim();
  if (selector === META_HOST_SELECTOR) return { host: true };
  const match = selector.match(META_SPAN_RE);
  if (!match) return null;
  // querySelector("#evMeta > span") returns the first span.
  return { span: match[1] ? Number(match[1]) : 1 };
}

// Same rule as /api/override normalizeFields, which feeds site-overrides.js:
// only text fields count, and a non string value becomes "".
function textValue(field) {
  if (!field || typeof field !== "object" || field.type !== "text") return null;
  return typeof field.value === "string" ? field.value : "";
}

function overrideFields(override) {
  const fields = override && typeof override === "object" ? override.fields : null;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields : null;
}

// The hero line items exactly as the page shows them after edits.
// items: the rendered hero line items before edits. override: the page
// override object ({ fields }) or null. Items are trimmed; blanks dropped.
export function editedScheduleParts(items, override) {
  const base = (Array.isArray(items) ? items : []).map((item) => String(item == null ? "" : item));
  const fields = overrideFields(override);
  let parts = base;
  if (fields) {
    // Rendered spans: item, dot, item, dot, item ... (1 based nth-of-type).
    const spans = [];
    base.forEach((text, i) => {
      if (i) spans.push({ dot: true, text: "·" });
      spans.push({ dot: false, text });
    });
    let replaced = null;
    for (const [key, field] of Object.entries(fields)) {
      const target = metaTarget(key);
      const value = target ? textValue(field) : null;
      if (value === null) continue;
      if (target.host) {
        // Setting textContent on the host replaces every span.
        replaced = value;
        spans.length = 0;
        continue;
      }
      const span = spans[target.span - 1];
      // Same as the page: a selector with no rendered span does nothing.
      // Separator dots stay separators on the card.
      if (span && !span.dot) span.text = value;
    }
    parts = replaced !== null ? [replaced] : spans.filter((span) => !span.dot).map((span) => span.text);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

const CARD_DATE_RE = /(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi;

function isTicketMetadata(value, rateNames) {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (rateNames.some((name) => text === name || text.startsWith(`${name} `))) return true;
  if (/(?:[$€£ƒ]|\b(?:usd|ang|xcg|awg|eur|naf|fl\.?)\b)\s*\d/i.test(value)) return true;
  return /\b(?:early bird|general admission|ticket(?:s| type)?|presale|door price)\b/i.test(value);
}

export function validDateValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function cardDate(value, timeZone) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", timeZone });
}

// The hero line items the page renders before any edit: design.meta, or when
// that is empty, event.html's fallback span (the start date for a dated
// event, "Flexible dates" for a recurring tour).
function renderedItems(source, timeZone) {
  const design = source.claudeDesign && typeof source.claudeDesign === "object" ? source.claudeDesign : {};
  // Same test as event.html: any meta array with entries is rendered as is.
  if (Array.isArray(design.meta) && design.meta.length) return design.meta;
  if (source.isPerennial === true) return ["Flexible dates"];
  const start = validDateValue(source.startDate);
  return start ? [cardDate(start, timeZone)] : [];
}

function sourceOf(project) {
  return project && typeof project === "object" ? project : {};
}

// True when the page override changes what the page hero line shows.
export function scheduleEdited(project, override, { timeZone = "America/Curacao" } = {}) {
  const items = renderedItems(sourceOf(project), timeZone);
  const before = editedScheduleParts(items, null);
  const after = editedScheduleParts(items, override);
  return before.length !== after.length || before.some((part, i) => part !== after[i]);
}

// Card schedule line for a site event project.
//   project.claudeDesign.meta   authored hero line items
//   project.claudeDesign.rates  ticket names (kept off the card)
//   project.startDate           real start of a dated event
//   project.isPerennial         recurring tour: never pinned to one date
// override: the page override the event page applies (may be null).
export function cardScheduleLabel(project, override = null, { timeZone = "America/Curacao" } = {}) {
  const source = sourceOf(project);
  const design = source.claudeDesign && typeof source.claudeDesign === "object" ? source.claudeDesign : {};
  const rateNames = Array.isArray(design.rates)
    ? design.rates.map((rate) => String((rate && rate.name) || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const schedule = editedScheduleParts(renderedItems(source, timeZone), override)
    .filter((item) => !isTicketMetadata(item, rateNames));

  // A recurring tour runs on many days; its first start date is not a
  // schedule, so the card shows only the hero line.
  if (source.isPerennial === true) return schedule.length ? schedule.join(" · ") : "Flexible dates";

  const actualDate = validDateValue(source.startDate);
  if (actualDate) {
    const label = cardDate(actualDate, timeZone);
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
