import * as fs from "fs/promises"
import { Logger } from "@/shared/services/Logger"
import type { EmbeddingService } from "./EmbeddingService"
import type { KnowledgeDatabase } from "./KnowledgeDatabase"
import type { VectorSearch } from "./VectorSearch"

export interface KnowledgeEntry {
	category: string
	key: string
	value: string
	metadata: Record<string, any>
	createdAt: number
	updatedAt: number
}

export interface KnowledgeSearchResult extends KnowledgeEntry {
	similarity: number
}

export class UserKnowledgeBase {
	private db: KnowledgeDatabase
	private vectorSearch: VectorSearch
	private embeddingService: EmbeddingService

	constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService) {
		this.db = db
		this.vectorSearch = vectorSearch
		this.embeddingService = embeddingService
	}

	async set(category: string, key: string, value: string, metadata?: Record<string, any>): Promise<void> {
		const now = Date.now()
		const metadataJson = JSON.stringify(metadata ?? {})

		this.db
			.getDb()
			.prepare(
				`INSERT OR REPLACE INTO user_knowledge (category, key, value, metadata, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(category, key, value, metadataJson, now, now)

		// Update embedding
		const embedding = await this.embeddingService.embed(`${category}: ${key} - ${value}`)
		if (embedding) {
			await this.vectorSearch.store({
				sourceType: "knowledge",
				sourceId: `${category}:${key}`,
				content: value,
				embedding,
				metadata: { category, key, ...metadata },
			})
		}
	}

	async get(category: string, key: string): Promise<string | null> {
		const row = this.db
			.getDb()
			.prepare("SELECT value FROM user_knowledge WHERE category = ? AND key = ?")
			.get(category, key) as { value: string } | undefined
		return row?.value ?? null
	}

	async delete(category: string, key: string): Promise<void> {
		this.db.getDb().prepare("DELETE FROM user_knowledge WHERE category = ? AND key = ?").run(category, key)
		await this.vectorSearch.deleteBySource("knowledge", `${category}:${key}`)
	}

	async listCategory(category: string): Promise<KnowledgeEntry[]> {
		const rows = this.db
			.getDb()
			.prepare("SELECT category, key, value, metadata, created_at, updated_at FROM user_knowledge WHERE category = ?")
			.all(category) as Array<{
			category: string
			key: string
			value: string
			metadata: string
			created_at: number
			updated_at: number
		}>

		return rows.map((row) => ({
			category: row.category,
			key: row.key,
			value: row.value,
			metadata: JSON.parse(row.metadata),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}))
	}

	async listCategories(): Promise<string[]> {
		const rows = this.db.getDb().prepare("SELECT DISTINCT category FROM user_knowledge ORDER BY category").all() as Array<{
			category: string
		}>
		return rows.map((r) => r.category)
	}

	async search(
		query: string,
		options?: {
			category?: string
			topK?: number
		},
	): Promise<KnowledgeSearchResult[]> {
		try {
			const results = await this.vectorSearch.search({
				query,
				sourceType: "knowledge",
				topK: options?.topK ?? 5,
			})

			return results
				.filter((r) => {
					if (!options?.category) {
						return true
					}
					return r.metadata.category === options.category
				})
				.map((r) => ({
					category: r.metadata.category as string,
					key: r.metadata.key as string,
					value: r.content,
					metadata: r.metadata,
					createdAt: 0,
					updatedAt: 0,
					similarity: r.similarity,
				}))
		} catch (error) {
			Logger.warn(`UserKnowledgeBase: Search failed: ${error}`)
			return []
		}
	}

	async importFromMarkdown(filePath: string, category?: string): Promise<number> {
		const cat = category ?? "general"
		let count = 0

		try {
			const content = await fs.readFile(filePath, "utf8")
			const lines = content.split("\n")
			let currentKey = ""
			let currentValue: string[] = []

			for (const line of lines) {
				const headingMatch = line.match(/^#{1,3}\s+(.+)/)
				if (headingMatch) {
					// Save previous entry
					if (currentKey && currentValue.length > 0) {
						await this.set(cat, currentKey, currentValue.join("\n").trim())
						count++
					}
					currentKey = headingMatch[1].trim()
					currentValue = []
				} else if (currentKey) {
					currentValue.push(line)
				}
			}

			// Save last entry
			if (currentKey && currentValue.length > 0) {
				await this.set(cat, currentKey, currentValue.join("\n").trim())
				count++
			}
		} catch (error) {
			Logger.warn(`UserKnowledgeBase: Failed to import from ${filePath}: ${error}`)
		}

		return count
	}

	async exportToMarkdown(): Promise<string> {
		const categories = await this.listCategories()
		const parts: string[] = ["# Knowledge Base\n"]

		for (const category of categories) {
			parts.push(`\n## ${category}\n`)
			const entries = await this.listCategory(category)
			for (const entry of entries) {
				parts.push(`### ${entry.key}\n`)
				parts.push(`${entry.value}\n`)
			}
		}

		return parts.join("\n")
	}
}
