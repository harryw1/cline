import { Logger } from "@/shared/services/Logger"
import { EmbeddingService } from "./EmbeddingService"
import type { KnowledgeDatabase } from "./KnowledgeDatabase"

export type SourceType = "conversation" | "document" | "knowledge"

export interface SearchResult {
	sourceType: string
	sourceId: string
	content: string
	similarity: number
	metadata: Record<string, any>
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dotProduct = 0
	let normA = 0
	let normB = 0
	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB)
	if (denominator === 0) {
		return 0
	}
	return dotProduct / denominator
}

export class VectorSearch {
	private db: KnowledgeDatabase
	private embeddingService: EmbeddingService

	constructor(db: KnowledgeDatabase, embeddingService: EmbeddingService) {
		this.db = db
		this.embeddingService = embeddingService
	}

	async store(params: {
		sourceType: SourceType
		sourceId: string
		content: string
		embedding: Float32Array
		metadata?: Record<string, any>
	}): Promise<void> {
		const now = Date.now()
		const embeddingBuffer = EmbeddingService.toBuffer(params.embedding)
		const metadataJson = JSON.stringify(params.metadata ?? {})

		const stmt = this.db.getDb().prepare(`
			INSERT OR REPLACE INTO embeddings (source_type, source_id, content, embedding, metadata, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`)

		stmt.run(params.sourceType, params.sourceId, params.content, embeddingBuffer, metadataJson, now, now)
	}

	async search(params: { query: string; sourceType?: SourceType; topK?: number; threshold?: number }): Promise<SearchResult[]> {
		const topK = params.topK ?? 5
		const threshold = params.threshold ?? 0.7

		const queryEmbedding = await this.embeddingService.embed(params.query)
		if (!queryEmbedding) {
			Logger.warn("VectorSearch: Failed to embed query, returning empty results")
			return []
		}

		let sql = "SELECT source_type, source_id, content, embedding, metadata FROM embeddings"
		const sqlParams: any[] = []

		if (params.sourceType) {
			sql += " WHERE source_type = ?"
			sqlParams.push(params.sourceType)
		}

		const rows = this.db
			.getDb()
			.prepare(sql)
			.all(...sqlParams) as Array<{
			source_type: string
			source_id: string
			content: string
			embedding: Buffer
			metadata: string
		}>

		const results: SearchResult[] = []

		for (const row of rows) {
			const storedEmbedding = EmbeddingService.fromBuffer(row.embedding)
			const similarity = cosineSimilarity(queryEmbedding, storedEmbedding)

			if (similarity >= threshold) {
				results.push({
					sourceType: row.source_type,
					sourceId: row.source_id,
					content: row.content,
					similarity,
					metadata: JSON.parse(row.metadata),
				})
			}
		}

		results.sort((a, b) => b.similarity - a.similarity)
		return results.slice(0, topK)
	}

	async deleteBySource(sourceType: string, sourceId: string): Promise<void> {
		this.db.getDb().prepare("DELETE FROM embeddings WHERE source_type = ? AND source_id = ?").run(sourceType, sourceId)
	}
}
