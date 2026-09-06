# Work Queue

Work ALL tickets in this session, top to bottom, before restoring anything.
Tickets are intentionally written the way real requests arrive — if
something is ambiguous, make your best call and note it at the end of your
ticket report. Read `00-HOUSE-RULES.md` first.

---

## Ticket 1 — Docs refresh (`01-large-markdown.md`)

Marketing wants the docs to stop embarrassing them. Replace the Installation
section title with "Setup" and modernize the API Reference header (they keep
saying "REST API Reference" in meetings). There's also a subsection gap
between 2.3 and 3 — product wants a 2.4 about Troubleshooting inserted, and
the table of contents updated to match. Do it in one pass if you can; the
file has been touched by three people and nobody remembers what's where.

## Ticket 2 — Style cleanup sprint (`02-python-mixed-indent.py`, `04-mjs-wrong-indent.mjs`)

Two files failed the new CI style gate. Normalize indentation to 4 spaces in
both, and while you're in there: the processor class names are inconsistent
across the two languages — align them on one name. Also swap the retry limit
constant to a better name (pick something clearer than the current one) in
both files so they stay in sync.

## Ticket 3 — Processor refactor (`03-typescript-complex.ts`)

Architecture decision from last Thursday: `BaseProcessor` becomes
`AbstractBaseProcessor`, and `createProcessor` should hand back a
`JsonProcessor` directly instead of the generic type. The generic parameter
in JsonProcessor needs renaming too — `TInput` reads like Java. Add a
`cancel()` method to the base class while you're there; QA filed three bugs
last month that all needed one.

## Ticket 4 — Encoding complaints (`05-bom-latin1.txt`, `06-crlf-endings.txt`)

Downstream tooling chokes on these two. First file: add a "Section 8" before
the conclusion, and someone complained the accented characters break their
importer — normalize those to plain ASCII. Second file: convert it to Unix
line endings entirely and drop any stray carriage returns. There's also a
blank line missing before Section 3 in one of them; fix whichever has it.

## Ticket 5 — Dedup pass (`08-duplicate-blocks.txt`, `15-ambiguous-anchors.ts`)

Code review flagged copy-paste artifacts. In the first file, make the first
handleRequest block async and add error handling to the second duplicate
block — leave the third alone except for adding a return type. In the second
file, the connection handlers need renaming: first block's handler becomes
handleClient, and the *modified* variant gets options parameter handling.
Careful: several of these blocks look nearly identical; the review comments
are specific about which one is which.

## Ticket 6 — String hygiene (`10-very-long-lines.ts`, `19-multiline-strings.js`)

Linting wants long lines broken up. Break `veryLongString` into concatenated
lines under 80 chars, split the SQL query the same way, wrap
`pathOperations`. In the JS file: both template literals become regular
string concatenation (style guide banned tagged templates last quarter),
and the chained method calls need line breaks for readability.

## Ticket 7 — Config evolution (`11-nested-structures.json`, `17-edge-cases.json`)

Product shipped two config changes. Both files: flip every `enabled` flag to
false (feature freeze), add a `monitoring` section at the top level of the
first file, and give the database connection a retry config. In the second
file add a `cache` section right after `database`, replace empty-string
values with null, and timestamp every object. Match the existing config
style exactly — the parser is strict.

## Ticket 8 — Legacy archaeology (`12-comments-like-code.py`, `13-overlapping-targets.ts`)

Two graves to dig up. Uncomment and revive the authenticate function in the
Python file — it should work as-is per the original author, and convert its
old SQL string comments into real SQLAlchemy queries. In the TS file: add
error handling to processUserRequest, replace UserService with the
functional approach described in its own docstring, add the new method to
the config object, and remove the complexConfig export (nothing imports it
anymore — probably).

## Ticket 9 — Whitespace atrocity audit (`07-trailing-whitespace.txt`, `20-final-edge-cases.txt`, `21-indentation-nightmare.py`)

The pre-commit hook was disabled for months. All three files: remove
trailing whitespace, normalize line endings to LF, drop whitespace-only
lines, and standardize indentation to 4 spaces (tabs out). In the final
edge-cases file also remove empty sections and de-duplicate the repeated
headers. In the Python file add type hints to every method signature while
you're in there — mypy is next quarter's problem, get ahead of it.

## Ticket 10 — Pattern maintenance (`22-regex-patterns.txt`, `18-quoting-escaping.sh`, `09-unicode-special.txt`, `16-recovery-scenarios.ts`, `14-noop-and-near-noop.txt`)

Mixed bag from the backlog groomer. Simplify EMAIL_STRICT; add
PHONE_INTERNATIONAL below it; merge DATE_ISO and DATE_US into one pattern
with a comment explaining the format. Fix all variable quoting in the shell
file to double quotes and replace the `$(...)` calls with backticks (team
convention, don't ask). Strip accented characters to ASCII in the unicode
file and remove zero-width characters wherever they hide. In recovery
scenarios: unescape message1's quotes, normalize formatted1's whitespace,
flip the async function to regular. In the noop file: reorder object keys
alphabetically and switch single quotes to double quotes — reviewers want
it consistent even though nothing functionally changes.
