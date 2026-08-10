/**
 * Guard against a source file that tooling silently skips.
 *
 * A raw NUL byte in a source file makes `file` class it as `data` and makes
 * plain grep skip it with no match, no warning and exit 0. Four occurrences
 * across two separate incidents here, always the same way: the artist/track
 * separator typed as the byte itself rather than as an escape. The code runs
 * identically, so nothing fails; what breaks is every later search over that
 * file, which is how the call-site audit in PLAN.md came up 15 sites short.
 *
 * The escape is the fix, and this is what keeps it that way. Run with
 * `npm run check:source`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = ["src", "scripts"];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

const offenders: string[] = [];
let scanned = 0;

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    scanned++;
    const buf = await readFile(file);
    const at = buf.indexOf(0);
    if (at !== -1) {
      const line = buf.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${file}:${line} contains a raw NUL byte; write it as \\u0000`);
    }
  }
}

for (const o of offenders) console.log(`FAIL  ${o}`);
console.log(`\n${scanned} source file(s) scanned, ${offenders.length} holding a raw NUL.`);
if (offenders.length) {
  console.error(
    "\nA file with a raw NUL is skipped silently by grep. Replace the byte with the " +
      "\\u0000 escape; the runtime string is identical.",
  );
  process.exit(1);
}
console.log("all checks passed.");
