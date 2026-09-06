import { describe, it, expect } from "vitest";

describe("repro: ambiguous + missing hints", () => {
  it("ambiguous oldText (no anchor) shows alternatives in diagnostics", async () => {
    const { resolveBlocks } = await import("../../src/edit/pipeline/resolve.js");
    const ambiguousContent = `function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

const uniqueMiddleware = {
\tname: "unique-middleware",
\texecute: async (context) => {
\t\tcontext.set("middleware_executed", true);
\t\treturn context.next();
\t},
};

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

export { handleConnection, uniqueMiddleware };
`;

    const result = resolveBlocks(
      ambiguousContent,
      [
        {
          path: "test.txt",
          oldText:
            'function handleConnection(socket) {\n\tconsole.log("New connection established");\n\tsocket.write("Welcome\\n");',
          newText: "REPLACED",
        },
      ],
      "test.txt",
    );
    expect(result.diagnostics[0]?.status).toBe("ambiguous");
    expect(result.diagnostics[0]?.alternatives?.length).toBeGreaterThanOrEqual(2);
    console.log(
      "ambiguous alternatives:",
      result.diagnostics[0]?.alternatives?.map(
        (a) => `lines ${a.startLine}-${a.endLine} sim=${a.similarity.toFixed(2)}`,
      ),
    );
  });

  it("ambiguous oldText with unique anchor resolves", async () => {
    const { resolveBlocks } = await import("../../src/edit/pipeline/resolve.js");
    const ambiguousContent = `function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

const uniqueMiddleware = {
\tname: "unique-middleware",
\texecute: async (context) => {
\t\tcontext.set("middleware_executed", true);
\t\treturn context.next();
\t},
};

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

export { handleConnection, uniqueMiddleware };
`;
    const result = resolveBlocks(
      ambiguousContent,
      [
        {
          path: "test.txt",
          oldText:
            'function handleConnection(socket) {\n\tconsole.log("New connection established");\n\tsocket.write("Welcome\\n");',
          newText: "REPLACED",
          anchor: "const uniqueMiddleware",
        },
      ],
      "test.txt",
    );
    expect(result.diagnostics[0]?.status).toBe("applied");
  });

  it("missing oldText (no anchor) includes closest candidate in error", async () => {
    const { resolveBlocks } = await import("../../src/edit/pipeline/resolve.js");
    const ambiguousContent = `function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

const uniqueMiddleware = {
\tname: "unique-middleware",
\texecute: async (context) => {
\t\tcontext.set("middleware_executed", true);
\t\treturn context.next();
\t},
};

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

export { handleConnection, uniqueMiddleware };
`;
    const result = resolveBlocks(
      ambiguousContent,
      [{ path: "test.txt", oldText: "this text does not exist", newText: "REPLACED" }],
      "test.txt",
    );
    expect(result.diagnostics[0]?.status).toBe("missing");
    expect(result.errors[0]?.closestCandidate).toBeDefined();
    const c = result.errors[0]!.closestCandidate!;
    expect(c.similarity).toBeGreaterThan(0);
    console.log(
      "missing closestCandidate: lines",
      c.startLine,
      "-",
      c.endLine,
      "sim=",
      c.similarity.toFixed(2),
    );
  });

  it("missing anchor builds near-miss alternatives but error message lacks them", async () => {
    const { resolveBlocks } = await import("../../src/edit/pipeline/resolve.js");
    const ambiguousContent = `function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

const uniqueMiddleware = {
\tname: "unique-middleware",
\texecute: async (context) => {
\t\tcontext.set("middleware_executed", true);
\t\treturn context.next();
\t},
};

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

function handleConnection(socket) {
\tconsole.log("New connection established");
\tsocket.write("Welcome\\n");
\tsocket.on("data", (data) => {
\t\tconst message = data.toString().trim();
\t\tif (message === "ping") {
\t\t\tsocket.write("pong\\n");
\t\t} else if (message === "quit") {
\t\t\tsocket.end("Goodbye\\n");
\t\t} else {
\t\t\tsocket.write(\`Unknown command: \${message}\\n\`);
\t\t}
\t});
\tsocket.on("end", () => {
\t\tconsole.log("Connection closed");
\t});
\tsocket.on("error", (err) => {
\t\tconsole.error("Socket error:", err.message);
\t});
}

export { handleConnection, uniqueMiddleware };
`;
    const result = resolveBlocks(
      ambiguousContent,
      [
        {
          path: "test.txt",
          oldText:
            'function handleConnection(socket) {\n\tconsole.log("New connection established");',
          newText: "REPLACED",
          anchor: "this anchor does not exist",
        },
      ],
      "test.txt",
    );
    expect(result.diagnostics[0]?.status).toBe("missing");
    expect(result.diagnostics[0]?.alternatives?.length).toBeGreaterThanOrEqual(1);
    console.log(
      "missing-anchor alternatives:",
      result.diagnostics[0]?.alternatives?.map(
        (a) =>
          `lines ${a.startLine}-${a.endLine} sim=${a.similarity.toFixed(2)} candidate=${a.candidate.slice(0, 40)}`,
      ),
    );
    // Phase 3: anchor-not-found now includes the closest match in the error text.
    expect(result.errors[0]?.message).toContain("Closest match");
  });

  it("partial apply: first edit succeeds, second edit missing", async () => {
    const { resolveBlocks } = await import("../../src/edit/pipeline/resolve.js");
    const fileContent = `line1\nline2\nline3\n`;
    const result = resolveBlocks(
      fileContent,
      [
        { path: "test.txt", oldText: "line1", newText: "L1" },
        { path: "test.txt", oldText: "lineX", newText: "LX" },
      ],
      "test.txt",
    );
    expect(result.resolved.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const missingDiag = result.diagnostics.find((d) => d.status === "missing");
    expect(missingDiag).toBeDefined();
    expect(missingDiag?.alternatives?.length).toBeGreaterThanOrEqual(1);
    console.log(
      "partial missing alternatives:",
      missingDiag?.alternatives?.map((a) => `lines ${a.startLine}-${a.endLine}`),
    );
  });
});
