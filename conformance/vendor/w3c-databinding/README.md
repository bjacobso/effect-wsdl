# W3C databinding source and adapted probes

Copyright (C) 2006 W3C (R) (MIT ERCIM Keio), All Rights Reserved.

This software includes material copied from or derived from **XML Schema Patterns for Databinding examples**, https://www.w3.org/2002/ws/databinding/examples/6/09/examples.xml and https://www.w3.org/2002/ws/databinding/examples/6/09/.

The upstream Working Group example corpus is distinct from the W3C WSDL 2.0 and XML Schema validity suites. No certification or W3C endorsement is claimed.

`examples.xml` is the unmodified source snapshot. `adapted/` contains modified documents produced by `../../import-w3c.py`: isolated schema declarations and instances, inherited namespaces, and a new direct-element document/literal echo WSDL wrapper. Changes are identified in every adapted file. `manifest.json` records source identifiers, external-dependency gaps, and SHA-256 hashes. Run the importer offline to reproduce the derived files.

These third-party materials are not covered by the repository's MIT license. The source pages link W3C document and software licensing rules. Copies of those notices are included:

- [W3C Document License](./LICENSE.html), https://www.w3.org/copyright/document-license-2023/
- [W3C Software and Document License](./SOFTWARE-LICENSE.html), https://www.w3.org/copyright/software-license-2023/

Source revision: `examples.xml,v 1.89 2009/03/19 23:13:46 pdowney`. Retrieved 2026-09-16. The generated manifest contains modified-fixture identifiers under the original example base URI for offline relative resolution; `adapted.wsdl` and those instance identifiers are local adapter identifiers, not assertions that corresponding web resources exist.
