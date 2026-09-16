import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { jsonReflection } from "../src/http-api/json.js";
import type { Element, Primitive, Type } from "../src/model/index.js";

const element: Element = {
  namespace: "urn:values",
  local: "Value",
  type: "value",
  min: 1,
  max: 1,
  nillable: false,
};
it.each<[Primitive, unknown, unknown]>([
  ["integer", "123456789012345678901234567890", 123456789012345678901234567890n],
  ["long", "-9223372036854775808", -9223372036854775808n],
  ["unsignedLong", "18446744073709551615", 18446744073709551615n],
  ["decimal", "123456789012345678901.0010", "123456789012345678901.0010"],
  ["base64Binary", "AP8=", new Uint8Array([0, 255])],
  ["double", "NaN", NaN],
  ["double", "INF", Infinity],
  ["float", "-INF", -Infinity],
  ["date", "2024-02-29+14:00", "2024-02-29+14:00"],
  ["time", "12:00:00.123", "12:00:00.123"],
  ["boolean", true, true],
  ["int", 2147483647, 2147483647],
])("preserves %s in the JSON/native boundary", (primitive, json, native) => {
  const reflection = jsonReflection({ value: { kind: "primitive", primitive } });
  expect(reflection.fromJson(element, json)).toEqual(native);
  expect(reflection.toJson(element, native)).toEqual(json);
  const spec = OpenApi.fromApi(
    HttpApi.make("test").add(
      HttpApiGroup.make("values").add(
        HttpApiEndpoint.post("value", "/value").setPayload(reflection.schema(element)),
      ),
    ),
  );
  expect(spec.paths["/value"]?.post?.requestBody).toBeDefined();
});
it.each<[Primitive, unknown]>([
  ["integer", 9007199254740992],
  ["integer", "+01"],
  ["unsignedLong", "18446744073709551616"],
  ["base64Binary", "AB=="],
  ["double", "Infinity"],
  ["double", Infinity],
  ["int", 2147483648],
  ["date", "2023-02-29"],
  ["decimal", 0.1],
])("rejects invalid JSON %s %s", (primitive, value) => {
  const reflection = jsonReflection({ value: { kind: "primitive", primitive } });
  expect(() => reflection.fromJson(element, value)).toThrow();
});
it("reflects recursive structures, nil, arrays, attributes and strict properties", () => {
  const types: Record<string, Type> = {
    text: { kind: "primitive", primitive: "string" },
    value: {
      kind: "complex",
      elements: [
        { ...element, local: "next", min: 0, nillable: true },
        { ...element, type: "text", local: "items", min: 0, max: 2, nillable: true },
      ],
      attributes: [{ namespace: "", local: "id", type: "text", required: true }],
    },
  };
  const reflection = jsonReflection(types);
  const value = {
    next: { next: null, items: [], $attributes: { id: "2" } },
    items: [null, ""],
    $attributes: { id: "1" },
  };
  expect(reflection.toJson(element, reflection.fromJson(element, value))).toEqual(value);
  for (const invalid of [
    { ...value, surprise: true },
    { ...value, items: [null, "", "3"] },
    { items: [] },
    { ...value, $attributes: { id: "1", surprise: true } },
  ])
    expect(() => reflection.fromJson(element, invalid)).toThrow();
  expect(Schema.is(reflection.schema(element))({ ...value, surprise: true })).toBe(false);
  const api = HttpApi.make("recursive").add(
    HttpApiGroup.make("values").add(
      HttpApiEndpoint.post("value", "/value").setPayload(reflection.schema(element)),
    ),
  );
  const spec = JSON.stringify(OpenApi.fromApi(api));
  expect(spec).toContain('"$ref"');
  expect(spec).toContain('"maxItems":2');
  expect(spec).toContain('"additionalProperties":false');
});
it("preserves decimal enumeration equivalence while reflecting string enums", () => {
  const decimal = jsonReflection({
    value: { kind: "primitive", primitive: "decimal", enumeration: ["1.0"] },
  });
  expect(decimal.fromJson(element, "1.00")).toBe("1.00");
  expect(() => decimal.fromJson(element, "2.0")).toThrow();
  const text = jsonReflection({
    value: { kind: "primitive", primitive: "string", enumeration: ["a", "b"] },
  });
  expect(() => text.fromJson(element, "c")).toThrow();
});
it("rejects prototype-setting property names in reflected struct fields", () => {
  const reflection = jsonReflection({
    text: { kind: "primitive", primitive: "string" },
    value: {
      kind: "complex",
      elements: [{ ...element, local: "__proto__", type: "text" }],
      attributes: [],
    },
  });
  expect(() =>
    Schema.decodeUnknownSync(reflection.schema(element))(JSON.parse('{"__proto__":"value"}')),
  ).toThrow("__proto__");
});
