import { ResolutionError, UnsupportedFeatureError } from "./errors.js";
import type { Document, SchemaDocument } from "./loader.js";
import {
  type Contract,
  type Element,
  expanded,
  type Operation,
  type Port,
  type Primitive,
  type Type,
} from "./model/index.js";
import { attr, children, qname, SOAP, WSDL, type XmlNode, XSD } from "./xml.js";

const primitives = new Set<string>([
  "string",
  "boolean",
  "byte",
  "short",
  "int",
  "unsignedByte",
  "unsignedShort",
  "unsignedInt",
  "integer",
  "long",
  "unsignedLong",
  "decimal",
  "float",
  "double",
  "date",
  "dateTime",
  "time",
  "base64Binary",
]);
const unsupported = (node: XmlNode, message: string): never => {
  throw new UnsupportedFeatureError({ message, location: node.location });
};
const invalid = (node: XmlNode, message: string): never => {
  throw new ResolutionError({ message, location: node.location });
};
const required = (node: XmlNode, name: string): string => {
  const value = attr(node, name) ?? invalid(node, `Missing ${name} on ${node.local}`);
  if (
    name === "name" &&
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: XML names permit individual combining code points after the first character.
    !/^[_\p{L}][_\p{L}\p{N}.\-\u00B7\u0300-\u036F\u203F-\u2040]*$/u.test(value)
  )
    invalid(node, "Invalid XML local name");
  return value;
};
function one(node: XmlNode, ns: string, name: string): XmlNode {
  const matches = children(node, ns, name);
  return matches.length === 1 ? matches[0]! : invalid(node, `Expected exactly one ${name}`);
}
function allowed(node: XmlNode, ns: string, names: readonly string[]) {
  for (const child of node.children) {
    if (child.namespace === ns && !names.includes(child.local))
      unsupported(child, `Unsupported ${child.local}`);
    if (
      child.namespace !== ns &&
      (ns === XSD ||
        attr(child, "required", WSDL) === "true" ||
        attr(child, "required", WSDL) === "1" ||
        child.namespace.includes("policy"))
    )
      unsupported(child, `Unsupported extension ${expanded(child)}`);
  }
}
function rejectAttributes(node: XmlNode, names: readonly string[]) {
  for (const name of names)
    if (attr(node, name) !== undefined) unsupported(node, `Unsupported ${name}`);
}
const booleanAttr = (node: XmlNode, name: string): boolean => {
  const v = attr(node, name);
  if (v === undefined || v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  return invalid(node, `Invalid boolean ${name}`);
};
interface Definition {
  readonly node: XmlNode;
  readonly schema: SchemaDocument;
}

export function compile(
  documents: readonly Document[],
  schemas: readonly SchemaDocument[],
): Contract {
  const types: Record<string, Type> = Object.create(null);
  const typeDefs = new Map<string, Definition>();
  const elementDefs = new Map<string, Definition>();
  const messages = new Map<string, XmlNode>();
  const bindings = new Map<string, XmlNode>();
  const portTypes = new Map<string, XmlNode>();
  const services: { node: XmlNode; namespace: string }[] = [];
  const insert = <A>(map: Map<string, A>, key: string, value: A, node: XmlNode) => {
    if (map.has(key)) invalid(node, `Conflicting declaration ${key}`);
    map.set(key, value);
  };
  for (const schema of schemas) {
    for (const node of schema.node.children) {
      if (node.namespace !== XSD) continue;
      const name = attr(node, "name");
      if (!name) continue;
      const id = expanded({ namespace: schema.namespace, local: name });
      if (node.local === "complexType" || node.local === "simpleType")
        insert(typeDefs, id, { node, schema }, node);
      if (node.local === "element") insert(elementDefs, id, { node, schema }, node);
    }
  }
  for (const { root } of documents) {
    if (root.namespace !== WSDL) continue;
    const namespace = attr(root, "targetNamespace") ?? "";
    for (const node of root.children) {
      if (node.namespace !== WSDL) continue;
      const name = attr(node, "name");
      if (!name) continue;
      const id = expanded({ namespace, local: name });
      if (node.local === "message") insert(messages, id, node, node);
      if (node.local === "binding") insert(bindings, id, node, node);
      if (node.local === "portType") insert(portTypes, id, node, node);
      if (node.local === "service") services.push({ node, namespace });
    }
  }
  const refId = (node: XmlNode, value: string, schema?: SchemaDocument): string => {
    const name = qname(node, value);
    // Chameleon schemas adopt references to their previously absent namespace.
    return expanded(
      !name.namespace && schema && !attr(schema.node, "targetNamespace")
        ? { ...name, namespace: schema.namespace }
        : name,
    );
  };
  const resolving = new Set<string>();
  const ensureType = (id: string, origin: XmlNode): string => {
    if (types[id] || resolving.has(id)) return id;
    if (id.startsWith(`{${XSD}}`)) {
      const primitive = id.slice(XSD.length + 2);
      if (!primitives.has(primitive)) unsupported(origin, `Unsupported XSD datatype ${primitive}`);
      types[id] = { kind: "primitive", primitive: primitive as Primitive };
      return id;
    }
    const def = typeDefs.get(id);
    if (!def) invalid(origin, `Unknown type ${id}`);
    resolving.add(id);
    try {
      types[id] = buildType(def!.node, def!.schema, id);
    } finally {
      resolving.delete(id);
    }
    return id;
  };
  const typeFor = (node: XmlNode, schema: SchemaDocument, id: string): string => {
    const named = attr(node, "type");
    const inline = node.children.filter(
      (c) => c.namespace === XSD && (c.local === "complexType" || c.local === "simpleType"),
    );
    if ((named && inline.length) || inline.length > 1)
      invalid(node, "Conflicting type definitions");
    if (named) return ensureType(refId(node, named, schema), node);
    if (inline.length === 1) {
      if (!types[id] && !resolving.has(id)) {
        resolving.add(id);
        try {
          types[id] = buildType(inline[0]!, schema, id);
        } finally {
          resolving.delete(id);
        }
      }
      return id;
    }
    return unsupported(node, "Explicit supported type required; implicit anyType is unsupported");
  };
  const element = (node: XmlNode, schema: SchemaDocument, id: string, global = false): Element => {
    allowed(node, XSD, ["annotation", "simpleType", "complexType"]);
    if (global) rejectAttributes(node, ["ref", "minOccurs", "maxOccurs", "form"]);
    rejectAttributes(node, ["default", "fixed", "substitutionGroup", "abstract", "block", "final"]);
    const count = (name: string, fallback: number): number => {
      const v = attr(node, name);
      if (v === undefined) return fallback;
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
        return invalid(node, `Invalid ${name}`);
      return Number(v);
    };
    const min = count("minOccurs", 1);
    const max = attr(node, "maxOccurs") === "unbounded" ? "unbounded" : count("maxOccurs", 1);
    if (max !== "unbounded" && (max < min || max === 0))
      unsupported(node, "Invalid or zero occurrence range");
    const ref = attr(node, "ref");
    if (ref) {
      if (
        attr(node, "name") ||
        attr(node, "type") ||
        node.children.some((c) => c.local !== "annotation") ||
        attr(node, "nillable") ||
        attr(node, "form")
      )
        invalid(node, "Element ref cannot redefine its declaration");
      const key = refId(node, ref, schema);
      const def = elementDefs.get(key);
      if (!def) return invalid(node, `Unknown element ${key}`);
      return { ...element(def.node, def.schema, `${key}#type`, true), min, max };
    }
    const local = required(node, "name");
    const form = attr(node, "form") ?? attr(schema.node, "elementFormDefault") ?? "unqualified";
    if (form !== "qualified" && form !== "unqualified") invalid(node, "Invalid element form");
    return {
      namespace: global || form === "qualified" ? schema.namespace : "",
      local,
      type: typeFor(node, schema, id),
      min,
      max,
      nillable: booleanAttr(node, "nillable"),
    };
  };
  const buildType = (node: XmlNode, schema: SchemaDocument, id: string): Type => {
    allowed(schema.node, XSD, [
      "annotation",
      "import",
      "include",
      "element",
      "simpleType",
      "complexType",
      "attribute",
    ]);
    rejectAttributes(schema.node, ["blockDefault", "finalDefault"]);
    if (node.local === "simpleType") {
      allowed(node, XSD, ["annotation", "restriction"]);
      const restriction = one(node, XSD, "restriction");
      allowed(restriction, XSD, ["annotation", "enumeration"]);
      const base = ensureType(
        refId(restriction, required(restriction, "base"), schema),
        restriction,
      );
      const t = types[base];
      if (t?.kind !== "primitive")
        return unsupported(node, "Restriction requires a nonrecursive primitive base");
      const enumeration = children(restriction, XSD, "enumeration").map((n) =>
        required(n, "value"),
      );
      if (!enumeration.length)
        return unsupported(node, "Only enumeration restrictions are supported");
      if (
        ![
          "string",
          "byte",
          "short",
          "int",
          "unsignedByte",
          "unsignedShort",
          "unsignedInt",
          "integer",
          "long",
          "unsignedLong",
          "decimal",
          "float",
          "double",
        ].includes(t.primitive)
      )
        return unsupported(node, "Enumeration requires a string or numeric base");
      if (t.enumeration && enumeration.some((v) => !t.enumeration?.includes(v)))
        return invalid(node, "Enumeration widens its base restriction");
      return { kind: "primitive", primitive: t.primitive, enumeration };
    }
    allowed(node, XSD, ["annotation", "sequence", "attribute"]);
    rejectAttributes(node, ["abstract", "block", "final"]);
    if (booleanAttr(node, "mixed")) unsupported(node, "Mixed content is unsupported");
    const sequences = children(node, XSD, "sequence");
    if (sequences.length > 1) invalid(node, "Multiple sequences are unsupported");
    const sequence = sequences[0];
    if (sequence) {
      allowed(sequence, XSD, ["annotation", "element"]);
      if (
        (attr(sequence, "minOccurs") ?? "1") !== "1" ||
        (attr(sequence, "maxOccurs") ?? "1") !== "1"
      )
        unsupported(sequence, "Sequence occurrence constraints are unsupported");
    }
    const elements = sequence
      ? children(sequence, XSD, "element").map((n, i) => element(n, schema, `${id}/element/${i}`))
      : [];
    if (
      new Set(elements.map((e) => e.local)).size !== elements.length ||
      elements.some((e) => e.local === "$attributes")
    )
      unsupported(node, "Ambiguous element property names");
    const attributes = children(node, XSD, "attribute").map((n, i) => {
      allowed(n, XSD, ["annotation", "simpleType"]);
      rejectAttributes(n, ["ref", "default", "fixed"]);
      const use = attr(n, "use") ?? "optional";
      if (use !== "optional" && use !== "required") unsupported(n, "Unsupported attribute use");
      const form = attr(n, "form") ?? attr(schema.node, "attributeFormDefault") ?? "unqualified";
      if (form !== "qualified" && form !== "unqualified") invalid(n, "Invalid attribute form");
      const type = typeFor(n, schema, `${id}/attribute/${i}`);
      if (types[type]?.kind !== "primitive") unsupported(n, "Attribute type must be primitive");
      return {
        namespace: form === "qualified" ? schema.namespace : "",
        local: required(n, "name"),
        type,
        required: use === "required",
      };
    });
    if (new Set(attributes.map((a) => a.local)).size !== attributes.length)
      unsupported(node, "Ambiguous attribute property names");
    return { kind: "complex", elements, attributes };
  };
  const get = (map: Map<string, XmlNode>, node: XmlNode, value: string): XmlNode => {
    const id = refId(node, value);
    return map.get(id) ?? invalid(node, `Unknown reference ${id}`);
  };
  const messageElement = (message: XmlNode, body?: XmlNode): Element => {
    allowed(message, WSDL, ["documentation", "part"]);
    const parts = children(message, WSDL, "part");
    const selected = attr(body ?? message, "parts")
      ?.trim()
      .split(/\s+/);
    const chosen = selected ? parts.filter((p) => selected.includes(required(p, "name"))) : parts;
    if (chosen.length !== 1 || (selected && selected.length !== 1))
      return unsupported(message, "Exactly one element-based body part is required");
    const part = chosen[0]!;
    if (attr(part, "type")) unsupported(part, "Type-based message parts are unsupported");
    const id = refId(part, required(part, "element"));
    const def = elementDefs.get(id);
    if (!def) return invalid(part, `Unknown message element ${id}`);
    return element(def.node, def.schema, `${id}#type`, true);
  };
  const ports: Port[] = [];
  for (const service of services)
    for (const port of children(service.node, WSDL, "port")) {
      const operations: Operation[] = [];
      const diagnostics: Port["diagnostics"][number][] = [];
      let endpoint = "";
      try {
        for (const d of documents)
          if (d.root.namespace === WSDL)
            allowed(d.root, WSDL, [
              "documentation",
              "import",
              "types",
              "message",
              "portType",
              "binding",
              "service",
            ]);
        allowed(service.node, WSDL, ["documentation", "port"]);
        allowed(port, WSDL, ["documentation"]);
        const address = one(port, SOAP, "address");
        endpoint = required(address, "location");
        let url: URL;
        try {
          url = new URL(endpoint);
        } catch {
          return invalid(address, "Invalid SOAP endpoint URL");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          unsupported(address, "SOAP endpoint must be HTTP(S) without credentials");
        const binding = get(bindings, port, required(port, "binding"));
        allowed(binding, WSDL, ["documentation", "operation"]);
        const wire = one(binding, SOAP, "binding");
        if (attr(wire, "transport") !== "http://schemas.xmlsoap.org/soap/http")
          unsupported(wire, "Only SOAP HTTP transport is supported");
        const portType = get(portTypes, binding, required(binding, "type"));
        allowed(portType, WSDL, ["documentation", "operation"]);
        const names = new Set<string>();
        for (const op of children(binding, WSDL, "operation")) {
          allowed(op, WSDL, ["documentation", "input", "output", "fault"]);
          const name = required(op, "name");
          if (names.has(name)) unsupported(op, "Operation overloading is unsupported");
          names.add(name);
          const abstract = children(portType, WSDL, "operation").filter(
            (n) => attr(n, "name") === name,
          );
          if (abstract.length !== 1) unsupported(op, "Missing or overloaded portType operation");
          const abstractOp = abstract[0]!;
          allowed(abstractOp, WSDL, ["documentation", "input", "output", "fault"]);
          const io = abstractOp.children.filter(
            (n) => n.namespace === WSDL && ["input", "output"].includes(n.local),
          );
          if (io.length !== 2 || io[0]?.local !== "input" || io[1]?.local !== "output")
            unsupported(op, "Only request/response operations are supported");
          const wireOp = one(op, SOAP, "operation");
          if ((attr(wireOp, "style") ?? attr(wire, "style") ?? "document") !== "document")
            unsupported(wireOp, "Only document style is supported");
          const bodyElement = (direction: string): Element => {
            const bound = one(op, WSDL, direction);
            if (
              bound.children.some(
                (n) => n.namespace !== WSDL && !(n.namespace === SOAP && n.local === "body"),
              )
            )
              unsupported(bound, "SOAP header/extension bindings are unsupported");
            const body = one(bound, SOAP, "body");
            if (attr(body, "use") !== "literal" || attr(body, "encodingStyle"))
              unsupported(body, "Only literal SOAP bodies are supported");
            const abstractIo = one(abstractOp, WSDL, direction);
            return messageElement(get(messages, abstractIo, required(abstractIo, "message")), body);
          };
          const faults = children(op, WSDL, "fault").map((fault) => {
            const name = required(fault, "name");
            if (name === "UnknownFault")
              unsupported(fault, "UnknownFault is reserved for generic runtime faults");
            const wireFault = one(fault, SOAP, "fault");
            if (
              attr(wireFault, "use") !== "literal" ||
              attr(wireFault, "encodingStyle") ||
              required(wireFault, "name") !== name
            )
              unsupported(fault, "Only matching literal fault bindings are supported");
            const abs = children(abstractOp, WSDL, "fault").filter((f) => attr(f, "name") === name);
            if (abs.length !== 1) invalid(fault, "Fault declaration not found");
            return {
              name,
              element: messageElement(get(messages, abs[0]!, required(abs[0]!, "message"))),
            };
          });
          if (
            faults.length !== children(abstractOp, WSDL, "fault").length ||
            new Set(faults.map((f) => f.name)).size !== faults.length
          )
            invalid(op, "Incomplete or duplicate fault bindings");
          if (new Set(faults.map((f) => expanded(f.element))).size !== faults.length)
            unsupported(op, "Fault detail names must be unambiguous");
          operations.push({
            name,
            action: attr(wireOp, "soapAction") ?? "",
            input: bodyElement("input"),
            output: bodyElement("output"),
            faults,
          });
        }
        if (
          !operations.length ||
          operations.length !== children(portType, WSDL, "operation").length
        )
          unsupported(binding, "Binding must cover every operation");
        const checked = new Set<string>();
        const checkElement = (element: Element) => {
          const t = types[element.type];
          if (!t) invalid(port, `Unresolved type ${element.type}`);
          if (element.nillable && t?.kind === "complex" && t.attributes.some((a) => a.required))
            unsupported(
              port,
              "Nillable elements with required attributes cannot be represented as null",
            );
          if (checked.has(element.type)) return;
          checked.add(element.type);
          if (t?.kind === "complex") for (const child of t.elements) checkElement(child);
        };
        for (const operation of operations) {
          checkElement(operation.input);
          checkElement(operation.output);
          for (const fault of operation.faults) checkElement(fault.element);
        }
      } catch (e) {
        if (e instanceof ResolutionError || e instanceof UnsupportedFeatureError)
          diagnostics.push({ code: e._tag, message: e.message, location: e.location });
        else throw e;
      }
      ports.push({
        service: expanded({ namespace: service.namespace, local: required(service.node, "name") }),
        name: required(port, "name"),
        endpoint,
        operations,
        diagnostics,
      });
    }
  if (!ports.length)
    throw new ResolutionError({
      message: "No WSDL service ports found",
      location: documents[0]!.root.location,
    });
  return { ports, types, sources: documents.map((d, i) => ({ id: `source-${i}`, hash: d.hash })) };
}

export const inspect = (contract: Contract) => ({
  version: 1,
  services: [...new Set(contract.ports.map((p) => p.service))].map((name) => ({
    name,
    ports: contract.ports
      .filter((p) => p.service === name)
      .map((p) => ({
        name: p.name,
        endpoint: p.endpoint,
        supported: p.diagnostics.length === 0,
        operations: p.operations.map((o) => o.name),
        diagnostics: p.diagnostics,
      })),
  })),
});
