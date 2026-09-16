import { Schema } from "effect";
import { schemaFor } from "effect-wsdl/runtime";
import { types, operations } from "./metadata.js";

export type Value1 = string;
export type Value2 = string;
export type Value3 = { readonly "orderId": Value2; };
export type Value4 = { readonly "orderId": Value2; readonly "status": Value6; readonly "total": Value1; };
export type Value5 = { readonly "orderId": Value2; };
export type Value6 = "pending" | "shipped";

export type Operation1Input = Value3;
export type Operation1Output = Value4;
export const Operation1Input = schemaFor<Operation1Input>(operations[0]!.input, types);
export const Operation1Output = schemaFor<Operation1Output>(operations[0]!.output, types);
export type Operation1Fault1 = Value5;
export const Operation1Fault1 = schemaFor<Operation1Fault1>(operations[0]!.faults[0]!.element, types);
export const Operation1Fault = Schema.Union(Schema.Struct({ _tag: Schema.Literal("OrderNotFound"), value: Operation1Fault1 }));
export type Operation1Fault = typeof Operation1Fault.Type;
