import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/grokeado.db");
for (const id of process.argv.slice(2)) {
  db.exec("BEGIN");
  db.prepare("DELETE FROM events WHERE case_id = (SELECT id FROM cases WHERE id = ? AND status IN ('queued', 'in_session'))").run(id);
  const { changes } = db.prepare("DELETE FROM cases WHERE id = ? AND status IN ('queued', 'in_session')").run(id);
  db.exec("COMMIT");
  console.log(id + ": " + (changes ? "removed" : "not queued or in session, left alone"));
}
