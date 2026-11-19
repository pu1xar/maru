import { test } from "node:test";
import assert from "node:assert/strict";
import { addToast, closeToast, subscribeToasts, toasts, TOAST_TIMEOUT_MS } from "./toast.ts";

test("a toast is listed with its type, title and description, and closing removes it", () => {
  let heard = 0;
  const off = subscribeToasts(() => heard++);
  const id = addToast({ type: "success", title: "Copied" });
  assert.deepEqual(toasts().filter((t) => t.id === id), [{ id, type: "success", title: "Copied", description: null }]);
  closeToast(id);
  assert.equal(toasts().some((t) => t.id === id), false);
  assert.equal(heard, 2);
  closeToast(id);
  assert.equal(heard, 2, "closing a closed toast says nothing");
  off();
});

test("a toast closes itself after the web's timeout, a loading one stays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = addToast({ type: "info", title: "Notice", description: "Details" });
  const loading = addToast({ type: "loading", title: "Forking" });
  t.mock.timers.tick(TOAST_TIMEOUT_MS);
  assert.equal(toasts().some((x) => x.id === shown), false);
  assert.equal(toasts().some((x) => x.id === loading), true);
  closeToast(loading);
  assert.equal(TOAST_TIMEOUT_MS, 5000);
});
