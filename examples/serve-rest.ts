import { createServer } from "node:http";
import { FetchHttpClient, HttpApiBuilder, HttpApiSwagger } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { load, nodeLoader, sourceRoot } from "effect-wsdl";
import { makeHttpApi } from "effect-wsdl/http-api";

const source = process.argv[2];
const port = Number(process.argv[3] ?? "3000");
if (!source || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: pnpm rest <local.wsdl> [port=3000]");
  process.exitCode = 2;
} else {
  const program = Effect.gen(function* () {
    const contract = yield* load(source).pipe(Effect.provide(nodeLoader([sourceRoot(source)])));
    const bridge = yield* makeHttpApi(contract);
    for (const route of bridge.routes) yield* Effect.log(`${route.method} http://127.0.0.1:${port}${route.path}`);
    yield* Effect.log(`Swagger UI: http://127.0.0.1:${port}/docs`);
    const api = Layer.mergeAll(HttpApiBuilder.serve(), HttpApiSwagger.layer()).pipe(
      Layer.provide(bridge.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
    );
    yield* Layer.launch(api);
  });
  NodeRuntime.runMain(program);
}
