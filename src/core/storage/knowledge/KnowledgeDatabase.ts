import Database from "better-sqlite3"
import * as fs from "fs"
import { existsSync, mkdirSync, unlinkSync } from "fs"
import os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

const CURRENT_SCHEMA_VERSION = 1
const STALE_LOCK_TIMEOUT = 1 * 60 * 1000 // 1 minute

export class KnowledgeDatabase {
	private db!: Database.Database
	private dbPath: string

	constructor(dataDir?: string) {
		const dir = dataDir ?? path.join(os.homedir(), ".cline", "data")
		this.dbPath = path.join(dir, "knowledge.db")

		const dbDir = path.dirname(this.dbPath)
		try {
			mkdirSync(dbDir, { recursive: true })
		} catch (error) {
			Logger.error(`CRITICAL ERROR: Failed to create knowledge database directory ${dbDir}:`, error)
			throw new Error(`Failed to create knowledge database directory: ${error}`)
		}

		try {
			this.initializeDatabaseWithLockSync()
		} catch (error) {
			Logger.error(`CRITICAL ERROR: Failed to initialize knowledge database at ${this.dbPath}:`, error)
			throw new Error(`Failed to initialize knowledge database: ${error}`)
		}
	}

	private initializeDatabaseWithLockSync(): void {
		const lockFile = `${this.dbPath}.lock`

		this.cleanupStaleLockSync(lockFile)

		try {
			let fd: number | null = null

			try {
				fd = fs.openSync(lockFile, "wx")
				fs.writeFileSync(fd, Date.now().toString())

				const dbExists = existsSync(this.dbPath)

				if (!dbExists) {
					this.db = new Database(this.dbPath)
					this.initializeSchema()
				} else {
					this.db = new Database(this.dbPath)
					this.runMigrations()
				}
			} finally {
				if (fd !== null) {
					fs.closeSync(fd)
				}
				try {
					unlinkSync(lockFile)
				} catch {}
			}
		} catch (error: any) {
			if (error.code === "EEXIST") {
				const delay = 100 + Math.random() * 100
				this.sleepSync(delay)
				this.initializeDatabaseWithLockSync()
				return
			}
			throw error
		}
	}

	private sleepSync(ms: number): void {
		const sab = new SharedArrayBuffer(4)
		const ia = new Int32Array(sab)
		Atomics.wait(ia, 0, 0, Math.max(0, Math.floor(ms)))
	}

	private cleanupStaleLockSync(lockFile: string): void {
		try {
			if (!existsSync(lockFile)) {
				return
			}

			try {
				const timestampStr = fs.readFileSync(lockFile, "utf8").trim()
				const timestamp = Number.parseInt(timestampStr, 10)

				if (isNaN(timestamp) || Date.now() - timestamp > STALE_LOCK_TIMEOUT) {
					unlinkSync(lockFile)
					Logger.warn(`Removed stale knowledge database lock file: ${lockFile}`)
				}
			} catch {
				unlinkSync(lockFile)
				Logger.warn(`Removed unreadable knowledge database lock file: ${lockFile}`)
			}
		} catch (error: any) {
			if (error.code !== "ENOENT") {
				Logger.warn(`Error checking lock file ${lockFile}:`, error)
			}
		}
	}

	private initializeSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);

			INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ${CURRENT_SCHEMA_VERSION});

			CREATE TABLE IF NOT EXISTS embeddings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_type TEXT NOT NULL CHECK (source_type IN ('conversation', 'document', 'knowledge')),
				source_id TEXT NOT NULL,
				content TEXT NOT NULL,
				embedding BLOB NOT NULL,
				metadata TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(source_type, source_id)
			);

			CREATE TABLE IF NOT EXISTS conversation_memory (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id TEXT NOT NULL UNIQUE,
				summary TEXT NOT NULL,
				key_topics TEXT DEFAULT '[]',
				message_count INTEGER DEFAULT 0,
				model_used TEXT,
				workspace_path TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS document_index (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL,
				file_hash TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_content TEXT NOT NULL,
				workspace_path TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(file_path, chunk_index)
			);

			CREATE TABLE IF NOT EXISTS user_knowledge (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				category TEXT NOT NULL DEFAULT 'general',
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				metadata TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(category, key)
			);

			CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
			CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(source_type);
			CREATE INDEX IF NOT EXISTS idx_conv_memory_task ON conversation_memory(task_id);
			CREATE INDEX IF NOT EXISTS idx_conv_memory_workspace ON conversation_memory(workspace_path);
			CREATE INDEX IF NOT EXISTS idx_doc_index_path ON document_index(file_path);
			CREATE INDEX IF NOT EXISTS idx_doc_index_workspace ON document_index(workspace_path);
			CREATE INDEX IF NOT EXISTS idx_user_knowledge_category ON user_knowledge(category);
		`)
	}

	private getSchemaVersion(): number {
		try {
			const row = this.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
				| { version: number }
				| undefined
			return row?.version ?? 0
		} catch {
			return 0
		}
	}

	private setSchemaVersion(version: number): void {
		this.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)").run(version)
	}

	private runMigrations(): void {
		const currentVersion = this.getSchemaVersion()

		if (currentVersion === 0) {
			// Database exists but has no schema_version table — fresh init needed
			this.initializeSchema()
			return
		}

		if (currentVersion < CURRENT_SCHEMA_VERSION) {
			// Future migrations go here
			// if (currentVersion < 2) { ... }
			this.setSchemaVersion(CURRENT_SCHEMA_VERSION)
		}
	}

	getDb(): Database.Database {
		return this.db
	}

	close(): void {
		this.db.close()
	}
}
