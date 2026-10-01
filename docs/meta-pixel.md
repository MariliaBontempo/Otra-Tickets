# Meta Pixel: passive integration

Pixel/Dataset: `9500041730032996`. Local feature branches:
`Otra-Tickets/feat/meta-pixel` and `curacao-calendar/feat/meta-pixel-checkout`.
Nothing has been deployed. This replaces the earlier redirect/acknowledgement implementation.

## Payment boundary

The following backend files match the original Git HEAD exactly:
`views.py`, `views_stripe_checkout.py`, `purchasing.py`, `sentoo_gateway.py`.
No payment calculation, provider request, checkout response, provisioning or redirect
has changed. The checkout template adds only an optional helper include and three
try/catch-wrapped notifications. Removing those additions reproduces the original
file exactly. There is no acknowledgement, delay, fetch replacement or dependency
on a tracking result. `scripts/check-meta-checkout.mjs` verifies this boundary.

## Events

- **PageView:** `meta-pixel.js`, once per document. The site uses full-page navigation;
  canonical replaceState and booking anchors do not count as new views. Existing
  index/event/Clearboat/RNB pages include it; future backend-created event pages
  inherit it through `event.html`. No duplicate backend Meta loader remains.
- **ViewContent:** after event details load, once per event ID/document. Omit money
  because advertised starting prices/tier currencies may be ambiguous.
- **InitiateCheckout:** after existing validation, immediately before the original
  Stripe checkout request or Sentoo form submission. Uses current selected tickets,
  displayed quote and currency. Sentoo excludes add-ons because its original form
  only submits tickets. A one-way postMessage to the storefront carries no PII.
  The parent checks iframe identity and origin. No reply/wait. This measures entry
  into checkout, not successful provider-session creation. Once per iframe document.
- **Purchase:** the existing confirmation template provides a signed order reference.
  After DOMContentLoaded, a separate GET to `/ticketing/meta-purchase/` reads verified
  payment data. Stripe must report `paid`; Sentoo's server session must be `success`.
  Failed/pending/cancelled states and URL success flags cannot create purchases.
  Rendering the confirmation page makes no new provider call or database query.
- **AddToCart:** omitted: no separate confirmed cart stage.

## Purchase data and failure behaviour

Stripe analytics uses an independent, 3-second-timeout read transport. It does not
change the payment SDK's global configuration. Full line-item pagination is handled.
Use confirmed session total/currency and discounted line totals, not the stored
pre-discount order amount. Existing product metadata identifies ticket/tier IDs;
for the direct iframe flow, existing session metadata maps unique product names and
quantities. Add-ons stay in the total but not the ticket count. Ambiguous mapping
skips the event instead of guessing. No provider metadata additions are required.

Sentoo uses its existing reference, amount, currency and line totals including fees.
Ticket IDs are matched against its saved selection by unique name/quantity, scoped
by event. JSON object ordering is not trusted. Renamed/ambiguous ticket names skip
tracking. No changes to session creation or persistence are required.

The analytics endpoint accepts only a signed reference (one-hour lifetime), returns
only whitelisted conversion fields, and is not cached. Failed lookups return no
event. Checkout and confirmation remain usable if scripts, storage, Meta or this
endpoint fail. No raw customer PII is included in Meta parameters.

## Deduplication and CAPI

Purchase uses persistent localStorage per provider session/reference, plus Web Locks
where supported. Refresh/revisit in the same browser/origin is deduplicated. If
storage is unavailable, skip the conversion. Clearing storage, another device, and
simultaneous tabs without Web Locks remain browser-only limitations.

`eventID = otratickets:Purchase:<provider session/reference>` is ready for future CAPI.
InitiateCheckout uses `otratickets:InitiateCheckout:<random UUID>` for the validated
browser attempt: no provider ID exists yet. Future CAPI would need to receive that
same UUID; this implementation deliberately does not alter payment requests to carry it.
Browser tracking is best-effort: navigation, blockers or network failure can lose
an event. It never delays checkout to improve tracking delivery.

## Environment, consent and rollout

Auto-enabled only on HTTPS `otratickets.com`, `otraguide.com` and their www variants.
Local/staging requires `?meta_debug=1` (sends real events unless fbq is mocked).
Staff previews/admin pages/iframe documents are excluded. Test-mode purchases are
suppressed unless Django DEBUG is enabled. Stripe amount conversion supports the
current two-decimal currencies USD/EUR/GBP/CAD/AUD; others skip tracking.

No existing marketing consent gate was detected on these routes. Existing Google
tracking is unchanged. If consent gating is introduced, apply it to this loader
and the production-only noscript fallback as well.

Deploy storefront first (shared `/meta-pixel.js`), then backend. In Meta Events
Manager: use the existing Dataset, configure Automatic Advanced Matching as planned,
allow both domains if Traffic Permissions is restricted, and remove any overlapping
manual/automatic Purchase rules. Verify actual receipt using Test Events after
release. No new Pixel, GTM installation or CAPI credential is required.

## Verification and files

Run in Otra Tickets:
```
npm run check:meta
node scripts/check-meta-checkout.mjs
npm run check:slug-override
npm run check:seo
npm run check:headers
npm run build
```
Run in curacao-calendar:
```
docker compose exec -T web python manage.py test apps.ticketing.tests.test_meta_pixel apps.ticketing.tests.test_stripe_checkout_iframe apps.ticketing.tests.test_sentoo_event_gating apps.ticketing.tests.test_sentoo_embed_gating apps.ticketing.tests.test_sentoo_persist_sessions --keepdb --noinput
```

Isolated Chrome QA used the real Django-rendered checkout and actual tracking code,
with local mocked provider endpoints/fbq. Verified validation prevents an invalid
submission, Stripe direct checkout, Stripe inline customer-details checkout, original
Sentoo form POST, tracker exceptions do not stop navigation, expected conversion
payloads and refresh deduplication. No requests were sent to Meta. Real Stripe/Sentoo
sandbox payments and Meta receipt in staging/production remain unverified.

Storefront files: `meta-pixel.js`, `functions/api/meta-pageview.js`, `index.html`,
`event.html`, `clearboat.html`, `rnb.html`, `scripts/build-pages.mjs`,
`scripts/check-meta-pixel.mjs`, `scripts/check-meta-checkout.mjs`, `package.json`, this doc.
Backend files: `apps/ticketing/{meta_pixel.py,views_meta.py,urls.py}`,
`apps/ticketing/templatetags/meta_pixel.py`, `apps/ticketing/tests/test_meta_pixel.py`,
`templates/ticketing/components/{meta_checkout.html,meta_purchase.html}`,
`templates/ticketing/{stripe_checkout_iframe_otratickets.html,stripe_checkout_success.html,sentoo_payment_return.html}`,
`templates/web/components/facebook_pixel.html`, `tasks/todo.md`.

Current revision verified 2026-10-01: 83 targeted Docker tests passed, plus storefront Meta/payment-boundary/slug/SEO/header checks and build. Earlier 38 Linux Node server tests passed; server code has not changed in this revision.
