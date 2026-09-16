import type { Contract, Port } from "./model/index.js";

export interface Selection {
  readonly service?: string;
  readonly port?: string;
}

/** Shared by source generation, runtime clients, and HTTP reflection. */
export function selectPort(contract: Contract, options: Selection): Port {
  const matching = contract.ports.filter(
    (p) =>
      (!options.service || p.service === options.service) &&
      (!options.port || p.name === options.port),
  );
  const supported = matching.filter((p) => !p.diagnostics.length);
  if (!supported.length)
    throw new Error(
      matching.flatMap((p) => p.diagnostics.map((d) => d.message)).join("; ") ||
        "No matching service/port",
    );
  if (supported.length !== 1)
    throw new Error("Ambiguous service/port; select service and port explicitly");
  return supported[0]!;
}
