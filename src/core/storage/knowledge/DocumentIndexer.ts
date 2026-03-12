import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import type { EmbeddingService } from "./EmbeddingService"
import type { KnowledgeDatabase } from "./KnowledgeDatabase"
import type { VectorSearch } from "./VectorSearch"

export interface IndexingStats {
	filesIndexed: number
	filesSkipped: number
	chunksCreated: number
	errors: string[]
}

export interface DocumentResult {
	filePath: string
	chunkContent: string
	chunkIndex: number
	similarity: number
}

const INDEXABLE_EXTENSIONS = new Set([
	".md",
	".txt",
	".ts",
	".js",
	".py",
	".rs",
	".go",
	".java",
	".json",
	".yaml",
	".yml",
	".toml",
	".cfg",
	".ini",
	".html",
	".css",
	".sql",
	".sh",
	".bash",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".rb",
	".php",
])

const MAX_FILE_SIZE = 100 * 1024 // 100KB
const CHUNK_SIZE = 2000
const CHUNK_OVERLAP = 200

export class DocumentIndexer {
	private db: KnowledgeDatabase
	private vectorSearch: VectorSearch
	private embeddingService: EmbeddingService

	constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService) {
		this.db = db
		this.vectorSearch = vectorSearch
		this.embeddingService = embeddingService
	}

	async indexFile(filePath: string, workspacePath?: string): Promise<void> {
		try {
			const stat = await fs.stat(filePath)
			if (stat.size > MAX_FILE_SIZE) {
				return
			}

			const ext = path.extname(filePath).toLowerCase()
			if (!INDEXABLE_EXTENSIONS.has(ext)) {
				return
			}

			const content = await fs.readFile(filePath, "utf8")
			const hash = crypto.createHash("sha256").update(content).digest("hex")

			// Check if file is already indexed with same hash
			const existing = this.db
				.getDb()
				.prepare("SELECT file_hash FROM document_index WHERE file_path = ? AND chunk_index = 0")
				.get(filePath) as { file_hash: string } | undefined

			if (existing && existing.file_hash === hash) {
				return // File unchanged
			}

			// Remove old chunks for this file
			await this.removeFile(filePath)

			// Chunk the content
			const chunks = this.chunkContent(content, ext)
			const now = Date.now()

			for (let i = 0; i < chunks.length; i++) {
				// Store chunk in document_index table
				this.db
					.getDb()
					.prepare(
						`INSERT OR REPLACE INTO document_index
					(file_path, file_hash, chunk_index, chunk_content, workspace_path, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(filePath, hash, i, chunks[i], workspacePath ?? null, now, now)

				// Generate and store embedding
				const embedding = await this.embeddingService.embed(chunks[i])
				if (embedding) {
					await this.vectorSearch.store({
						sourceType: "document",
						sourceId: `${filePath}:${i}`,
						content: chunks[i],
						embedding,
						metadata: { filePath, chunkIndex: i },
					})
				}
			}
		} catch (error) {
			Logger.warn(`DocumentIndexer: Failed to index file ${filePath}: ${error}`)
		}
	}

	async indexDirectory(
		dirPath: string,
		options?: {
			recursive?: boolean
			respectGitignore?: boolean
			maxFiles?: number
		},
	): Promise<IndexingStats> {
		const recursive = options?.recursive ?? true
		const maxFiles = options?.maxFiles ?? 500
		const stats: IndexingStats = { filesIndexed: 0, filesSkipped: 0, chunksCreated: 0, errors: [] }

		try {
			const files = await this.collectFiles(dirPath, recursive, maxFiles)

			for (const filePath of files) {
				try {
					const ext = path.extname(filePath).toLowerCase()
					if (!INDEXABLE_EXTENSIONS.has(ext)) {
						stats.filesSkipped++
						continue
					}

					await this.indexFile(filePath, dirPath)
					stats.filesIndexed++
				} catch (error) {
					stats.errors.push(`${filePath}: ${error}`)
					stats.filesSkipped++
				}
			}
		} catch (error) {
			stats.errors.push(`Directory scan failed: ${error}`)
		}

		return stats
	}

	async refreshIndex(workspacePath: string): Promise<IndexingStats> {
		const stats: IndexingStats = { filesIndexed: 0, filesSkipped: 0, chunksCreated: 0, errors: [] }

		try {
			// Get all indexed file paths for this workspace
			const rows = this.db
				.getDb()
				.prepare("SELECT DISTINCT file_path FROM document_index WHERE workspace_path = ?")
				.all(workspacePath) as Array<{ file_path: string }>

			for (const row of rows) {
				try {
					// Check if file still exists
					await fs.access(row.file_path)
					await this.indexFile(row.file_path, workspacePath)
					stats.filesIndexed++
				} catch {
					// File was deleted, remove from index
					await this.removeFile(row.file_path)
					stats.filesSkipped++
				}
			}
		} catch (error) {
			stats.errors.push(`Refresh failed: ${error}`)
		}

		return stats
	}

	async removeFile(filePath: string): Promise<void> {
		// Remove document chunks
		this.db.getDb().prepare("DELETE FROM document_index WHERE file_path = ?").run(filePath)

		// Remove associated embeddings
		const rows = this.db
			.getDb()
			.prepare("SELECT source_id FROM embeddings WHERE source_type = 'document' AND source_id LIKE ?")
			.all(`${filePath}:%`) as Array<{ source_id: string }>

		for (const row of rows) {
			await this.vectorSearch.deleteBySource("document", row.source_id)
		}
	}

	async searchDocuments(
		query: string,
		options?: {
			topK?: number
			workspacePath?: string
		},
	): Promise<DocumentResult[]> {
		try {
			const results = await this.vectorSearch.search({
				query,
				sourceType: "document",
				topK: options?.topK ?? 5,
			})

			return results
				.map((r) => ({
					filePath: r.metadata.filePath as string,
					chunkContent: r.content,
					chunkIndex: r.metadata.chunkIndex as number,
					similarity: r.similarity,
				}))
				.filter((r) => {
					if (!options?.workspacePath) {
						return true
					}
					return r.filePath.startsWith(options.workspacePath)
				})
		} catch (error) {
			Logger.warn(`DocumentIndexer: Search failed: ${error}`)
			return []
		}
	}

	private chunkContent(content: string, ext: string): string[] {
		if (ext === ".md") {
			return this.chunkMarkdown(content)
		}
		return this.chunkBySize(content)
	}

	private chunkMarkdown(content: string): string[] {
		const sections = content.split(/^(?=#{1,3}\s)/m)
		const chunks: string[] = []

		for (const section of sections) {
			if (section.trim().length === 0) {
				continue
			}
			if (section.length <= CHUNK_SIZE) {
				chunks.push(section.trim())
			} else {
				chunks.push(...this.chunkBySize(section))
			}
		}

		return chunks.length > 0 ? chunks : this.chunkBySize(content)
	}

	private chunkBySize(content: string): string[] {
		const chunks: string[] = []
		let start = 0

		while (start < content.length) {
			const end = Math.min(start + CHUNK_SIZE, content.length)
			chunks.push(content.slice(start, end))
			start += CHUNK_SIZE - CHUNK_OVERLAP
		}

		return chunks.filter((c) => c.trim().length > 0)
	}

	private async collectFiles(dirPath: string, recursive: boolean, maxFiles: number): Promise<string[]> {
		const files: string[] = []

		const scan = async (dir: string) => {
			if (files.length >= maxFiles) {
				return
			}

			let entries
			try {
				entries = await fs.readdir(dir, { withFileTypes: true })
			} catch {
				return
			}

			for (const entry of entries) {
				if (files.length >= maxFiles) {
					break
				}

				const fullPath = path.join(dir, entry.name)

				// Skip hidden directories and common non-project dirs
				if (entry.isDirectory()) {
					if (
						entry.name.startsWith(".") ||
						entry.name === "node_modules" ||
						entry.name === "__pycache__" ||
						entry.name === "dist" ||
						entry.name === "build" ||
						entry.name === "target" ||
						entry.name === "vendor"
					) {
						continue
					}
					if (recursive) {
						await scan(fullPath)
					}
				} else if (entry.isFile()) {
					files.push(fullPath)
				}
			}
		}

		await scan(dirPath)
		return files
	}
}
