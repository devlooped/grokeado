import { Agent } from "@cursor/sdk";
import { mkdirSync } from "node:fs";

const models = {
  grok: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] },
  gemini: { id: "gemini-4-argon", params: [{ id: "reasoning_effort", value: "high" }] },
  claude: { id: "claude-opus-5-5", params: [{ id: "effort", value: "high" }] },
};

const claim = "La Ciudad de Buenos Aires tiene más habitantes que la provincia de Córdoba.";
const only = process.argv[2];

async function trial(name, model) {
  const calls = [];
  const cwd = "data/spike/" + name;
  mkdirSync(cwd, { recursive: true });
  const started = Date.now();
  await using agent = await Agent.create({
    model,
    name: "spike-" + name,
    tools: ["webSearch", "webFetch", "mcp"],
    local: {
      cwd,
      settingSources: [],
      customTools: {
        file_evidence: {
          description: "File one piece of evidence with the court.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" }, excerpt: { type: "string" } },
            required: ["title", "url", "excerpt"],
          },
          execute: (args) => {
            calls.push(["file_evidence", args]);
            return "Evidence filed as E" + calls.length + ".";
          },
        },
        cast_vote: {
          description: "Cast your final vote on the claim.",
          inputSchema: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["verdadero", "falso", "no_verificable"] },
              rationale: { type: "string" },
            },
            required: ["verdict", "rationale"],
          },
          execute: (args) => {
            calls.push(["cast_vote", args]);
            return "Vote recorded.";
          },
        },
      },
    },
  });
  const run = await agent.send(
    "Sos abogado ante un tribunal de chequeo de datos. Investigá en la web esta afirmación: \"" + claim + "\". " +
      "Presentá al menos una prueba con la herramienta file_evidence (servidor custom-user-tools) y después votá con cast_vote. " +
      "Respondé en español rioplatense con un resumen de una oración."
  );
  const toolNames = [];
  for await (const event of run.stream()) {
    if (event.type === "tool_call" && event.status === "running") toolNames.push(event.name);
  }
  const result = await run.wait();
  return { name, status: result.status, seconds: Math.round((Date.now() - started) / 1000), toolNames, calls, text: result.result?.slice(0, 300) };
}

const entries = Object.entries(models).filter(([n]) => !only || n === only);
const results = await Promise.allSettled(entries.map(([n, m]) => trial(n, m)));
for (const r of results) console.log(JSON.stringify(r.status === "fulfilled" ? r.value : { error: String(r.reason) }, null, 1));
