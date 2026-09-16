import type { HttpServerRequest } from "@effect/platform";
import { Effect, Stream } from "effect";
import type { GatewayError } from "./errors.js";

export function readJson(
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  timeoutMs: number,
): Effect.Effect<unknown, GatewayError> {
  return Effect.gen(function* () {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json")
      return yield* Effect.fail({
        _tag: "WsdlUnsupportedMediaType" as const,
        message: "Expected application/json",
      });
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
      return yield* Effect.fail({
        _tag: "WsdlUnsupportedMediaType" as const,
        message: "Compressed requests are unsupported",
      });
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* request.stream.pipe(
      Stream.mapError(() => ({
        _tag: "WsdlBadRequest" as const,
        message: "Cannot read request body",
      })),
      Stream.runForEach((chunk) => {
        size += chunk.byteLength;
        if (size > maxBytes)
          return Effect.fail({
            _tag: "WsdlPayloadTooLarge" as const,
            message: "Request body limit exceeded",
          });
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    return yield* Effect.try({
      try: () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
        while (pending.length) {
          const item = pending.pop()!;
          if (item.depth > 128) throw new Error("Too deeply nested");
          if (item.value !== null && typeof item.value === "object")
            for (const child of Object.values(item.value))
              pending.push({ value: child, depth: item.depth + 1 });
        }
        return value;
      },
      catch: () => ({
        _tag: "WsdlBadRequest" as const,
        message: "Invalid JSON or nesting limit exceeded",
      }),
    });
  }).pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => ({
        _tag: "WsdlRequestTimeout" as const,
        message: "Request body deadline exceeded",
      }),
    }),
  );
}
