# Implementation plan

Status: working alpha implemented; npm publication remains pending. Completed items below have implementation and test evidence. `pnpm check` runs the validation suite, including an independently installed tarball consumer; `pnpm example` runs the generated Orders client against a local SOAP server. See docs/DECISIONS.md for alpha restrictions.

## M0 — Establish the package and decisions

- [x] Initialize a TypeScript ESM package with pnpm, a lockfile, strict typechecking, formatting, linting, and Vitest.
- [x] Establish `src/`, `src/runtime/`, `src/model/`, `src/cli/`, `test/fixtures/`, and `examples/` boundaries matching SPEC.md exports.
- [x] Pin development dependencies; prove an Effect 3/platform pair and minimum TypeScript version in a consumer compilation test.
- [x] Evaluate XML parsing requirements against namespace, child-order, entity rejection, source-location, and depth-limit fixtures. Record the selection and its limitations.
- [x] Add CI for Node.js 22 and 24 with typecheck, lint, tests, build, and package-tarball checks.

Exit: an installable local tarball exports an empty public skeleton correctly, CI passes, and dependency/parser decisions are recorded. Do not publish yet.

## M1 — Prove one complete operation

Depends on M0. Keep the first supported fixture deliberately small.

- [x] Write a self-contained Orders WSDL using SOAP 1.1 document/literal with one request, one response, and one declared fault, plus a local fixture server.
- [x] Implement bounded local loading and safe namespace-aware XML parsing.
- [x] Resolve the fixture's WSDL symbols into a readonly model with source diagnostics.
- [x] Emit request/response schemas, XML metadata, a generated client, and a service Layer.
- [x] Implement input validation, envelope serialization, injected HTTP execution, response validation, and declared/generic fault decoding.
- [x] Compile and execute the generated client in a separate consumer fixture.

Exit: the generated Orders client returns a typed success and a typed fault through Effect. Unsupported contracts fail explicitly. This proves the architecture; it is not the full release profile.

## M2 — Complete linking and compatibility diagnostics

Depends on M1.

- [x] Resolve WSDL imports and XSD import/include graphs with catalogs, caching per load, namespace checks, and no-target-namespace includes.
- [x] Handle document cycles, recursive type references, missing/ambiguous symbols, and conflicting definitions.
- [x] Implement service/port inspection and explicit selection; preserve expanded names and binding/action metadata.
- [x] Validate the selected reachable graph and diagnose unsupported constructs.
- [x] Enforce local path roots, symlink policy, loading limits, and total deadlines.

Exit: imported and cyclic fixtures terminate deterministically; malformed and unsupported contracts report source locations without emitting partial output.

## M3 — Implement the advertised XSD subset

Depends on M2.

- [x] Support sequences, global references, anonymous/named types, attributes, enumerations, and recursive validation schemas.
- [x] Implement every datatype in the specification with lexical and range validation.
- [x] Preserve element/attribute qualification, ordering, optionality, nil, empty values, and repeated-element cardinality within the documented alpha restrictions.
- [x] Generate stable identifiers and collision mappings without changing XML names.
- [x] Reject unexpected XML members and unsupported polymorphic instance types.
- [x] Add table-driven and property-based codec tests, with independent hand-authored wire expectations so encoder/decoder bugs cannot merely cancel each other out.

Exit: every supported schema row has positive, negative, and boundary fixtures; large integers and decimal strings retain precision; unsupported semantics never silently widen types.

## M4 — Harden the runtime and remote loading

Depends on M3.

- [x] Complete fault-before-status classification, mandatory-header handling, response limits, deadlines, interruption, and resource cleanup.
- [x] Implement configurable endpoint and HTTP authentication/header injection while protecting SOAP protocol headers.
- [x] Add remote source resolution with opt-in host policy, redirect rejection, pinned destination enforcement, and no URL credentials.
- [x] Verify entity rejection, depth/size limits, blocked destinations, generated-code escaping, and absence of default secret/payload logging.
- [ ] Add safe tracing metadata and document explicit retry composition for operations known to be safe to retry.

Exit: a controlled HTTP server verifies cancellation and resource cleanup; malicious fixtures fail within configured limits; no request is automatically retried. Remote loading remains unavailable until destination policy is enforceable.

## M5 — Deliver the library and CLI

Depends on M4. Library APIs remain usable without the CLI.

- [x] Finalize `load`, `inspect`, and in-memory `generate` alpha APIs and typed errors.
- [x] Implement noninteractive CLI commands, selection/policy flags, versioned JSON inspection, and documented exit codes.
- [x] Emit stable manifests and deterministic files; implement read-only `--check` drift detection.
- [x] Implement owned-file checks, staging, recoverable output replacement, and safe stale-file removal.
- [x] Test replacement failure and rollback, conflicting user files, symlinks, and invalid manifests. Document manual recovery after a hard process kill.
- [x] Test runtime subpath isolation and generated imports against the packed package.

Exit: a fresh checkout can inspect, generate, compile, call, and check drift using only documented commands; failed generation leaves the previous complete output usable.

## M6 — Prepare a public alpha

Depends on M5 and all SPEC.md release acceptance criteria.

- [x] Convert proposed README usage into executable examples and document installation, configuration, fault handling, and alpha export stability.
- [x] Add an exact compatibility/limitations table and fixture contribution guide.
- [x] Add a changelog and contract-support issue template.
- [ ] Configure release automation with trusted publishing after establishing npm ownership.
- [ ] Verify npm ownership/name availability, package contents, license notices, declarations, and dependency peer ranges.
- [x] Run tarball consumer tests on Node.js 22 and 24; both pass, including generation, strict compilation, success/fault calls, and service Layers.
- [ ] Obtain maintainer release authorization, then publish an explicitly marked prerelease and create its release notes.

Exit: another developer can follow the README against the published alpha without relying on unpublished source paths or undocumented setup. Creating this public design repository does not itself authorize an npm release.

## Runtime client and HTTP bridge extension

- [x] Reuse port selection and SOAP invocation for `makeClient` without source generation.
- [x] Reflect structural JSON schemas, recursive types, precision-safe values, and fault details.
- [x] Provide an Effect HttpApi and implementation Layer with operation selection and OpenAPI metadata.
- [x] Bound and validate incoming requests, map errors, and propagate cancellation upstream.
- [x] Test native runtime calls, JSON-to-SOAP round trips, real Node HTTP serving, and installed-package exports.
- [x] Document the JSON mapping and provide a Node server example with Swagger UI.

## Deferred work

Revisit only with a concrete consumer contract and fixtures: SOAP 1.2, wider XSD coverage, typed SOAP headers, WS-Security, RPC bindings, attachments, browser/Bun/Deno support, Effect 4 support, and SOAP server/WSDL generation. Do not add plugin frameworks or multiple packages until actual implementation boundaries justify them.

## Main risks and decision gates

| Risk | Evidence required before proceeding |
| --- | --- |
| A real contract exceeds the initial XSD subset | Inspect early; add explicit diagnostics or amend the supported profile before promising support |
| XML parser loses namespaces/order or cannot enforce limits | Reject that parser in M0; no string-replacement SOAP codec fallback |
| Effect dependency APIs drift | Compile against pinned development versions and test claimed peer ranges before release |
| Generated schema and wire codec disagree | Independent XML expectations plus end-to-end fixture service tests |
| Untrusted contracts cause network/file access or code injection | Negative resolver/emitter fixtures and controlled network tests before enabling remote loading |
| Generated output damages consumer files | Ownership manifest and injected write-failure tests before CLI release |
