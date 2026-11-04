import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("the Minimatch override preserves glob matching for dependent tooling", () => {
  // Jake's FileList expects the Minimatch 5 match() API; the override uses 11.
  const jakeRequire = createRequire(require.resolve("jake"));
  const { FileList } = jakeRequire("filelist") as {
    FileList: new (pattern: string) => { toArray(): string[] };
  };
  const files = new FileList("*.json").toArray();
  assert.ok(files.includes("package.json"));
  assert.ok(!files.includes("README.md"));

  // These consumers use the named minimatch export from versions 9 and 10.
  for (const consumer of ["@oclif/core", "@swc/cli/package.json", "@vercel/queue"]) {
    const consumerRequire = createRequire(require.resolve(consumer));
    const { minimatch } = consumerRequire("minimatch") as {
      minimatch: (path: string, pattern: string) => boolean;
    };
    assert.equal(minimatch("src/example.ts", "**/*.ts"), true, consumer);
    assert.equal(minimatch("src/example.js", "**/*.ts"), false, consumer);
  }
});
