import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { load, nodeLoader } from "../src/index.js";
import { publicAddress } from "../src/network.js";

it.each([
  "127.0.0.1",
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "224.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "fe80::1",
  "fc00::1",
  "2001:db8::1",
  "2002:7f00:1::",
])("blocks nonpublic %s", (address) => expect(publicAddress(address)).toBe(false));
it("allows ordinary public address ranges", () => {
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
it("requires host and private-network opt-ins, bounds streams, and rejects redirects", async () => {
  const wsdl = await readFile(new URL("./fixtures/orders.wsdl", import.meta.url), "utf8");
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/" });
      res.end();
    } else if (req.url === "/import") {
      res.end(
        wsdl.replace(
          "<wsdl:types>",
          '<wsdl:import namespace="urn:other" location="file:///etc/passwd"/><wsdl:types>',
        ),
      );
    } else res.end(wsdl);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const host = `127.0.0.1:${address.port}`,
    source = `http://${host}/`;
  try {
    await expect(
      Effect.runPromise(load(source).pipe(Effect.provide(nodeLoader([])))),
    ).rejects.toThrow("disabled");
    await expect(
      Effect.runPromise(load(source).pipe(Effect.provide(nodeLoader([], { allowHosts: [host] })))),
    ).rejects.toThrow("blocked");
    expect(hits).toBe(0);
    const layer = nodeLoader([], { allowHosts: [host], allowPrivateAddresses: true });
    expect(
      (await Effect.runPromise(load(source).pipe(Effect.provide(layer)))).ports[0]?.diagnostics,
    ).toEqual([]);
    await expect(
      Effect.runPromise(load(`${source}redirect`).pipe(Effect.provide(layer))),
    ).rejects.toThrow("redirects");
    await expect(
      Effect.runPromise(load(source, { maxDocumentBytes: 100 }).pipe(Effect.provide(layer))),
    ).rejects.toThrow("byte limit");
    await expect(
      Effect.runPromise(load(`${source}import`).pipe(Effect.provide(layer))),
    ).rejects.toThrow("local files");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
