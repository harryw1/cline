import { Logger } from "@/shared/services/Logger"
import type { EmbeddingService } from "./EmbeddingService"
import type { KnowledgeDatabase } from "./KnowledgeDatabase"
import type { VectorSearch } from "./VectorSearch"

export interface MemoryResult {
	taskId: string
	summary: string
	relevantContent: string
	similarity: number
	keyTopics: string[]
}

const MAX_SUMMARY_LENGTH = 2000 // ~500 tokens

export class ConversationMemory {
	private db: KnowledgeDatabase
	private vectorSearch: VectorSearch
	private embeddingService: EmbeddingService

	constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService) {
		this.db = db
		this.vectorSearch = vectorSearch
		this.embeddingService = embeddingService
	}

	async indexConversation(params: {
		taskId: string
		messages: Array<{ role: string; content: string }>
		modelUsed?: string
		workspacePath?: string
	}): Promise<void> {
		try {
			if (await this.isIndexed(params.taskId)) {
				return
			}

			const summary = this.createSummary(params.messages)
			if (!summary) {
				return
			}

			const keyTopics = this.extractKeyTopics(params.messages)
			const now = Date.now()

			// Store in conversation_memory table
			this.db
				.getDb()
				.prepare(
					`INSERT OR REPLACE INTO conversation_memory
				(task_id, summary, key_topics, message_count, model_used, workspace_path, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					params.taskId,
					summary,
					JSON.stringify(keyTopics),
					params.messages.length,
					params.modelUsed ?? null,
					params.workspacePath ?? null,
					now,
					now,
				)

			// Generate and store embedding
			const embedding = await this.embeddingService.embed(summary)
			if (embedding) {
				await this.vectorSearch.store({
					sourceType: "conversation",
					sourceId: params.taskId,
					content: summary,
					embedding,
					metadata: { keyTopics, modelUsed: params.modelUsed },
				})
			}
		} catch (error) {
			Logger.warn(`ConversationMemory: Failed to index conversation ${params.taskId}: ${error}`)
		}
	}

	async searchMemory(
		query: string,
		options?: {
			topK?: number
			workspacePath?: string
		},
	): Promise<MemoryResult[]> {
		try {
			const searchResults = await this.vectorSearch.search({
				query,
				sourceType: "conversation",
				topK: options?.topK ?? 5,
			})

			const results: MemoryResult[] = []

			for (const result of searchResults) {
				const row = this.db
					.getDb()
					.prepare("SELECT task_id, summary, key_topics, workspace_path FROM conversation_memory WHERE task_id = ?")
					.get(result.sourceId) as
					| { task_id: string; summary: string; key_topics: string; workspace_path: string | null }
					| undefined

				if (!row) {
					continue
				}

				// Filter by workspace if specified
				if (options?.workspacePath && row.workspace_path && row.workspace_path !== options.workspacePath) {
					continue
				}

				results.push({
					taskId: row.task_id,
					summary: row.summary,
					relevantContent: result.content,
					similarity: result.similarity,
					keyTopics: JSON.parse(row.key_topics),
				})
			}

			return results
		} catch (error) {
			Logger.warn(`ConversationMemory: Search failed: ${error}`)
			return []
		}
	}

	async isIndexed(taskId: string): Promise<boolean> {
		const row = this.db.getDb().prepare("SELECT 1 FROM conversation_memory WHERE task_id = ?").get(taskId) as
			| { 1: number }
			| undefined
		return !!row
	}

	async getStats(): Promise<{ totalConversations: number; totalEmbeddings: number }> {
		const convCount = this.db.getDb().prepare("SELECT COUNT(*) as count FROM conversation_memory").get() as {
			count: number
		}
		const embCount = this.db
			.getDb()
			.prepare("SELECT COUNT(*) as count FROM embeddings WHERE source_type = 'conversation'")
			.get() as { count: number }
		return {
			totalConversations: convCount.count,
			totalEmbeddings: embCount.count,
		}
	}

	private createSummary(messages: Array<{ role: string; content: string }>): string {
		const parts: string[] = []

		// Take the first user message as the task description
		const firstUserMsg = messages.find((m) => m.role === "user")
		if (firstUserMsg) {
			parts.push(`Task: ${firstUserMsg.content.slice(0, 500)}`)
		}

		// Take key assistant responses (first and last substantive ones)
		const assistantMsgs = messages.filter((m) => m.role === "assistant" && m.content.length > 50)
		if (assistantMsgs.length > 0) {
			parts.push(`Response: ${assistantMsgs[0].content.slice(0, 500)}`)
		}
		if (assistantMsgs.length > 1) {
			const lastMsg = assistantMsgs[assistantMsgs.length - 1]
			parts.push(`Final: ${lastMsg.content.slice(0, 500)}`)
		}

		const summary = parts.join("\n\n")
		return summary.slice(0, MAX_SUMMARY_LENGTH)
	}

	private extractKeyTopics(messages: Array<{ role: string; content: string }>): string[] {
		// Simple keyword extraction from the first user message
		const firstUserMsg = messages.find((m) => m.role === "user")
		if (!firstUserMsg) {
			return []
		}

		const words = firstUserMsg.content.toLowerCase().split(/\s+/)
		const stopWords = new Set([
			"the",
			"a",
			"an",
			"is",
			"are",
			"was",
			"were",
			"be",
			"been",
			"being",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"can",
			"to",
			"of",
			"in",
			"for",
			"on",
			"with",
			"at",
			"by",
			"from",
			"as",
			"into",
			"through",
			"during",
			"before",
			"after",
			"and",
			"but",
			"or",
			"not",
			"no",
			"if",
			"then",
			"else",
			"when",
			"up",
			"out",
			"it",
			"its",
			"this",
			"that",
			"these",
			"those",
			"i",
			"me",
			"my",
			"we",
			"you",
			"your",
			"he",
			"she",
			"they",
			"them",
			"what",
			"which",
			"who",
			"how",
			"all",
			"each",
			"every",
			"both",
			"few",
			"more",
			"most",
			"other",
			"some",
			"such",
			"only",
			"same",
			"so",
			"than",
			"too",
			"very",
			"just",
			"because",
			"about",
			"please",
			"help",
		])

		const wordFreq = new Map<string, number>()
		for (const word of words) {
			const cleaned = word.replace(/[^a-z0-9-_]/g, "")
			if (cleaned.length > 2 && !stopWords.has(cleaned)) {
				wordFreq.set(cleaned, (wordFreq.get(cleaned) ?? 0) + 1)
			}
		}

		return Array.from(wordFreq.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([word]) => word)
	}
}
