import { Schema } from "effect";
import { type Element, expanded, type Primitive, type Type } from "../model/index.js";
import { attr, escapeXml, qname, type XmlNode, XSI } from "../xml.js";

export type Types = Readonly<Record<string, Type>>;
export const integerRanges: Readonly<Record<string, readonly [bigint, bigint]>> = {
  byte: [-128n, 127n],
  short: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  unsignedByte: [0n, 255n],
  unsignedShort: [0n, 65535n],
  unsignedInt: [0n, 4294967295n],
  long: [-9223372036854775808n, 9223372036854775807n],
  unsignedLong: [0n, 18446744073709551615n],
};
const fail = (message: string): never => {
  throw new Error(message);
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("Expected an object");
const known = (value: Record<string, unknown>, names: readonly string[]) => {
  if (Object.keys(value).some((k) => !names.includes(k))) fail("Unexpected property");
};
const typeAt = (types: Types, id: string): Type => types[id] ?? fail(`Unknown type ${id}`);
const decimalKey = (text: string): string => {
  const negative = text.startsWith("-");
  const [a = "", b = ""] = text.replace(/^[+-]/, "").split(".");
  const whole = a.replace(/^0+/, "") || "0";
  const fraction = b.replace(/0+$/, "");
  return `${negative && (whole !== "0" || fraction) ? "-" : ""}${whole}.${fraction}`;
};

function temporal(value: string, kind: "date" | "dateTime" | "time"): void {
  const date = "(-?(?:[0-9]{4}|[1-9][0-9]{4,}))-(\\d{2})-(\\d{2})";
  const time = "(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?";
  const zone = "(Z|[+-]\\d{2}:\\d{2})?";
  const match = new RegExp(
    `^${kind === "time" ? time : date + (kind === "dateTime" ? `T${time}` : "")}${zone}$`,
  ).exec(value);
  if (!match) fail(`Invalid ${kind}`);
  if (kind !== "time") {
    const year = BigInt(match![1]!);
    const month = Number(match![2]);
    const day = Number(match![3]);
    const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year === 0n || month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
      fail(`Invalid ${kind} calendar date`);
  }
  if (kind !== "date") {
    const offset = kind === "time" ? 1 : 4;
    const hour = Number(match![offset]),
      minute = Number(match![offset + 1]),
      second = Number(match![offset + 2]),
      fraction = match![offset + 3];
    if (
      hour > 24 ||
      minute > 59 ||
      second > 59 ||
      (hour === 24 && (minute !== 0 || second !== 0 || (fraction && /[1-9]/.test(fraction))))
    )
      fail(`Invalid ${kind} clock time`);
  }
  const tz = match!.at(-1);
  if (tz && tz !== "Z") {
    const h = Number(tz.slice(1, 3)),
      m = Number(tz.slice(4));
    if (h > 14 || m > 59 || (h === 14 && m !== 0)) fail("Invalid timezone");
  }
}

export function parsePrimitive(primitive: Primitive, value: string): unknown {
  if (primitive === "string") {
    escapeXml(value);
    return value;
  }
  const text = value.replace(/[\t\n\r ]+/g, " ").trim();
  if (primitive === "boolean") {
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
    return fail("Invalid boolean");
  }
  if (primitive === "decimal") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) fail("Invalid decimal");
    return text;
  }
  if (primitive === "date" || primitive === "dateTime" || primitive === "time") {
    temporal(text, primitive);
    return text;
  }
  if (primitive === "float" || primitive === "double") {
    if (text === "INF") return Infinity;
    if (text === "-INF") return -Infinity;
    if (text === "NaN") return NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
      fail("Invalid floating point value");
    return primitive === "float" ? Math.fround(Number(text)) : Number(text);
  }
  if (primitive === "base64Binary") {
    const compact = text.replaceAll(" ", "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
      fail("Invalid base64");
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (base64(bytes) !== compact) fail("Noncanonical base64 padding bits");
    return bytes;
  }
  if (!/^[+-]?\d+$/.test(text)) fail("Invalid integer");
  const number = BigInt(text);
  const bounds = integerRanges[primitive];
  if (bounds && (number < bounds[0] || number > bounds[1])) fail("Integer out of range");
  return ["integer", "long", "unsignedLong"].includes(primitive) ? number : Number(number);
}
function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function enumeration(type: Extract<Type, { kind: "primitive" }>, value: unknown): void {
  if (!type.enumeration) return;
  if (
    !type.enumeration.some((v) => {
      const candidate = parsePrimitive(type.primitive, v);
      return type.primitive === "decimal"
        ? decimalKey(String(candidate)) === decimalKey(String(value))
        : Object.is(candidate, value) || candidate === value;
    })
  )
    fail("Value is outside enumeration");
}
export function formatPrimitive(
  type: Extract<Type, { kind: "primitive" }>,
  value: unknown,
): string {
  const p = type.primitive;
  let text: string;
  if (["string", "decimal", "date", "dateTime", "time"].includes(p)) {
    if (typeof value !== "string") return fail("Expected string");
    text = value;
  } else if (p === "boolean") {
    if (typeof value !== "boolean") return fail("Expected boolean");
    text = String(value);
  } else if (p === "base64Binary") {
    if (!(value instanceof Uint8Array)) return fail("Expected Uint8Array");
    text = base64(value);
  } else if (["integer", "long", "unsignedLong"].includes(p)) {
    if (typeof value !== "bigint") return fail("Expected bigint");
    text = String(value);
  } else {
    if (typeof value !== "number") return fail("Expected number");
    text = Number.isNaN(value)
      ? "NaN"
      : value === Infinity
        ? "INF"
        : value === -Infinity
          ? "-INF"
          : String(value);
  }
  const parsed = parsePrimitive(p, text);
  enumeration(type, parsed);
  return text;
}
const matches = (
  a: { namespace: string; local: string },
  b: { namespace: string; local: string },
) => a.namespace === b.namespace && a.local === b.local;
const repeated = (element: Element) => element.max === "unbounded" || element.max > 1;
const checkCount = (e: Element, n: number) => {
  if (n < e.min || (e.max !== "unbounded" && n > e.max))
    fail(`Invalid occurrence count for ${e.local}`);
};
const xmlAttribute = (value: string) =>
  escapeXml(value).replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");

export function encodeElement(element: Element, value: unknown, types: Types, depth = 0): string {
  if (depth > 128) fail("Value nesting limit exceeded");
  const tag = `v:${element.local}`;
  // Namespace-less elements must not inherit the parent's default namespace.
  const name = element.namespace ? tag : element.local;
  let start = `<${name}${element.namespace ? ` xmlns:v="${xmlAttribute(element.namespace)}"` : ' xmlns=""'}`;
  if (value === null) {
    if (!element.nillable) fail(`Non-nillable ${element.local}`);
    return `${start} xmlns:xsi="${XSI}" xsi:nil="true"/>`;
  }
  const type = typeAt(types, element.type);
  if (type.kind === "primitive")
    return `${start}>${escapeXml(formatPrimitive(type, value))}</${name}>`;
  const record = object(value);
  known(record, [
    ...type.elements.map((e) => e.local),
    ...(type.attributes.length ? ["$attributes"] : []),
  ]);
  const attrs = record.$attributes === undefined ? {} : object(record.$attributes);
  known(
    attrs,
    type.attributes.map((a) => a.local),
  );
  for (const [i, a] of type.attributes.entries()) {
    const v = Object.hasOwn(attrs, a.local) ? attrs[a.local] : undefined;
    if (v === undefined) {
      if (a.required) fail(`Missing attribute ${a.local}`);
      continue;
    }
    const t = typeAt(types, a.type);
    if (t.kind !== "primitive") fail("Non-primitive attribute");
    const lexical = xmlAttribute(formatPrimitive(t as Extract<Type, { kind: "primitive" }>, v));
    start += a.namespace
      ? ` xmlns:a${i}="${xmlAttribute(a.namespace)}" a${i}:${a.local}="${lexical}"`
      : ` ${a.local}="${lexical}"`;
  }
  let content = "";
  for (const e of type.elements) {
    const v = Object.hasOwn(record, e.local) ? record[e.local] : undefined;
    const values = repeated(e)
      ? Array.isArray(v)
        ? v
        : fail(`Expected array ${e.local}`)
      : v === undefined
        ? []
        : [v];
    checkCount(e, values.length);
    for (const item of values) content += encodeElement(e, item, types, depth + 1);
  }
  return `${start}>${content}</${name}>`;
}

export function decodeElement(element: Element, node: XmlNode, types: Types, depth = 0): unknown {
  if (depth > 128) fail("Value nesting limit exceeded");
  if (!matches(element, node)) fail(`Expected ${expanded(element)}`);
  const type = typeAt(types, element.type);
  const dynamic = attr(node, "type", XSI);
  if (dynamic && expanded(qname(node, dynamic)) !== element.type) fail("Unsupported xsi:type");
  const attributes = node.attributes.filter(
    (a) => !(a.namespace === XSI && ["nil", "type"].includes(a.local)),
  );
  const expected = type.kind === "complex" ? type.attributes : [];
  if (attributes.some((a) => !expected.some((e) => matches(a, e))))
    fail("Unexpected XML attribute");
  const nil = attr(node, "nil", XSI);
  if (nil !== undefined && !["true", "false", "1", "0"].includes(nil)) fail("Invalid xsi:nil");
  if (nil === "true" || nil === "1") {
    if (!element.nillable || node.children.length || node.text.length || attributes.length)
      fail("Invalid nil element");
    return null;
  }
  if (type.kind === "primitive") {
    if (node.children.length) fail("Unexpected element in primitive value");
    const value = parsePrimitive(type.primitive, node.text);
    enumeration(type, value);
    return value;
  }
  if (node.text.trim()) fail("Unexpected mixed content");
  const value: Record<string, unknown> = Object.create(null);
  if (type.attributes.length) {
    const attrs: Record<string, unknown> = Object.create(null);
    for (const a of type.attributes) {
      const text = attributes.find((n) => matches(a, n))?.value;
      if (text === undefined) {
        if (a.required) fail(`Missing attribute ${a.local}`);
        continue;
      }
      const t = typeAt(types, a.type);
      if (t.kind !== "primitive") fail("Non-primitive attribute");
      const scalar = t as Extract<Type, { kind: "primitive" }>;
      attrs[a.local] = parsePrimitive(scalar.primitive, text);
      enumeration(scalar, attrs[a.local]);
    }
    value.$attributes = attrs;
  }
  let cursor = 0;
  for (const e of type.elements) {
    const values: unknown[] = [];
    while (node.children[cursor] && matches(e, node.children[cursor]!))
      values.push(decodeElement(e, node.children[cursor++]!, types, depth + 1));
    checkCount(e, values.length);
    if (repeated(e)) value[e.local] = values;
    else if (values.length) value[e.local] = values[0];
  }
  if (cursor !== node.children.length) fail("Unexpected element or sequence order");
  return value;
}

/** Schema backed by the same validation rules as the XML codec, including recursive types. */
export function schemaFor<A>(element: Element, types: Types): Schema.Schema<A> {
  return Schema.declare(
    (value: unknown): value is A => {
      try {
        encodeElement(element, value, types);
        return true;
      } catch {
        return false;
      }
    },
    { identifier: expanded(element) },
  );
}
