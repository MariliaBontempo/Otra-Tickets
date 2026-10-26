import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_DETAIL_EXCEPTIONS } from "../../functions/_lib/guide-event-hidden.js";

test("hidden-detail exceptions keep 8088 and add Strange Bird Thursday 8266", () => {
  assert.equal(HIDDEN_DETAIL_EXCEPTIONS["8088"], "draft-1791253678425-26c548a5");
  assert.equal(HIDDEN_DETAIL_EXCEPTIONS["8266"], "draft-1792794458964-79d36de9");
  assert.ok(Object.isFrozen(HIDDEN_DETAIL_EXCEPTIONS));
});
