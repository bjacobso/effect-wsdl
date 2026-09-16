import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { FetchHttpClient, HttpApiBuilder, HttpServer, OpenApi } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Either, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpApiOptions, makeHttpApi } from "../src/http-api/index.js";
import { load, memoryLoader } from "../src/index.js";
import type { Contract } from "../src/model/index.js";
import { makeClient } from "../src/runtime/index.js";

const wsdl = await readFile(new URL("./fixtures/orders.wsdl", import.meta.url), "utf8");
const contract = await Effect.runPromise(
  load("file:///orders.wsdl").pipe(Effect.provide(memoryLoader({ "file:///orders.wsdl": wsdl }))),
);
const envelope = (body: string) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
let server: Server, endpoint: string;
let requests = 0,
  lastBody = "",
  lastAuthorization: string | undefined;
const disposers: (() => Promise<void>)[] = [];
const upstreamEvents = new EventEmitter();
beforeAll(async () => {
  server = createServer(async (request, response) => {
    requests++;
    lastAuthorization = request.headers.authorization;
    let body = "";
    for await (const chunk of request) body += chunk;
    lastBody = body;
    if (body.includes("<v:Values")) {
      response.end(body);
      return;
    }
    if (body.includes("timeout")) {
      if (body.includes("cancel-timeout")) {
        response.on("close", () => upstreamEvents.emit("cancelled"));
        upstreamEvents.emit("started");
      }
      return;
    }
    if (body.includes("status-error")) {
      response.writeHead(503);
      response.end("private upstream failure detail");
      return;
    }
    if (body.includes("bad-xml")) {
      response.end("<private-invalid>");
      return;
    }
    if (body.includes("missing")) {
      response.writeHead(500);
      response.end(
        envelope(
          '<s:Fault><faultcode>s:Client</faultcode><faultstring>Order missing</faultstring><detail><OrderNotFound xmlns="urn:orders"><orderId>missing</orderId></OrderNotFound></detail></s:Fault>',
        ),
      );
      return;
    }
    if (body.includes("generic-fault")) {
      response.writeHead(500);
      response.end(
        envelope(
          '<s:Fault><faultcode>s:Server</faultcode><faultstring>Unknown fault</faultstring><detail><Other xmlns="urn:other"/></detail></s:Fault>',
        ),
      );
      return;
    }
    response.end(
      envelope(
        '<GetOrderResponse xmlns="urn:orders"><orderId>123</orderId><status>shipped</status><total>12345678901234567890.001</total></GetOrderResponse>',
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const dispose of disposers) await dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function bridge(options: HttpApiOptions = {}, source: Contract = contract) {
  const reflected = await Effect.runPromise(
    makeHttpApi(source, { ...options, client: { endpoint, ...options.client } }),
  );
  const web = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      reflected.layer.pipe(Layer.provide(FetchHttpClient.layer)),
      HttpServer.layerContext,
    ),
  );
  disposers.push(web.dispose);
  const post = (body: unknown, path = reflected.routes[0]!.path) =>
    web.handler(
      new Request(`http://rest.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "inbound-client-secret" },
        body: JSON.stringify(body),
      }),
    );
  return { ...reflected, ...web, post };
}
describe("runtime client and reflected HttpApi", () => {
  it("keeps the reflected port selection separate from client transport options", async () => {
    const first = contract.ports[0]!;
    const source: Contract = {
      ...contract,
      ports: [
        first,
        { ...first, name: "Other", operations: [{ ...first.operations[0]!, name: "OtherOnly" }] },
      ],
    };
    const widerConfig = { port: "Other", endpoint };
    const api = await bridge({ port: first.name, client: widerConfig }, source);
    expect((await api.post({ orderId: "1" })).status).toBe(200);
  });
  it("propagates a cancelled REST request to the SOAP connection", async () => {
    const api = await bridge();
    const controller = new AbortController();
    const started = once(upstreamEvents, "started");
    const cancelled = once(upstreamEvents, "cancelled");
    const response = api
      .handler(
        new Request("http://rest.test/soap/GetOrder", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: "cancel-timeout" }),
          signal: controller.signal,
        }),
      )
      .catch(() => undefined);
    await started;
    controller.abort();
    await cancelled;
    await response;
  });
  it("rejects slow request streams and excessively nested JSON", async () => {
    const api = await bridge({ requestTimeoutMs: 30 });
    const pending = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"orderId":'));
      },
    });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pending,
      duplex: "half",
    };
    const slow = await api.handler(new Request("http://rest.test/soap/GetOrder", init));
    expect(slow.status).toBe(408);
    const deep = `${"[".repeat(130)}0${"]".repeat(130)}`;
    const invalid = await api.handler(
      new Request("http://rest.test/soap/GetOrder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: deep,
      }),
    );
    expect(invalid.status).toBe(400);
  });
  it("serves the reflected layer through NodeHttpServer over a real HTTP socket", async () => {
    const reflected = await Effect.runPromise(makeHttpApi(contract, { client: { endpoint } }));
    const serving = HttpApiBuilder.serve().pipe(
      Layer.provide(reflected.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP address");
        const port = server.address.port;
        return yield* Effect.tryPromise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/soap/GetOrder`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orderId: "1" }),
          });
          return { status: response.status, body: await response.json() };
        });
      }).pipe(Effect.provide(serving), Effect.scoped),
    );
    expect(result).toEqual({
      status: 200,
      body: { orderId: "123", status: "shipped", total: "12345678901234567890.001" },
    });
  });
  it("round-trips large integers, bytes, special numbers and recursive values over REST and SOAP", async () => {
    const xml = await readFile(new URL("./fixtures/values.wsdl", import.meta.url), "utf8");
    const source = await Effect.runPromise(
      load("file:///values.wsdl").pipe(
        Effect.provide(memoryLoader({ "file:///values.wsdl": xml })),
      ),
    );
    const api = await bridge({}, source);
    const leaf = {
      id: "9223372036854775807",
      total: "12345678901234567890.0001",
      data: "AP8=",
      special: "NaN",
      note: null,
      tags: ["", null],
      $attributes: { version: 1 },
    };
    const value = { ...leaf, special: "INF", child: leaf };
    const response = await api.post(value);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value);
    const client = await Effect.runPromise(
      makeClient(source, { endpoint }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const native = {
      ...leaf,
      id: 9223372036854775807n,
      data: new Uint8Array([0, 255]),
      special: NaN,
    };
    expect(await Effect.runPromise(client.call("Echo", native))).toEqual(native);
    const invalid = await api.post({ ...leaf, id: Number(9223372036854775807n) });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(api.openApi)).toContain('"maxItems":3');
  });
  it("registers every reflected operation and respects a subset allowlist", async () => {
    const op = contract.ports[0]!.operations[0]!;
    const source: Contract = {
      ...contract,
      ports: [
        {
          ...contract.ports[0]!,
          operations: [
            op,
            { ...op, name: "Other" },
            { ...op, name: "constructor" },
            { ...op, name: "Écho" },
            { ...op, name: "__proto__" },
          ],
        },
      ],
    };
    const all = await bridge({}, source);
    for (const name of ["GetOrder", "Other", "constructor", "Écho", "__proto__"])
      expect((await all.post({ orderId: "1" }, `/soap/${encodeURIComponent(name)}`)).status).toBe(
        200,
      );
    const selected = await bridge({ operations: ["Other"] }, source);
    expect((await selected.post({ orderId: "1" }, "/soap/Other")).status).toBe(200);
    expect((await selected.post({ orderId: "1" }, "/soap/GetOrder")).status).toBe(404);
  });
  it("calls SOAP directly at runtime with native results and declared faults", async () => {
    const client = await Effect.runPromise(
      makeClient(contract, { endpoint }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(await Effect.runPromise(client.call("GetOrder", { orderId: "123" }))).toEqual({
      orderId: "123",
      status: "shipped",
      total: "12345678901234567890.001",
    });
    const fault = await Effect.runPromise(
      client.call("GetOrder", { orderId: "missing" }).pipe(Effect.either),
    );
    expect(Either.isLeft(fault) && fault.left._tag === "SoapFault" && fault.left.detail).toEqual({
      _tag: "OrderNotFound",
      value: { orderId: "missing" },
    });
  });
  it("reflects a real HttpApi and OpenAPI schemas, and proxies a JSON request", async () => {
    const api = await bridge({
      client: { headers: { authorization: "configured-upstream-secret" } },
    });
    expect(api.routes).toEqual([
      { operation: "GetOrder", endpoint: "operation1", method: "POST", path: "/soap/GetOrder" },
    ]);
    expect(OpenApi.fromApi(api.api)).toEqual(api.openApi);
    const spec = JSON.stringify(api.openApi);
    expect(spec).toContain('"orderId"');
    expect(spec).toContain('"shipped"');
    expect(spec).toContain('"502"');
    expect(spec).not.toContain("configured-upstream-secret");
    const response = await api.post({ orderId: "hello<&" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      orderId: "123",
      status: "shipped",
      total: "12345678901234567890.001",
    });
    expect(lastBody).toContain("hello&lt;&amp;");
    expect(lastAuthorization).toBe("configured-upstream-secret");
  });
  it("rejects invalid payloads and extra fields before making upstream requests", async () => {
    const api = await bridge();
    const before = requests;
    for (const value of [
      {},
      { orderId: 3 },
      { orderId: "1", endpoint: "http://evil.test" },
      null,
      [],
    ])
      expect((await api.post(value)).status).toBe(400);
    expect(requests).toBe(before);
  });
  it("bounds bodies and handles malformed JSON and unsupported content types", async () => {
    const api = await bridge({ maxRequestBytes: 50 });
    const before = requests;
    expect((await api.post({ orderId: "x".repeat(100) })).status).toBe(413);
    const malformed = await api.handler(
      new Request("http://rest.test/soap/GetOrder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(
      (
        await api.handler(
          new Request("http://rest.test/soap/GetOrder", { method: "POST", body: "text" }),
        )
      ).status,
    ).toBe(415);
    expect(requests).toBe(before);
  });
  it("maps declared and generic faults to documented JSON errors", async () => {
    const api = await bridge();
    const response = await api.post({ orderId: "missing" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      _tag: "WsdlSoapFault",
      operation: "GetOrder",
      detail: { _tag: "OrderNotFound", value: { orderId: "missing" } },
    });
    const generic = await api.post({ orderId: "generic-fault" });
    expect(generic.status).toBe(502);
    expect(await generic.json()).toMatchObject({
      detail: { _tag: "UnknownFault", xmlName: "{urn:other}Other" },
    });
  });
  it("maps upstream protocol failures and deadlines without exposing raw errors", async () => {
    const api = await bridge({ client: { timeoutMs: 50 } });
    for (const orderId of ["status-error", "bad-xml"]) {
      const result = await api.post({ orderId });
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({
        _tag: "WsdlUpstreamError",
        operation: "GetOrder",
        message: "SOAP upstream request failed",
      });
    }
    const result = await api.post({ orderId: "timeout" });
    expect(result.status).toBe(504);
  });
  it("supports prefixes and explicit exposure without generating GET routes", async () => {
    const api = await bridge({ prefix: "/api/orders", operations: ["GetOrder"] });
    expect((await api.post({ orderId: "1" })).status).toBe(200);
    expect((await api.handler(new Request("http://rest.test/api/orders/GetOrder"))).status).toBe(
      404,
    );
    for (const options of [
      { prefix: "/api/:id" },
      { operations: [] },
      { operations: ["Unknown"] },
      { operations: ["GetOrder", "GetOrder"] },
      { maxRequestBytes: 0 },
    ])
      await expect(Effect.runPromise(makeHttpApi(contract, options))).rejects.toThrow();
  });
});
