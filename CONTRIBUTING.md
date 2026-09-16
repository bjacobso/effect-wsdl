# Contributing

Use Node.js 22 or 24 and pnpm 10.20.0. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm example`.

For contract features, include a minimal redistributable WSDL/XSD fixture. Document the expected TypeScript shape and independent request/response XML. Cover success, malformed input, unsupported neighboring constructs, and declared faults. Keep source policy separate from parsing and generation.

Runtime changes must preserve typed errors, interruption, response bounds, and no implicit retries. Do not log credentials, source URL queries, or SOAP payloads. Runtime imports must remain independent of filesystem and compiler code.

Change the generator and regenerate `examples/generated`; do not hand-edit generated files. Run the installed-package consumer test when changing exports or generation. Open an issue before broadening the supported profile. Do not attach private contracts or credentials.

Publication is a separate maintainer action after reviewing package ownership and release checks.

When changing contract support, run `pnpm conformance --write` and review the report diff, then `pnpm conformance --check`. Add specification references and positive/negative probes as described in [conformance/README.md](./conformance/README.md). Keep rejection, untested behavior, and passing behavioral assertions distinct. Preserve upstream attribution and checksum provenance; regenerate adapted fixtures with the documented offline importer.
