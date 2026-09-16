import { readFile } from "node:fs/promises";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import { load, memoryLoader } from "../src/index.js";
import { makeClient } from "../src/runtime/index.js";

const wsdl = await readFile(new URL("./fixtures/orders.wsdl", import.meta.url), "utf8");
const contract = await Effect.runPromise(
  load("file:///orders.wsdl").pipe(Effect.provide(memoryLoader({ "file:///orders.wsdl": wsdl }))),
);
it("reflects native schemas and rejects unknown operations without sending a request", async () => {
  const client = await Effect.runPromise(
    makeClient(contract).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  expect(client.service).toBe("{urn:orders}Orders");
  expect([...client.operations.keys()]).toEqual(["GetOrder"]);
  const operation = client.operations.get("GetOrder")!;
  expect(Schema.is(operation.inputSchema)({ orderId: "1" })).toBe(true);
  expect(Schema.is(operation.inputSchema)({ orderId: 1 })).toBe(false);
  const missing = await Effect.runPromise(client.call("constructor", {}).pipe(Effect.either));
  expect(Either.isLeft(missing) && missing.left._tag).toBe("UnknownOperationError");
  const invalid = await Effect.runPromise(
    client.call("GetOrder", { orderId: 1 }).pipe(Effect.either),
  );
  expect(Either.isLeft(invalid) && invalid.left._tag).toBe("InputValidationError");
});
it("rejects ambiguous and unsupported ports consistently with generation", async () => {
  const ambiguous = {
    ...contract,
    ports: [...contract.ports, { ...contract.ports[0]!, name: "Other" }],
  };
  await expect(
    Effect.runPromise(makeClient(ambiguous).pipe(Effect.provide(FetchHttpClient.layer))),
  ).rejects.toThrow("Ambiguous");
  expect(
    (
      await Effect.runPromise(
        makeClient(ambiguous, { port: "Other" }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
    ).port,
  ).toBe("Other");
  await expect(
    Effect.runPromise(
      makeClient(contract, { service: "missing" }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  ).rejects.toThrow("No matching");
});
