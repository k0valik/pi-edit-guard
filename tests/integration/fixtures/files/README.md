# Integration Test Fixture Files

This directory contains deliberately "funky" source files designed to trigger a wide variety of edit tool behaviors during live session recording. Do NOT edit these files manually after the initial recording session.

## Files

| #   | File                         | Primary Target                            | Secondary Targets                   |
| --- | ---------------------------- | ----------------------------------------- | ----------------------------------- |
| 1   | `01-large-markdown.md`       | Fuzzy match on numbered section headers   | Long lines, tables, code blocks     |
| 2   | `02-python-mixed-indent.py`  | Mixed tab/space indentation normalization | Function definitions, class methods |
| 3   | `03-typescript-complex.ts`   | Generic type edits, nested interfaces     | Abstract classes, deep nesting      |
| 4   | `04-mjs-wrong-indent.mjs`    | Inconsistent indentation (tabs vs spaces) | ESM imports, class methods          |
| 5   | `05-bom-latin1.txt`          | BOM preservation on write                 | UTF-8 special chars                 |
| 6   | `06-crlf-endings.txt`        | CRLF preservation in untouched regions    | Windows line endings                |
| 7   | `07-trailing-whitespace.txt` | Trailing space/tab stripping              | `line_trimmed` pass                 |
| 8   | `08-duplicate-blocks.txt`    | Ambiguous match requiring anchor          | 3x identical function blocks        |
| 9   | `09-unicode-special.txt`     | Unicode normalization                     | RTL, zero-width, emoji              |
| 10  | `10-very-long-lines.ts`      | Long line fuzzy matching                  | Token estimation limits             |
| 11  | `11-nested-structures.json`  | Deep JSON path edits                      | Nested objects, arrays              |
| 12  | `12-comments-like-code.py`   | Avoid matching inside comments/strings    | SQL in strings, code in comments    |
| 13  | `13-overlapping-targets.ts`  | Overlapping edit rejection                | Import blocks, function bodies      |
| 14  | `14-noop-and-near-noop.txt`  | No-op detection                           | Identical text, reordered keys      |
| 15  | `15-ambiguous-anchors.ts`    | Anchor window disambiguation              | 3x identical handler blocks         |
| 16  | `16-recovery-scenarios.ts`   | Retry/backoff recovery paths               | Circuit breaker, fallback chains    |
| 17  | `17-edge-cases.json`         | Mixed types, nulls, booleans               | Nested edge values                  |
| 18  | `18-quoting-escaping.sh`     | Shell quoting and escape sequences         | Heredoc delimiters, single quotes    |
| 19  | `19-multiline-strings.js`    | Template literals and multiline strings     | Nested interpolation, long strings   |
| 20  | `20-final-edge-cases.txt`    | Mixed line endings and whitespace          | Blank lines, trailing content       |
| 21  | `21-indentation-nightmare.py`| Mixed tabs/spaces and alignment            | Nested blocks, continuation lines    |
| 22  | `22-regex-patterns.txt`      | Regex metacharacters and escaping          | Character classes, anchors, flags    |
| 23  | `23-comment-strings-astray.sh`| Strings and comments in shell scripts     | Quoted vars, inline comments         |
| 24  | `24-nested-ternaries.js`     | Deeply nested ternary expressions          | Conditional chains, implicit returns |
| 25  | `25-heredoc-nowdoc.sh`       | Heredoc/nowdoc delimiter collisions        | Variable expansion, quoted heredocs  |

## Recording Session Prompt Ideas

When you open a new pi session to record failures, ask the model to perform edits that target these files. Here are prompt ideas per file:

### 01-large-markdown.md

- "Replace the Introduction section header with ## Overview"
- "Change the installation steps from 1. 2. 3. to a. b. c."
- "Add a new subsection 2.3 between 2.2 and 3"
- "Replace the table headers with Name, Value, Type"
- "Update the API Reference section to say REST API"

### 02-python-mixed-indent.py

- "Change the DataProcessor class name to ContentProcessor"
- "Replace MAX_RETRIES with MAX_ATTEMPTS everywhere"
- "Fix the indentation of the _backoff method to use 4 spaces"
- "Add type hints to the process_batch method"
- "Replace the logger setup with structlog"

### 03-typescript-complex.ts

- "Change BaseProcessor to AbstractProcessor"
- "Add a cancel() method to the BaseProcessor class"
- "Replace TInput with TSource in the JsonProcessor class"
- "Update the createProcessor function to accept a config object"
- "Add error handling for network failures in _makeRequest"

### 04-mjs-wrong-indent.mjs

- "Fix all indentation to use 4 spaces consistently"
- "Rename FileProcessor to ContentProcessor"
- "Replace readFileSync with promises.readFile"
- "Add a progress callback option"
- "Change the default OUTPUT_DIR to ./dist"

### 05-bom-latin1.txt

- "Add a new Section 8 before the conclusion"
- "Change the BOM detection explanation to mention UTF-16"
- "Replace 'café' with 'cafe' everywhere"
- "Add a paragraph about byte order marks in the introduction"
- "Update the code block to use stripBom from a library"

### 06-crlf-endings.txt

- "Convert this file to Unix line endings"
- "Add a blank line before Section 3"
- "Replace CRLF with LF in the code block"
- "Change 'CRLF' to 'CRLF/LF' in all headers"
- "Remove trailing CR from the last line"

### 07-trailing-whitespace.txt

- "Remove all trailing whitespace from this file"
- "Change 'hello world ' to 'hello world' everywhere"
- "Add trailing tabs to all lines in Section 3"
- "Normalize all indentation to 4 spaces"
- "Replace tab-indented lines with space-indented lines"

### 08-duplicate-blocks.txt

- "Replace the first handleRequest function with async version"
- "Add error handling to the second duplicate block"
- "Change 'processPayload' to 'transformPayload' in all three blocks"
- "Add a return type annotation to the third block only"
- "Rename the third Template Block A to Template Block A Prime"

### 09-unicode-special.txt

- "Replace all accented characters with ASCII equivalents"
- "Add emoji support to the section headers"
- "Normalize all Unicode to NFC form"
- "Remove all zero-width characters from the file"
- "Add bidirectional text markers to Section 5"

### 10-very-long-lines.ts

- "Break the veryLongString into multiple concatenated lines"
- "Replace the template literal with string concatenation"
- "Split the SQL query into multiple lines"
- "Add line breaks to the chainedMethodCalls"
- "Wrap the pathOperations at 80 characters"

### 11-nested-structures.json

- "Add a new 'monitoring' section at the top level"
- "Change all 'enabled' values to false"
- "Add retry configuration to the database connection"
- "Replace the endpoints array with an object keyed by path"
- "Add a 'version' field to all nested objects"

### 12-comments-like-code.py

- "Uncomment the authenticate function and add type hints"
- "Replace the SQL comments with actual SQLAlchemy queries"
- "Convert the deploy commands to a Python list"
- "Add docstrings to all commented-out functions"
- "Move the commented code into actual implementation"

### 13-overlapping-targets.ts

- "Add error handling to the processUserRequest function"
- "Replace the UserService class with a functional approach"
- "Add a new method to the config object without changing existing keys"
- "Remove the complexConfig export"
- "Change all console.log calls to use a logger"

### 14-noop-and-near-noop.txt

- "Reorder the keys in all object literals alphabetically"
- "Replace all 'const' with 'let' where the value doesn't change"
- "Add JSDoc comments to all functions"
- "Change all single quotes to double quotes"
- "Add type annotations to all variable declarations"

### 15-ambiguous-anchors.ts

- "Replace handleConnection with handleClient in the first block only"
- "Add options parameter to the second handleConnection"
- "Change console.log to use a logger in the third block"
- "Add error handling to handleConnectionModified"
- "Rename uniqueMiddleware to authMiddleware"

## Post-Recording Steps

1. After the recording session, copy the JSONL to `/tmp/`
2. Run the extraction script: `node scripts/extract-session-fixtures.mjs`
3. Inspect `src/__tests__/integration/fixtures/session-failures.json`
4. Verify file contents match the committed versions in this directory
5. Build replay tests against the extracted fixtures
