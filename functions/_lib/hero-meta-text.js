// Display text of one hero line (#evMeta) item, shared by every place that
// shows the line: /api/event (authored design.meta items), /api/override
// (page editor edits of hero line items, which site-overrides.js applies) and
// the homepage/search card (schedule-line.js). One rule, one place.
//
// The line separates its items with a middle dot, so a colon between the days
// and the times reads heavy: "Wednesday to Sunday: 12:00 PM & 1:00 PM"
// becomes "Wednesday to Sunday · 12:00 PM & 1:00 PM". Only a colon that
// follows a run of day names and is followed by a time changes; colons inside
// times (12:00) and any other colon ("Doors: 8 PM", "Dec 31: 9 PM",
// "Saturday: The Party") stay as written. The stored text is never rewritten.

export const META_SEPARATOR = " · ";

// Day names (full, short, plural) in English, Spanish, Dutch and Papiamentu,
// plus whole week words. Accents are optional so plain typing matches too.
const DAY_WORDS = [
  // English
  "mon(?:day)?s?", "tue(?:s(?:day)?)?s?", "wed(?:nesday)?s?", "thu(?:r(?:s(?:day)?)?)?s?",
  "fri(?:day)?s?", "sat(?:urday)?s?", "sun(?:day)?s?",
  "daily", "every\\s+day", "everyday", "weekdays?", "weekends?",
  // Spanish
  "lunes", "martes", "mi[eé]rcoles", "jueves", "viernes", "s[aá]bados?", "domingos?",
  "diario", "todos\\s+los\\s+d[ií]as",
  // Dutch
  "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag",
  "dagelijks", "elke\\s+dag",
  // Papiamentu
  "djaluna", "djamars", "djarason", "djaweps", "djabierne", "djasabra", "djadumingu",
  "tur\\s+dia",
];
// "Every Friday", "Cada viernes", "Elke vrijdag", "Tur djabierne".
const EVERY = "(?:(?:every|cada|todos\\s+los|elke|iedere|tur)\\s+)?";
const DAY = `${EVERY}(?:${DAY_WORDS.join("|")})\\.?`;
// Words that join day names: "to", "through", "and", "&", "-", ",", "/",
// Spanish "a"/"al"/"y", Dutch "tot"/"t/m"/"en", Papiamentu "te"/"i".
const JOIN = "(?:\\s*(?:,|/|&|\\+|-|–|—)\\s*|\\s+(?:to|through|thru|till|until|and|a|al|y|hasta|tot|t/m|tot\\s+en\\s+met|en|te|i)\\s+)";
const DAY_RUN = `${DAY}(?:${JOIN}${DAY})*`;
// A time: 12:00, 9.30, 9 AM, 8pm, 9 to 11 PM, 21h, 21h30, 21u, 12.00 uur. A
// bare number ("21+ only", "2026 edition") is not a time.
const MERIDIEM = "\\s*[ap]\\.?\\s?m\\b\\.?";
const TIME = `\\d{1,2}(?:[:.]\\d{2}(?!\\d)|${MERIDIEM}|h(?:\\d{2})?\\b|u\\b|\\s*uur\\b|\\s*(?:-|–|to)\\s*\\d{1,2}(?:[:.]\\d{2})?${MERIDIEM})`;
const TIME_AHEAD = `(?=${TIME})`;
// The day run starts the item or follows a separator another edit typed in
// ("Mon to Fri: 9 AM · Sat: 10 AM", "Mon: 9 AM; Tue: 10 AM").
const DAYS_COLON_TIME = new RegExp(`(^|[·|;]\\s*)(${DAY_RUN})\\s*:\\s*${TIME_AHEAD}`, "giu");

export function heroMetaItemText(value) {
  if (typeof value !== "string" || !value.includes(":")) return value;
  return value.replace(DAYS_COLON_TIME, (_match, lead, days) => `${lead}${days}${META_SEPARATOR}`);
}

// Same mapping over a list of items; anything that is not a string is kept.
export function heroMetaItems(items) {
  return Array.isArray(items) ? items.map(heroMetaItemText) : items;
}
