# effect-wsdl

Generate typed TypeScript SOAP clients from WSDL, build clients at runtime, or expose a WSDL as a JSON HTTP API using [Effect](https://effect.website/).

**Working alpha (`0.1.0-alpha.0`), not yet published to npm.** The generator, runtime client, and reflected `HttpApi` bridge are implemented for a limited subset. See the [compatibility report](./docs/CONFORMANCE.md) for unsupported features and known validation gaps.

## Try it

Requires Node.js 22+ and pnpm 10.20.0.

```sh
git clone https://github.com/bjacobso/effect-wsdl.git
cd effect-wsdl
pnpm install --frozen-lockfile
pnpm build
node dist/cli/index.js inspect test/fixtures/orders.wsdl --json
node dist/cli/index.js generate test/fixtures/orders.wsdl --out examples/generated
node dist/cli/index.js generate test/fixtures/orders.wsdl --out examples/generated --check
pnpm example
```

The example starts its own local SOAP server, calls it with a generated client, handles a declared fault, and shuts down. No external service or credentials are needed.

To use this alpha in another project, run `pnpm pack` here, then install the resulting tarball there alongside `effect@3.22.2` and `@effect/platform@0.97.2`. Use the installed `effect-wsdl` executable to generate clients. The package exports ESM and declarations; generated code requires TypeScript 5.9.3 or later.

## Generated client

```ts
import { Effect } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { OrdersClient } from "./generated/index.js"

const program = Effect.gen(function* () {
  const orders = yield* OrdersClient.make({
    endpoint: "https://example.com/soap/orders",
    timeoutMs: 10_000
  })
  return yield* orders.getOrder({ orderId: "order-123" })
})

const runnable = program.pipe(Effect.provide(FetchHttpClient.layer))
// Execute at your application boundary with Effect.runPromise(runnable).
```

For dependency injection, use `OrdersClient.Tag` and `OrdersClient.layer(config)`. See [the executable example](./examples/demo.ts).

Generated files include request/response schemas, fault-detail schemas, XML metadata, the client, and an ownership manifest. Operation schemas are named `Operation1Input`, `Operation1Output`, and `Operation1Fault` in contract order; the exported `names` mapping records original operation names and generated method names. Schemas share validation rules with XML encoding, including recursive types; they are Effect `Schema.declare` validators rather than structurally introspectable schema trees.

Errors distinguish input validation, transport, timeouts, HTTP status, response decoding, and SOAP faults. Handle a declared fault through `error._tag === "SoapFault"`, then narrow `error.detail._tag` to its WSDL fault name. Unmatched details use `UnknownFault`. Default timeout is 30 seconds and response limit is 10 MiB. Requests support Effect interruption and do not retry automatically.

Pass authentication through `config.headers` or your injected `HttpClient`. SOAP protocol headers are reserved. The runtime disables platform HTTP tracing for these requests to avoid automatically capturing sensitive URLs and headers.

## Runtime client — no generated files

```ts
import { Effect } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { load, makeClient, nodeLoader } from "effect-wsdl"

const program = Effect.gen(function* () {
  const contract = yield* load("./contracts/orders.wsdl")
  const client = yield* makeClient(contract)
  return yield* client.call("GetOrder", { orderId: "order-123" })
}).pipe(
  Effect.provide(nodeLoader(["./contracts"])),
  Effect.provide(FetchHttpClient.layer)
)
```

`makeClient` interprets the loaded contract without emitting or evaluating source code. Calls use original WSDL names; `client.operations` exposes definitions and native schemas. Results have static type `unknown` because the contract is discovered at runtime. Native values retain `bigint` and `Uint8Array`; source-generated clients remain available for compile-time operation types.

## WSDL → JSON HTTP API

Start a local adapter and Swagger UI for a WSDL whose upstream SOAP service is running:

```sh
pnpm rest ./contracts/orders.wsdl 3000
# POST http://127.0.0.1:3000/soap/GetOrder
# Swagger UI: http://127.0.0.1:3000/docs

curl http://127.0.0.1:3000/soap/GetOrder \
  -H 'content-type: application/json' \
  -d '{"orderId":"order-123"}'
```

The reusable bridge lives in `effect-wsdl/http-api`:

```ts
import { FetchHttpClient, HttpApiBuilder, HttpServer } from "@effect/platform"
import { Effect, Layer } from "effect"
import { makeHttpApi } from "effect-wsdl/http-api"

// contract is the result of load(...).
const bridge = await Effect.runPromise(makeHttpApi(contract, {
  prefix: "/api/orders",
  operations: ["GetOrder"],
  client: { endpoint: "https://example.com/soap/orders" }
}))

const { handler, dispose } = HttpApiBuilder.toWebHandler(Layer.mergeAll(
  bridge.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  HttpServer.layerContext
))
// Mount handler(Request) in your host; call dispose() on shutdown.
// bridge.api is an Effect HttpApi; bridge.openApi is its OpenAPI document.
```

Each selected operation becomes a JSON `POST` route. WSDL provides no reliable resource/method semantics for inferring GET, PATCH, or DELETE. Bodies preserve the existing schema shape. Reflected OpenAPI schemas describe recursive objects, enums, arrays, and attributes. Large integers use JSON strings, binary values use base64, and non-finite numbers use `"INF"`, `"-INF"`, or `"NaN"`. Decimal strings retain precision.

See [REST mapping and integration](./docs/REST.md) for errors, limits, hosting, and lifecycle. The [Node server example](./examples/serve-rest.ts) uses `@effect/platform-node` as a host dependency; the bridge itself uses the existing Effect/platform peers.

## Library API

```ts
import { Effect } from "effect"
import { generate, inspect, load, nodeLoader } from "effect-wsdl"

const program = Effect.gen(function* () {
  const contract = yield* load("./contracts/orders.wsdl")
  const summary = inspect(contract)
  const generated = yield* generate(contract, {
    service: "{urn:orders}Orders",
    port: "OrdersSoap"
  })
  return { summary, files: generated.files }
}).pipe(Effect.provide(nodeLoader(["./contracts"])))
```

Generation returns files in memory; it does not write or start a runtime. `ResourceLoader` is an injectable Effect service. `memoryLoader` accepts a map keyed by absolute source URLs for tests. The runtime subpath (`effect-wsdl/runtime`) has no filesystem, source-loader, or generator imports.

## Sources and output

Local imports are limited to the source directory by default; use repeatable `--root` options for additional roots. WSDL imports and XSD imports/includes resolve relative to their containing document. Library `load` options expose byte, count, depth, and deadline limits, plus a namespace-to-location `catalog` for imports without locations.

Remote access is opt-in:

```sh
effect-wsdl inspect https://services.example.com/orders.wsdl \
  --allow-host services.example.com --json
```

Every imported host must also be allowed. Hosts include nondefault ports. DNS addresses are validated and pinned for the connection; private networks are blocked unless `--allow-private-addresses` is explicitly supplied. Redirects, URL credentials, compressed sources, remote-to-local imports, DTDs, and custom entities are rejected. Library settings are the second argument to `nodeLoader(roots, { allowHosts, allowPrivateAddresses })`.

Use a dedicated generated-output directory. The CLI refuses unowned files and output symlinks, stages replacements, and restores the old generation if replacement fails. `--check` never writes. A hard process kill can leave a sibling `.effect-wsdl-lock/previous` directory containing the old generation; stop other generators before manually recovering it. Inspect that backup before removing a stale lock.

CLI exit codes: `0` success, `1` contract/I/O failure, `2` invalid usage, `3` stale or missing generated output. `inspect --json` emits versioned machine-readable results, including compatibility diagnostics.

## Compatibility

| Supported | Boundary |
| --- | --- |
| WSDL 1.1, SOAP 1.1 over HTTP | Document/literal request/response, one element-based body part |
| Wrapped and bare elements | Preserve schema value shape; no automatic wrapper flattening |
| Declared and generic faults | Literal details, fault detection on 2xx and error statuses |
| XSD imports/includes | Relative references, chameleon includes, cyclic document graphs |
| Complex types | Element sequences, local attributes, recursive types, global element references |
| Values | Optional/nil/empty distinctions, readonly arrays with occurrence bounds |
| Primitives | Strings, booleans, bounded integers, bigint integers, decimal strings, float/double, date/time lexical strings, binary bytes |
| Enumerations | String/numeric bases; decimals remain `string` with runtime validation |

Unsupported: SOAP 1.2, WSDL 2.0, RPC/encoded bindings, one-way operations, SOAP header bindings, WS-Security/Policy, attachments, SOAP server generation, choice/all, mixed content, inheritance, wildcards, identity constraints, defaults/fixed values, general restriction facets, attribute references, and unlisted XSD built-ins. Nillable types with required attributes and ambiguous element-property names are rejected. Nil values cannot carry attributes; `UnknownFault` is reserved. Only UTF-8 XML 1.0 is accepted.

See [SPEC.md](./SPEC.md), [PLAN.md](./PLAN.md), and [design decisions](./docs/DECISIONS.md).

### Conformance coverage and known gaps

The [generated compatibility report](./docs/CONFORMANCE.md) records supported examples, explicit rejections, validation defects, behavioral failures, and untested areas. It combines focused WSDL/XSD probes with all 324 examples from an adapted W3C databinding source catalog. This is not full WSDL conformance or an official W3C certification. [Method, upstream suites, and provenance](./conformance/README.md).

```sh
pnpm conformance           # run offline and summarize current observations
pnpm conformance --check   # compare against the reviewed report (also runs in CI)
pnpm conformance --strict  # exits nonzero while missing or untested cases remain
```

## Development

```sh
pnpm check       # lint, typecheck, build, tests (including tarball consumer)
pnpm format
pnpm example
```

Tests cover local HTTP calls, independent XML expectations, generated consumer compilation, property-based codecs, resource policies, rollback, and CLI exit codes. CI runs on Node.js 22 and 24. Package tests need registry access to install pinned dependencies into a temporary project.

Conformance regression tests check agreement with recorded observations, including known failures; their passing count is not a conformance score.

Contributions should include a redistributable WSDL/XSD fixture and wire expectations. See [CONTRIBUTING.md](./CONTRIBUTING.md). Do not contribute private contracts or credentials.

## License

[MIT](./LICENSE).
