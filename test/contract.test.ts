import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { generate, inspect, load, memoryLoader, nodeLoader } from "../src/index.js";
import { decodeElement, encodeElement } from "../src/runtime/codec.js";
import { parseXml } from "../src/xml.js";

const wsdl = await readFile(new URL("./fixtures/orders.wsdl", import.meta.url), "utf8");
const url = "file:///contracts/orders.wsdl";
const contract = (text = wsdl, extras: Record<string, string> = {}) =>
  Effect.runPromise(load(url).pipe(Effect.provide(memoryLoader({ [url]: text, ...extras }))));

describe("XML and contracts", () => {
  it("maps element references, arrays, nil and local attributes from actual XSD", async () => {
    const enriched = wsdl
      .replace(
        '<xs:element name="orderId" type="xs:string"/>',
        '<xs:element ref="tns:Token" minOccurs="0" maxOccurs="3"/>',
      )
      .replace(
        "</xs:sequence></xs:complexType>",
        '</xs:sequence><xs:attribute name="version" type="xs:int" use="required"/></xs:complexType>',
      )
      .replace(
        '<xs:simpleType name="Status">',
        '<xs:element name="Token" type="xs:string" nillable="true"/><xs:simpleType name="Status">',
      );
    const c = await contract(enriched);
    expect(c.ports[0]?.diagnostics).toEqual([]);
    const element = c.ports[0]!.operations[0]!.input;
    const input = { Token: [null, "", "a"], $attributes: { version: 2 } };
    expect(
      decodeElement(
        element,
        parseXml(
          '<GetOrder xmlns="urn:orders" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" version="2"><Token i:nil="true"/><Token/><Token>a</Token></GetOrder>',
        ),
        c.types,
      ),
    ).toEqual(input);
    expect(() =>
      encodeElement(element, { ...input, Token: ["a", "b", "c", "d"] }, c.types),
    ).toThrow("occurrence");
    const output = await Effect.runPromise(generate(c));
    expect(output.files["schemas.ts"]).toContain("ReadonlyArray<");
    expect(output.files["schemas.ts"]).toContain("$attributes:");
  });
  it("loads cyclic WSDL imports and catalog-located schemas", async () => {
    const imported = wsdl.replace(
      "<wsdl:types>",
      '<wsdl:import namespace="urn:other" location="other.wsdl"/><wsdl:types>',
    );
    const other =
      '<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:other"><w:import namespace="urn:orders" location="orders.wsdl"/></w:definitions>';
    const c = await contract(imported, { "file:///contracts/other.wsdl": other });
    expect(c.sources).toHaveLength(2);
    expect(c.ports[0]?.diagnostics).toEqual([]);
    const catalogWsdl = wsdl.replace(
      '<xs:simpleType name="Status">',
      '<xs:import namespace="urn:extra"/><xs:simpleType name="Status">',
    );
    const result = await Effect.runPromise(
      load(url, { catalog: { "urn:extra": "extra.xsd" } }).pipe(
        Effect.provide(
          memoryLoader({
            [url]: catalogWsdl,
            "file:///contracts/extra.xsd":
              '<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:extra"/>',
          }),
        ),
      ),
    );
    expect(result.sources).toHaveLength(2);
  });
  it("escapes generated strings and rejects malformed XML local names", async () => {
    const c = await contract(
      wsdl.replace(
        'soapAction="urn:orders/GetOrder"',
        'soapAction="urn:orders/&quot;injection&quot;"',
      ),
    );
    const output = await Effect.runPromise(generate(c));
    expect(output.files["metadata.ts"]).toContain('urn:orders/\\"injection\\"');
    const invalid = await contract(wsdl.replace('name="orderId"', 'name="bad&lt;name"'));
    expect(invalid.ports[0]?.diagnostics[0]?.message).toBe("Invalid XML local name");
  });
  it("loads and inspects the complete Orders contract", async () => {
    const c = await contract();
    expect(c.ports[0]?.diagnostics).toEqual([]);
    expect(inspect(c).services[0]?.ports[0]?.operations).toEqual(["GetOrder"]);
    const a = await Effect.runPromise(generate(c));
    expect(a).toEqual(await Effect.runPromise(generate(c)));
    expect(a.files["client.ts"]).toContain("OrdersClient");
    expect(a.files["effect-wsdl.manifest.json"]).not.toContain("file:");
  });
  it.each([
    ['style="document"', 'style="rpc"', "document style"],
    ['use="literal"', 'use="encoded"', "literal"],
    ["<xs:sequence>", "<xs:choice>", "Malformed"],
    ['type="xs:string"', 'type="xs:anyURI"', "datatype"],
    ['<xs:enumeration value="pending"/>', '<xs:pattern value=".*"/>', "pattern"],
    [
      '<soap:body use="literal"/>',
      '<soap:header message="tns:GetOrderInput" part="body" use="literal"/><soap:body use="literal"/>',
      "header",
    ],
    ["<xs:complexType>", '<xs:complexType mixed="true">', "Mixed"],
    [
      'name="orderId" type="xs:string"',
      'name="orderId" type="xs:string" default="secret"',
      "default",
    ],
  ])("rejects unsupported %s → %s", async (from, to, message) => {
    const changed = wsdl.replace(from, to);
    if (message === "Malformed") {
      await expect(contract(changed)).rejects.toThrow("Malformed");
      return;
    }
    const c = await contract(changed);
    expect(c.ports[0]?.diagnostics[0]?.message).toContain(message);
    await expect(Effect.runPromise(generate(c))).rejects.toThrow(message);
  });
  it("resolves imported schemas, includes, chameleon namespaces and cycles", async () => {
    const begin = wsdl.indexOf("    <xs:schema");
    const end = wsdl.indexOf("</xs:schema>") + "</xs:schema>".length;
    const inline = wsdl.slice(begin, end);
    const main =
      wsdl.slice(0, begin) +
      '<xs:schema><xs:import namespace="urn:orders" schemaLocation="types.xsd"/></xs:schema>' +
      wsdl.slice(end);
    const external = inline
      .replace(
        "<xs:schema ",
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:orders" ',
      )
      .replace("</xs:schema>", '<xs:include schemaLocation="extra.xsd"/></xs:schema>');
    const extra =
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="types.xsd"/><xs:simpleType name="Extra"><xs:restriction base="xs:string"><xs:enumeration value="ok"/></xs:restriction></xs:simpleType></xs:schema>';
    const c = await contract(main, {
      "file:///contracts/types.xsd": external,
      "file:///contracts/extra.xsd": extra,
    });
    expect(c.sources).toHaveLength(3);
    expect(c.ports[0]?.diagnostics).toEqual([]);
    await expect(
      contract(main, {
        "file:///contracts/types.xsd": external.replace(
          'targetNamespace="urn:orders"',
          'targetNamespace="urn:wrong"',
        ),
      }),
    ).rejects.toThrow("namespace");
  });
  it("resolves recursive complex types without recursive loading", async () => {
    const recursive = wsdl
      .replace('type="xs:string"', 'type="tns:Node"')
      .replace(
        '<xs:simpleType name="Status">',
        '<xs:complexType name="Node"><xs:sequence><xs:element name="next" type="tns:Node" minOccurs="0"/></xs:sequence></xs:complexType><xs:simpleType name="Status">',
      );
    const c = await contract(recursive);
    expect(c.ports[0]?.diagnostics).toEqual([]);
    await expect(Effect.runPromise(generate(c))).resolves.toBeDefined();
  });
  it("requires selection when multiple supported ports exist", async () => {
    const c = await contract(
      wsdl.replace(
        "</wsdl:service>",
        '<wsdl:port name="Other" binding="tns:OrdersSoapBinding"><soap:address location="https://example.com/soap"/></wsdl:port></wsdl:service>',
      ),
    );
    await expect(Effect.runPromise(generate(c))).rejects.toThrow("Ambiguous");
    await expect(Effect.runPromise(generate(c, { port: "Other" }))).resolves.toBeDefined();
  });
  it("reports unbound prefixes and unresolved references", async () => {
    await expect(
      contract(wsdl.replace('type="xs:string"', 'type="missing:string"')),
    ).rejects.toThrow("Unbound");
    const c = await contract(wsdl.replace('type="xs:string"', 'type="tns:Missing"'));
    expect(c.ports[0]?.diagnostics[0]?.code).toBe("ResolutionError");
  });
  it("blocks entity declarations and malformed XML and enforces depth", () => {
    for (const xml of [
      '<!DOCTYPE a [<!ENTITY x "expanded">]><a>&x;</a>',
      "<a><b></a>",
      '<a x="1" x="2"/>',
      "<a>&unknown;</a>",
    ])
      expect(() => parseXml(xml)).toThrow();
    expect(() => parseXml("<a><b><c/></b></a>", "test", 2)).toThrow("depth");
    const n = parseXml('<a xmlns="urn:a" xmlns:x="urn:b"><x:b/><c/></a>');
    expect(n.children.map((c) => c.namespace)).toEqual(["urn:b", "urn:a"]);
    expect(n.location.line).toBe(1);
  });
  it("enforces byte budgets and local root policies", async () => {
    const limited = await Effect.runPromise(
      load(url, { maxDocumentBytes: 10 }).pipe(
        Effect.provide(memoryLoader({ [url]: wsdl })),
        Effect.either,
      ),
    );
    expect(Either.isLeft(limited) && limited.left._tag).toBe("ResourceError");
    const temp = await mkdtemp(join(tmpdir(), "wsdl-roots-"));
    try {
      await writeFile(join(temp, "outside.wsdl"), wsdl);
      const inside = await mkdtemp(join(temp, "inside-"));
      await symlink(join(temp, "outside.wsdl"), join(inside, "escape.wsdl"));
      await expect(
        Effect.runPromise(
          load(join(inside, "escape.wsdl")).pipe(Effect.provide(nodeLoader([inside]))),
        ),
      ).rejects.toThrow("outside");
      await expect(
        Effect.runPromise(
          load("https://example.com/a.wsdl").pipe(Effect.provide(nodeLoader([inside]))),
        ),
      ).rejects.toThrow("Remote loading");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
