import { Cursor } from "@cursor/sdk";

const models = await Cursor.models.list();
for (const m of models) {
  if (!/grok|gemini|claude|opus|sonnet/i.test(m.id + m.displayName)) continue;
  console.log(m.id + " | " + m.displayName + " | params: " + JSON.stringify(m.parameters?.map((p) => [p.id, p.values.map((v) => v.value)])));
}
