import assert from "node:assert/strict";
import test from "node:test";
import { matchQuote } from "./quote-match.ts";

const blocks = [
  { id: "p1:b1", page: 1, text: "# Censo 2022: resultados definitivos" },
  { id: "p1:b2", page: 1, text: "La Ciudad Autónoma de Buenos Aires tiene **3.121.707** habitantes, según el INDEC." },
  { id: "p1:b3", page: 1, text: "El total del país es de 46.044.703 personas." },
  { id: "p2:b1", page: 2, text: "Los resultados provisionales no se usan en este informe." },
];

test("an exact quote matches its block", () => {
  assert.deepEqual(matchQuote(blocks, "La Ciudad Autónoma de Buenos Aires tiene 3.121.707 habitantes"), { blockIds: ["p1:b2"] });
});

test("accents, case, punctuation and markup do not prevent a match", () => {
  assert.deepEqual(matchQuote(blocks, "«la ciudad autonoma de buenos aires tiene 3121707 habitantes, segun el Indec»"), undefined, "digits grouped differently are another text");
  assert.deepEqual(matchQuote(blocks, "«LA CIUDAD AUTONOMA DE BUENOS AIRES TIENE 3.121.707 HABITANTES — según el INDEC.»"), { blockIds: ["p1:b2"] });
});

test("a quote across a Markdown link matches its label, not its target", () => {
  const linked = [
    { id: "p1:b1", page: 1, text: 'No domingo à noite, Moraes [**determinou que Flávio não poderia deixar o País**](https://example.test/pf/?id=1 "https://example.test/pf/?id=1") e o italiano.' },
    { id: "p1:b2", page: 1, text: "El senador [Flávio Bolsonaro](https://example.test/a_(b)) huyó a [Miami](https://example.test/miami/). ![Foto](https://example.test/f.jpg) Ver <https://example.test/x>." },
  ];
  assert.deepEqual(matchQuote(linked, "No domingo à noite, Moraes determinou que Flávio não poderia deixar o País e o italiano"), { blockIds: ["p1:b1"] });
  assert.deepEqual(matchQuote(linked, "El senador Flávio Bolsonaro huyó a Miami. Ver"), { blockIds: ["p1:b2"] });
  assert.equal(matchQuote(linked, "example test miami"), undefined, "a link target is not quoted text");
});

test("an ellipsis matches its segments in order, across blocks", () => {
  assert.deepEqual(matchQuote(blocks, "Buenos Aires tiene 3.121.707 habitantes … el total del país es de 46.044.703"), { blockIds: ["p1:b2", "p1:b3"] });
  assert.deepEqual(matchQuote(blocks, "Buenos Aires tiene 3.121.707 habitantes [...] Los resultados provisionales no se usan"), { blockIds: ["p1:b2", "p2:b1"] });
  assert.equal(matchQuote(blocks, "el total del país es de 46.044.703 ... Buenos Aires tiene 3.121.707 habitantes"), undefined, "segments out of order");
});

test("a quote spanning two blocks matches both", () => {
  assert.deepEqual(matchQuote(blocks, "según el INDEC. El total del país es de 46.044.703 personas"), { blockIds: ["p1:b2", "p1:b3"] });
});

test("a paraphrase, a translation, a short fragment or another source's quote does not match", () => {
  assert.equal(matchQuote(blocks, "La CABA supera los tres millones de habitantes según el INDEC"), undefined);
  assert.equal(matchQuote(blocks, "The Autonomous City of Buenos Aires has 3,121,707 inhabitants"), undefined);
  assert.equal(matchQuote(blocks, "habitantes"), undefined);
  assert.equal(matchQuote(blocks, "Buenos Aires tiene 3.121.707 habitantes … INDEC"), undefined, "every segment must be substantial");
  const other = [{ id: "p1:b1", page: 1, text: "Las exportaciones PyME crecieron 17,3% en dólares en 2024." }];
  assert.equal(matchQuote(other, "La Ciudad Autónoma de Buenos Aires tiene 3.121.707 habitantes"), undefined);
  assert.equal(matchQuote([], "La Ciudad Autónoma de Buenos Aires tiene 3.121.707 habitantes"), undefined);
});
