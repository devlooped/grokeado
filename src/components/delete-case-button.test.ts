import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { DeleteCaseButton } from "./delete-case-button.tsx";

test("admin controls are labelled, show icons, and disable active cases", () => {
  for (const active of [false, true]) {
    const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "" };
    const content = createElement(AppRouterContext.Provider, { value: router }, createElement(DeleteCaseButton, { caseId: "AA-123-BB", active }));
    const { document } = parseHTML(renderToStaticMarkup(content));
    const buttons = [...document.querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Volver a ejecutar caso Nº AA-123-BB", "Eliminar caso Nº AA-123-BB"]);
    for (const button of buttons) {
      assert.equal(button.hasAttribute("disabled"), active);
      assert.match(button.getAttribute("class")!, active ? /disabled:cursor-not-allowed/ : /cursor-pointer/);
      assert.ok(button.querySelector('svg[aria-hidden="true"]'));
    }
  }
});
