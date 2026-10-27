import { createCase, newCaseId } from "../src/store.ts";

const text = process.argv.slice(2).join(" ");
if (!text) throw new Error("usage: tsx scripts/enqueue.ts <texto a chequear>");
const id = newCaseId();
createCase(id, { kind: "text", text });
console.log(id);
