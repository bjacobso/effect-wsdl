import fc from "fast-check";
import { expect, it } from "vitest";
import type { Element } from "../src/model/index.js";
import { decodeElement, encodeElement } from "../src/runtime/codec.js";
import { parseXml } from "../src/xml.js";

const e: Element = {
  namespace: "urn:roundtrip",
  local: "value",
  type: "value",
  min: 1,
  max: 1,
  nillable: false,
};
it("round-trips arbitrary XML-safe strings, bytes, and 64-bit integers", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      expect(
        decodeElement(
          e,
          parseXml(encodeElement(e, value, { value: { kind: "primitive", primitive: "string" } })),
          { value: { kind: "primitive", primitive: "string" } },
        ),
      ).toBe(value);
    }),
    { numRuns: 200 },
  );
  fc.assert(
    fc.property(fc.uint8Array(), (value) => {
      expect(
        decodeElement(
          e,
          parseXml(
            encodeElement(e, value, { value: { kind: "primitive", primitive: "base64Binary" } }),
          ),
          { value: { kind: "primitive", primitive: "base64Binary" } },
        ),
      ).toEqual(value);
    }),
    { numRuns: 100 },
  );
  fc.assert(
    fc.property(fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }), (value) => {
      expect(
        decodeElement(
          e,
          parseXml(encodeElement(e, value, { value: { kind: "primitive", primitive: "long" } })),
          { value: { kind: "primitive", primitive: "long" } },
        ),
      ).toBe(value);
    }),
    { numRuns: 100 },
  );
});
