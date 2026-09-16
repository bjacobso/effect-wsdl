import { SaxesParser } from "saxes";
import { XmlParseError } from "./errors.js";
import type { Location, Name } from "./model/index.js";
export const XSD = "http://www.w3.org/2001/XMLSchema";
export const WSDL = "http://schemas.xmlsoap.org/wsdl/";
export const SOAP = "http://schemas.xmlsoap.org/wsdl/soap/";
export const ENV = "http://schemas.xmlsoap.org/soap/envelope/";
export const XSI = "http://www.w3.org/2001/XMLSchema-instance";
export interface XmlNode extends Name {
  readonly attributes: readonly (Name & { readonly value: string })[];
  readonly namespaces: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
  readonly location: Location;
}
export function parseXml(xml: string, source = "<xml>", maxDepth = 128): XmlNode {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const fail = (message: string): never => {
    throw new XmlParseError({
      message,
      location: { source, line: parser.line, column: parser.column },
    });
  };
  parser.on("error", () => fail("Malformed XML"));
  parser.on("doctype", () => fail("DTDs and entity declarations are forbidden"));
  parser.on("xmldecl", (decl) => {
    if (decl.version !== "1.0") fail("Only XML 1.0 is supported");
    if (decl.encoding && !/^utf-?8$/i.test(decl.encoding)) fail("Only UTF-8 XML is supported");
  });
  parser.on("opentag", (tag) => {
    if (stack.length >= maxDepth) fail("XML depth limit exceeded");
    const parent = stack.at(-1);
    const node: XmlNode = {
      namespace: tag.uri,
      local: tag.local,
      attributes: Object.values(tag.attributes)
        .filter((a) => a.uri !== "http://www.w3.org/2000/xmlns/")
        .map((a) => ({ namespace: a.uri, local: a.local, value: a.value })),
      namespaces: { ...parent?.namespaces, ...tag.ns },
      children: [],
      text: "",
      location: { source, line: parser.line, column: parser.column },
    };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => {
    const node = stack.at(-1);
    if (node) node.text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (!root) return fail("Missing document element");
  return root;
}
export const attr = (node: XmlNode, local: string, namespace = ""): string | undefined =>
  node.attributes.find((a) => a.local === local && a.namespace === namespace)?.value;
export const children = (node: XmlNode, namespace: string, local: string): XmlNode[] =>
  node.children.filter((c) => c.namespace === namespace && c.local === local);
export function qname(node: XmlNode, value: string): Name {
  const match = /^(?:([^\s:]+):)?([^\s:]+)$/.exec(value);
  if (!match) throw new XmlParseError({ message: "Invalid QName", location: node.location });
  const prefix = match[1] ?? "";
  const namespace = node.namespaces[prefix];
  if (prefix && namespace === undefined)
    throw new XmlParseError({
      message: `Unbound namespace prefix: ${prefix}`,
      location: node.location,
    });
  return { namespace: namespace ?? "", local: match[2]! };
}
export function escapeXml(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 explicitly permits tab, LF and CR.
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value))
    throw new Error("Invalid XML character");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r", "&#13;");
}
