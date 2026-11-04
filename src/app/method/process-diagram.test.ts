import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ProcessDiagram } from "./process-diagram.tsx";
import MethodPage from "./page.tsx";

const html = renderToStaticMarkup(createElement(ProcessDiagram));
const { document } = parseHTML(html);

test("the process is rendered as an accessible Pele diagram", () => {
  const region = document.querySelector('[role="region"]');
  const svg = region?.querySelector("svg.pele-flowchart");
  assert.ok(svg);
  assert.equal(svg.querySelector("title")?.textContent, "El proceso de un chequeo");
  assert.match(svg.querySelector("desc")?.textContent ?? "", /crítica de fuentes/);
  for (const text of [
    "Se cierra la instrucción",
    "Expediente común sin fuentes",
    "Fuente anulada",
    "Fuente admitida",
    "Se anula la intervención objetada",
    "Resultado por mayoría",
    "El moderador desempata",
    "Termina el debate",
  ]) assert.ok(svg.textContent?.replace(/\s/g, "").includes(text.replace(/\s/g, "")), text);
  assert.ok(!svg.textContent?.replace(/\s/g, "").includes("Secierraelexpediente"));
  assert.equal(region?.getAttribute("tabindex"), "0");
});

test("the process diagram follows the four possible results on the method page", () => {
  const page = parseHTML(renderToStaticMarkup(createElement(MethodPage))).document;
  const sections = [...page.querySelectorAll("main section, section")];
  const results = sections.findIndex((section) => section.id === "resultados");
  const process = sections.findIndex((section) => section.id === "proceso");
  assert.ok(results >= 0 && process > results);
  assert.ok(sections[process]?.querySelector("svg.pele-flowchart"));
});
