import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Effect, Layer } from "effect";
import {
  type ContractError,
  ResolutionError,
  ResourceError,
  UnsupportedFeatureError,
  XmlParseError,
} from "./errors.js";
import { type NetworkPolicy, readRemote } from "./network.js";
import { compile } from "./resolve.js";
import { attr, children, parseXml, WSDL, type XmlNode, XSD } from "./xml.js";

export class ResourceLoader extends Context.Tag("effect-wsdl/ResourceLoader")<
  ResourceLoader,
  {
    readonly read: (url: string, maxBytes: number) => Effect.Effect<string, ResourceError>;
  }
>() {}

export const memoryLoader = (sources: Readonly<Record<string, string>>) =>
  Layer.succeed(ResourceLoader, {
    read: (url, maxBytes) =>
      Effect.try({
        try: () => {
          const text = sources[url];
          if (text === undefined) throw new Error("Source not found");
          if (Buffer.byteLength(text) > maxBytes) throw new Error("Document byte limit exceeded");
          return text;
        },
        catch: (e) =>
          new ResourceError({ message: e instanceof Error ? e.message : "Cannot load source" }),
      }),
  });

/** Local roots plus explicit, connection-pinned remote access. No remote access by default. */
export const nodeLoader = (roots: readonly string[], network: NetworkPolicy = {}) =>
  Layer.succeed(ResourceLoader, {
    read: (url, maxBytes) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (new URL(url).protocol !== "file:")
            return readRemote(new URL(url), maxBytes, network, signal);
          const target = await realpath(fileURLToPath(url));
          const allowed = await Promise.all(roots.map((root) => realpath(root)));
          if (
            !allowed.some((root) => {
              const rel = relative(root, target);
              return (
                rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
              );
            })
          )
            throw new Error("Source is outside configured roots");
          const handle = await open(target, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > maxBytes)
              throw new Error("Source is not a regular file or exceeds byte limit");
            const chunks: Buffer[] = [];
            let size = 0;
            while (true) {
              signal.throwIfAborted();
              const buffer = Buffer.alloc(Math.min(65536, maxBytes - size + 1));
              const { bytesRead } = await handle.read(buffer);
              if (!bytesRead) break;
              size += bytesRead;
              if (size > maxBytes) throw new Error("Document byte limit exceeded");
              chunks.push(buffer.subarray(0, bytesRead));
            }
            return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          } finally {
            await handle.close();
          }
        },
        catch: (e) =>
          new ResourceError({
            message: e instanceof Error && !("code" in e) ? e.message : "Cannot read source",
          }),
      }),
  });

export interface LoadOptions {
  readonly maxDocumentBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDocuments?: number;
  readonly maxImportDepth?: number;
  readonly maxXmlDepth?: number;
  readonly timeoutMs?: number;
  readonly catalog?: Readonly<Record<string, string>>;
}
export interface Document {
  readonly url: string;
  readonly root: XmlNode;
  readonly hash: string;
}
export interface SchemaDocument {
  readonly node: XmlNode;
  readonly namespace: string;
}
export const sourceUrl = (source: string): string =>
  /^[a-z][a-z\d+.-]*:/i.test(source) ? new URL(source).href : pathToFileURL(resolve(source)).href;
export const sourceRoot = (source: string): string => dirname(fileURLToPath(sourceUrl(source)));

export function load(source: string, options: LoadOptions = {}) {
  return Effect.gen(function* () {
    const loader = yield* ResourceLoader;
    const limits = {
      document: options.maxDocumentBytes ?? 5 * 1024 * 1024,
      total: options.maxTotalBytes ?? 25 * 1024 * 1024,
      count: options.maxDocuments ?? 100,
      imports: options.maxImportDepth ?? 20,
      xml: options.maxXmlDepth ?? 128,
    };
    if (
      Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      !Number.isFinite(options.timeoutMs ?? 30000) ||
      (options.timeoutMs ?? 30000) <= 0
    )
      return yield* new ResourceError({ message: "Limits must be positive finite integers" });
    const documents = new Map<string, Document>();
    const schemas: SchemaDocument[] = [];
    const seenSchemas = new Set<string>();
    let total = 0;
    const sync = <A>(f: () => A) =>
      Effect.try({
        try: f,
        catch: (e) =>
          e instanceof XmlParseError
            ? e
            : new ResourceError({ message: e instanceof Error ? e.message : "Invalid source" }),
      });
    const visit = (
      url: string,
      depth: number,
      kind?: "wsdl" | "import" | "include",
      namespace = "",
    ): Effect.Effect<void, ContractError> =>
      Effect.gen(function* () {
        if (depth > limits.imports)
          return yield* new ResourceError({ message: "Import depth limit exceeded" });
        const canonical = yield* sync(() => {
          const u = new URL(url);
          u.hash = "";
          return u.href;
        });
        let document = documents.get(canonical);
        const fresh = !document;
        if (!document) {
          if (documents.size >= limits.count)
            return yield* new ResourceError({ message: "Document count limit exceeded" });
          const text = yield* loader.read(canonical, limits.document);
          const size = Buffer.byteLength(text);
          total += size;
          if (size > limits.document || total > limits.total)
            return yield* new ResourceError({ message: "Source graph byte limit exceeded" });
          const root = yield* sync(() => parseXml(text, canonical, limits.xml));
          document = {
            url: canonical,
            root,
            hash: createHash("sha256").update(text).digest("hex"),
          };
          documents.set(canonical, document);
        }
        const root = document.root;
        const actual = attr(root, "targetNamespace") ?? "";
        if (
          kind === "wsdl" &&
          (root.namespace !== WSDL || root.local !== "definitions" || actual !== namespace)
        )
          return yield* new ResourceError({
            message: "WSDL import namespace or document mismatch",
          });
        if (
          (kind === "include" || kind === "import") &&
          (root.namespace !== XSD ||
            root.local !== "schema" ||
            (kind === "import" ? actual !== namespace : actual !== "" && actual !== namespace))
        )
          return yield* new ResourceError({
            message: "XSD import/include namespace or document mismatch",
          });
        const follow = (node: XmlNode, edgeKind: "wsdl" | "import" | "include", ns: string) =>
          Effect.gen(function* () {
            const location =
              attr(node, edgeKind === "wsdl" ? "location" : "schemaLocation") ??
              options.catalog?.[ns];
            if (!location)
              return yield* new ResourceError({
                message: "Import has no location or catalog entry",
              });
            const next = yield* sync(() => new URL(location, canonical).href);
            if (!canonical.startsWith("file:") && next.startsWith("file:"))
              return yield* new ResourceError({
                message: "Remote documents cannot import local files",
              });
            yield* visit(next, depth + 1, edgeKind, ns);
          });
        const addSchema = (
          node: XmlNode,
          ns: string,
          key: string,
        ): Effect.Effect<void, ContractError> =>
          Effect.gen(function* () {
            if (seenSchemas.has(key)) return;
            seenSchemas.add(key);
            schemas.push({ node, namespace: ns });
            for (const edge of node.children) {
              if (edge.namespace !== XSD) continue;
              if (edge.local === "include") yield* follow(edge, "include", ns);
              if (edge.local === "import") {
                const imported = attr(edge, "namespace") ?? "";
                if (imported === ns)
                  return yield* new ResourceError({
                    message: "XSD import must reference a different namespace",
                  });
                yield* follow(edge, "import", imported);
              }
            }
          });
        if (root.namespace === XSD && root.local === "schema") {
          const ns = kind === "include" && !actual ? namespace : actual;
          yield* addSchema(root, ns, `${canonical}#${ns}`);
        } else if (root.namespace === WSDL && root.local === "definitions") {
          if (!fresh) return;
          for (const edge of children(root, WSDL, "import"))
            yield* follow(edge, "wsdl", attr(edge, "namespace") ?? "");
          let index = 0;
          for (const types of children(root, WSDL, "types"))
            for (const schema of children(types, XSD, "schema"))
              yield* addSchema(
                schema,
                attr(schema, "targetNamespace") ?? "",
                `${canonical}#inline-${index++}`,
              );
        } else
          return yield* new ResourceError({
            message: "Expected WSDL 1.1 definitions or XSD schema",
          });
      });
    const url = yield* sync(() => sourceUrl(source));
    yield* visit(url, 0);
    return yield* Effect.try({
      try: () => compile([...documents.values()], schemas),
      catch: (e) =>
        e instanceof ResolutionError ||
        e instanceof UnsupportedFeatureError ||
        e instanceof XmlParseError
          ? e
          : new ResourceError({ message: "Invalid contract document" }),
    });
  }).pipe(
    Effect.timeoutFail({
      duration: options.timeoutMs ?? 30000,
      onTimeout: () => new ResourceError({ message: "Source loading deadline exceeded" }),
    }),
  );
}
