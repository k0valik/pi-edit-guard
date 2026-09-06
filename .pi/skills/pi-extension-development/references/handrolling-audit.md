# Handrolling Audit

Systematically scan an extension for code reimplementing what
`@earendil-works/pi-*` packages already export.

## Process

1. Read `package.json` — identify peer deps and entry points.
2. Read every `.ts` source file. Scan for imports from `node:fs`, `node:os`,
   `node:path` that duplicate pi utilities.
3. Check against installed pi exports:
   ```bash
   grep -n "export.*function.*getAgentDir\|export.*function.*expandTildePath" \
     node_modules/.pnpm/@earendil-works+pi-coding-agent@*/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts
   ```
4. Categorize each finding by tier.

## Smell Catalog

| Smell                                                        | What to look for                                               | Tier   |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------ |
| `homedir()` + manual agent-dir construction                  | `join(homedir(), ".pi", "agent")`                              | Tier 1 |
| Hand-rolled tilde expansion                                  | `path.startsWith("~/")` or `path === "~"`                      | Tier 1 |
| `existsSync`, `readFileSync`, `writeFileSync` for JSON state | Config persistence                                             | Tier 2 |
| Shell command parsing with state-machine loops               | `tokenizeCommand`, quote-state tracking                        | Tier 3 |
| Hand-rolled LRU/Map eviction                                 | `cache.set()` + oldest-key eviction                            | Tier 3 |
| Config loading from env vars                                 | `readBooleanEnv`, `readPositiveIntEnv`                         | Tier 3 |
| Inline home-dir resolution                                   | `process.env.HOME \|\| process.env.USERPROFILE \|\| homedir()` | Tier 1 |
| Hand-rolled path normalization                               | `path.replace(/\\/g, "/")` or ad-hoc join logic                | Tier 1 |

## Tier Classification

- **Tier 1 — Direct pi replacement exists.** Near-copy of a pi export.
  Action: drop the hand-rolled code, add the pi import.
- **Tier 2 — Common pattern, could be shared.** Same pattern in 2+ extensions.
  Action: flag to user ("appears in N extensions — worth extracting?").
  Don't extract without approval.
- **Tier 3 — Genuinely domain-specific.** Shell parsing, custom caching, etc.
  Action: keep, document why.

## Edge Cases

- Extension uses `ExtensionAPI` but doesn't list `@earendil-works/pi-coding-agent`
  in peerDeps → already a bug. Report as Tier 1.
- pi's `getAgentDir` doesn't match extension's custom fallback → document the
  delta, decide if composable.
- Function looks redundant but has extra behavior (e.g. also normalizes slashes) →
  can pi's version be composed? Only flag as redundant if pi's is a true superset.
