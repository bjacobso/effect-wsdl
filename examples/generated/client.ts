import { Context, Effect, Layer } from "effect";
import { HttpClient } from "@effect/platform";
import { invoke, type ClientConfig } from "effect-wsdl/runtime";
import { types, operations } from "./metadata.js";
import * as S from "./schemas.js";

const make = (config: ClientConfig = {}) => Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  return {
    "getOrder": (input: S.Operation1Input) => invoke(http, operations[0]!, types, "http://localhost:8080/soap/orders", config, input, S.Operation1Output, S.Operation1Fault),
  };
});
export type OrdersClient = Effect.Effect.Success<ReturnType<typeof make>>;
const Tag = Context.GenericTag<OrdersClient>("effect-wsdl/{urn:orders}Orders/OrdersSoap");
export const OrdersClient = { make, Tag, layer: (config: ClientConfig = {}) => Layer.effect(Tag, make(config)) };
