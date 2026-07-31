import assert from "node:assert/strict";
import test from "node:test";
import { buildOptimisticPanelReadPatch } from "./read-state";

test("buildOptimisticPanelReadPatch marks a message read immediately with a timestamp", () => {
  assert.deepEqual(buildOptimisticPanelReadPatch(true, "2026-08-01T08:00:00.000Z"), {
    panelRead: true,
    panelReadAt: "2026-08-01T08:00:00.000Z"
  });
});

test("buildOptimisticPanelReadPatch clears the timestamp when marking unread", () => {
  assert.deepEqual(buildOptimisticPanelReadPatch(false, "2026-08-01T08:00:00.000Z"), {
    panelRead: false,
    panelReadAt: undefined
  });
});
