import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("production start uses the low-memory Bash supervisor", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.equal(packageJson.scripts?.start, "bash scripts/service-supervisor.sh");
});

test("Bash supervisor enforces the production memory budget and recovery behavior", async () => {
  const script = await readFile(
    path.join(projectRoot, "scripts", "service-supervisor.sh"),
    "utf8"
  );

  assert.match(script, /APP_MAX_OLD_SPACE_MB:-384/);
  assert.match(script, /MALLOC_ARENA_MAX:-2/);
  assert.match(script, /--max-old-space-size=/);
  assert.match(script, /server\/src\/server\.ts/);
  assert.match(script, /\/api\/health/);
  assert.match(script, /APP_HEALTH_FAILURE_LIMIT:-3/);
  assert.match(script, /trap .*TERM/);
  assert.match(script, /trap .*INT/);
  assert.match(script, /trap .*HUP/);
  assert.match(script, /while \[\[ \$stopping -eq 0 \]\]/);
  assert.doesNotMatch(script, /npm run start/);
  assert.doesNotMatch(script, /service-supervisor\.mjs/);
});
