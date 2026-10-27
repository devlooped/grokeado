import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/grokeado.db");
for (const id of process.argv.slice(2)) {
  const { changes } = db.prepare("DELETE FROM cases WHERE id = ? AND status = 'queued'").run(id);
  console.log(id + ": " + (changes ? "removed" : "not queued, left alone"));
}
