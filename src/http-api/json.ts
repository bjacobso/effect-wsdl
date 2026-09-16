import { Schema } from "effect";
import type { Element, Type } from "../model/index.js";
import {
  encodeElement,
  formatPrimitive,
  integerRanges,
  parsePrimitive,
  type Types,
} from "../runtime/codec.js";

type Scalar = Extract<Type, { kind: "primitive" }>;
// Reflection cannot promise compile-time fields for a contract loaded at runtime.
// Rebuild the same AST with unknown static types, retaining all runtime validators.
const dynamic = <A, I>(schema: Schema.Schema<A, I>): Schema.Schema<unknown> =>
  Schema.make(schema.ast);
const big = new Set(["integer", "long", "unsignedLong"]);
const float = new Set(["float", "double"]);
function fromScalar(type: Scalar, value: unknown): unknown {
  if (big.has(type.primitive) || type.primitive === "base64Binary") {
    if (typeof value !== "string") throw new Error("Expected JSON string");
    return parsePrimitive(type.primitive, value);
  }
  if (float.has(type.primitive) && typeof value === "string") {
    if (!["INF", "-INF", "NaN"].includes(value))
      throw new Error("Invalid special floating point value");
    return parsePrimitive(type.primitive, value);
  }
  return value;
}
function toScalar(type: Scalar, value: unknown): unknown {
  const text = formatPrimitive(type, value);
  return big.has(type.primitive) ||
    type.primitive === "base64Binary" ||
    (float.has(type.primitive) && typeof value === "number" && !Number.isFinite(value))
    ? text
    : value;
}

/** Structural JSON schemas plus explicit conversion to/from SOAP's native JS values. */
export function jsonReflection(types: Types) {
  const cache = new Map<string, Schema.Schema<unknown>>();
  const ids = new Map(
    Object.keys(types)
      .sort()
      .map((id, index) => [id, `WsdlValue${index + 1}`]),
  );
  const get = (id: string) => {
    const t = types[id];
    if (!t) throw new Error(`Missing type ${id}`);
    return t;
  };
  const optional = (schema: Schema.Schema<unknown>) => Schema.optionalWith(schema, { exact: true });
  type Field = Schema.Schema<unknown> | ReturnType<typeof optional>;
  const strictStruct = (fields: Record<string, Field>): Schema.Schema<unknown> =>
    dynamic(Schema.Struct(fields).annotations({ parseOptions: { onExcessProperty: "error" } }));
  const elementSchema = (e: Element): Schema.Schema<unknown> =>
    e.nillable ? Schema.NullOr(typeSchema(e.type)) : typeSchema(e.type);
  const build = (type: Type): Schema.Schema<unknown> => {
    if (type.kind === "complex") {
      if (
        type.elements.some((e) => e.local === "__proto__") ||
        type.attributes.some((a) => a.local === "__proto__")
      )
        throw new Error("HttpApi reflection cannot represent an XML property named __proto__");
      const fields: Record<string, Field> = Object.create(null);
      for (const e of type.elements) {
        let schema = elementSchema(e);
        if (e.max === "unbounded" || e.max > 1) {
          let array: Schema.Schema<readonly unknown[]> = Schema.Array(schema);
          if (e.min > 0) array = array.pipe(Schema.minItems(e.min));
          if (e.max !== "unbounded") array = array.pipe(Schema.maxItems(e.max));
          schema = dynamic(array);
          fields[e.local] = schema;
        } else fields[e.local] = e.min === 0 ? optional(schema) : schema;
      }
      if (type.attributes.length) {
        const attributes: Record<string, Field> = Object.create(null);
        for (const a of type.attributes)
          attributes[a.local] = a.required ? typeSchema(a.type) : optional(typeSchema(a.type));
        const schema = strictStruct(attributes);
        fields.$attributes = type.attributes.some((a) => a.required) ? schema : optional(schema);
      }
      return strictStruct(fields);
    }
    let base: Schema.Schema<unknown>;
    const p = type.primitive;
    if (p === "boolean") base = dynamic(Schema.Boolean);
    else if (big.has(p))
      base = dynamic(
        Schema.String.pipe(Schema.pattern(/^-?(?:0|[1-9]\d*)$/)).annotations({
          description: "Integer encoded as a decimal string to preserve precision",
        }),
      );
    else if (p === "base64Binary")
      base = dynamic(
        Schema.String.pipe(
          Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        ).annotations({ jsonSchema: { type: "string", format: "byte" } }),
      );
    else if (float.has(p))
      base = dynamic(
        Schema.Union(Schema.Number.pipe(Schema.finite()), Schema.Literal("INF", "-INF", "NaN")),
      );
    else if (["string", "decimal", "date", "dateTime", "time"].includes(p)) {
      base = dynamic(
        p === "decimal"
          ? Schema.String.pipe(Schema.pattern(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/))
          : Schema.String,
      );
    } else {
      const bounds = integerRanges[p];
      base = dynamic(
        bounds
          ? Schema.Number.pipe(Schema.int(), Schema.between(Number(bounds[0]), Number(bounds[1])))
          : Schema.Number.pipe(Schema.int()),
      );
    }
    if (type.enumeration && p !== "decimal") {
      const values = type.enumeration.map((v) => toScalar(type, parsePrimitive(p, v)));
      if (
        values.every(
          (v): v is string | number | boolean =>
            typeof v === "string" || typeof v === "number" || typeof v === "boolean",
        )
      )
        base = dynamic(Schema.Literal(...values));
    }
    return base.pipe(
      Schema.filter(
        (value) => {
          try {
            formatPrimitive(type, fromScalar(type, value));
            return true;
          } catch {
            return false;
          }
        },
        { message: () => `Invalid ${p} value`, jsonSchema: {} },
      ),
    );
  };
  function typeSchema(id: string): Schema.Schema<unknown> {
    const existing = cache.get(id);
    if (existing) return existing;
    get(id);
    const schema: Schema.Schema<unknown> = Schema.suspend(() => build(get(id))).annotations({
      identifier: ids.get(id)!,
    });
    cache.set(id, schema);
    return schema;
  }
  const convert = (e: Element, value: unknown, direction: "from" | "to", depth = 0): unknown => {
    if (depth > 128) throw new Error("JSON value nesting limit exceeded");
    if (value === null && e.nillable) return null;
    const type = get(e.type);
    if (type.kind === "primitive")
      return direction === "from" ? fromScalar(type, value) : toScalar(type, value);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected object");
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const child of type.elements) {
      if (!Object.hasOwn(record, child.local)) continue;
      const v = record[child.local];
      if (child.max === "unbounded" || child.max > 1) {
        if (!Array.isArray(v)) throw new Error("Expected array");
        out[child.local] = v.map((item) => convert(child, item, direction, depth + 1));
      } else out[child.local] = convert(child, v, direction, depth + 1);
    }
    if (Object.hasOwn(record, "$attributes")) {
      const attrs = record.$attributes;
      if (attrs === null || typeof attrs !== "object" || Array.isArray(attrs))
        throw new Error("Expected attributes object");
      const converted: Record<string, unknown> = Object.create(null);
      for (const a of type.attributes)
        if (Object.hasOwn(attrs, a.local))
          converted[a.local] = convert(
            { ...a, nillable: false, min: 1, max: 1 },
            (attrs as Record<string, unknown>)[a.local],
            direction,
            depth + 1,
          );
      out.$attributes = converted;
    }
    return out;
  };
  return {
    schema: elementSchema,
    fromJson: (e: Element, value: unknown): unknown => {
      const json = Schema.decodeUnknownSync(elementSchema(e), { onExcessProperty: "error" })(value);
      const native = convert(e, json, "from");
      encodeElement(e, native, types);
      return native;
    },
    toJson: (e: Element, value: unknown): unknown => {
      encodeElement(e, value, types);
      return Schema.decodeUnknownSync(elementSchema(e), { onExcessProperty: "error" })(
        convert(e, value, "to"),
      );
    },
  };
}
