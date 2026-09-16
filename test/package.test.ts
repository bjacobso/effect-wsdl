import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it("installs the tarball, generates and compiles a consumer, and exercises public exports", async () => {
  const temp = await mkdtemp(join(tmpdir(), "effect-wsdl-consumer-"));
  try {
    await exec("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], {
      cwd: resolve("."),
      timeout: 30000,
    });
    await writeFile(join(temp, "package.json"), JSON.stringify({ type: "module", private: true }));
    await exec(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "./effect-wsdl-0.1.0-alpha.0.tgz",
        "effect@3.22.2",
        "@effect/platform@0.97.2",
        "typescript@5.9.3",
        "@types/node@22.19.15",
      ],
      { cwd: temp, timeout: 120000 },
    );
    const cli = join(temp, "node_modules/effect-wsdl/dist/cli/index.js");
    expect(
      (
        await exec(join(temp, "node_modules/.bin/effect-wsdl"), ["--version"], { cwd: temp })
      ).stdout.trim(),
    ).toBe("0.1.0-alpha.0");
    const fixture = resolve("test/fixtures/orders.wsdl");
    const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: temp });
    expect(JSON.parse((await run("inspect", fixture, "--json")).stdout).services[0].name).toBe(
      "{urn:orders}Orders",
    );
    await run("generate", fixture, "--out", "generated");
    await run("generate", fixture, "--out", "generated", "--check");
    await expect(run("--bad-argument")).rejects.toMatchObject({ code: 2 });
    await writeFile(join(temp, "generated/client.ts"), "stale");
    await expect(run("generate", fixture, "--out", "generated", "--check")).rejects.toMatchObject({
      code: 3,
    });
    await run("generate", fixture, "--out", "generated");
    await writeFile(
      join(temp, "consumer.ts"),
      `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Effect, Either } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { OrdersClient, Operation1Input } from "./generated/index.js";
import { Schema } from "effect";
assert.equal(Schema.is(Operation1Input)({ orderId: "123" }), true);
assert.equal(Schema.is(Operation1Input)({ orderId: 123 }), false);
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  assert.equal(req.headers.soapaction, '"urn:orders/GetOrder"');
  const missing = body.includes("missing");
  res.statusCode = missing ? 500 : 200;
  res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + (missing
    ? '<s:Fault><faultcode>s:Client</faultcode><faultstring>Missing</faultstring><detail><OrderNotFound xmlns="urn:orders"><orderId>missing</orderId></OrderNotFound></detail></s:Fault>'
    : '<GetOrderResponse xmlns="urn:orders"><orderId>123</orderId><status>shipped</status><total>1.00</total></GetOrderResponse>') + '</s:Body></s:Envelope>');
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
try {
  const config = { endpoint: "http://127.0.0.1:" + address.port };
  const result = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* OrdersClient.make(config);
    const success = yield* client.getOrder({ orderId: "123" });
    const fault = yield* client.getOrder({ orderId: "missing" }).pipe(Effect.either);
    return { success, fault };
  }).pipe(Effect.provide(FetchHttpClient.layer)));
  assert.equal(result.success.status, "shipped");
  assert.ok(Either.isLeft(result.fault));
  if (Either.isLeft(result.fault) && result.fault.left._tag === "SoapFault") {
    assert.equal(result.fault.left.detail._tag, "OrderNotFound");
    if (result.fault.left.detail._tag === "OrderNotFound") assert.equal(result.fault.left.detail.value.orderId, "missing");
  } else throw new Error("Expected declared fault");
  const viaLayer = await Effect.runPromise(Effect.gen(function* () { const client = yield* OrdersClient.Tag; return yield* client.getOrder({ orderId: "123" }); }).pipe(Effect.provide(OrdersClient.layer(config)), Effect.provide(FetchHttpClient.layer)));
  assert.equal(viaLayer.total, "1.00");
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("consumer passed");
`,
    );
    await exec(
      process.execPath,
      [
        join(temp, "node_modules/typescript/bin/tsc"),
        "--strict",
        "--noUncheckedIndexedAccess",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--outDir",
        "compiled",
        "consumer.ts",
      ],
      { cwd: temp },
    );
    expect(
      (await exec(process.execPath, ["compiled/consumer.js"], { cwd: temp })).stdout,
    ).toContain("consumer passed");
    const runtime = await readFile(
      join(temp, "node_modules/effect-wsdl/dist/runtime/index.js"),
      "utf8",
    );
    expect(runtime).not.toMatch(/node:fs|loader|generate\.js/);
    await expect(run("inspect", "missing.wsdl")).rejects.toMatchObject({ code: 1 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 180000);
