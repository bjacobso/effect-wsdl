#!/usr/bin/env python3
"""Adapt the pinned W3C databinding source catalog into document/literal probes.

No third-party Python modules required. Default is entirely offline. --refresh
fetches one source catalog with curl; review the source diff before adapting it.
The published per-example WSDL wrappers are NOT reproduced: each example's
global element is used directly as both input and output of a bare SOAP echo.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
from xml.dom import minidom
from xml.sax.saxutils import quoteattr

BASE = "https://www.w3.org/2002/ws/databinding/examples/6/09/"
ROOT = pathlib.Path(__file__).resolve().parent / "vendor/w3c-databinding"
XSD = "http://www.w3.org/2001/XMLSchema"
EX = "http://www.w3.org/2002/ws/databinding/examples/6/09/"
NOTICE = """<!--
Copyright (C) 2006 W3C (R) (MIT ERCIM Keio), All Rights Reserved.
This software includes material copied from XML Schema Patterns for Databinding:
https://www.w3.org/2002/ws/databinding/examples/6/09/examples.xml
https://www.w3.org/copyright/document-license-2023/
https://www.w3.org/copyright/software-license-2023/
Adapted by effect-wsdl: isolated schema and direct-element SOAP echo wrapper.
These are modified compatibility probes, not official W3C conformance results.
-->\n"""


def children(node, namespace=None, local=None):
    return [n for n in node.childNodes if n.nodeType == n.ELEMENT_NODE
            and (namespace is None or n.namespaceURI == namespace)
            and (local is None or n.localName == local)]


def isolated(node):
    """Preserve inherited xmlns declarations, including QName-valued attributes."""
    cloned = node.cloneNode(deep=True)
    ancestor = node
    while ancestor and ancestor.nodeType == ancestor.ELEMENT_NODE:
        for attribute in ancestor.attributes.values():
            if attribute.name.startswith("xmlns") and not cloned.hasAttribute(attribute.name):
                cloned.setAttribute(attribute.name, attribute.value)
        ancestor = ancestor.parentNode
    return cloned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    if args.refresh:
        subprocess.run(["curl", "--fail", "--location", "--max-time", "60",
                        BASE + "examples.xml", "--output", str(ROOT / "examples.xml")], check=True)
    data = (ROOT / "examples.xml").read_bytes()
    catalog = minidom.parseString(data).documentElement
    declarations = " ".join(f"{a.name}={quoteattr(a.value)}" for a in catalog.attributes.values()
                            if a.name.startswith("xmlns"))
    files = {"examples.xml": (BASE + "examples.xml", data)}
    cases = []
    for entry in children(catalog, EX, "example"):
        name = entry.getAttribute("xml:id")
        typedef = children(entry, EX, "typedef")
        explicit = children(entry, EX, "types")
        issues = []
        if typedef:
            schema = f'<xs:schema xmlns="{EX}" targetNamespace="{EX}" elementFormDefault="qualified">' + "".join(isolated(n).toxml() for n in children(typedef[0])) + "</xs:schema>"
            element = entry.getAttribute("element")
        else:
            schema = "".join(isolated(n).toxml() for n in children(explicit[0]))
            element = entry.getAttribute("element")
            # NoTargetNamespace's source label uses ex:, but its global declaration
            # is unqualified. Resolve this one namespace difference in the wrapper.
            if name == "NoTargetNamespace":
                element = element.split(":")[-1]
        for tag in ("import", "include", "redefine"):
            for dependency in entry.getElementsByTagNameNS(XSD, tag):
                target = dependency.getAttribute("schemaLocation") or dependency.getAttribute("namespace")
                issues.append(f"External schema dependency not adapted: {tag} {target}")
        # These prefixes do not occur in the upstream catalog.
        header = f'<cfw:definitions xmlns:cfw="http://schemas.xmlsoap.org/wsdl/" xmlns:cfs="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:cft="urn:effect-wsdl:conformance" {declarations} targetNamespace="urn:effect-wsdl:conformance">'
        document = NOTICE + header + f"""
<cfw:types>{schema}</cfw:types>
<cfw:message name="Value"><cfw:part name="body" element={quoteattr(element)}/></cfw:message>
<cfw:portType name="EchoPortType"><cfw:operation name="Echo"><cfw:input message="cft:Value"/><cfw:output message="cft:Value"/></cfw:operation></cfw:portType>
<cfw:binding name="EchoBinding" type="cft:EchoPortType"><cfs:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/><cfw:operation name="Echo"><cfs:operation soapAction="urn:echo"/><cfw:input><cfs:body use="literal"/></cfw:input><cfw:output><cfs:body use="literal"/></cfw:output></cfw:operation></cfw:binding>
<cfw:service name="EchoService"><cfw:port name="EchoPort" binding="cft:EchoBinding"><cfs:address location="https://soap.invalid/echo"/></cfw:port></cfw:service>
</cfw:definitions>
"""
        source = BASE + name + "/adapted.wsdl"
        files[f"adapted/{name}/service.wsdl"] = (source, document.encode())
        instances = []
        for instance in children(entry, EX, "instance"):
            instance_id = instance.getAttribute("xml:id")
            nodes = children(instance)
            if len(nodes) != 1:
                issues.append(f"Instance {instance_id} has {len(nodes)} roots; no single-element adapter")
                continue
            node = isolated(nodes[0])
            url = BASE + name + "/" + instance_id + ".xml"
            files[f"adapted/{name}/{instance_id}.xml"] = (url, (NOTICE + node.toxml() + "\n").encode())
            instances.append(url)
        cases.append({"id": name, "source": source, "instances": instances, "issues": issues})
    manifest = {"source": BASE, "sourceRevision": "examples.xml 1.89 2009-03-19 (embedded upstream revision)",
                "adaptation": "Direct-element document/literal echo; see import-w3c.py", "cases": cases, "files": []}
    for path, (url, content) in sorted(files.items()):
        destination = ROOT / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        manifest["files"].append({"url": url, "path": path, "sha256": hashlib.sha256(content).hexdigest()})
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Adapted {len(cases)} examples / {sum(len(c['instances']) for c in cases)} instances")


if __name__ == "__main__":
    main()
