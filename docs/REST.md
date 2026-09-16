# Runtime clients and WSDL-to-HTTP reflection

Load a supported contract once at application startup. `makeClient(contract, options)` builds an interpreted SOAP client; `makeHttpApi(contract, options)` builds an actual Effect `HttpApi`, its implementation Layer, a route map, and an OpenAPI document. Neither function writes files, evaluates generated JavaScript, loads contracts on incoming requests, or opens a listening socket.

## Runtime client contract

Import `makeClient` from `effect-wsdl` or `effect-wsdl/runtime`. It returns `Effect<RuntimeClient, ClientConstructionError, HttpClient>`. Options combine `service`/`port` selection with the existing `ClientConfig` settings. The returned client captures its transport dependency; subsequent calls have no HTTP service requirement.

Call `client.call("GetOrder", input)` using the original operation name. Successful values have static type `unknown` and validated native shapes. Errors include the existing SOAP operation errors and `UnknownOperationError`. `client.operations` is a readonly map containing the WSDL definition and input, output, and declared fault schemas. Arbitrary generics cannot manufacture static knowledge of a runtime WSDL; use source generation when you need named TypeScript request/response types.

## HttpApi contract

Import `makeHttpApi` from `effect-wsdl/http-api`. It returns an Effect requiring no services. Its result contains:

| Field | Meaning |
| --- | --- |
| `api` | Effect `HttpApi`, with group `soap` and reflected endpoint schemas |
| `layer` | Implementation Layer providing `HttpApi.Api`; requires `HttpClient` |
| `routes` | Original operation name, HTTP method/path, and internal endpoint identifier |
| `openApi` | `OpenApi.fromApi(api)` output, without upstream credentials |

Options:

| Setting | Default |
| --- | --- |
| `service`, `port` | Infer only if exactly one supported port exists |
| `prefix` | `/soap`; `""` or `/` mounts at the root |
| `operations` | All operations; an explicit list must be nonempty, unique, and valid |
| `client` | WSDL endpoint and existing SOAP client defaults; supports endpoint/auth overrides |
| `maxRequestBytes` | 1 MiB |
| `requestTimeoutMs` | 30 seconds for reading the REST body |

Routes are `POST <prefix>/<encoded-original-operation-name>`. Prefixes must consist of literal ASCII path segments; parameters, wildcards, and trailing slashes are rejected. Internal endpoint identifiers are `operation1`, `operation2`, etc.; use `routes` to correlate them with operations. One bridge represents one selected WSDL port. The fixed API/group identifiers are intended for one bridge per HttpApi application; mounting several independent bridges requires separate host routing.

Every route expects `application/json`, rejects compressed bodies, and limits nesting to 128 levels. `handleRaw` is used only to read and bound the request body before applying the endpoint's reflected schema; successful responses still go through HttpApi response encoding. This also provides predictable errors for malformed JSON rather than relying on the platform's default body parser. Requests preserve optional versus null values, arrays, and `$attributes`. Unknown fields are rejected before contacting SOAP.

## JSON mapping

| SOAP/native value | JSON representation |
| --- | --- |
| `integer`, `long`, `unsignedLong` / `bigint` | Decimal integer string; no `+` or leading zeros |
| `decimal` | Decimal string preserving precision and trailing zeros |
| `base64Binary` / `Uint8Array` | Canonical base64 string |
| Finite float/double | JSON number |
| Non-finite float/double | `"INF"`, `"-INF"`, `"NaN"` |
| Date/time | Original XSD lexical string, including timezone presence |
| Other supported primitives | JSON string, boolean, or bounded number |

The bridge builds structural Effect schemas and OpenAPI references for recursion. It does not attempt to derive JSON schemas from native `Schema.declare` validators. Constraints that cannot be fully expressed in JSON Schema, such as decimal enumeration value equivalence, calendar validation, and bigint ranges, remain enforced at runtime. Declared SOAP fault details use the same JSON conversion as successful results.

The HTTP bridge rejects XML element/attribute properties named `__proto__`, which the current platform's struct decoder cannot safely preserve. Original operation names, including reserved JavaScript names, remain supported through generated internal endpoint identifiers.

## Errors

| Status | Body `_tag` | Trigger |
| --- | --- | --- |
| 400 | `WsdlBadRequest` | Invalid JSON, nesting, or WSDL input |
| 408 | `WsdlRequestTimeout` | REST body read deadline |
| 413 | `WsdlPayloadTooLarge` | Actual streamed body exceeds limit |
| 415 | `WsdlUnsupportedMediaType` | Wrong content type or compressed body |
| 502 | `WsdlSoapFault` | Declared or generic SOAP fault, even on upstream HTTP 200 |
| 502 | `WsdlUpstreamError` | Transport/status/XML/response conversion failure |
| 504 | `WsdlUpstreamTimeout` | SOAP request deadline |

SOAP fault JSON includes operation, code, message, and detail. Declared detail is `{ "_tag": "FaultName", "value": ... }`; unmatched detail is `{ "_tag": "UnknownFault", "xmlName": ... }`. SOAP fault messages and declared data are intentionally returned. Other upstream errors use generic messages and never copy raw upstream bodies. No HTTP status is guessed from a business fault name. Applications needing domain-specific statuses can use the runtime client with their own endpoint handlers.

## Hosting and lifecycle

`examples/serve-rest.ts` uses `HttpApiBuilder.serve`, `HttpApiSwagger.layer`, and `NodeHttpServer.layer`. Run `pnpm rest <local.wsdl> [port]`; it binds to `127.0.0.1` and uses the service address from that WSDL. Requests require the upstream SOAP service to be available. Ctrl-C closes the Effect server scope. The package does not require a Node server dependency for consumers using a Web `Request`/`Response` host.

For those hosts, use the README's `HttpApiBuilder.toWebHandler` example and call `dispose()` on shutdown. Request interruption propagates to the SOAP HTTP request. Add authentication, authorization, CORS, and rate limiting through your host/server middleware as appropriate for the operations you expose. Incoming HTTP headers, cookies, and credentials are not forwarded to SOAP; upstream configuration is provided by the application. Use an explicit operation list to expose a subset.

This is an operation-oriented JSON adapter. It does not infer resource models, CRUD semantics, idempotency, or retry safety from operation names.
