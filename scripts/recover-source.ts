import nextEnv from "@next/env";
import { parseArgs } from "node:util";
import { requireLocalDatabase } from "../src/lib/local-database.ts";
import { sourceOperationRepository } from "../src/store.ts";

const { values } = parseArgs({ options: { case: { type: "string" }, operation: { type: "string" }, reason: { type: "string" } } });
if (!values.case || !values.operation || !values.reason?.trim()) throw new Error("Usage: recover-source --case ID --operation KEY --reason REASON");
nextEnv.loadEnvConfig(process.cwd(), true);
// This development command cannot accidentally open a production connection.
requireLocalDatabase();
await sourceOperationRepository.recover(values.case, values.operation, values.reason);
console.log("Explicit source recovery recorded. The next shared read may claim only the recovered stage.");
