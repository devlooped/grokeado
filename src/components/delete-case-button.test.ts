import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { DeleteCaseButton } from "./delete-case-button.tsx";

test("delete control is labelled, shows a trash icon, and disables active cases", () => {
  for (const active of [false, true]) {
    const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "" };
    const content = createElement(AppRouterContext.Provider, { value: router }, createElement(DeleteCaseButton, { caseId: "AA-123-BB", active }));
    const { document } = parseHTML(renderToStaticMarkup(content));
    const button = document.querySelector("button")!;
    assert.equal(button.getAttribute("aria-label"), "Eliminar caso Nº AA-123-BB");
    assert.equal(button.hasAttribute("disabled"), active);
    assert.ok(button.querySelector('svg[aria-hidden="true"]'));
  }
});
