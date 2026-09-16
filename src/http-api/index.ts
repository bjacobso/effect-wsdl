import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  type HttpApiError,
  HttpApiGroup,
  type HttpClient,
  type HttpServerRequest,
  OpenApi,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import type { Contract, Operation } from "../model/index.js";
import { makeClient, reflectOperations } from "../runtime/client.js";
import { ClientConstructionError } from "../runtime/errors.js";
import { type ClientConfig, validateClientConfig } from "../runtime/invoke.js";
import type { Selection } from "../selection.js";
import {
  BadRequest,
  type GatewayError,
  type GatewayFault,
  PayloadTooLarge,
  RequestTimeout,
  UnsupportedMediaType,
  UpstreamError,
  UpstreamTimeout,
} from "./errors.js";
import { jsonReflection } from "./json.js";
import { readJson } from "./request.js";

export type { GatewayError, GatewayFault } from "./errors.js";
export interface HttpApiOptions extends Selection {
  readonly prefix?: string;
  /** Only these original WSDL operation names are exposed; defaults to all. */
  readonly operations?: readonly string[];
  readonly client?: ClientConfig;
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
}
type Endpoint = HttpApiEndpoint.HttpApiEndpoint<
  string,
  "POST",
  never,
  never,
  unknown,
  never,
  unknown,
  GatewayError
>;
type Group = HttpApiGroup.HttpApiGroup<"soap", Endpoint, never>;
export type WsdlApi = HttpApi.HttpApi<"wsdl", Group, HttpApiError.HttpApiDecodeError>;
export interface ReflectedRoute {
  readonly operation: string;
  readonly endpoint: string;
  readonly method: "POST";
  readonly path: `/${string}`;
}
export interface WsdlHttpApi {
  readonly api: WsdlApi;
  readonly layer: Layer.Layer<HttpApi.Api, ClientConstructionError, HttpClient.HttpClient>;
  readonly routes: readonly ReflectedRoute[];
  readonly openApi: OpenApi.OpenAPISpec;
}

/** Reflect a loaded WSDL into an HttpApi and its SOAP-backed implementation layer. */
export function makeHttpApi(
  contract: Contract,
  options: HttpApiOptions = {},
): Effect.Effect<WsdlHttpApi, ClientConstructionError> {
  return Effect.try({
    try: () => {
      const { port, operations } = reflectOperations(contract, options);
      validateClientConfig(port.endpoint, options.client ?? {});
      const prefix = options.prefix === "/" ? "" : (options.prefix ?? "/soap");
      if (prefix !== "" && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix))
        throw new Error(
          "Prefix must contain literal path segments without parameters or trailing slash",
        );
      const maxBytes = options.maxRequestBytes ?? 1024 * 1024;
      const timeoutMs = options.requestTimeoutMs ?? 30000;
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      )
        throw new Error("Invalid request limits");
      const selected = options.operations ? [...options.operations] : [...operations.keys()];
      if (
        !selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some((name) => !operations.has(name))
      )
        throw new Error(
          "Operation allowlist must be nonempty, unique, and contain known WSDL names",
        );
      const json = jsonReflection(contract.types);
      const routes: ReflectedRoute[] = [];
      let group: Group = HttpApiGroup.make("soap");
      for (const [index, name] of selected.entries()) {
        const op = operations.get(name)!.definition;
        const route: ReflectedRoute = {
          operation: name,
          endpoint: `operation${index + 1}`,
          method: "POST",
          path: `/${prefix ? `${prefix.slice(1)}/` : ""}${encodeURIComponent(name)}`,
        };
        routes.push(route);
        const detail = Schema.Union(
          ...op.faults.map((f) =>
            Schema.Struct({ _tag: Schema.Literal(f.name), value: json.schema(f.element) }),
          ),
          Schema.Struct({
            _tag: Schema.Literal("UnknownFault"),
            xmlName: Schema.NullOr(Schema.String),
          }),
        );
        const fault: Schema.Schema<GatewayFault> = Schema.make(
          Schema.Struct({
            _tag: Schema.Literal("WsdlSoapFault"),
            operation: Schema.String,
            code: Schema.String,
            message: Schema.String,
            detail,
          }).ast,
        );
        // The router decodes incoming URL segments before matching; registration
        // uses the original Unicode name while the public route map is URL-encoded.
        const endpoint: Endpoint = HttpApiEndpoint.post(
          route.endpoint,
          `/${prefix ? `${prefix.slice(1)}/` : ""}${name}`,
        )
          .setPayload(json.schema(op.input))
          .addSuccess(json.schema(op.output))
          .addError(BadRequest, { status: 400 })
          .addError(PayloadTooLarge, { status: 413 })
          .addError(RequestTimeout, { status: 408 })
          .addError(UnsupportedMediaType, { status: 415 })
          .addError(fault, { status: 502 })
          .addError(UpstreamError, { status: 502 })
          .addError(UpstreamTimeout, { status: 504 })
          .annotate(OpenApi.Summary, name)
          .annotate(
            OpenApi.Description,
            `SOAP operation ${name} on ${port.service} / ${port.name}`,
          );
        group = group.add(endpoint);
      }
      const api: WsdlApi = HttpApi.make("wsdl")
        .add(group)
        .annotate(OpenApi.Title, `${port.service} SOAP bridge`)
        .annotate(OpenApi.Version, "1.0.0");
      const clientOptions = {
        ...options.client,
        ...(options.client?.headers ? { headers: { ...options.client.headers } } : {}),
        service: port.service,
        port: port.name,
      };
      const implementation = HttpApiBuilder.group(api, "soap", (initial) =>
        Effect.gen(function* () {
          const client = yield* makeClient(contract, clientOptions);
          const handle = (
            op: Operation,
            request: HttpServerRequest.HttpServerRequest,
          ): Effect.Effect<unknown, GatewayError> =>
            Effect.gen(function* () {
              const payload = yield* readJson(request, maxBytes, timeoutMs);
              const native = yield* Effect.try({
                try: () => json.fromJson(op.input, payload),
                catch: () => ({
                  _tag: "WsdlBadRequest" as const,
                  message: "Payload does not match the WSDL input schema",
                }),
              });
              const output = yield* client.call(op.name, native).pipe(
                Effect.mapError((error): GatewayError => {
                  if (error._tag === "InputValidationError")
                    return {
                      _tag: "WsdlBadRequest",
                      message: "Payload does not match the WSDL input schema",
                    };
                  if (error._tag === "TimeoutError")
                    return {
                      _tag: "WsdlUpstreamTimeout",
                      operation: op.name,
                      message: "SOAP upstream deadline exceeded",
                    };
                  if (error._tag === "SoapFault") {
                    const declaration = op.faults.find((f) => f.name === error.detail._tag);
                    if (declaration && "value" in error.detail) {
                      try {
                        return {
                          _tag: "WsdlSoapFault",
                          operation: op.name,
                          code: error.code,
                          message: error.message,
                          detail: {
                            _tag: declaration.name,
                            value: json.toJson(declaration.element, error.detail.value),
                          },
                        };
                      } catch {
                        return {
                          _tag: "WsdlUpstreamError",
                          operation: op.name,
                          message: "Cannot encode SOAP fault detail",
                        };
                      }
                    }
                    return {
                      _tag: "WsdlSoapFault",
                      operation: op.name,
                      code: error.code,
                      message: error.message,
                      detail: error.detail,
                    };
                  }
                  return {
                    _tag: "WsdlUpstreamError",
                    operation: op.name,
                    message: "SOAP upstream request failed",
                  };
                }),
              );
              return yield* Effect.try({
                try: () => json.toJson(op.output, output),
                catch: () => ({
                  _tag: "WsdlUpstreamError" as const,
                  operation: op.name,
                  message: "Cannot encode SOAP response",
                }),
              });
            });
          let handlers = initial;
          for (const route of routes)
            handlers = handlers.handleRaw(
              route.endpoint,
              ({ request }) => handle(operations.get(route.operation)!.definition, request),
              { uninterruptible: false },
            );
          // The endpoint names are runtime strings. The loop covers the same route list
          // used to build the group; the type system cannot track removal per iteration.
          return handlers as HttpApiBuilder.Handlers<
            HttpApiError.HttpApiDecodeError,
            never,
            never,
            never
          >;
        }),
      );
      return {
        api,
        routes,
        layer: HttpApiBuilder.api(api).pipe(Layer.provide(implementation)),
        openApi: OpenApi.fromApi(api),
      };
    },
    catch: (e) =>
      new ClientConstructionError({
        message: e instanceof Error ? e.message : "Cannot reflect HttpApi",
      }),
  });
}
