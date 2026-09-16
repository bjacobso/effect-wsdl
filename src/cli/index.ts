#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Effect, Either } from "effect";
import { generate, inspect, load, nodeLoader, sourceRoot, sourceUrl, version } from "../index.js";
import { writeOutput } from "./output.js";

const help = `effect-wsdl ${version}
Usage:
  effect-wsdl inspect <local.wsdl> [--json]
  effect-wsdl generate <local.wsdl> --out <directory> [--service <expanded-name>] [--port <name>] [--check]
Options:
  --root <directory>  Allowed local import root (repeatable; defaults to source directory)
  --allow-host <host> Allow a remote host, including nondefault port (repeatable)
  --allow-private-addresses  Permit internal addresses for explicitly allowed hosts
  --help             Print help
  --version          Print version
Exit codes: 0 success, 1 contract/I/O failure, 2 usage error, 3 stale output.
Remote access requires --allow-host. Redirects and compressed sources are rejected.
`;
async function main(): Promise<number> {
  let parsed: ReturnType<typeof argumentsFor>;
  try {
    parsed = argumentsFor();
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Invalid arguments");
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (values.version) {
    console.log(version);
    return 0;
  }
  const [command, source] = positionals;
  if (
    positionals.length !== 2 ||
    !source ||
    !["inspect", "generate"].includes(command ?? "") ||
    (command === "generate" && (!values.out || values.json)) ||
    (command === "inspect" && (values.out || values.check || values.service || values.port))
  ) {
    console.error(help);
    return 2;
  }
  try {
    const result = await Effect.runPromise(
      load(source).pipe(
        Effect.provide(
          nodeLoader(
            values.root ?? (sourceUrl(source).startsWith("file:") ? [sourceRoot(source)] : []),
            {
              ...(values["allow-host"] ? { allowHosts: values["allow-host"] } : {}),
              ...(values["allow-private-addresses"] ? { allowPrivateAddresses: true } : {}),
            },
          ),
        ),
        Effect.either,
      ),
    );
    if (Either.isLeft(result)) {
      if (values.json)
        console.log(
          JSON.stringify({
            version: 1,
            error: { code: result.left._tag, message: result.left.message },
          }),
        );
      else console.error(`${result.left._tag}: ${result.left.message}`);
      return 1;
    }
    if (command === "inspect") {
      const summary = inspect(result.right);
      if (values.json) console.log(JSON.stringify(summary, null, 2));
      else
        for (const service of summary.services)
          for (const port of service.ports)
            console.log(
              `${service.name} / ${port.name}: ${port.supported ? port.operations.join(", ") : port.diagnostics.map((d) => d.message).join("; ")}`,
            );
      return 0;
    }
    const generated = await Effect.runPromise(
      generate(result.right, {
        ...(values.service ? { service: values.service } : {}),
        ...(values.port ? { port: values.port } : {}),
      }).pipe(Effect.either),
    );
    if (Either.isLeft(generated)) {
      console.error(generated.left.message);
      return 1;
    }
    const current = await writeOutput(values.out!, generated.right, values.check ?? false);
    if (!current) {
      console.error("Generated output is stale or missing");
      return 3;
    }
    console.error(
      values.check ? "Generated output is current" : `Generated client in ${values.out}`,
    );
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Command failed";
    if (values.json)
      console.log(JSON.stringify({ version: 1, error: { code: "ResourceError", message } }));
    else console.error(message);
    return 1;
  }
}
function argumentsFor() {
  return parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      json: { type: "boolean" },
      check: { type: "boolean" },
      out: { type: "string" },
      service: { type: "string" },
      port: { type: "string" },
      root: { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
      "allow-private-addresses": { type: "boolean" },
    },
  });
}
process.exitCode = await main();
