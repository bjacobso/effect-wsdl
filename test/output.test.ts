import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { writeOutput } from "../src/cli/output.js";
import { generate, load, nodeLoader } from "../src/index.js";

const fixture = new URL("./fixtures/orders.wsdl", import.meta.url).pathname;
const c = await Effect.runPromise(
  load(fixture).pipe(Effect.provide(nodeLoader([new URL("./fixtures", import.meta.url).pathname]))),
);
const generated = await Effect.runPromise(generate(c));
it("writes, detects drift without writing, and safely regenerates", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wsdl-output-"));
  const out = join(temp, "generated");
  try {
    expect(await writeOutput(out, generated, true)).toBe(false);
    expect(await readdir(temp)).toEqual([]);
    await writeOutput(out, generated);
    expect(await writeOutput(out, generated, true)).toBe(true);
    await writeFile(join(out, "client.ts"), "drift");
    expect(await writeOutput(out, generated, true)).toBe(false);
    expect(await readFile(join(out, "client.ts"), "utf8")).toBe("drift");
    await writeOutput(out, generated);
    expect(await writeOutput(out, generated, true)).toBe(true);
    await writeFile(join(out, "mine.ts"), "mine");
    await expect(writeOutput(out, generated)).rejects.toThrow("unowned");
    expect(await readFile(join(out, "mine.ts"), "utf8")).toBe("mine");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it("rejects symlinks and forged ownership manifests", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wsdl-output-"));
  const out = join(temp, "generated");
  try {
    await writeOutput(out, generated);
    await symlink(out, join(temp, "link"));
    await expect(writeOutput(join(temp, "link"), generated)).rejects.toThrow("symlink");
    await writeFile(
      join(out, "effect-wsdl.manifest.json"),
      JSON.stringify({ format: 1, owned: ["../outside"] }),
    );
    await expect(writeOutput(out, generated)).rejects.toThrow("manifest");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it("restores the previous generation when output replacement fails", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wsdl-rollback-"));
  const out = join(temp, "generated");
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    await writeOutput(out, generated);
    await writeFile(join(out, "client.ts"), "previous generation");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).includes("-stage-")) throw new Error("Injected rename failure");
      return original.rename(from, to);
    });
    await expect(writeOutput(out, generated)).rejects.toThrow("Injected rename failure");
    expect(await readFile(join(out, "client.ts"), "utf8")).toBe("previous generation");
    expect(await readdir(temp)).toEqual(["generated"]);
  } finally {
    vi.mocked(rename).mockImplementation(original.rename);
    await rm(temp, { recursive: true, force: true });
  }
});
