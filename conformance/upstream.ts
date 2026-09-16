import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeElement, encodeElement } from "../src/runtime/codec.js";
import { parseXml, type XmlNode, XSI } from "../src/xml.js";
import type { Case } from "./model.js";

interface Manifest {
  source: string;
  cases: { id: string; source: string; instances: string[]; issues: string[] }[];
  files: { url: string; path: string; sha256: string }[];
}
// Compare element/attribute topology independently of our native-value decoder.
// Lexical numeric normalization and namespace prefix choices are intentionally excluded.
function shape(n: XmlNode): unknown {
  return {
    name: `{${n.namespace}}${n.local}`,
    attributes: n.attributes
      .filter((a) => a.namespace !== XSI || a.local === "nil")
      .map((a) => `{${a.namespace}}${a.local}`)
      .sort(),
    children: n.children.map(shape),
  };
}

export function upstreamCases(): readonly Case[] {
  const root = resolve("conformance/vendor/w3c-databinding");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")) as Manifest;
  const resources: Record<string, string> = Object.create(null);
  for (const file of manifest.files) {
    assert.ok(!file.path.includes("..") && !file.path.startsWith("/"), "Unsafe corpus path");
    const bytes = readFileSync(resolve(root, file.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      `Corpus hash mismatch: ${file.url}`,
    );
    assert.equal(resources[file.url], undefined, `Duplicate resource: ${file.url}`);
    resources[file.url] = bytes.toString("utf8");
  }
  return manifest.cases.map(
    (entry) =>
      ({
        id: `w3c.${entry.id}`,
        area: "W3C databinding",
        title: entry.id,
        reference: `${manifest.source}${entry.id}/`,
        validity: "valid",
        source: entry.source,
        resources,
        ...(entry.issues.length
          ? { untested: entry.issues.join("; ") }
          : {
              ...(entry.instances.length
                ? {
                    evidence: `${entry.instances.length} upstream valid instance(s): decode/encode consistency and XML topology; no independent native-value oracle`,
                    verify: (contract) => {
                      const op = contract.ports[0]!.operations[0]!;
                      for (const url of entry.instances) {
                        assert.ok(resources[url], `Missing upstream instance: ${url}`);
                        const xml = parseXml(resources[url]!);
                        const native = decodeElement(op.input, xml, contract.types);
                        const encoded = parseXml(encodeElement(op.input, native, contract.types));
                        assert.deepEqual(
                          shape(encoded),
                          shape(xml),
                          `XML topology changed: ${url}`,
                        );
                        assert.deepEqual(
                          decodeElement(op.input, encoded, contract.types),
                          native,
                          `Roundtrip changed: ${url}`,
                        );
                        assert.deepEqual(
                          decodeElement(op.output, xml, contract.types),
                          native,
                          `Output differs: ${url}`,
                        );
                      }
                    },
                  }
                : {}),
            }),
      }) satisfies Case,
  );
}
