#!/usr/bin/env python3
"""
audit-descriptions.py — Validate tool description JSON against anti-patterns.

Reads a JSON array of tool definition objects from stdin, prints findings
to stdout, exits non-zero on any finding.

Input format:
[
  {
    "name": "tool_name",
    "description": "The tool description",
    "promptSnippet": "One-liner",
    "promptGuidelines": ["Bullet 1", "Bullet 2"],
    "parameters": {
      "param_name": { "description": "Param description" },
      ...
    }
  }
]

Each finding includes: field path, violated rule, fix suggestion.
Exit code: 0 = no findings, 1 = one or more findings.
"""

import json
import re
import sys


def check_snippet(snippet: str, name: str) -> list[dict]:
    findings = []
    if len(snippet) > 80:
        findings.append(
            {
                "field": f"{name}.promptSnippet",
                "rule": "snippet_too_long",
                "severity": "warning",
                "message": f"promptSnippet is {len(snippet)} chars (max 80). "
                "Shorten to a scan-friendly headline.",
            }
        )
    return findings


def check_description(desc: str, name: str, snippet: str) -> list[dict]:
    findings = []
    # Check for implementation leak
    impl_terms = ["internally", "under the hood", "behind the scenes", "architecture", "two-pass"]
    for term in impl_terms:
        if term in desc.lower():
            findings.append(
                {
                    "field": f"{name}.description",
                    "rule": "implementation_leak",
                    "severity": "warning",
                    "message": f"Description contains '{term}' — implementation detail. "
                    "Describe what the tool does, not how.",
                }
            )

    # Check if description starts with snippet verbatim
    if snippet and desc.startswith(snippet):
        findings.append(
            {
                "field": f"{name}.description",
                "rule": "snippet_desc_duplicate",
                "severity": "warning",
                "message": "Description starts with the exact promptSnippet text. "
                "Either shorten the snippet or rephrase the description to add "
                "context beyond the snippet.",
            }
        )

    # Check for filler phrases
    fillers = ["please note that", "it is important to", "this parameter is used for"]
    for f in fillers:
        if f in desc.lower():
            findings.append(
                {
                    "field": f"{name}.description",
                    "rule": "filler_phrase",
                    "severity": "warning",
                    "message": f"Contains filler phrase '{f}'. Remove — "
                    "every token is permanent overhead.",
                }
            )

    return findings


def check_guidelines(guidelines: list[str], name: str) -> list[dict]:
    findings = []
    if len(guidelines) > 3:
        findings.append(
            {
                "field": f"{name}.promptGuidelines",
                "rule": "too_many_guidelines",
                "severity": "warning",
                "message": f"{len(guidelines)} guideline bullets (max 3). "
                "Move schema details to param descriptions. Keep only routing "
                "and critical safety notes.",
            }
        )

    for i, bullet in enumerate(guidelines):
        # Check for backticked tool name
        if f"`{name}`" not in bullet:
            findings.append(
                {
                    "field": f"{name}.promptGuidelines[{i}]",
                    "rule": "missing_backtick",
                    "severity": "error",
                    "message": f"Guideline does not backtick tool name (`{name}`). "
                    "Guidelines is a flat section shared by all tools — "
                    "backticks are the only visual anchor.",
                }
            )

        # Check for schema-like content (defaults, allowed values, exclusions)
        schema_patterns = [
            r"(default|defaults to)\s+[`']?\d+",
            r"(minimum|maximum|min|max)\s*(:|=|is)\s+\d+",
            r"(mutually exclusive|cannot be used with)",
            r"^one of",
            r"(allowed|valid|supported)\s+(values?|languages?|types?)",
        ]
        for pat in schema_patterns:
            if re.search(pat, bullet, re.IGNORECASE):
                findings.append(
                    {
                        "field": f"{name}.promptGuidelines[{i}]",
                        "rule": "schema_detail_in_guidelines",
                        "severity": "warning",
                        "message": f"Guideline contains schema-level detail "
                        f"(matched: '{pat}'). Move to param description.",
                    }
                )

    return findings


def check_param_descriptions(
    params: dict, name: str
) -> list[dict]:
    findings = []
    if not params:
        return findings

    for param_name, param_info in params.items():
        if not isinstance(param_info, dict):
            continue
        desc = param_info.get("description", "")
        if not desc:
            continue

        # Check for implementation leak
        impl_terms = ["internally", "under the hood", "architecture"]
        for term in impl_terms:
            if term in desc.lower():
                findings.append(
                    {
                        "field": f"{name}.parameters.{param_name}.description",
                        "rule": "implementation_leak",
                        "severity": "warning",
                        "message": f"Implementation detail '{term}' in param description. "
                        "Tell the agent what to pass, not how the tool uses it.",
                    }
                )

        # Check for filler
        if desc.startswith("This parameter ") or desc.startswith("This field "):
            findings.append(
                {
                    "field": f"{name}.parameters.{param_name}.description",
                    "rule": "redundant_prefix",
                    "severity": "warning",
                    "message": f"Starts with 'This parameter/field' — redundant. "
                    f"Just state the purpose directly.",
                }
            )

    return findings


def audit_tool(tool: dict) -> list[dict]:
    name = tool.get("name", "unknown")
    findings = []

    # Required fields
    desc = tool.get("description", "")
    snippet = tool.get("promptSnippet", "")
    guidelines = tool.get("promptGuidelines", [])
    params = tool.get("parameters", {})

    if not desc:
        findings.append(
            {
                "field": f"{name}.description",
                "rule": "missing_description",
                "severity": "error",
                "message": "description is required but missing or empty.",
            }
        )

    if snippet:
        findings.extend(check_snippet(snippet, name))
    if desc:
        findings.extend(check_description(desc, name, snippet))
    if guidelines:
        findings.extend(check_guidelines(guidelines, name))
    if params:
        findings.extend(check_param_descriptions(params, name))

    return findings


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON input — {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, list):
        print("Error: input must be a JSON array of tool definitions.", file=sys.stderr)
        sys.exit(1)

    all_findings = []
    for tool in data:
        all_findings.extend(audit_tool(tool))

    if not all_findings:
        print("No findings — all tool descriptions pass audit.")
        sys.exit(0)

    # Group by severity
    errors = [f for f in all_findings if f["severity"] == "error"]
    warnings = [f for f in all_findings if f["severity"] == "warning"]

    if errors:
        print(f"\n=== {len(errors)} ERROR(S) ===")
        for f in errors:
            print(f"  [{f['field']}] {f['message']}")

    if warnings:
        print(f"\n=== {len(warnings)} WARNING(S) ===")
        for f in warnings:
            print(f"  [{f['field']}] {f['message']}")

    print(f"\nTotal: {len(errors)} errors, {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
