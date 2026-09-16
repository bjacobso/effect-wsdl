import assert from "node:assert/strict";
import { createServer } from "node:http";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Either } from "effect";
import { OrdersClient } from "./generated/index.js";

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const missing = body.includes("missing");
  response.writeHead(missing ? 500 : 200, { "content-type": "text/xml; charset=utf-8" });
  response.end(
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      (missing
        ? '<s:Fault><faultcode>s:Client</faultcode><faultstring>Order missing</faultstring><detail><OrderNotFound xmlns="urn:orders"><orderId>missing</orderId></OrderNotFound></detail></s:Fault>'
        : '<GetOrderResponse xmlns="urn:orders"><orderId>order-123</orderId><status>shipped</status><total>42.50</total></GetOrderResponse>') +
      '</s:Body></s:Envelope>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Server address missing");

const program = Effect.gen(function* () {
  const orders = yield* OrdersClient.Tag;
  const order = yield* orders.getOrder({ orderId: "order-123" });
  assert.equal(order.total, "42.50");
  console.log("Order:", order);
  const result = yield* orders.getOrder({ orderId: "missing" }).pipe(Effect.either);
  assert.ok(Either.isLeft(result));
  if (Either.isLeft(result) && result.left._tag === "SoapFault") {
    const detail = result.left.detail;
    if (detail._tag === "OrderNotFound") console.log("Declared fault:", detail.value.orderId);
    else throw new Error("Expected OrderNotFound");
  } else throw new Error("Expected a SOAP fault");
}).pipe(
  Effect.provide(OrdersClient.layer({ endpoint: `http://127.0.0.1:${address.port}` })),
  Effect.provide(FetchHttpClient.layer),
);

try {
  await Effect.runPromise(program);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
