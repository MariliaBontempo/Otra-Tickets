// Oracle: admin event search must use the staff-only all-ticket-types endpoint,
// keep expired tickets selectable, and clearly label past results in the UI.
// Run: node scripts/check-admin-past-event-search.mjs

import fs from 'node:fs';
import { URL } from 'node:url';
import { onRequestGet } from '../functions/admin/api/events.js';

const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const originalFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/users/user-role/')) {
    return Response.json({ is_staff_or_admin: true });
  }
  if (url.includes('/events/admin-ticketed-search/?q=love')) {
    return Response.json({
      events: [{
        id: 7275,
        title: 'WE LOVE R&B - CASCADA - 4th OF JULY',
        startDate: '2026-07-04T18:00:00-04:00',
        endDate: '2026-07-05T01:59:00-04:00',
        isPast: true,
        isTicketed: true,
        published: false,
        tickets: [
          { id: 296, name: 'General Admission', price: '15.00', quantity: 500, currency: 'USD', isActive: false },
          { id: 298, name: 'VIP Table for 4', price: '450.00', quantity: 20, currency: 'USD', isActive: false },
        ],
      }, {
        id: 9001,
        title: 'Direct payment - private charter',
        slug: 'payment-abc12345',
        startDate: '2026-07-04T18:00:00-04:00',
        endDate: '2026-07-04T20:00:00-04:00',
        isPast: true,
        isTicketed: true,
        tickets: [
          { id: 999, name: 'Private charter payment', price: '500.00', quantity: 1, currency: 'USD' },
        ],
      }],
    });
  }
  return new Response('{}', { status: 404 });
};

try {
  const response = await onRequestGet({
    request: new Request('https://tickets.test/admin/api/events?q=love', {
      headers: { authorization: 'Bearer test-token' },
    }),
    env: { OTRA_API_URL: 'https://backend.test/api' },
  });
  const payload = await response.json();
  assert(response.status === 200, 'search proxy must succeed');
  assert(payload.events?.length === 1, 'past ticketed event must remain in search results');
  assert(payload.events?.[0]?.id === 7275, 'payment-link invoice events must be removed from search results');
  assert(payload.events?.[0]?.isPast === true, 'past marker must survive proxy normalization');
  assert(payload.events?.[0]?.tickets?.length === 2, 'expired ticket types must remain selectable');
  assert(payload.events?.[0]?.tickets?.[0]?.id === 296, 'original ticket type ids must be preserved');
  assert(
    calls.some((url) => url.includes('/events/admin-ticketed-search/?q=love')),
    'search must call the staff-only historical endpoint'
  );
  assert(
    !calls.some((url) => url.includes('/ticket/purchase/tickets/')),
    'successful admin search must not use the sale-window-filtered purchase endpoint'
  );
} finally {
  globalThis.fetch = originalFetch;
}

const adminHtml = fs.readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
assert(
  /event\.isPast\s*\?\s*["']\s*— Past event/.test(adminHtml),
  'event dropdown must append the Past event warning'
);
assert(
  /selectedExistingEvent\.isPast\s*\?\s*["']Past event/.test(adminHtml),
  'selected-event metadata must keep the Past event warning visible'
);
assert(
  /event\.title\}\$\{event\.isPast\s*\?\s*["'] — Past event/.test(adminHtml),
  'clone search results must label past events too'
);

const projectsSource = fs.readFileSync(new URL('../functions/admin/api/projects.js', import.meta.url), 'utf8');
assert(
  projectsSource.includes('/events/admin-ticketed-search/?id=${eventId}'),
  'draft binding must fetch expired ticket types from the admin endpoint'
);
assert(
  /ticket\.base_currency\s*\|\|\s*ticket\.currency/.test(projectsSource),
  'draft rates must retain the historical ticket currency'
);

if (failures.length) {
  console.error('check-admin-past-event-search FAILED:');
  failures.forEach((failure) => console.error(' - ' + failure));
  process.exit(1);
}

console.log('check-admin-past-event-search OK (expired tickets searchable and past events labeled)');
