import { eventSlug } from "./event-slug.js";

// Old production pretty URLs that must 301 after a live Django title change.
// Keys are the slugs that currently 200 in production; values are the live
// Otra Guide titles the event page slugs from. The oracle imports this same
// list so the redirect targets cannot drift from comments.
export const SLUG_ALIAS_TITLES = [
  ["iguana-ride-e-scooter-city-combo-tour", "Iguana Scooter Ride - City Combo Tour"],
  ["iguana-ride-e-scooter-punda-or-otrobanda-tour", "Iguana Scooter Ride - Punda or Otrobanda Tour"],
  ["iguana-ride-e-scooter-night-tour", "Iguana Scooter Ride - Night Tour"],
  ["iguana-ride-e-scooter-sunset-tour", "Iguana Scooter Ride - Sunset Tour"],
];

export const SLUG_ALIASES = new Map(
  SLUG_ALIAS_TITLES.map(([from, title]) => [from, `/${eventSlug(title)}`]),
);
