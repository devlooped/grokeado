import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { DeleteCaseButton } from "./delete-case-button.tsx";

test("active cases show an enabled stop control instead of rerun; deletion remains disabled", () => {
  for (const active of [false, true]) {
    const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "" };
    const content = createElement(AppRouterContext.Provider, { value: router }, createElement(DeleteCaseButton, { caseId: "AA-123-BB", active }));
    const { document } = parseHTML(renderToStaticMarkup(content));
    const buttons = [...document.querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [active ? "Detener caso Nº AA-123-BB" : "Volver a ejecutar caso Nº AA-123-BB", "Eliminar caso Nº AA-123-BB"]);
    assert.equal(buttons[0]!.hasAttribute("disabled"), false);
    assert.equal(buttons[1]!.hasAttribute("disabled"), active);
    assert.equal(!!buttons[0]!.querySelector("rect"), active);
    for (const button of buttons) {
      assert.match(button.getAttribute("class")!, /cursor-pointer/);
      assert.ok(button.querySelector('svg[aria-hidden="true"]'));
    }
  }
});
