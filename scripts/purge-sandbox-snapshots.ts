import { Snapshot } from "@vercel/sandbox";

// One-off cleanup of the automatic snapshots left by sandboxes before they had
// retention. Dry run by default; pass --yes to delete. Never deletes the
// configured harness snapshot(s), their ancestors, or anything created or used
// recently (an in-flight case may still resume from it).
//   node --import tsx scripts/purge-sandbox-snapshots.ts [--yes] [--keep snap_x] [--recent-hours 6]
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--yes");
const recentMs = Number(option("--recent-hours") ?? 6) * 60 * 60_000;
const keep = new Set([process.env.EVIDENCE_SANDBOX_SNAPSHOT_ID, process.env.INSTRUCTION_SANDBOX_SNAPSHOT_ID, ...args.flatMap((arg, i) => args[i - 1] === "--keep" ? [arg] : [])].filter((id): id is string => Boolean(id)));
if (!keep.size) throw new Error("No harness snapshot configured: set INSTRUCTION_SANDBOX_SNAPSHOT_ID/EVIDENCE_SANDBOX_SNAPSHOT_ID or pass --keep");

const all = await (await Snapshot.list({ limit: 50 })).toArray();
const byId = new Map(all.map((snapshot) => [snapshot.id, snapshot]));
for (const id of keep) if (!byId.has(id)) throw new Error(`Protected snapshot ${id} is not in this project's list; refusing to continue`);
// Protect the ancestry of kept snapshots too.
for (const id of [...keep]) for (let parent = byId.get(id)?.parentId; parent && !keep.has(parent); parent = byId.get(parent)?.parentId) keep.add(parent);

const now = Date.now();
const candidates = all.filter((snapshot) => snapshot.status === "created" && !keep.has(snapshot.id)
  && now - Math.max(snapshot.createdAt, snapshot.updatedAt, snapshot.lastUsedAt ?? 0) > recentMs);
const bytes = candidates.reduce((sum, snapshot) => sum + (snapshot.sizeBytes ?? 0), 0);
console.log(`Snapshots: ${all.length} listed, ${keep.size} protected (${[...keep].join(", ")}), ${all.length - keep.size - candidates.length} recent or not live, ${candidates.length} to delete (${(bytes / 1e9).toFixed(2)} GB).`);
if (!apply) console.log("Dry run. Pass --yes to delete.");

let deleted = 0, failed = 0;
for (let i = 0; apply && i < candidates.length; i += 10) {
  const batch = await Promise.allSettled(candidates.slice(i, i + 10).map(async ({ id }) => {
    if (keep.has(id)) throw new Error(`refusing protected ${id}`);
    await (await Snapshot.get({ snapshotId: id })).delete({ signal: AbortSignal.timeout(30_000) });
  }));
  for (const [j, result] of batch.entries()) {
    if (result.status === "fulfilled") deleted++;
    else { failed++; console.warn(`Could not delete ${candidates[i + j]!.id}:`, result.reason instanceof Error ? result.reason.message : result.reason); }
  }
}
if (apply) console.log(`Deleted ${deleted}, failed ${failed}.`);
if (failed) process.exitCode = 1;
