import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Effect, Either, Fiber, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { load, memoryLoader } from "../src/index.js";
import { invoke, schemaFor } from "../src/runtime/index.js";

const wsdl = await readFile(new URL("./fixtures/orders.wsdl", import.meta.url), "utf8");
const contract = await Effect.runPromise(
  load("file:///orders.wsdl").pipe(Effect.provide(memoryLoader({ "file:///orders.wsdl": wsdl }))),
);
const op = contract.ports[0]!.operations[0]!;
const envelope = (body: string, header = "") =>
  `<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/">${header}<e:Body>${body}</e:Body></e:Envelope>`;
const successBody =
  '<o:GetOrderResponse xmlns:o="urn:orders"><o:orderId>123</o:orderId><o:status>shipped</o:status><o:total>12345678901234567890.001</o:total></o:GetOrderResponse>';
const faultBody = (detail: string) =>
  `<e:Fault><faultcode>e:Client</faultcode><faultstring>Order missing</faultstring><detail>${detail}</detail></e:Fault>`;
interface Output {
  readonly orderId: string;
  readonly status: "pending" | "shipped";
  readonly total: string;
}
const output = schemaFor<Output>(op.output, contract.types);
const fault = Schema.Struct({
  _tag: Schema.Literal("OrderNotFound"),
  value: schemaFor<{ readonly orderId: string }>(op.faults[0]!.element, contract.types),
});
let server: Server;
let endpoint: string;
let requests = 0;
let cancelled = 0;
let lastRequest = "";
let lastAction: string | undefined;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    requests++;
    res.on("close", () => {
      if (!res.writableEnded) cancelled++;
    });
    let text = "";
    for await (const chunk of req) text += chunk;
    lastRequest = text;
    lastAction = req.headers.soapaction as string;
    res.setHeader("content-type", "text/xml");
    if (req.url === "/slow") {
      return;
    }
    if (req.url === "/large") {
      res.write(envelope(successBody));
      res.end(" ".repeat(10000));
      return;
    }
    if (req.url === "/status") {
      res.statusCode = 503;
      res.end("upstream unavailable");
      return;
    }
    if (req.url === "/xml") {
      res.end("<broken>");
      return;
    }
    if (req.url === "/wrong") {
      res.end(envelope(successBody.replace("shipped", "invalid")));
      return;
    }
    if (req.url === "/header") {
      res.end(
        envelope(
          successBody,
          '<e:Header><x:Token xmlns:x="urn:security" e:mustUnderstand="1"/></e:Header>',
        ),
      );
      return;
    }
    if (req.url?.startsWith("/fault")) {
      res.statusCode = req.url === "/fault200" ? 200 : 500;
      res.end(
        envelope(
          faultBody(
            '<o:OrderNotFound xmlns:o="urn:orders"><o:orderId>123</o:orderId></o:OrderNotFound>',
          ),
        ),
      );
      return;
    }
    if (req.url === "/unknown") {
      res.statusCode = 500;
      res.end(envelope(faultBody('<Other xmlns="urn:other"/>')));
      return;
    }
    res.end(envelope(successBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const call = (
  path = "/",
  input: unknown = { orderId: "123" },
  config: { timeoutMs?: number; maxResponseBytes?: number; headers?: Record<string, string> } = {},
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* invoke(http, op, contract.types, endpoint + path, config, input, output, fault);
  }).pipe(Effect.provide(FetchHttpClient.layer));
describe("SOAP runtime", () => {
  it("posts escaped SOAP XML with the exact action and decodes values", async () => {
    expect(await Effect.runPromise(call("/", { orderId: "a<&" }))).toEqual({
      orderId: "123",
      status: "shipped",
      total: "12345678901234567890.001",
    });
    expect(lastRequest).toContain("a&lt;&amp;");
    expect(lastAction).toBe('"urn:orders/GetOrder"');
  });
  it("validates before accessing the network", async () => {
    const before = requests;
    const result = await Effect.runPromise(call("/", { orderId: 42 }).pipe(Effect.either));
    expect(Either.isLeft(result) && result.left._tag).toBe("InputValidationError");
    expect(requests).toBe(before);
  });
  it.each(["/fault", "/fault200"])("decodes a declared SOAP fault at %s", async (path) => {
    const result = await Effect.runPromise(call(path).pipe(Effect.either));
    if (Either.isRight(result)) throw new Error("Expected failure");
    expect(result.left._tag).toBe("SoapFault");
    if (result.left._tag === "SoapFault")
      expect(result.left.detail).toEqual({ _tag: "OrderNotFound", value: { orderId: "123" } });
  });
  it("preserves undeclared faults as generic faults", async () => {
    const result = await Effect.runPromise(call("/unknown").pipe(Effect.either));
    expect(Either.isLeft(result) && result.left._tag === "SoapFault" && result.left.detail).toEqual(
      { _tag: "UnknownFault", xmlName: "{urn:other}Other" },
    );
  });
  it.each([
    ["/status", "HttpStatusError"],
    ["/xml", "ResponseDecodeError"],
    ["/wrong", "ResponseDecodeError"],
    ["/header", "ResponseDecodeError"],
  ])("classifies %s as %s", async (path, tag) => {
    const result = await Effect.runPromise(call(path).pipe(Effect.either));
    expect(Either.isLeft(result) && result.left._tag).toBe(tag);
  });
  it("enforces body limits and configurable deadlines without retries", async () => {
    const result = await Effect.runPromise(
      call("/large", undefined, { maxResponseBytes: 100 }).pipe(Effect.either),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("ResponseDecodeError");
    const before = requests;
    const timeout = await Effect.runPromise(
      call("/slow", undefined, { timeoutMs: 50 }).pipe(Effect.either),
    );
    expect(Either.isLeft(timeout) && timeout.left._tag).toBe("TimeoutError");
    expect(requests).toBe(before + 1);
  });
  it("retains interruption and cancels the HTTP request", async () => {
    const before = cancelled;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(call("/slow"));
        yield* Effect.sleep("50 millis");
        return yield* Fiber.interrupt(fiber);
      }),
    );
    expect(exit._tag).toBe("Failure");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancelled).toBeGreaterThan(before);
  });
  it("rejects protocol header overrides and invalid configuration", async () => {
    for (const config of [
      { headers: { SOAPAction: "evil" } },
      { timeoutMs: -1 },
      { maxResponseBytes: 0 },
    ]) {
      const result = await Effect.runPromise(call("/", undefined, config).pipe(Effect.either));
      expect(Either.isLeft(result) && result.left._tag).toBe("InputValidationError");
    }
  });
});
