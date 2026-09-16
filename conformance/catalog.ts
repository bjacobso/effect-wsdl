import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Contract } from "../src/model/index.js";
import { decodeElement, encodeElement } from "../src/runtime/codec.js";
import { parseXml } from "../src/xml.js";
import type { Case } from "./model.js";

const base = readFileSync(resolve("test/fixtures/orders.wsdl"), "utf8");
const source = "https://fixtures.invalid/orders.wsdl";
const wsdl = "https://www.w3.org/TR/wsdl.html";
const xsd = "https://www.w3.org/TR/xmlschema-1/";
const datatypes = "https://www.w3.org/TR/xmlschema-2/";
const field = '<xs:element name="orderId" type="xs:string"/>';
const input = '<wsdl:input message="tns:GetOrderInput"/>';
const output = '<wsdl:output message="tns:GetOrderOutput"/>';
const fault = '<wsdl:fault name="OrderNotFound" message="tns:OrderNotFoundMessage"/>';
const boundFault =
  '<wsdl:fault name="OrderNotFound"><soap:fault name="OrderNotFound" use="literal"/></wsdl:fault>';

// A failed replacement must fail the harness, not accidentally test the baseline.
function replace(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `Fixture anchor missing: ${from}`);
  return text.replace(from, to);
}
function probe(
  id: string,
  title: string,
  document: string,
  reference = wsdl,
  verify?: Case["verify"],
  validity: Case["validity"] = "valid",
): Case {
  return {
    id,
    title,
    area: id.startsWith("xsd.") ? "XSD 1.0" : "WSDL 1.1",
    reference,
    validity,
    source,
    resources: { [source]: document },
    ...(verify ? { verify, evidence: "Independent metadata or codec assertion" } : {}),
  };
}
function roundtrip(value: unknown, xml: string): (c: Contract) => void {
  const plain = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(plain);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
  };
  return (c) => {
    const element = c.ports[0]!.operations[0]!.input;
    assert.deepEqual(plain(decodeElement(element, parseXml(xml), c.types)), value);
    assert.deepEqual(
      plain(decodeElement(element, parseXml(encodeElement(element, value, c.types)), c.types)),
      value,
    );
  };
}
const order = roundtrip(
  { orderId: "A&1" },
  '<GetOrder xmlns="urn:orders"><orderId>A&amp;1</orderId></GetOrder>',
);
const noFault = base.replace(fault, "").replace(boundFault, "");
const c: Case[] = [
  probe(
    "wsdl.document-literal",
    "Document/literal request-response",
    base,
    `${wsdl}#_request-response`,
    order,
  ),
  probe(
    "wsdl.documentation",
    "Documentation extension",
    replace(base, "<wsdl:types>", "<wsdl:documentation>Example</wsdl:documentation><wsdl:types>"),
    `${wsdl}#_documentation`,
    order,
  ),
  probe(
    "wsdl.prefixes",
    "Namespace prefixes are aliases",
    base.replaceAll("wsdl:", "w:").replace("xmlns:wsdl=", "xmlns:w="),
    `${wsdl}#_names`,
    order,
  ),
  probe(
    "wsdl.optional-extension",
    "Unknown optional extension",
    replace(
      base,
      "<wsdl:types>",
      '<ext:feature xmlns:ext="urn:extension" wsdl:required="false"/><wsdl:types>',
    ),
    `${wsdl}#_language`,
    order,
  ),
  probe(
    "wsdl.required-extension",
    "Unknown required extension",
    replace(
      base,
      "<wsdl:types>",
      '<ext:feature xmlns:ext="urn:extension" wsdl:required="true"/><wsdl:types>',
    ),
    `${wsdl}#_language`,
  ),
  probe(
    "wsdl.type-parts",
    "Type-based message part",
    replace(base, 'element="tns:GetOrder"', 'type="xs:string"'),
    `${wsdl}#_message`,
  ),
  probe(
    "wsdl.multipart",
    "Multiple literal body parts",
    replace(
      base,
      '<wsdl:part name="body" element="tns:GetOrder"/>',
      '<wsdl:part name="a" element="tns:GetOrder"/><wsdl:part name="b" element="tns:GetOrderResponse"/>',
    ),
    `${wsdl}#_message`,
  ),
  probe(
    "wsdl.body-parts",
    "Explicit body part selection",
    replace(base, '<soap:body use="literal"/>', '<soap:body use="literal" parts="body"/>'),
    `${wsdl}#_soap:body`,
    order,
  ),
  probe(
    "wsdl.one-way",
    "One-way operation",
    noFault
      .replace(output, "")
      .replace('<wsdl:output><soap:body use="literal"/></wsdl:output>', ""),
    `${wsdl}#_one-way`,
  ),
  probe(
    "wsdl.solicit-response",
    "Solicit-response operation",
    replace(noFault, input + output, output + input),
    `${wsdl}#_solicit-response`,
  ),
  probe(
    "wsdl.notification",
    "Notification operation",
    noFault.replace(input, "").replace('<wsdl:input><soap:body use="literal"/></wsdl:input>', ""),
    `${wsdl}#_notification`,
  ),
  probe(
    "wsdl.rpc-literal",
    "RPC/literal binding",
    base
      .replace('style="document"', 'style="rpc"')
      .replace('element="tns:GetOrder"', 'type="xs:string"')
      .replace('element="tns:GetOrderResponse"', 'type="xs:string"'),
    `${wsdl}#_soap:binding`,
  ),
  probe(
    "wsdl.encoded",
    "SOAP encoded body",
    base.replaceAll(
      'use="literal"',
      'use="encoded" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"',
    ),
    `${wsdl}#_soap:body`,
  ),
  probe(
    "wsdl.style-default",
    "Default document style",
    base.replace(' style="document"', ""),
    `${wsdl}#_soap:binding`,
    order,
  ),
  probe(
    "wsdl.style-override",
    "Operation overrides binding style",
    base
      .replace('style="document"', 'style="rpc"')
      .replace("<soap:operation ", '<soap:operation style="document" '),
    `${wsdl}#_soap:operation`,
    order,
  ),
  probe(
    "wsdl.empty-action",
    "Explicit empty SOAPAction",
    base.replace('soapAction="urn:orders/GetOrder"', 'soapAction=""'),
    `${wsdl}#_soap:operation`,
    (c) => assert.equal(c.ports[0]!.operations[0]!.action, ""),
  ),
  probe("wsdl.fault", "Declared literal fault metadata", base, `${wsdl}#_soap:fault`, (c) =>
    assert.equal(c.ports[0]!.operations[0]!.faults[0]!.element.local, "OrderNotFound"),
  ),
  probe(
    "wsdl.header",
    "SOAP header binding",
    replace(
      base,
      '<soap:body use="literal"/>',
      '<soap:header message="tns:GetOrderInput" part="body" use="literal"/><soap:body use="literal" parts=""/>',
    ),
    `${wsdl}#_soap:header`,
  ),
  probe(
    "wsdl.headerfault",
    "SOAP headerfault binding",
    replace(
      base,
      '<soap:body use="literal"/>',
      '<soap:header message="tns:GetOrderInput" part="body" use="literal"><soap:headerfault message="tns:OrderNotFoundMessage" part="body" use="literal"/></soap:header><soap:body use="literal" parts=""/>',
    ),
    `${wsdl}#_soap:header`,
  ),
  probe(
    "wsdl.non-http-transport",
    "SOAP transport other than HTTP",
    base.replace(
      'transport="http://schemas.xmlsoap.org/soap/http"',
      'transport="urn:example:transport"',
    ),
    `${wsdl}#_soap:binding`,
  ),
  probe(
    "wsdl.soap12",
    "SOAP 1.2 binding extension",
    base.replaceAll(
      "http://schemas.xmlsoap.org/wsdl/soap/",
      "http://schemas.xmlsoap.org/wsdl/soap12/",
    ),
    "https://www.w3.org/submissions/wsdl11soap12/",
  ),
];

const imported = probe(
  "wsdl.imports",
  "Relative WSDL imports and cyclic linking",
  base.replace(
    "<wsdl:types>",
    '<wsdl:import namespace="urn:other" location="other.wsdl"/><wsdl:types>',
  ),
  `${wsdl}#_names`,
  (contract) => {
    order(contract);
    assert.equal(contract.sources.length, 2);
  },
);
c.push({
  ...imported,
  resources: {
    ...imported.resources,
    "https://fixtures.invalid/other.wsdl":
      '<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:other"><w:import namespace="urn:orders" location="orders.wsdl"/></w:definitions>',
  },
});
c.push({
  ...probe(
    "wsdl.multiple-ports",
    "Explicit selection among multiple ports",
    base.replace(
      "</wsdl:service>",
      '<wsdl:port name="Other" binding="tns:OrdersSoapBinding"><soap:address location="https://soap.invalid/other"/></wsdl:port></wsdl:service>',
    ),
    `${wsdl}#_ports`,
    order,
  ),
  port: "Other",
});
c.push(
  probe(
    "wsdl.abstract-document",
    "Abstract WSDL without a service",
    `${base.slice(0, base.indexOf("  <wsdl:service"))}</wsdl:definitions>`,
    `${wsdl}#_style`,
  ),
);

// WSDL HTTP bindings are not the same feature as our reflected JSON HttpApi.
for (const method of ["GET", "POST"] as const) {
  const document = `<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" xmlns:h="http://schemas.xmlsoap.org/wsdl/http/" xmlns:m="http://schemas.xmlsoap.org/wsdl/mime/" xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:http" targetNamespace="urn:http">
  <w:types><x:schema targetNamespace="urn:http"><x:element name="Result" type="x:string"/></x:schema></w:types>
  <w:message name="Request"><w:part name="id" type="x:string"/></w:message><w:message name="Response"><w:part name="body" element="t:Result"/></w:message>
  <w:portType name="PortType"><w:operation name="Find"><w:input message="t:Request"/><w:output message="t:Response"/></w:operation></w:portType>
  <w:binding name="Binding" type="t:PortType"><h:binding verb="${method}"/><w:operation name="Find"><h:operation location="/find"/><w:input>${method === "GET" ? "<h:urlEncoded/>" : '<m:content type="application/x-www-form-urlencoded"/>'}</w:input><w:output><m:mimeXml part="body"/></w:output></w:operation></w:binding>
  <w:service name="Service"><w:port name="Port" binding="t:Binding"><h:address location="https://http.invalid"/></w:port></w:service></w:definitions>`;
  c.push(
    probe(
      `wsdl.http-${method.toLowerCase()}-binding`,
      `HTTP ${method} binding`,
      document,
      `${wsdl}#_http`,
    ),
  );
  if (method === "GET")
    c.push(
      probe(
        "wsdl.url-replacement",
        "HTTP urlReplacement",
        document
          .replace("<h:urlEncoded/>", "<h:urlReplacement/>")
          .replace('location="/find"', 'location="/find/(id)"'),
        `${wsdl}#_http:urlReplacement`,
      ),
    );
}
c.push(
  probe(
    "wsdl.mime-multipart",
    "SOAP body with MIME attachment",
    noFault
      .replace("xmlns:soap=", 'xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/" xmlns:soap=')
      .replace(
        '<wsdl:part name="body" element="tns:GetOrder"/>',
        '<wsdl:part name="body" element="tns:GetOrder"/><wsdl:part name="attachment" type="xs:base64Binary"/>',
      )
      .replace(
        '<soap:body use="literal"/>',
        '<mime:multipartRelated><mime:part><soap:body use="literal" parts="body"/></mime:part><mime:part><mime:content part="attachment" type="image/png"/></mime:part></mime:multipartRelated>',
      ),
    `${wsdl}#_mime`,
  ),
);

const wsdl20 = probe(
  "wsdl20.document",
  "WSDL 2.0 description",
  '<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:example"/>',
  "https://www.w3.org/TR/wsdl20/",
);
c.push({ ...wsdl20, area: "WSDL 2.0" });

// Schema probes are well-formed XML; malformed replacements cannot masquerade as rejections.
function schema(id: string, title: string, contents: string, reference = xsd): Case {
  return probe(`xsd.${id}`, title, replace(base, field, contents), reference);
}
for (const compositor of ["choice", "all"])
  c.push(
    probe(
      `xsd.${compositor}`,
      `xs:${compositor} compositor`,
      base.replaceAll("xs:sequence", `xs:${compositor}`),
      `${xsd}#element-${compositor}`,
    ),
  );
for (const [id, contents] of [
  ["wildcard", '<xs:any minOccurs="0" maxOccurs="unbounded" processContents="lax"/>'],
  ["nested-sequence", `<xs:sequence>${field}</xs:sequence>`],
  ["zero-occurs", '<xs:element name="orderId" type="xs:string" minOccurs="0" maxOccurs="0"/>'],
  ["default", '<xs:element name="orderId" type="xs:string" default="A"/>'],
  ["fixed", '<xs:element name="orderId" type="xs:string" fixed="A"/>'],
  ["implicit-anyType", '<xs:element name="orderId"/>'],
] as const)
  c.push(schema(id, id, contents));
for (const [id, from, to] of [
  ["mixed", "<xs:complexType>", '<xs:complexType mixed="true">'],
  ["sequence-occurs", "<xs:sequence>", '<xs:sequence minOccurs="0" maxOccurs="2">'],
  [
    "attribute-ref",
    "</xs:sequence></xs:complexType>",
    '</xs:sequence><xs:attribute ref="tns:lang"/></xs:complexType>',
  ],
  [
    "anyAttribute",
    "</xs:sequence></xs:complexType>",
    '</xs:sequence><xs:anyAttribute processContents="lax"/></xs:complexType>',
  ],
  [
    "unique",
    "</xs:complexType></xs:element>",
    '</xs:complexType><xs:unique name="OrderKey"><xs:selector xpath="tns:orderId"/><xs:field xpath="."/></xs:unique></xs:element>',
  ],
] as const) {
  const document = replace(base, from, to);
  c.push(
    probe(
      `xsd.${id}`,
      id,
      id === "attribute-ref"
        ? document.replace(
            "</xs:schema>",
            '<xs:attribute name="lang" type="xs:string"/></xs:schema>',
          )
        : document,
      xsd,
    ),
  );
}
for (const [facet, value] of [
  ["length", "2"],
  ["minLength", "1"],
  ["maxLength", "9"],
  ["pattern", "[A-Z]+"],
  ["whiteSpace", "collapse"],
  ["minInclusive", "0"],
  ["maxInclusive", "9"],
  ["minExclusive", "0"],
  ["maxExclusive", "9"],
  ["totalDigits", "2"],
  ["fractionDigits", "1"],
] as const) {
  const numeric = [
    "minInclusive",
    "maxInclusive",
    "minExclusive",
    "maxExclusive",
    "totalDigits",
    "fractionDigits",
  ].includes(facet);
  c.push(
    schema(
      `facet-${facet}`,
      `Restriction facet ${facet}`,
      `<xs:element name="orderId"><xs:simpleType><xs:restriction base="xs:${numeric ? "decimal" : "string"}"><xs:${facet} value="${value}"/></xs:restriction></xs:simpleType></xs:element>`,
      `${datatypes}#rf-${facet}`,
    ),
  );
}
for (const [id, definition] of [
  ["list", '<xs:simpleType><xs:list itemType="xs:string"/></xs:simpleType>'],
  ["union", '<xs:simpleType><xs:union memberTypes="xs:string xs:int"/></xs:simpleType>'],
  [
    "simple-content",
    '<xs:complexType><xs:simpleContent><xs:extension base="xs:string"><xs:attribute name="lang" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType>',
  ],
  [
    "complex-extension",
    '<xs:complexType><xs:complexContent><xs:extension base="xs:anyType"><xs:sequence><xs:element name="value" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent></xs:complexType>',
  ],
] as const)
  c.push(schema(id, id, `<xs:element name="orderId">${definition}</xs:element>`));

// Every XSD 1.0 built-in datatype is inventoried, not just those implemented.
const builtins =
  "anyType anySimpleType string boolean decimal float double duration dateTime time date gYearMonth gYear gMonthDay gDay gMonth hexBinary base64Binary anyURI QName NOTATION normalizedString token language NMTOKEN NMTOKENS Name NCName ID IDREF IDREFS ENTITY ENTITIES integer nonPositiveInteger negativeInteger long int short byte nonNegativeInteger unsignedLong unsignedInt unsignedShort unsignedByte positiveInteger".split(
    " ",
  );
const samples: Record<string, readonly [unknown, string]> = {
  string: ["A&1", "A&amp;1"],
  boolean: [true, "1"],
  decimal: ["12.50", "12.50"],
  float: [1.5, "1.5"],
  double: [Infinity, "INF"],
  dateTime: ["2024-02-29T12:00:00Z", "2024-02-29T12:00:00Z"],
  time: ["12:00:00Z", "12:00:00Z"],
  date: ["2024-02-29", "2024-02-29"],
  base64Binary: [new Uint8Array([65]), "QQ=="],
  integer: [123456789012345678901n, "123456789012345678901"],
  long: [-9223372036854775808n, "-9223372036854775808"],
  unsignedLong: [18446744073709551615n, "18446744073709551615"],
  int: [2147483647, "2147483647"],
  short: [-32768, "-32768"],
  byte: [-128, "-128"],
  unsignedInt: [4294967295, "4294967295"],
  unsignedShort: [65535, "65535"],
  unsignedByte: [255, "255"],
};
for (const name of builtins) {
  const sample = samples[name];
  c.push(
    probe(
      `xsd.builtin-${name}`,
      `xs:${name}`,
      name === "NOTATION"
        ? replace(
            base,
            field,
            '<xs:element name="orderId"><xs:simpleType><xs:restriction base="xs:NOTATION"><xs:enumeration value="tns:picture"/></xs:restriction></xs:simpleType></xs:element>',
          ).replace(
            "</xs:schema>",
            '<xs:notation name="picture" public="urn:picture"/></xs:schema>',
          )
        : replace(base, field, `<xs:element name="orderId" type="xs:${name}"/>`),
      `${datatypes}#${name}`,
      sample
        ? roundtrip(
            { orderId: sample[0] },
            `<GetOrder xmlns="urn:orders"><orderId>${sample[1]}</orderId></GetOrder>`,
          )
        : undefined,
    ),
  );
}

for (const [id, from, to, reference] of [
  ["unknown-type", 'type="xs:string"', 'type="tns:Missing"', xsd],
  [
    "conflicting-type",
    'name="orderId" type="xs:string"/>',
    'name="orderId" type="xs:string"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="A"/></xs:restriction></xs:simpleType></xs:element>',
    xsd,
  ],
  ["missing-binding", 'binding="tns:OrdersSoapBinding"', 'binding="tns:Missing"', `${wsdl}#_ports`],
  [
    "missing-part-name",
    'name="body" element="tns:GetOrder"',
    'element="tns:GetOrder"',
    `${wsdl}#_message`,
  ],
  ["missing-soap-action", ' soapAction="urn:orders/GetOrder"', "", `${wsdl}#_soap:operation`],
  [
    "duplicate-body",
    '<soap:body use="literal"/>',
    '<soap:body use="literal"/><soap:body use="literal"/>',
    `${wsdl}#_soap:body`,
  ],
  [
    "mismatched-fault",
    '<soap:fault name="OrderNotFound"',
    '<soap:fault name="Other"',
    `${wsdl}#_soap:fault`,
  ],
] as const)
  c.push(probe(`invalid.${id}`, id, replace(base, from, to), reference, undefined, "invalid"));

// Explicit inventories prevent absence of an executable fixture from looking like support.
for (const [id, area, title, reference, reason] of [
  [
    "wsdl.import-graph",
    "WSDL 1.1",
    "Import namespace constraints and full document graphs",
    `${wsdl}#_names`,
    "A cyclic import probe runs above; exhaustive namespace and graph constraints remain untested.",
  ],
  [
    "wsdl.overloading",
    "WSDL 1.1",
    "Operation overloading and input/output names",
    `${wsdl}#_names`,
    "Needs valid overloaded abstract and concrete fixtures.",
  ],
  [
    "wsdl.parameter-order",
    "WSDL 1.1",
    "RPC parameterOrder",
    `${wsdl}#_parameter`,
    "RPC is unsupported; parameter-order semantics not independently tested.",
  ],
  [
    "wsdl.http-get",
    "WSDL 1.1",
    "HTTP GET wire serialization",
    `${wsdl}#_http`,
    "Binding-load rejection probes run above; urlEncoded/urlReplacement wire semantics are not tested.",
  ],
  [
    "wsdl.http-post",
    "WSDL 1.1",
    "HTTP POST wire serialization",
    `${wsdl}#_http`,
    "Binding-load rejection probe runs above; form serialization is not tested.",
  ],
  [
    "wsdl.mime",
    "WSDL 1.1",
    "MIME wire serialization",
    `${wsdl}#_mime`,
    "Multipart binding-load rejection is probed; MIME wire semantics are not tested.",
  ],
  [
    "soap.envelope",
    "SOAP 1.1",
    "Envelope, Body, namespaces, encodingStyle",
    "https://www.w3.org/TR/2000/NOTE-SOAP-20000508/#_Toc478383494",
    "Existing runtime tests are not a complete SOAP assertion adapter.",
  ],
  [
    "soap.headers",
    "SOAP 1.1",
    "actor, mustUnderstand, header processing",
    "https://www.w3.org/TR/2000/NOTE-SOAP-20000508/#_Toc478383499",
    "Full header-processing conformance not exercised.",
  ],
  [
    "soap.faults",
    "SOAP 1.1",
    "Fault code, actor, detail and HTTP behavior",
    "https://www.w3.org/TR/2000/NOTE-SOAP-20000508/#_Toc478383507",
    "Existing fault tests cover a subset; full normative oracle not mapped.",
  ],
  [
    "soap.encoding",
    "SOAP 1.1",
    "SOAP encoding graphs, arrays, references",
    "https://www.w3.org/TR/2000/NOTE-SOAP-20000508/#_Toc478383512",
    "No encoding implementation or adapter.",
  ],
  [
    "wsdl20.suite",
    "WSDL 2.0",
    "W3C good/bad documents and component-model interchange",
    "https://dev.w3.org/2002/ws/desc/test-suite/index.html",
    "WSDL 2.0 unsupported; official suite not executed.",
  ],
  [
    "wsi.bp11",
    "WS-I",
    "Basic Profile 1.1 Test Assertion Document",
    "https://ws-i.org/Testing/Tools/2005/01/BP11_TAD_1-1.htm",
    "Not executed: needs assertion-by-assertion description and wire-log adapters.",
  ],
  [
    "xsd.w3c-suite",
    "XSD 1.0",
    "W3C XML Schema validity suite",
    "https://www.w3.org/XML/2004/xml-schema-test-suite/",
    "Databinding examples below are a different corpus. Full schema/instance validity suite needs a validator adapter.",
  ],
  [
    "xsd11.suite",
    "XSD 1.1",
    "XSD 1.1 assertions, alternatives, open content",
    "https://github.com/w3c/xsdtests",
    "No XSD 1.1 implementation or adapter; keep separate from XSD 1.0.",
  ],
  [
    "ws.security",
    "WS-*",
    "WS-Security, WS-Policy, WS-Addressing, MTOM",
    "https://www.w3.org/2002/ws/",
    "Separate extensions, not implied by WSDL conformance; no comprehensive adapters.",
  ],
] as const)
  c.push({ id, area, title, reference, validity: "not-applicable", untested: reason });

export const catalog: readonly Case[] = c;
