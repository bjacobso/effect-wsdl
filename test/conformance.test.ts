import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalog } from "../conformance/catalog.js";
import type { Phase, Result } from "../conformance/model.js";
import { render, strictFailure, summary } from "../conformance/report.js";
import { classify, runCase, runSuite } from "../conformance/runner.js";
import { upstreamCases } from "../conformance/upstream.js";
import { parseXml } from "../src/xml.js";

const cases = [...catalog, ...upstreamCases()];
const baseline = JSON.parse(readFileSync("conformance/results.json", "utf8")) as {
  formatVersion: number;
  results: Result[];
};
const expected = new Map(baseline.results.map((result) => [result.id, result]));

describe("conformance observations (baseline agreement, not conformance passes)", () => {
  it.each(cases)("$id", async (test) => {
    expect(await runCase(test)).toEqual(expected.get(test.id));
  });
});

it("retains all source examples, hashes, and well-formed adapted WSDL fixtures", () => {
  const upstream = cases.filter((test) => test.id.startsWith("w3c."));
  expect(upstream).toHaveLength(324);
  expect(new Set(cases.map((test) => test.id)).size).toBe(cases.length);
  expect([...expected.keys()].sort()).toEqual(cases.map((test) => test.id).sort());
  for (const test of cases) {
    if (test.source) {
      const text = test.resources![test.source]!;
      expect(() => parseXml(text)).not.toThrow();
    }
  }
});

it("distinguishes rejection, construction-only acceptance, and actual assertions", () => {
  const pass: Phase = { status: "pass", detail: "" };
  const notRun: Phase = { status: "not-run", detail: "" };
  const phases = { load: pass, generate: pass, runtime: pass, httpApi: pass, behavior: notRun };
  expect(classify("valid", phases)).toBe("accepted-unverified");
  expect(classify("valid", { ...phases, behavior: pass })).toBe("demonstrated");
  expect(classify("invalid", phases)).toBe("invalid-accepted");
  expect(classify("valid", { ...phases, load: { status: "unsupported", detail: "choice" } })).toBe(
    "unsupported",
  );
  expect(
    classify("invalid", { ...phases, load: { status: "unsupported", detail: "choice" } }),
  ).toBe("invalid-blocked");
  expect(
    classify("invalid", { ...phases, load: { status: "rejected", detail: "Missing name" } }),
  ).toBe("invalid-rejected");
  expect(
    classify("valid", { ...phases, behavior: { status: "failed", detail: "lost data" } }),
  ).toBe("failed");
  expect(classify("valid", phases, true)).toBe("untested");
});

it("fails the harness for missing resources and duplicate identifiers", async () => {
  const sample = catalog[0]!;
  await expect(runCase({ ...sample, resources: {} })).rejects.toThrow("Fixture resource error");
  await expect(runSuite([sample, sample])).rejects.toThrow("Duplicate conformance case");
});

it("does not execute untested cases or count them as support", async () => {
  const result = await runCase({
    id: "unadapted",
    area: "test",
    title: "Unavailable schema",
    reference: "https://example.com",
    validity: "valid",
    untested: "Requires external schema",
    verify: () => {
      throw new Error("Must not execute");
    },
  });
  expect(result.outcome).toBe("untested");
  expect(Object.values(result.phases).every((phase) => phase.status === "not-run")).toBe(true);
  expect(strictFailure([result])).toBe(true);
  expect(summary([result]).demonstrated).toBe(0);
});

it("renders every observation deterministically and keeps strict mode red for known gaps", () => {
  expect(baseline.formatVersion).toBe(1);
  expect(render(baseline.results)).toBe(readFileSync("docs/CONFORMANCE.md", "utf8"));
  expect(strictFailure(baseline.results)).toBe(true);
  const successful = baseline.results.filter(
    (r) => r.outcome === "demonstrated" || r.outcome === "invalid-rejected",
  );
  expect(successful.length).toBeGreaterThan(0);
  expect(strictFailure(successful)).toBe(false);
});
