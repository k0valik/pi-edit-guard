#!/usr/bin/env node
/**
 * ESM module with intentionally wrong indentation.
 * Mixes tabs, spaces, and inconsistent levels.
 * Some blocks are indented with tabs, others with 2 spaces, others with 4.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve, basename, extname, sep } from "node:path";
import { randomInt, randomUUID } from "node:crypto";

const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname), "config.json");
const OUTPUT_DIR = join(dirname(new URL(import.meta.url).pathname), "output");

class FileProcessor {
	constructor(options = {}) {
		this.config = options.config ?? {};
		this.cache = new Map();
		this.stats = {
			processed: 0,
			failed: 0,
			skipped: 0,
		};
	}

	async processFile(filePath) {
		if (!existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		const stat = statSync(filePath);
		if (!stat.isFile()) {
			this.stats.skipped++;
			return null;
		}

		try {
			const content = readFileSync(filePath, "utf-8");
			const result = this.transform(content);
			const outputPath = this.getOutputPath(filePath);
			mkdirSync(dirname(outputPath), { recursive: true });
			writeFileSync(outputPath, result, "utf-8");
			this.stats.processed++;
			return { input: filePath, output: outputPath, size: result.length };
		} catch (error) {
			this.stats.failed++;
			console.error(`Failed to process ${filePath}:`, error.message);
			return null;
		}
	}

	transform(content) {
		const lines = content.split(/\r?\n/);
		const transformed = lines.map((line) => {
			if (line.trim().startsWith("//")) {
				return this.transformComment(line);
			}
			return this.transformLine(line);
		});
		return transformed.join("\n");
	}

	transformComment(line) {
		return line.replace(/\/\/\s*TODO[:\s]/i, "// FIXME: ");
	}

	transformLine(line) {
		return line
			.replace(/\bconst\b/g, "let")
			.replace(/\blet\b/g, "const")
			.replace(/\bvar\b/g, "let");
	}

	getOutputPath(inputPath) {
		const parsed = parseInputPath(inputPath);
		return join(OUTPUT_DIR, parsed.dir, `${parsed.name}.out${parsed.ext}`);
	}

	getStats() {
		return { ...this.stats };
	}
}

function parseInputPath(filePath) {
	const ext = extname(filePath);
	const name = basename(filePath, ext);
	const dir = dirname(filePath);
	return { name, ext, dir };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: node wrong-indent.mjs <file> [files...]");
		process.exit(1);
	}

	const processor = new FileProcessor({
		config: { verbose: true, dryRun: false },
	});

	const results = [];
	for (const file of args) {
		const result = await processor.processFile(resolve(file));
		if (result) {
			results.push(result);
		}
	}

	console.log(`Processed ${results.length} files`);
	console.log("Stats:", processor.getStats());

	return results;
}

export { FileProcessor, parseInputPath };
export default main();
