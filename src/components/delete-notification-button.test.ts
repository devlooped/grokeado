import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { DeleteNotificationButton } from "./delete-notification-button.tsx";

test("notification delete button is labelled and shows a trash icon", () => {
  const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "" };
  const content = createElement(AppRouterContext.Provider, { value: router }, createElement(DeleteNotificationButton, { id: "42", title: "Falló un caso" }));
  const html = renderToStaticMarkup(content);
  assert.match(html, /aria-label="Eliminar notificación: Falló un caso"/);
  assert.match(html, /title="Eliminar notificación"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
});
