# Conformance and compatibility testing

Run `pnpm conformance` from the repository root to execute the offline catalog and print current counts. Read [the generated report](../docs/CONFORMANCE.md) for the feature matrix and [results.json](./results.json) for exact diagnostics, evidence, and individual phase results.

This is a broad, extensible compatibility suite, **not a full WSDL conformance suite or certification**. WSDL 1.1, WSDL 2.0, SOAP, XSD, and WS-I profiles have different requirements. A finite collection of feature examples does not cover all their normative constraints. Unimplemented and untested areas stay visible in the report.

## Commands

```sh
pnpm conformance                 # execute all cases; print observations
pnpm conformance --check         # fail if observations differ from committed reports
pnpm conformance --write         # regenerate Markdown and JSON for review
pnpm conformance --strict        # fail if any missing, failed, or untested case remains
pnpm test                       # regression suite, including conformance harness tests
```

The default command is reporting mode: exit zero means execution completed, not conformance. CI uses `--check` on Node 22 and 24. Both improvements and regressions require reviewing the changed report. Known failures are observations in JSON, not skipped tests or a green conformance claim. `--strict` currently exits 1 intentionally. Invalid CLI arguments exit 2; missing/corrupt corpus resources and harness errors fail execution.

## Online suites found

| Source | What it tests | Integration here |
| --- | --- | --- |
| [W3C XML Schema Patterns for Databinding examples](https://www.w3.org/2002/ws/databinding/examples/6/09/) | Schema/data binding patterns, with WSDL and XML/SOAP examples | Complete source catalog of 324 examples and 603 instances adapted into local WSDL 1.1 probes; external-schema examples explicitly untested |
| [WS-I Basic Profile 1.1 Test Assertion Document](https://ws-i.org/Testing/Tools/2005/01/BP11_TAD_1-1.htm) and [testing tools](https://www.ws-i.org/deliverables/testingtools.html) | Interoperability rules for descriptions, SOAP messages and their producers/consumers | Referenced, not executed; requires description and captured wire-message adapters |
| [W3C WSDL 2.0 Test Suite](https://dev.w3.org/2002/ws/desc/test-suite/index.html) | Good/bad descriptions, validation and component-model interchange | Referenced, not executed; distinct language from WSDL 1.1 |
| [W3C XML Schema Test Suite](https://www.w3.org/XML/2004/xml-schema-test-suite/) and [XSD repository](https://github.com/w3c/xsdtests) | Schema and instance validity, including version-specific expectations | Referenced, not executed; our databinding examples are a different suite |

WS-I profile conformance also differs from supporting every valid WSDL feature: a profile restricts usage to improve interoperability. Do not use its prohibitions as evidence that a WSDL language feature is invalid. WS-Security, WS-Addressing, Policy, MTOM, and XSD 1.1 require their own scope and adapters.

## What runs

`catalog.ts` contains original feature and invalid-document probes linked to specifications. It inventories every XSD 1.0 built-in type and all restriction facets, alongside WSDL message styles, SOAP/HTTP/MIME bindings, imports, faults and extensions. Explicit untested rows cover remaining normative and wire-level gaps. Each original fixture labeled valid is intended to exercise legal syntax, including unsupported features; it is not independently certified by an external WSDL validator.

`upstream.ts` verifies SHA-256 hashes before reading the adapted W3C corpus. Cases run through:

1. `load` and selected-port diagnostics.
2. Source `generate` (emission only; this harness does not independently typecheck every emitted client).
3. Native `makeClient` construction with a transport that forbids network requests.
4. `makeHttpApi` construction and OpenAPI reflection.
5. The case's behavioral assertions, if present.

Original primitive tests compare against independently specified native values. Upstream instances are decoded, re-encoded, and decoded again; element/attribute topology must survive, and output decoding must agree. This catches rejection and structural loss but **is not an independent value or wire-equivalence oracle**. It does not prove correctness of defaults, whitespace normalization, all lexical forms, or every restriction. The source schemas' declared instances are treated as positive examples. Negative validity probes are maintained separately.

The runtime and HttpApi columns mean construction, not a SOAP call or HTTP serving test. Existing `test/runtime.test.ts` and `test/http-api.test.ts` exercise real requests separately; their passing counts are not folded into this matrix. Passing one sample does not mean complete support for that feature.

Each row reports the first blocking phase. An unsupported construct may conceal later errors; implementing it should reveal the next blocker on the next run. `invalid-blocked` deliberately does not count an unsupported feature as successful validity checking. `invalid-accepted` specifically means load/resolution accepted an invalid description, regardless of later construction outcomes.

## Upstream provenance and adaptation

The original [examples.xml](https://www.w3.org/2002/ws/databinding/examples/6/09/examples.xml) snapshot is preserved byte-for-byte in `vendor/w3c-databinding/examples.xml`. Its embedded revision is 1.89, dated 2009-03-19. Retrieval: 2026-09-16. The SHA-256 digest and every derived file are pinned in `manifest.json`. See [the vendor notice](./vendor/w3c-databinding/README.md) for attribution and licenses.

The published per-example download was rate-limited during initial research. `import-w3c.py` therefore adapts the complete source catalog locally, using Python's standard library:

- Isolate each example's schema, preserving namespace declarations, QName-valued attributes, mixed content, and instance text.
- Wrap schema fragments in a schema with the example namespace as default and target namespace, and qualified local elements.
- Use the example's global element directly as input and output of a document/literal echo operation. This is our wrapper, not W3C's published `echoExample` wrapper.
- For NoTargetNamespace, resolve its unqualified global declaration instead of the source catalog's prefixed display label.
- Keep all 603 instance documents. Mark the 12 examples needing external schemas/catalog resolution untested; no network or invented substitute schemas.

```sh
python3 conformance/import-w3c.py           # regenerate deterministically, offline
python3 conformance/import-w3c.py --refresh # explicitly fetch a new source snapshot
pnpm conformance --write
git diff                                  # review source, checksum, case and result changes
```

The derived probes contain attribution and modification notices. They are not an unmodified official W3C test suite, and their results must not be advertised as passing that suite.

## Extending toward fuller conformance

Add cases with stable IDs, authoritative references, explicit valid/invalid expectations, and behavioral oracles. Ensure a valid-but-unsupported case is well-formed and references a reachable feature. A malformed fixture is not evidence of unsupported schema semantics. Add both positive and negative forms and boundary values; avoid inferring support from parser acceptance alone.

The next major work is independent schema/instance validation, WSDL rule-by-rule coverage, complete SOAP wire assertions, WS-I assertion mapping, and adapters for the official WSDL 2.0 and XML Schema suites. Track those as untested until they actually run. Never remove an untested row or known failure just to make the summary greener.
