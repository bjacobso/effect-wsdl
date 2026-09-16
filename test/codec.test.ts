import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Element, Primitive, Type } from "../src/model/index.js";
import { decodeElement, encodeElement, parsePrimitive, schemaFor } from "../src/runtime/codec.js";
import { parseXml } from "../src/xml.js";

const scalar = (primitive: Primitive) => ({ value: { kind: "primitive", primitive } }) as const;
const element: Element = {
  namespace: "urn:test",
  local: "value",
  type: "value",
  min: 1,
  max: 1,
  nillable: false,
};
describe("scalar values", () => {
  it.each<[Primitive, string, unknown]>([
    ["string", "a & b", "a & b"],
    ["boolean", "1", true],
    ["boolean", "false", false],
    ["byte", "-128", -128],
    ["short", "32767", 32767],
    ["int", "-2147483648", -2147483648],
    ["unsignedByte", "255", 255],
    ["unsignedShort", "65535", 65535],
    ["unsignedInt", "4294967295", 4294967295],
    ["integer", "123456789012345678901234567890", 123456789012345678901234567890n],
    ["long", "-9223372036854775808", -9223372036854775808n],
    ["unsignedLong", "18446744073709551615", 18446744073709551615n],
    ["decimal", "12345678901234567890.0010", "12345678901234567890.0010"],
    ["float", "INF", Infinity],
    ["double", "-INF", -Infinity],
    ["double", "NaN", NaN],
    ["date", "2024-02-29+14:00", "2024-02-29+14:00"],
    ["dateTime", "2026-09-16T24:00:00Z", "2026-09-16T24:00:00Z"],
    ["time", "12:30:59.123", "12:30:59.123"],
    ["base64Binary", "AP8=", new Uint8Array([0, 255])],
  ])("decodes and round-trips %s %s", (primitive, text, value) => {
    expect(parsePrimitive(primitive, text)).toEqual(value);
    expect(
      decodeElement(
        element,
        parseXml(encodeElement(element, value, scalar(primitive))),
        scalar(primitive),
      ),
    ).toEqual(value);
  });
  it.each<[Primitive, string]>([
    ["byte", "128"],
    ["short", "-32769"],
    ["unsignedInt", "4294967296"],
    ["integer", "1.1"],
    ["long", "9223372036854775808"],
    ["boolean", "True"],
    ["decimal", "1e3"],
    ["float", "Infinity"],
    ["date", "2023-02-29"],
    ["date", "0000-01-01"],
    ["dateTime", "2026-09-16T24:01:00"],
    ["time", "12:00:00+14:01"],
    ["base64Binary", "AB=="],
  ])("rejects invalid %s %s", (p, text) => expect(() => parsePrimitive(p, text)).toThrow());
  it("rejects invalid runtime types, XML control characters, and out-of-enumeration values", () => {
    expect(() => encodeElement(element, "\u0001", scalar("string"))).toThrow();
    expect(() => encodeElement(element, 1, scalar("integer"))).toThrow();
    const types = {
      value: { kind: "primitive", primitive: "decimal", enumeration: ["1.0"] },
    } as const;
    expect(() => encodeElement(element, "1.00", types)).not.toThrow();
    expect(() => encodeElement(element, "2", types)).toThrow("enumeration");
    expect(Schema.is(schemaFor<string>(element, scalar("string")))(123)).toBe(false);
  });
});
describe("structured XML", () => {
  const root: Element = { ...element, type: "root" };
  const types: Record<string, Type> = {
    ...scalar("string"),
    root: {
      kind: "complex",
      elements: [
        { ...element, namespace: "", local: "optional", min: 0, nillable: true },
        { ...element, local: "items", min: 0, max: "unbounded" },
      ],
      attributes: [{ namespace: "urn:attrs", local: "id", type: "value", required: true }],
    },
  };
  it("distinguishes absence, nil, empty text, arrays and namespaced attributes", () => {
    for (const optional of [undefined, null, ""]) {
      const value = {
        ...(optional !== undefined ? { optional } : {}),
        items: ["<escaped>", "b"],
        $attributes: { id: "a\tb\nc\r" },
      };
      expect(decodeElement(root, parseXml(encodeElement(root, value, types)), types)).toEqual(
        value,
      );
    }
    expect(
      decodeElement(
        root,
        parseXml('<p:value xmlns:p="urn:test" xmlns:a="urn:attrs" a:id="x"/>'),
        types,
      ),
    ).toEqual({ items: [], $attributes: { id: "x" } });
  });
  it("rejects wrong order, unknown members, wrong nil, and missing required attributes", () => {
    for (const text of [
      "<p:items>a</p:items><optional/>",
      "<unknown/>",
      '<optional xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true">x</optional>',
    ])
      expect(() =>
        decodeElement(
          root,
          parseXml(`<p:value xmlns:p="urn:test" xmlns:a="urn:attrs" a:id="x">${text}</p:value>`),
          types,
        ),
      ).toThrow();
    expect(() => decodeElement(root, parseXml('<value xmlns="urn:test"/>'), types)).toThrow(
      "attribute",
    );
    expect(() =>
      encodeElement(root, { items: [], extra: true, $attributes: { id: "x" } }, types),
    ).toThrow("Unexpected property");
  });
  it("does not treat prototype properties as supplied values", () => {
    expect(() =>
      encodeElement(root, Object.create({ items: [], $attributes: { id: "x" } }), types),
    ).toThrow();
  });
});
