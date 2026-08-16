import assert from "node:assert/strict";
import test from "node:test";
import { parseEmailReadStateEvent } from "./app-events";

test("parses an email read-state SSE event", () => {
  assert.deepEqual(
    parseEmailReadStateEvent(JSON.stringify({
      type: "email-read-state",
      payload: { id: "mail-1", panelRead: true, panelReadAt: "2026-08-17T00:00:00.000Z" }
    })),
    { id: "mail-1", panelRead: true, panelReadAt: "2026-08-17T00:00:00.000Z" }
  );
});

test("clears panelReadAt for unread events", () => {
  assert.deepEqual(
    parseEmailReadStateEvent(JSON.stringify({
      type: "email-read-state",
      payload: { id: "mail-1", panelRead: false, panelReadAt: "stale" }
    })),
    { id: "mail-1", panelRead: false, panelReadAt: undefined }
  );
});

test("ignores malformed and unrelated SSE events", () => {
  assert.equal(parseEmailReadStateEvent("not-json"), undefined);
  assert.equal(parseEmailReadStateEvent(JSON.stringify({ type: "email", payload: { id: "mail-1" } })), undefined);
});