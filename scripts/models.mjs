// The public catalog needs no credential; AI SDK's discovery method does.
const response = await fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error("Gateway model catalog failed: " + response.status);
const { data } = await response.json();
for (const model of data) {
  if (/^(spacexai|google|anthropic|openai)\//.test(model.id)) console.log(model.id + " | " + model.name);
}
