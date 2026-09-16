import { Effect } from "effect";
import { GenerationError } from "./errors.js";
import type { Contract, Element, Generated, Type } from "./model/index.js";
import { parsePrimitive } from "./runtime/codec.js";
import { selectPort } from "./selection.js";
export const version = "0.1.0-alpha.0";
export interface GenerateOptions {
  readonly service?: string;
  readonly port?: string;
}
const json = (value: unknown): string =>
  JSON.stringify(value, null, 2).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const identifier = (name: string): string => {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
};
const reserved = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
  "constructor",
  "__proto__",
  "then",
]);
function names() {
  const used = new Set(reserved);
  return (value: string) => {
    const base = identifier(value);
    let name = base,
      suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    return name;
  };
}

export function generate(
  contract: Contract,
  options: GenerateOptions = {},
): Effect.Effect<Generated, GenerationError> {
  return Effect.try({
    try: () => {
      const port = selectPort(contract, options);
      const reachable = new Set<string>();
      const visit = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        const t = contract.types[id];
        if (!t) throw new Error(`Missing type ${id}`);
        if (t.kind === "primitive")
          for (const value of t.enumeration ?? []) parsePrimitive(t.primitive, value);
        if (t.kind === "complex") {
          for (const e of t.elements) visit(e.type);
          for (const a of t.attributes) visit(a.type);
        }
      };
      for (const op of port.operations) {
        visit(op.input.type);
        visit(op.output.type);
        for (const f of op.faults) visit(f.element.type);
      }
      const types = Object.fromEntries(
        [...reachable].sort().map((id) => [id, contract.types[id]!]),
      );
      const allocate = names();
      const typeNames = new Map(Object.keys(types).map((id, i) => [id, `Value${i + 1}`]));
      const elementType = (e: Element): string =>
        `${typeNames.get(e.type)}${e.nillable ? " | null" : ""}`;
      const literal = (v: unknown): string =>
        typeof v === "bigint"
          ? `${v}n`
          : typeof v === "number" && !Number.isFinite(v)
            ? "number"
            : json(v);
      const typeExpression = (t: Type): string => {
        if (t.kind === "primitive") {
          if (t.enumeration && t.primitive !== "decimal")
            return [
              ...new Set(t.enumeration.map((v) => literal(parsePrimitive(t.primitive, v)))),
            ].join(" | ");
          if (t.primitive === "boolean") return "boolean";
          if (["integer", "long", "unsignedLong"].includes(t.primitive)) return "bigint";
          if (t.primitive === "base64Binary") return "Uint8Array";
          return ["string", "decimal", "date", "dateTime", "time"].includes(t.primitive)
            ? "string"
            : "number";
        }
        const fields = t.elements.map((e) => {
          const repeated = e.max === "unbounded" || e.max > 1;
          return `readonly ${json(e.local)}${e.min === 0 && !repeated ? "?" : ""}: ${repeated ? `ReadonlyArray<${elementType(e)}>` : elementType(e)};`;
        });
        if (t.attributes.length)
          fields.push(
            `readonly $attributes${t.attributes.some((a) => a.required) ? "" : "?"}: { ${t.attributes.map((a) => `readonly ${json(a.local)}${a.required ? "" : "?"}: ${typeNames.get(a.type)};`).join(" ")} };`,
          );
        return `{ ${fields.join(" ")} }`;
      };
      const operations = port.operations.map((op) => ({
        op,
        method: allocate(op.name.charAt(0).toLowerCase() + op.name.slice(1)),
        prefix: `Operation${port.operations.indexOf(op) + 1}`,
      }));
      const serviceLocal = port.service.slice(port.service.indexOf("}") + 1);
      const clientName = `${identifier(serviceLocal)}Client`;
      let schemas = `import { Schema } from "effect";\nimport { schemaFor } from "effect-wsdl/runtime";\nimport { types, operations } from "./metadata.js";\n\n`;
      for (const [id, t] of Object.entries(types))
        schemas += `export type ${typeNames.get(id)} = ${typeExpression(t)};\n`;
      for (const [i, { op, prefix }] of operations.entries()) {
        schemas += `\nexport type ${prefix}Input = ${elementType(op.input)};\nexport type ${prefix}Output = ${elementType(op.output)};\n`;
        schemas += `export const ${prefix}Input = schemaFor<${prefix}Input>(operations[${i}]!.input, types);\nexport const ${prefix}Output = schemaFor<${prefix}Output>(operations[${i}]!.output, types);\n`;
        const faultTypes = op.faults.map((f, j) => {
          schemas += `export type ${prefix}Fault${j + 1} = ${elementType(f.element)};\nexport const ${prefix}Fault${j + 1} = schemaFor<${prefix}Fault${j + 1}>(operations[${i}]!.faults[${j}]!.element, types);\n`;
          return `Schema.Struct({ _tag: Schema.Literal(${json(f.name)}), value: ${prefix}Fault${j + 1} })`;
        });
        schemas += `export const ${prefix}Fault = ${faultTypes.length ? `Schema.Union(${faultTypes.join(", ")})` : "Schema.Never"};\nexport type ${prefix}Fault = typeof ${prefix}Fault.Type;\n`;
      }
      const metadata = `import type { Operation, Type } from "effect-wsdl/model";\nexport const types: Readonly<Record<string, Type>> = ${json(types)};\nexport const operations: readonly Operation[] = ${json(port.operations)};\nexport const names: Readonly<Record<string, string>> = Object.fromEntries(${json(operations.map((o) => [o.op.name, o.method]))});\n`;
      let client = `import { Context, Effect, Layer } from "effect";\nimport { HttpClient } from "@effect/platform";\nimport { invoke, type ClientConfig } from "effect-wsdl/runtime";\nimport { types, operations } from "./metadata.js";\nimport * as S from "./schemas.js";\n\nconst make = (config: ClientConfig = {}) => Effect.gen(function* () {\n  const http = yield* HttpClient.HttpClient;\n  return {\n`;
      for (const [i, { method, prefix }] of operations.entries())
        client += `    ${json(method)}: (input: S.${prefix}Input) => invoke(http, operations[${i}]!, types, ${json(port.endpoint)}, config, input, S.${prefix}Output, S.${prefix}Fault),\n`;
      client += `  };\n});\nexport type ${clientName} = Effect.Effect.Success<ReturnType<typeof make>>;\nconst Tag = Context.GenericTag<${clientName}>(${json(`effect-wsdl/${port.service}/${port.name}`)});\nexport const ${clientName} = { make, Tag, layer: (config: ClientConfig = {}) => Layer.effect(Tag, make(config)) };\n`;
      const files: Record<string, string> = {
        "schemas.ts": schemas,
        "metadata.ts": metadata,
        "client.ts": client,
        "index.ts":
          'export * from "./schemas.js";\nexport * from "./client.js";\nexport { names } from "./metadata.js";\n',
      };
      files["effect-wsdl.manifest.json"] =
        `${json({ format: 1, generator: version, service: port.service, port: port.name, sources: contract.sources, owned: [...Object.keys(files), "effect-wsdl.manifest.json"].sort() })}\n`;
      return { files };
    },
    catch: (e) =>
      new GenerationError({ message: e instanceof Error ? e.message : "Generation failed" }),
  });
}
