import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { expanded, type Operation } from "../model/index.js";
import { attr, ENV, parseXml, qname, type XmlNode } from "../xml.js";
import { decodeElement, encodeElement, type Types } from "./codec.js";
import {
  HttpStatusError,
  InputValidationError,
  type OperationError,
  ResponseDecodeError,
  SoapFault,
  TimeoutError,
  TransportError,
} from "./errors.js";

export { schemaFor } from "./codec.js";
export * from "./errors.js";
export interface ClientConfig {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export function invoke<A, B, D>(
  client: HttpClient.HttpClient,
  operation: Operation,
  types: Types,
  endpoint: string,
  config: ClientConfig,
  input: A,
  outputSchema: Schema.Schema<B>,
  faultSchema: Schema.Schema<D>,
): Effect.Effect<B, OperationError<D>> {
  const invalid = (message: string) =>
    new InputValidationError({ operation: operation.name, message });
  const decodeError = (message: string) =>
    new ResponseDecodeError({ operation: operation.name, message });
  return Effect.suspend(() => {
    const maxBytes = config.maxResponseBytes ?? 10 * 1024 * 1024;
    const timeout = config.timeoutMs ?? 30000;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    )
      return Effect.fail(invalid("Invalid timeout or response byte limit"));
    const request = Effect.try({
      try: () => {
        const url = new URL(config.endpoint ?? endpoint);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Endpoint must be HTTP(S) without embedded credentials");
        if (
          Object.keys(config.headers ?? {}).some((k) =>
            ["content-type", "soapaction", "content-length", "host", "transfer-encoding"].includes(
              k.toLowerCase(),
            ),
          )
        )
          throw new Error("Cannot override protocol headers");
        if (/[\r\n"\\]/.test(operation.action)) throw new Error("Invalid SOAPAction");
        const body = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${ENV}"><s:Body>${encodeElement(operation.input, input, types)}</s:Body></s:Envelope>`;
        return HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(config.headers ?? {}),
          HttpClientRequest.bodyText(body, "text/xml; charset=utf-8"),
          HttpClientRequest.setHeader("SOAPAction", `"${operation.action}"`),
        );
      },
      catch: (e) => invalid(e instanceof Error ? e.message : "Invalid input"),
    });
    return Effect.gen(function* () {
      const req = yield* request;
      const response = yield* client
        .pipe(
          HttpClient.withTracerDisabledWhen(() => true),
          HttpClient.withScope,
        )
        .execute(req)
        .pipe(
          Effect.mapError(
            () =>
              new TransportError({ operation: operation.name, message: "HTTP transport failed" }),
          ),
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* response.stream.pipe(
        Stream.mapError(
          () =>
            new TransportError({ operation: operation.name, message: "Response stream failed" }),
        ),
        Stream.runForEach((chunk) => {
          size += chunk.byteLength;
          if (size > maxBytes) return Effect.fail(decodeError("Response byte limit exceeded"));
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      return yield* Effect.try({
        try: () => {
          let root: XmlNode;
          try {
            const buffer = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              buffer.set(chunk, offset);
              offset += chunk.byteLength;
            }
            root = parseXml(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
          } catch {
            if (response.status < 200 || response.status >= 300)
              throw new HttpStatusError({ status: response.status, operation: operation.name });
            throw decodeError("Malformed response XML");
          }
          const nonSuccess = response.status < 200 || response.status >= 300;
          if (root.namespace !== ENV || root.local !== "Envelope") {
            if (nonSuccess)
              throw new HttpStatusError({ status: response.status, operation: operation.name });
            throw decodeError("Expected SOAP 1.1 Envelope");
          }
          const nodes = root.children;
          const body = nodes.at(-1);
          if (
            root.text.trim() ||
            !body ||
            body.namespace !== ENV ||
            body.local !== "Body" ||
            nodes.length > 2 ||
            (nodes.length === 2 && (nodes[0]?.namespace !== ENV || nodes[0]?.local !== "Header")) ||
            body.text.trim() ||
            body.children.length !== 1
          )
            throw decodeError("Invalid SOAP envelope/body shape");
          if (nodes.length === 2)
            for (const header of nodes[0]!.children) {
              const mandatory = attr(header, "mustUnderstand", ENV);
              if (mandatory !== undefined && mandatory !== "0")
                throw decodeError("Unsupported mandatory SOAP header");
            }
          const payload = body.children[0]!;
          if (payload.namespace === ENV && payload.local === "Fault") {
            const field = (name: string, required = true): XmlNode | undefined => {
              const matches = payload.children.filter(
                (n) => n.namespace === "" && n.local === name,
              );
              if (matches.length > 1 || (required && matches.length !== 1))
                throw decodeError("Malformed SOAP fault");
              return matches[0];
            };
            const code = field("faultcode")!;
            const message = field("faultstring")!;
            field("faultactor", false);
            if (
              code.children.length ||
              message.children.length ||
              payload.text.trim() ||
              payload.children.some(
                (n) =>
                  n.namespace !== "" ||
                  !["faultcode", "faultstring", "faultactor", "detail"].includes(n.local),
              )
            )
              throw decodeError("Malformed SOAP fault");
            const detail = field("detail", false);
            const detailNode = detail?.children.length === 1 ? detail.children[0] : undefined;
            const declared =
              detailNode &&
              operation.faults.find((f) => expanded(f.element) === expanded(detailNode));
            const decoded =
              declared && detailNode
                ? Schema.decodeUnknownSync(faultSchema)({
                    _tag: declared.name,
                    value: decodeElement(declared.element, detailNode, types),
                  })
                : {
                    _tag: "UnknownFault" as const,
                    xmlName: detailNode ? expanded(detailNode) : null,
                  };
            throw new SoapFault({
              operation: operation.name,
              code: expanded(qname(code, code.text.trim())),
              message: message.text,
              detail: decoded,
            });
          }
          if (nonSuccess)
            throw new HttpStatusError({ status: response.status, operation: operation.name });
          return Schema.decodeUnknownSync(outputSchema)(
            decodeElement(operation.output, payload, types),
          );
        },
        catch: (e) =>
          e instanceof SoapFault || e instanceof HttpStatusError || e instanceof ResponseDecodeError
            ? (e as OperationError<D>)
            : decodeError(e instanceof Error ? e.message : "Invalid response"),
      });
    }).pipe(
      Effect.scoped,
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new TimeoutError({ operation: operation.name, message: "Request deadline exceeded" }),
      }),
    );
  });
}
