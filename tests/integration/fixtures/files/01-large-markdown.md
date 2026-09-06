# Project Documentation

## Table of Contents

1. [Introduction](#introduction)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [API Reference](#api-reference)
5. [Examples](#examples)
6. [Troubleshooting](#troubleshooting)
7. [Contributing](#contributing)
8. [License](#license)

---

## Introduction

This is a comprehensive documentation file with numbered block headers.
It is designed to test fuzzy matching when the model references
"Section 3.2" or similar identifiers.

### Purpose

The purpose of this project is to demonstrate edit tool behavior
across a variety of file formats and edge cases.

### Scope

- Large files
- Multiple sections
- Numbered headings
- Tables and code blocks

---

## Installation

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Git

### Steps

1. Clone the repository
2. Run `pnpm install`
3. Copy `.env.example` to `.env`
4. Run `pnpm dev`

### Verification

After installation, verify with:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected output: all green.

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| PORT | No | 3000 | Server port |
| HOST | No | 0.0.0.0 | Bind address |
| LOG_LEVEL | No | info | Logging verbosity |
| DATABASE_URL | Yes | - | Database connection string |

### Config File

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "logging": {
    "level": "info",
    "format": "json"
  },
  "features": {
    "beta": false,
    "experimental": true
  }
}
```

---

## API Reference

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00Z"
}
```

### POST /process

Process a payload.

**Request Body:**

```typescript
interface ProcessRequest {
  id: string;
  payload: Record<string, unknown>;
  options?: {
    retries?: number;
    timeout?: number;
  };
}
```

**Response:**

```typescript
interface ProcessResponse {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

### Errors

| Code | Meaning |
|------|---------|
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 429 | Too Many Requests |
| 500 | Internal Server Error |

---

## Examples

### Example 1: Basic Usage

```typescript
import { Client } from "./client";

const client = new Client({ apiKey: "sk-..." });

const result = await client.process({
  id: "req-1",
  payload: { hello: "world" },
});

console.log(result.status);
```

### Example 2: Advanced

```typescript
const stream = client.stream({
  id: "req-2",
  payload: largeObject,
  options: {
    retries: 3,
    timeout: 5000,
  },
});

for await (const chunk of stream) {
  console.log(chunk);
}
```

### Example 3: Error Handling

```typescript
try {
  await client.process({ id: "", payload: null });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error("Invalid input:", error.details);
  } else {
    console.error("Unexpected error:", error);
  }
}
```

---

## Troubleshooting

### Common Issues

1. **Port already in use** — change `PORT` or stop the conflicting process
2. **Database connection failed** — verify `DATABASE_URL` and network access
3. **Out of memory** — increase Node.js memory limit with `--max-old-space-size=4096`

### Debug Mode

Enable debug logging:

```bash
LOG_LEVEL=debug pnpm dev
```

### Logs

Logs are written to `logs/app.log` with rotation.

---

## Contributing

Please read `CONTRIBUTING.md` before submitting PRs.

### Development Workflow

1. Create a feature branch
2. Make changes
3. Run `pnpm check`
4. Open a PR

### Code of Conduct

Be respectful. See `CODE_OF_CONDUCT.md`.

---

## License

MIT License — see `LICENSE` for details.
