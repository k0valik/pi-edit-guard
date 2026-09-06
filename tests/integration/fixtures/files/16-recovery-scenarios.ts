// Recovery and Fuzzy Match Scenarios
// This file contains text that is intentionally close to but not exactly
// what the model might generate, testing fuzzy matching passes.

import { Client } from "./client";
import { Logger } from "./logger";
import { Config } from "./config";

// ─── Scenario 1: Backslash Escape Mismatch ───────────────────────────────────
// The model might forget to escape a quote in a string literal.

const message1 = "She said \"hello\" to me";
const message1_fuzzy = 'She said "hello" to me';

// ─── Scenario 2: Whitespace Drift ───────────────────────────────────────────
// Extra spaces, tabs, or missing spaces that fuzzy should normalize.

const formatted1 = "hello   world   foo   bar";
const formatted2 = "hello world foo bar";

const indented1 = "    code block with spaces";
const indented2 = "\tcode block with tab";

// ─── Scenario 3: Line Boundary Crossing ─────────────────────────────────────
// Text that spans lines differently than expected.

const multiLine1 = `line1
line2
line3`;

const multiLine2 = `line1 line2
line3`;

// ─── Scenario 4: Unicode Normalization ─────────────────────────────────────
// Composed vs decomposed characters.

const composed = "café résumé naïve";
const decomposed = "cafe\u0301 resume\u0301 naive\u0308";

// ─── Scenario 5: Trailing Comment Drift ─────────────────────────────────────
// Comments appended to lines that might be trimmed.

const withComment1 = "const x = 1; // this is a very long comment that was appended later by another tool and might cause matching issues";
const withComment2 = "const x = 1;";

// ─── Scenario 6: Quote Style Mismatch ───────────────────────────────────────

const singleQuoted = 'single quoted string';
const doubleQuoted = "double quoted string";

// ─── Scenario 7: Semicolon Presence/Absence ──────────────────────────────────

const withSemicolon = "const a = 1;";
const withoutSemicolon = "const a = 1";

// ─── Scenario 8: Brace Style ────────────────────────────────────────────────

const kAndR = `if (true) {
	doSomething();
}`;

const allman = `if (true)
{
	doSomething();
}`;

// ─── Scenario 9: Import Path Style ─────────────────────────────────────────

import { foo } from "./foo.js";
import { bar } from "./bar";

// ─── Scenario 10: Number Format ─────────────────────────────────────────────

const decimal = 1000;
const hex = 0x3E8;
const binary = 0b1111101000;
const octal = 0o1750;

// ─── Scenario 11: Template Literal vs Concatenation ─────────────────────────

const templateStr = `Hello, ${name}!`;
const concatStr = "Hello, " + name + "!";

// ─── Scenario 12: Async/Await vs Promises ───────────────────────────────────

async function asyncVersion() {
	const result = await fetchData();
	return result;
}

function promiseVersion() {
	return fetchData().then((result) => result);
}

// ─── Scenario 13: Arrow Function vs Regular ─────────────────────────────────

const arrowFn = (x) => x * 2;
function regularFn(x) {
	return x * 2;
}

// ─── Scenario 14: Spread vs Object.assign ───────────────────────────────────

const merged1 = { ...obj1, ...obj2 };
const merged2 = Object.assign({}, obj1, obj2);

// ─── Scenario 15: Optional Chaining ─────────────────────────────────────────

const safe1 = obj?.prop?.nested?.value;
const safe2 = obj && obj.prop && obj.prop.nested && obj.prop.nested.value;

export { message1, message1_fuzzy, formatted1, formatted2, indented1, indented2, multiLine1, multiLine2, composed, decomposed, withComment1, withComment2, singleQuoted, doubleQuoted, withSemicolon, withoutSemicolon, kAndR, allman, decimal, hex, binary, octal, templateStr, concatStr, asyncVersion, promiseVersion, arrowFn, regularFn, merged1, merged2, safe1, safe2 };
