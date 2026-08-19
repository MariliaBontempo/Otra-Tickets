# Otra Tickets

Front-end for the **Otra Tickets** events platform — a Netflix-style ticketing
storefront for events, tours, and experiences in Curaçao. Built as a static site
(vanilla HTML/CSS/JS, no build step) and deployed on Cloudflare Pages.

Powered by Otra Guide.

## Pages

| URL | File | What it is |
| --- | --- | --- |
| `/` | `index.html` | **Otra Tickets storefront** — the hero mosaic under the OTRA TICKETS wordmark, then horizontally-scrolling category rows of event cards built from the live `/api/homepage-events` feed. Cards open their event detail page. |
| `/<event-slug>` | `event.html` | Event detail page, rendered by `functions/[slug].js` from the feed entry for that slug. |
| `/events` | — | Retired. Permanently redirects to `/` (see `RETIRED_PATHS` in `functions/[slug].js`). |
| `/clearboat` | `clearboat.html` | **Clearboat West Coast Tour** — a single cinematic event detail page: hero, story, video slot, highlights, practical info, rates, a working booking calendar → checkout mock, and a "Pairs Well With" related row. |
| `/admin/` | `admin/index.html` | Staff-only editor for site-side event/page overrides. |

Navigation is wired: the storefront cards open their event page, and the logo in
the header returns to `/` from every page.

## Design system

Near-black surfaces (`#07080a`), brushed-silver display type, a single steel-blue
accent (`#3f7cc4`), square corners, hairline borders. Fonts: Archivo, Space
Grotesk, Inter, Poppins (Google Fonts, mirrored in `fonts/`).

## Folders

- `uploads/` — event photography, flyers, the Clearboat photos, the logo + wordmark, and the black paper texture.
- `photos/` — additional Caribbean event/tour photography used in the storefront grid.
- `fonts/` — local font files.

## Notes

- The booking flow (calendar, guest steppers, totals, 9% processing fee, checkout)
  is a **front-end mock** — no real payment processing is wired.
- Header dropdowns, search, and category rows are interactive but not connected to a backend.

## Running locally

No build step — serve the folder with any static server:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

To test Cloudflare Pages Functions and local KV/R2 bindings:

```sh
npm exec --yes wrangler@4.101.0 -- pages dev . \
  --port 8790 \
  --kv OVERRIDES \
  --r2 OVERRIDE_IMAGES \
  --persist-to .wrangler/state \
  --compatibility-date=2026-06-17
```

## Admin overrides

Cloudflare Pages needs these production bindings:

- `OVERRIDES` — KV namespace for text/image override metadata.
- `OVERRIDE_IMAGES` — R2 bucket for uploaded override images.

The admin login proxies Otra Guide auth through `/admin/api/login` and every
write endpoint re-checks `is_staff_or_admin`. Public pages read overrides from
same-origin Functions; the Otra Guide backend is not modified. Overrides can
target the main event description/image or individual page fields such as
titles, body copy, rate labels, info cells, hero photos, gallery images, and
other content that exists only in this site.

## Deployment

Deployed via **Cloudflare Pages** connected to this GitHub repo. Every push to
`main` triggers an automatic deploy. No build command — Cloudflare serves the
repo root as static files.
