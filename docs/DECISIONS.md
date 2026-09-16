# Alpha implementation decisions

## XML parser

Use `saxes@6.0.0` behind `src/xml.ts`. Its namespace-aware events preserve child order and expose positions. Reject DTD events and non-UTF-8/XML-1.0 declarations, and enforce depth during parsing. Source and response adapters bound bytes before constructing trees.

The [upstream repository](https://github.com/lddubeau/saxes) is archived. This is an explicit maintenance risk: the dependency is pinned and isolated, and parser regression tests must pass before replacement. Permissive XML-to-object conversion complicates namespace identity and ordered sequences. This adapter is a well-formedness parser, not a general XSD validator.

## Effect and schemas

Target Effect 3.22.2 / platform 0.97.2. Consumer tests compile with TypeScript 5.9.3 under strict settings. Public operations return Effects and never run them internally. CLI/example application boundaries run Effects explicitly.

Generated types are static declarations. Effect `Schema.declare` validators delegate to XML value validation so recursive types and wire restrictions share one implementation. They do not expose structural ASTs for JSON Schema derivation. Decimal enumerations use `string` statically because multiple lexical strings represent one numeric value; runtime validation compares without floating-point conversion. Date/time values preserve lexical strings. `xs:float` decoding applies binary32 rounding.

## Source loading

Local paths are checked after symlink resolution against explicit roots. Remote loading requires exact host/port entries. DNS results are validated, then the connection uses a pinned lookup and no shared socket pool. Redirects and URL credentials are rejected. Private-address opt-in still requires a host allowlist. Every import is checked. Custom `ResourceLoader` implementations own their resource policy; library graph budgets still apply.

The Node adapter assumes local filesystem ownership is trusted during a load; it is not a sandbox against another process actively replacing directories between system calls. Humans should not edit the output directory while generation runs.

## Output recovery

Stage complete output in a sibling directory; move the previous directory into an exclusive sibling lock, then move the stage into place. A failed replacement restores the backup. A hard process kill can leave a lock and backup requiring manual recovery. Unowned files in the dedicated output directory cause generation to fail.

## Alpha restrictions

- No npm publication has occurred; repository visibility does not establish npm ownership.
- Node.js is the validated runtime; browser/Bun/Deno support remains untested.
- `UnknownFault` is reserved as the generic fault discriminator.
- Nil maps to `null`, so nil instances carrying attributes cannot be represented. Nillable elements with required attributes fail generation.
- Element-property collisions fail rather than overwrite data.
- Schema exports use positional operation names. Adding/reordering operations can rename these exports.
- Platform HTTP tracing is suppressed; payload-safe custom observability is left to applications.
- This is a supported-profile compiler, not full WSDL/XSD conformance certification. Add fixtures before widening compatibility claims.
