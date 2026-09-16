# effect-wsdl specification

Status: proposed, pre-implementation. This document defines the first release target; it does not describe existing functionality.

## 1. Purpose and boundaries

Provide a reusable TypeScript library and CLI that compile supported WSDL contracts into Effect-native SOAP clients. Consumers should get validated inputs and outputs, precise error handling, injectable dependencies, and deterministic generated code without hand-writing XML.

The initial product is a client generator plus runtime. It is not a SOAP server, WSDL authoring tool, general XML Schema validator, or full implementation of every WS-* standard.

Success means a fresh consumer project can generate a client from a supported local contract, compile it, call a fixture service, and handle both a typed result and a declared SOAP fault.

## 2. Distribution and dependencies

Start with one npm package, provisionally `effect-wsdl`, with explicit subpath exports:

| Export | Responsibility |
| --- | --- |
| `effect-wsdl` | Loading, inspection, and generation APIs |
| `effect-wsdl/runtime` | SOAP codecs, operation execution, and runtime errors |
| `effect-wsdl/model` | Readonly resolved contract and diagnostic types |
| `effect-wsdl` executable | CLI adapter over the same public APIs |

Package-name availability must be checked before publishing; the repository name does not reserve npm ownership. Ship ESM and TypeScript declarations initially. Generated code imports only `effect`, the runtime subpath, and any explicitly documented HTTP dependency. It must not pull in filesystem or code-generation modules.

Design against Effect 3 and `@effect/platform`; exact compatible peer ranges and a minimum TypeScript version will be established by consumer compilation tests. Registry stable tags observed on 2026-09-16 were `effect@3.22.2` and `@effect/platform@0.97.2`; these are a planning baseline, not a promise of future compatibility. Effect 4 migration is a separate decision. Initial runtime and CLI validation targets Node.js 22 and 24.

## 3. Processing pipeline

```text
WSDL/XSD sources
  → bounded resource loader
  → namespace-aware XML parser
  → linked WSDL/XSD model
  → compatibility validation
  → deterministic TypeScript emitter
  → generated schemas + XML metadata + client
                                      ↓
                             SOAP runtime → HttpClient
```

Keep parsing, name resolution, schema mapping, and emission separate. Use a small internal XML adapter to isolate parser-specific nodes. Select the parser through fixtures proving namespace fidelity, ordered children, safe entity handling, and bounded parsing; do not build a new XML parser.

The resolved model identifies symbols by namespace URI and local name, never by prefix alone. Preserve source locations, document identity, sequence order, qualified/unqualified element and attribute names, occurrence bounds, binding actions, and service addresses. Resolve all references before emitting files. Resolve recursive schema types lazily; detect document cycles without infinite loading and reject unresolved references or conflicting declarations.

## 4. Supported contract profile

### WSDL and SOAP

- WSDL 1.1 definitions, types, messages, port types, bindings, services, and ports.
- SOAP 1.1 HTTP bindings with document style and literal bodies. Honor binding-level style and operation overrides.
- Request/response operations with exactly one selected element-based body part on each side. Preserve the body element shape for both wrapped and bare contracts; no implicit wrapper flattening.
- Declared literal faults with one element-based detail part.
- Multiple services and ports may be inspected. Generation requires explicit selection if more than one supported choice exists; the CLI identifies choices using expanded names.
- WSDL imports, XSD imports, and XSD includes with relative locations resolved against the containing document. Validate declared namespace relationships, including no-target-namespace includes adopting the including schema's namespace.

Reject reachable unsupported constructs before writing output: RPC, SOAP encoding, SOAP 1.2, WSDL 2.0, multipart bodies, one-way/solicit-response/notification operations, operation overloading, SOAP header bindings, MIME/MTOM attachments, WS-Policy requirements, and unknown extensions marked required. Inspection reports unsupported ports without preventing inspection of supported ports. Generation validates the selected port and its entire reachable schema graph; unrelated unused definitions may be reported as warnings.

### XSD subset

Support named and anonymous complex types containing sequences of elements, global element references, attributes with required/optional use, named simple restrictions with enumerations, recursive references, and element occurrence constraints. Sequences may contain elements only in the first release. Support `elementFormDefault`, `attributeFormDefault`, local `form`, and `nillable`.

| XSD value | Proposed TypeScript value and validation |
| --- | --- |
| `string` | `string`, XML character validity checked |
| `boolean` | `boolean`; accept XML `true`, `false`, `1`, `0` |
| `byte`, `short`, `int`, unsigned counterparts through `unsignedInt` | Integer `number` with corresponding range validation |
| `integer`, `long`, `unsignedLong` | `bigint`, with range validation where bounded |
| `decimal` | Validated decimal string; never round through a JS number |
| `float`, `double` | `number`, explicit XML `INF`, `-INF`, and `NaN` handling |
| `date`, `dateTime`, `time` | Validated lexical strings retaining timezone presence and precision |
| `base64Binary` | `Uint8Array`, strict base64 decoding |
| Supported string/numeric enumeration restriction | Narrowed value schema over the supported base type |

All unlisted built-in types and restriction facets are unsupported initially. In particular, fail on patterns, general numeric/length facets, lists, unions, choice/all compositors, type derivation, substitution groups, wildcards, mixed content, identity constraints, schema redefine, and default/fixed values. Never silently approximate an unsupported feature as `any`, `unknown`, or a string.

For single-valued elements, absence maps to an optional property only when `minOccurs=0`; `xsi:nil` maps to `null` only when nillable; empty text remains distinct from both. Repeated elements always map to readonly arrays, including `[]` for zero occurrences, with minimum/maximum counts enforced. Nil repeated items are nullable array members. Attributes live in a dedicated `$attributes` property to avoid element-name collisions. Reject unexpected elements, attributes, invalid order, or occurrence counts, apart from explicitly handled XML namespace and instance metadata. Unsupported polymorphic `xsi:type` values fail decoding.

## 5. Public library and generated surface

Proposed library operations:

| Operation | Result | Required services |
| --- | --- | --- |
| `load(source, options)` | Effect of a resolved contract or typed load/parse/resolve error | ResourceLoader |
| `inspect(contract)` | Pure service, operation, and compatibility summary | None |
| `generate(contract, options)` | Effect of generated in-memory files or typed generation error | None |

Writing files is a separate CLI responsibility. A `ResourceLoader` service supports in-memory fixtures and policy-controlled local/network adapters. No library function starts a runtime or executes an Effect for its caller.

Each generated service exports request/response schemas and types, declared fault detail schemas, operation metadata, and a client factory. `Client.make(config)` requires an injected platform `HttpClient` and returns an Effect containing a client that captures that dependency. Client methods have the conceptual signature `Input → Effect<Output, OperationError>` with no hidden runtime creation. Also expose a service tag and Layer constructor for application dependency injection.

Client configuration includes endpoint override, request timeout, response-size limit, and HTTP headers. HTTP headers do not imply SOAP header-binding support. Authentication is supplied through the HTTP client or explicit headers; do not implement credential storage. Library-owned SOAP content type and action headers cannot be silently overridden. Preserve source XML names separately from sanitized TypeScript identifiers. Resolve reserved words and naming collisions deterministically and publish the mapping in generated metadata.

Output files: `schemas.ts`, `metadata.ts`, `client.ts`, `index.ts`, and a generation manifest recording generator version, options, and content hashes of the input graph. Exclude credentials, machine-specific absolute paths, and timestamps. Identical bytes, options, and generator versions must produce identical output bytes. Generated code must compile under strict TypeScript without `any`-based escape hatches.

## 6. Runtime behavior and error contract

Validate inputs before network access. Serialize a namespace-correct SOAP envelope with escaped text/attributes, schema-defined element order, `text/xml; charset=utf-8`, and the binding's quoted `SOAPAction` value, including an explicitly empty action. Decode by namespace URI and local name, independent of response prefix choices.

Read response bodies within a byte limit before decoding. Recognize SOAP faults on successful and unsuccessful HTTP statuses before generic HTTP status handling. Non-fault unsuccessful responses become HTTP errors; malformed successful responses become XML/protocol errors. Validate the Envelope/Body shape and reject unknown mandatory SOAP headers. Decode declared fault details into generated types; preserve unmatched faults as a bounded generic fault, never fabricate a declared fault type.

| Error tag | Meaning |
| --- | --- |
| `ResourceError` | Source unavailable, denied by policy, or over limits |
| `XmlParseError` | Malformed or forbidden XML |
| `ResolutionError` | Missing, ambiguous, or conflicting contract reference |
| `UnsupportedFeatureError` | Unsupported reachable contract semantics |
| `GenerationError` | Cannot emit valid code from the resolved model |
| `InputValidationError` | Request violates the generated schema |
| `TransportError` | HTTP connection or transport failure |
| `TimeoutError` | Configured request deadline elapsed |
| `HttpStatusError` | Non-success status without a recognized SOAP fault |
| `ResponseDecodeError` | Invalid envelope, response value, or body limit exceeded |
| `SoapFault` | Declared detail union or generic SOAP fault |

Errors carry safe structured context such as operation, source location, and underlying cause where appropriate. Expected failures use the typed error channel; interruption retains Effect interruption semantics. Request interruption must cancel the underlying HTTP request. Default request deadline: 30 seconds; default response cap: 10 MiB, both configurable. Close response resources on every path.

No automatic retry. Consumers may explicitly compose Effect retry policies with knowledge of operation semantics. Optional tracing records service, operation, duration, and outcome; it must not record payloads, credentials, or sensitive URL query parameters by default.

## 7. Resource and XML safety

Reject DTDs and external entities; never expand user-defined entities, execute schema content, or evaluate emitted expressions from XML text. Escape all contract-derived source strings and comments. Validate emitted paths independently of contract names.

Local resolution is confined to configured roots after resolving symlinks. Remote loading is disabled by default and requires an explicit host allowlist. When enabled, validate every import and redirect, restrict protocols to HTTP(S), block private/loopback/link-local destinations by default, and prevent remote sources from reading local files. Explicit policy overrides may permit internal enterprise endpoints. Do not forward authorization across origins. The network adapter must enforce destination policy at connection time, or disallow redirects/remote loading when it cannot guarantee this.

Default loading limits: 5 MiB per document, 25 MiB total graph, 100 documents, import depth 20, XML nesting depth 128, and a 30-second total loading deadline. Limits are configurable and produce typed errors. Namespace URIs are identifiers, not implicit fetch targets. Imports without locations require an explicit catalog mapping or fail with a resolution diagnostic. The manifest enables drift detection; vendored local contracts are the initial reproducible-build workflow.

## 8. CLI contract

Proposed commands:

```sh
effect-wsdl inspect ./service.wsdl --json
effect-wsdl generate ./service.wsdl --service '{urn:orders}Orders' --port OrdersSoap --out ./generated
effect-wsdl generate ./service.wsdl --out ./generated --check
```

Both commands expose matching source-policy options, including repeatable `--allow-host` for remote access. `inspect --json` emits a versioned JSON object with services, ports, operations, and diagnostics. Human diagnostics go to stderr; JSON mode leaves stdout machine-readable. Commands are noninteractive and support `--help` and `--version`.

Exit codes: `0` success, `1` contract/load/generation failure, `2` invalid arguments, `3` stale or missing generated output under `--check`. Inspection can succeed with compatibility diagnostics; generation fails on unsupported selected features. `--check` never writes and compares content plus the manifest's owned-file set.

Generation builds and validates all files in memory before mutation. Refuse to overwrite unowned files. Stage output in a sibling directory and use a recoverable replacement strategy; retain the last complete generation on failure. Remove stale files only if the previous manifest owns them. Reject traversal and symlink escapes. No `--force` overwrite mode in the first release.

## 9. Release acceptance

1. A checked-in Orders fixture generates strict-compiling code and successfully calls a local SOAP service using the public runtime.
2. Declared and generic SOAP faults, HTTP errors, invalid payloads, timeouts, and interruption follow the documented error contract.
3. Namespace alias changes do not change semantics; ordering, optional/nil/empty values, repeated elements, and precision-sensitive values round-trip correctly.
4. Import cycles terminate; missing references, unsupported features, unsafe XML, blocked resources, and oversized inputs produce actionable failures.
5. Two identical generations are byte-identical; `--check` detects drift without writing; failed generation preserves prior output.
6. An installed package tarball works in an independent consumer project on supported Node versions. Runtime imports do not load generator or filesystem dependencies.
7. README examples become executable tested examples, and every advertised supported construct has a fixture. Publish a limitations table with the first release.

## 10. Reference material

These sources ground the design; this project's subset and API choices are its own constraints.

- [WSDL 1.1](https://www.w3.org/TR/wsdl.html): contract model and SOAP bindings.
- [SOAP 1.1](https://www.w3.org/TR/2000/NOTE-SOAP-20000508/): envelopes, faults, and HTTP binding.
- [XML Schema 1.0 structures](https://www.w3.org/TR/xmlschema-1/) and [datatypes](https://www.w3.org/TR/xmlschema-2/): schema semantics and lexical values.
- [Effect Schema](https://effect.website/docs/v3/schema/introduction): runtime schemas.
- [Effect platform HttpClient](https://effect.website/docs/v3/api/platform/HttpClient): injectable HTTP transport.
