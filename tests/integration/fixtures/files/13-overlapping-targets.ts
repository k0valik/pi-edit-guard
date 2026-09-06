// Overlapping Edit Targets Test File
// This file contains regions where multiple edits would overlap.
// Tests that the edit tool correctly rejects overlapping edits
// or applies them in a safe order.

import { Request, Response, NextFunction } from "express";
import { z } from "zod";

// ─── Overlapping Region 1: Import Block ─────────────────────────────────────
// Edit A targets the entire import block
// Edit B targets just the express import
// These overlap because B is contained in A

import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "ioredis";
import { EventEmitter } from "events";

// ─── Overlapping Region 2: Function Signature and Body ──────────────────────
// Edit A changes the function name and parameter list
// Edit B changes the return type annotation
// These overlap at the function signature line

async function processUserRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const { userId, action, payload } = req.body;
		
		// Validate input
		const schema = z.object({
			userId: z.string().uuid(),
			action: z.enum(["create", "update", "delete"]),
			payload: z.record(z.unknown()).optional(),
		});
		
		const validated = schema.parse({ userId, action, payload });
		
		// Check permissions
		const hasPermission = await checkPermission(req.user, validated.action, "users");
		if (!hasPermission) {
			return res.status(403).json({ error: "Forbidden" });
		}
		
		// Process the request
		const result = await userService[validated.action](validated.userId, validated.payload);
		
		return res.status(200).json({ success: true, data: result });
	} catch (error) {
		if (error instanceof z.ZodError) {
			return res.status(400).json({ error: "Validation failed", details: error.errors });
		}
		return res.status(500).json({ error: "Internal server error" });
	}
}

// ─── Overlapping Region 3: Class Definition ─────────────────────────────────
// Edit A adds a new method to the class
// Edit B modifies the constructor and adds an instance variable
// These overlap in the class body

class UserService {
	private db: Redis;
	private supabase: ReturnType<typeof createClient>;
	private cache: Map<string, unknown>;
	private logger: Console;

	constructor(config: { redis: Redis; supabase: ReturnType<typeof createClient> }) {
		this.db = config.redis;
		this.supabase = config.supabase;
		this.cache = new Map();
		this.logger = console;
	}

	async create(userData: CreateUserInput): Promise<User> {
		const id = crypto.randomUUID();
		const user = { id, ...userData, created_at: new Date().toISOString() };
		await this.db.set(`user:${id}`, JSON.stringify(user));
		return user as User;
	}

	async update(id: string, updates: Partial<User>): Promise<User> {
		const existing = await this.findById(id);
		if (!existing) {
			throw new Error("User not found");
		}
		const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
		await this.db.set(`user:${id}`, JSON.stringify(updated));
		return updated as User;
	}

	async delete(id: string): Promise<void> {
		const existing = await this.findById(id);
		if (!existing) {
			throw new Error("User not found");
		}
		await this.db.del(`user:${id}`);
	}

	private async findById(id: string): Promise<User | null> {
		const data = await this.db.get(`user:${id}`);
		return data ? JSON.parse(data) : null;
	}
}

// ─── Overlapping Region 4: Object Literal ───────────────────────────────────
// Edit A replaces the entire config object
// Edit B replaces just the database section
// These overlap because B's target is inside A's target

const config = {
	app: {
		name: "myapp",
		version: "1.0.0",
		env: "production",
	},
	database: {
		host: "localhost",
		port: 5432,
		name: "app_db",
		pool: {
			min: 2,
			max: 10,
		},
	},
	cache: {
		driver: "redis",
		host: "localhost",
		port: 6379,
	},
	features: {
		newAuth: true,
		betaUI: false,
		experimentalApi: true,
	},
};

// ─── Non-overlapping Region for Control ─────────────────────────────────────
// These edits are far apart and should not overlap

const unrelated1 = "This is a standalone string that should not overlap with anything.";
const unrelated2 = "Another standalone string for control testing.";

// ─── Edge Case: Nested Overlaps ─────────────────────────────────────────────
// Three-way overlap scenario
// Edit A: outer block
// Edit B: middle block  
// Edit C: inner block
// All three overlap at different levels

const complexConfig = {
	server: {
		host: "0.0.0.0",
		port: 3000,
		tls: {
			enabled: true,
			cert: "/path/to/cert.pem",
			key: "/path/to/key.pem",
		},
	},
};

export { UserService, config, complexConfig };
