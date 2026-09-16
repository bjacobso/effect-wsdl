import { readFile, writeFile } from "node:fs/promises";
import { catalog } from "./catalog.js";
import { render, strictFailure, summary } from "./report.js";
import { runSuite } from "./runner.js";
import { upstreamCases } from "./upstream.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "pnpm conformance [--check | --write] [--strict]\nDefault: print summary. --check: require unchanged checked-in reports. --write: update reports for review. --strict: fail for any known gap or untested case. No network access.",
  );
} else if (
  args.some((arg) => !["--check", "--write", "--strict"].includes(arg)) ||
  (args.includes("--check") && args.includes("--write"))
) {
  console.error("Invalid options. Use --help.");
  process.exitCode = 2;
} else {
  const results = await runSuite([...catalog, ...upstreamCases()]);
  console.log(JSON.stringify({ cases: results.length, outcomes: summary(results) }, null, 2));
  const files = {
    "conformance/results.json": `${JSON.stringify({ formatVersion: 1, summary: summary(results), results }, null, 2)}\n`,
    "docs/CONFORMANCE.md": render(results),
  };
  for (const [path, contents] of Object.entries(files)) {
    if (args.includes("--write")) await writeFile(path, contents);
    else if (args.includes("--check") && (await readFile(path, "utf8")) !== contents) {
      console.error(
        `Conformance results changed: ${path}. Run pnpm conformance --write and review the diff.`,
      );
      process.exitCode = 1;
    }
  }
  if (args.includes("--strict") && strictFailure(results)) {
    console.error(
      "Full catalog conformance is not met: missing, failed, or untested cases remain.",
    );
    process.exitCode = 1;
  }
}
