# Otra Tickets

Front-end for the **Otra Tickets** events platform — a Netflix-style ticketing
storefront for events, tours, and experiences in Curaçao. Built as a static site
(vanilla HTML/CSS/JS, no build step) and deployed on Cloudflare Pages.

Powered by Otra Guide.

## Pages

| URL | File | What it is |
| --- | --- | --- |
| `/` | `index.html` | **Events Mosaic** — the brand splash: the OTRA TICKETS wordmark knocked out over a 5×5 grid of event photography. Click **Enter Events** to go to the storefront. |
| `/events.html` | `events.html` | **Otra Tickets storefront** — the events browse page with a full header (search, profile, menu, location, language) and horizontally-scrolling category rows of event cards. The Clearboat cards open the event detail page. |
| `/clearboat.html` | `clearboat.html` | **Clearboat West Coast Tour** — a single cinematic event detail page: hero, story, video slot, highlights, practical info, rates, a working booking calendar → checkout mock, and a "Pairs Well With" related row. |

Navigation is wired: the splash leads into the storefront, the storefront logo
returns home, the Clearboat cards open the event page, and the event-page logo
returns to the storefront.

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

## Deployment

Deployed via **Cloudflare Pages** connected to this GitHub repo. Every push to
`main` triggers an automatic deploy. No build command — Cloudflare serves the
repo root as static files.
