// Ambiguous Anchors Test File
// This file tests the anchor window behavior when oldText appears multiple times.
// The model must provide a unique anchor to disambiguate.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Identical Blocks Without Anchors ───────────────────────────────────────
// These blocks are identical and will cause ambiguous match errors
// unless an anchor is provided.

function handleConnection(socket) {
	console.log("New connection established");
	socket.write("Welcome\n");
	socket.on("data", (data) => {
		const message = data.toString().trim();
		if (message === "ping") {
			socket.write("pong\n");
		} else if (message === "quit") {
			socket.end("Goodbye\n");
		} else {
			socket.write(`Unknown command: ${message}\n`);
		}
	});
	socket.on("end", () => {
		console.log("Connection closed");
	});
	socket.on("error", (err) => {
		console.error("Socket error:", err.message);
	});
}

// ─── Middle Section (Unique Anchor Candidate) ───────────────────────────────
// This unique block can serve as an anchor for the first handleConnection.

const uniqueMiddleware = {
	name: "unique-middleware",
	execute: async (context) => {
		context.set("middleware_executed", true);
		return context.next();
	},
};

// ─── Second Identical Block ─────────────────────────────────────────────────
// This is identical to the first handleConnection.
// An anchor pointing to uniqueMiddleware should restrict the search.

function handleConnection(socket) {
	console.log("New connection established");
	socket.write("Welcome\n");
	socket.on("data", (data) => {
		const message = data.toString().trim();
		if (message === "ping") {
			socket.write("pong\n");
		} else if (message === "quit") {
			socket.end("Goodbye\n");
		} else {
			socket.write(`Unknown command: ${message}\n`);
		}
	});
	socket.on("end", () => {
		console.log("Connection closed");
	});
	socket.on("error", (err) => {
		console.error("Socket error:", err.message);
	});
}

// ─── Third Identical Block ──────────────────────────────────────────────────
// Another identical block, making it a 3-way ambiguity.
// An anchor is required to target any specific occurrence.

function handleConnection(socket) {
	console.log("New connection established");
	socket.write("Welcome\n");
	socket.on("data", (data) => {
		const message = data.toString().trim();
		if (message === "ping") {
			socket.write("pong\n");
		} else if (message === "quit") {
			socket.end("Goodbye\n");
		} else {
			socket.write(`Unknown command: ${message}\n`);
		}
	});
	socket.on("end", () => {
		console.log("Connection closed");
	});
	socket.on("error", (err) => {
		console.error("Socket error:", err.message);
	});
}

// ─── Near-Duplicate Block ───────────────────────────────────────────────────
// This block is similar but not identical.
// Tests fuzzy matching when the model provides text that is close but not exact.

function handleConnectionModified(socket, options = {}) {
	console.log("New connection established with options");
	socket.write("Welcome to modified server\n");
	socket.on("data", (data) => {
		const message = data.toString().trim();
		if (message === "ping") {
			socket.write("pong from modified\n");
		} else if (message === "quit") {
			socket.end("Goodbye from modified\n");
		} else if (options.echo) {
			socket.write(`Echo: ${message}\n`);
		} else {
			socket.write(`Unknown command: ${message}\n`);
		}
	});
	socket.on("end", () => {
		console.log("Modified connection closed");
	});
	socket.on("error", (err) => {
		console.error("Modified socket error:", err.message);
	});
}

// ─── Unique Footer ──────────────────────────────────────────────────────────
// This content is unique and can serve as an anchor for the third block.

export { handleConnection, handleConnectionModified, uniqueMiddleware };
