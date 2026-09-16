import { HttpClient } from "@effect/platform";
import { Effect, Either } from "effect";
import { makeHttpApi } from "../src/http-api/index.js";
import { generate, load, makeClient, memoryLoader } from "../src/index.js";
import type { Case, Outcome, Phase, Result } from "./model.js";

const skipped: Phase = { status: "not-run", detail: "Prerequisite not satisfied" };
const passed: Phase = { status: "pass", detail: "" };
const transport = HttpClient.make(() => Effect.die("Conformance harness forbids network requests"));

function rejection(error: { _tag: string; message: string }): Phase {
  return {
    status: error._tag === "UnsupportedFeatureError" ? "unsupported" : "rejected",
    detail: `${error._tag}: ${error.message}`,
  };
}
async function phase<A, E extends { _tag: string; message: string }>(
  effect: Effect.Effect<A, E>,
): Promise<Phase> {
  const result = await Effect.runPromise(effect.pipe(Effect.either));
  return Either.isLeft(result) ? rejection(result.left) : passed;
}

export function classify(
  validity: Case["validity"],
  phases: Result["phases"],
  untested = false,
): Outcome {
  if (untested) return "untested";
  if (validity === "invalid") {
    if (phases.load.status === "unsupported") return "invalid-blocked";
    if (phases.load.status === "rejected") return "invalid-rejected";
    return "invalid-accepted";
  }
  if (phases.load.status === "unsupported") return "unsupported";
  if (phases.load.status === "rejected") return "rejected-valid";
  if (Object.values(phases).some((p) => p.status === "failed")) return "failed";
  if (Object.values(phases).some((p) => p.status === "rejected" || p.status === "unsupported"))
    return "failed";
  return phases.behavior.status === "pass" ? "demonstrated" : "accepted-unverified";
}

export async function runCase(test: Case): Promise<Result> {
  const phases = {
    load: skipped,
    generate: skipped,
    runtime: skipped,
    httpApi: skipped,
    behavior: skipped,
  };
  if (!test.untested) {
    if (!test.source || !test.resources) throw new Error(`Missing fixture: ${test.id}`);
    const result = await Effect.runPromise(
      load(test.source).pipe(Effect.provide(memoryLoader(test.resources)), Effect.either),
    );
    if (Either.isLeft(result)) {
      // Broken corpus/setup and defects are harness failures, never "unsupported".
      // The loader uses ResourceError for unsupported root vocabularies too.
      // Preserve that specific observation without hiding actual I/O failures.
      if (
        result.left._tag === "ResourceError" &&
        result.left.message !== "Expected WSDL 1.1 definitions or XSD schema"
      )
        throw new Error(`Fixture resource error in ${test.id}: ${result.left.message}`);
      phases.load = rejection(result.left);
    } else {
      const contract = result.right;
      const ports = test.port ? contract.ports.filter((p) => p.name === test.port) : contract.ports;
      if (ports.length !== 1) throw new Error(`Fixture must select one port: ${test.id}`);
      const diagnostic = ports[0]!.diagnostics[0];
      phases.load = diagnostic
        ? rejection({ _tag: diagnostic.code, message: diagnostic.message })
        : passed;
      if (!diagnostic) {
        const selection = test.port ? { port: test.port } : {};
        phases.generate = await phase(generate(contract, selection));
        phases.runtime = await phase(
          makeClient(contract, selection).pipe(
            Effect.provideService(HttpClient.HttpClient, transport),
          ),
        );
        phases.httpApi = await phase(makeHttpApi(contract, selection));
        if (test.verify) {
          try {
            test.verify(contract);
            phases.behavior = passed;
          } catch (error) {
            phases.behavior = {
              status: "failed",
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        } else
          phases.behavior = { status: "not-run", detail: "No behavioral oracle for this case" };
      }
    }
  }
  return {
    id: test.id,
    area: test.area,
    title: test.title,
    reference: test.reference,
    validity: test.validity,
    outcome: classify(test.validity, phases, !!test.untested),
    evidence:
      test.untested ?? test.evidence ?? "Contract acceptance/rejection only; no behavioral oracle",
    phases,
  };
}

export async function runSuite(cases: readonly Case[]): Promise<readonly Result[]> {
  const ids = new Set<string>();
  for (const test of cases) {
    if (ids.has(test.id)) throw new Error(`Duplicate conformance case: ${test.id}`);
    ids.add(test.id);
  }
  const results: Result[] = [];
  for (const test of cases) results.push(await runCase(test));
  return results;
}
