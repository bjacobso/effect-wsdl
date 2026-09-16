# effect-wsdl

An Effect-based WSDL toolkit for generating typed TypeScript SOAP clients, runtime schemas, and reusable service definitions.

**Status: design stage.** This repository currently contains the specification and implementation plan. No generator, runtime, CLI, or npm package is available yet. All API and command examples below describe the proposed interface.

## What we're building

Point the generator at a WSDL contract and produce:

- TypeScript request, response, and declared fault types.
- Effect Schema validators and XML serialization metadata.
- Client operations returning `Effect` values with typed failures.
- Service definitions that can be provided through Effect Layers and tested with an injected HTTP client.

The same parsing and generation pipeline will be available as a library and CLI. Generated clients will use a small runtime without loading the WSDL or generator in production.

Here, “generator” means **WSDL → TypeScript clients**, not generating WSDL from TypeScript.

## Proposed workflow

Once implemented, a locally installed CLI will support:

```sh
effect-wsdl inspect ./contracts/orders.wsdl
effect-wsdl generate ./contracts/orders.wsdl --out ./src/generated/orders
effect-wsdl generate ./contracts/orders.wsdl --out ./src/generated/orders --check
```

Illustrative generated client usage; these exports do not exist yet:

```ts
import { Effect } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { OrdersClient } from "./generated/orders/index.js"

const program = Effect.gen(function* () {
  const orders = yield* OrdersClient.make({
    endpoint: "https://example.com/soap/orders"
  })
  return yield* orders.getOrder({ orderId: "order-123" })
})

const runnable = program.pipe(Effect.provide(FetchHttpClient.layer))
// Run at your application's boundary, e.g. Effect.runPromise(runnable).
```

Input validation, HTTP failures, XML decoding failures, and SOAP faults will remain distinguishable in the Effect error channel. Requests will support interruption and configurable timeouts. Automatic retries will be disabled because SOAP operations can mutate remote state.

## Initial compatibility target

| Area | First release target |
| --- | --- |
| Contracts | WSDL 1.1, explicit service/port selection when ambiguous |
| Wire protocol | SOAP 1.1 over HTTP, document/literal, one body element per message |
| Operations | Request/response, declared faults |
| Schemas | A documented XSD 1.0 subset; unsupported constructs fail generation |
| Imports | Local WSDL/XSD imports and includes; remote resolution requires opt-in |
| Effect | Effect 3 baseline; supported peer ranges verified before release |
| Runtime | Node.js 22+ initially; additional runtimes require compatibility tests |

SOAP 1.2, WSDL 2.0, RPC/encoded bindings, server generation, WS-Security, and attachments are outside the first release. See [SPEC.md](./SPEC.md) for the exact boundary.

## Design and contribution

- [SPEC.md](./SPEC.md): contracts, architecture, compatibility, and acceptance criteria.
- [PLAN.md](./PLAN.md): ordered milestones and release gates.

Contributions should start with a supported use case and a small, redistributable WSDL/XSD fixture. Open an issue for additional contract features so their wire semantics can be specified before implementation. Do not contribute private service contracts or credentials.

There are no build or test commands yet. The first implementation milestone will establish them and a working end-to-end fixture before expanding schema coverage.

## License

[MIT](./LICENSE).
