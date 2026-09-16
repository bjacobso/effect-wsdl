import { HttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import type { Contract, Operation, Port } from "../model/index.js";
import { type Selection, selectPort } from "../selection.js";
import { parsePrimitive, schemaFor } from "./codec.js";
import { ClientConstructionError, type OperationError, UnknownOperationError } from "./errors.js";
import { type ClientConfig, invoke, validateClientConfig } from "./invoke.js";

export interface RuntimeFault {
  readonly _tag: string;
  readonly value: unknown;
}
export interface RuntimeClientOptions extends Selection, ClientConfig {}
export interface RuntimeOperation {
  readonly definition: Operation;
  readonly inputSchema: Schema.Schema<unknown>;
  readonly outputSchema: Schema.Schema<unknown>;
  readonly faultSchema: Schema.Schema<RuntimeFault>;
}
export interface RuntimeClient {
  readonly service: string;
  readonly port: string;
  readonly operations: ReadonlyMap<string, RuntimeOperation>;
  /** Names are the original WSDL operation names, e.g. GetOrder. */
  readonly call: (
    operation: string,
    input: unknown,
  ) => Effect.Effect<unknown, OperationError<RuntimeFault> | UnknownOperationError>;
}

export function reflectOperations(
  contract: Contract,
  options: Selection,
): { port: Port; operations: Map<string, RuntimeOperation> } {
  const port = selectPort(contract, options);
  const visited = new Set<string>();
  const validate = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const type = contract.types[id];
    if (!type) throw new Error(`Missing type ${id}`);
    if (type.kind === "primitive")
      for (const value of type.enumeration ?? []) parsePrimitive(type.primitive, value);
    else {
      for (const e of type.elements) validate(e.type);
      for (const a of type.attributes) validate(a.type);
    }
  };
  const operations = new Map<string, RuntimeOperation>();
  for (const definition of port.operations) {
    if (operations.has(definition.name)) throw new Error(`Duplicate operation ${definition.name}`);
    validate(definition.input.type);
    validate(definition.output.type);
    for (const f of definition.faults) validate(f.element.type);
    const faults = definition.faults.map((f) =>
      Schema.Struct({
        _tag: Schema.Literal(f.name),
        value: schemaFor<unknown>(f.element, contract.types),
      }),
    );
    operations.set(definition.name, {
      definition,
      inputSchema: schemaFor<unknown>(definition.input, contract.types),
      outputSchema: schemaFor<unknown>(definition.output, contract.types),
      faultSchema: Schema.Union(...faults),
    });
  }
  if (!operations.size) throw new Error("Selected port has no operations");
  return { port, operations };
}

/** Builds an interpreted client. No files, generated source evaluation, or network requests. */
export function makeClient(
  contract: Contract,
  options: RuntimeClientOptions = {},
): Effect.Effect<RuntimeClient, ClientConstructionError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const reflected = yield* Effect.try({
      try: () => {
        const reflected = reflectOperations(contract, options);
        validateClientConfig(reflected.port.endpoint, options);
        return reflected;
      },
      catch: (e) =>
        new ClientConstructionError({
          message: e instanceof Error ? e.message : "Cannot reflect contract",
        }),
    });
    const http = yield* HttpClient.HttpClient;
    const config: ClientConfig = {
      ...options,
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    };
    const call: RuntimeClient["call"] = (name, input) => {
      const operation = reflected.operations.get(name);
      if (!operation) return Effect.fail(new UnknownOperationError({ operation: name }));
      return invoke(
        http,
        operation.definition,
        contract.types,
        reflected.port.endpoint,
        config,
        input,
        operation.outputSchema,
        operation.faultSchema,
      );
    };
    return {
      service: reflected.port.service,
      port: reflected.port.name,
      operations: new Map(reflected.operations),
      call,
    };
  });
}
