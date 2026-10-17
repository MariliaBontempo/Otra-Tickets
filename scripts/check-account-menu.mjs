import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const pages = ["index.html", "event.html", "clearboat.html", "rnb.html"];

for (const page of pages) {
  const html = read(page);
  const start = html.indexOf('<div class="dd-panel dd-profile">');
  assert.ok(start > -1, `${page}: profile panel exists`);
  // The panel is the last dropdown in the header: it ends at the header close.
  const panel = html.slice(start, html.indexOf("</header>", start));
  assert.ok(panel.includes("data-account-panel"), `${page}: panel has data-account-panel`);
  assert.ok(!/href="#"/.test(panel), `${page}: no href="#" left in the profile panel`);
  assert.ok(!/data-acc\b/.test(panel), `${page}: placeholder accordion groups removed`);
  assert.ok(!/Payment Methods|My Favorites|Notifications/.test(panel), `${page}: placeholder groups removed`);
  assert.ok(html.includes('<script src="/account-menu.js"'), `${page}: loads account-menu.js`);
}

const build = read("scripts/build-pages.mjs");
assert.ok(/copyEntries = \[[^\]]*"account-menu\.js"/s.test(build), "account-menu.js is in copyEntries");

assert.ok(existsSync(new URL("../account-menu.js", import.meta.url)), "account-menu.js exists");
const js = read("account-menu.js");
for (const needle of [
  "Sign in", "Use your Otra Guide account", "Create an account", "Forgot password?",
  "https://www.otraguide.com/accounts/signup/", "https://www.otraguide.com/accounts/password/reset/",
  "My tickets", "https://www.otraguide.com/tickets/", "Account settings",
  "https://www.otraguide.com/users/profile/", "Sign out", "/api/login", "/api/me", "/api/logout",
  "same-origin", "isStaff", "location.reload",
]) assert.ok(js.includes(needle), `account-menu.js mentions ${needle}`);

const event = read("event.html");
assert.ok(event.includes("Array.isArray(ev.addons)"), "event.html guards ev.addons");
assert.ok(event.includes("Add-ons are booked with a ticket at checkout."), "event.html add-on foot line");
assert.ok(event.includes(">Add-on<") || event.includes("Add-on</div>"), "event.html add-on kicker");

console.log("account menu checks passed");
