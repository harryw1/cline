import { Logger } from "@/shared/services/Logger"
import type { ConversationMemory } from "./ConversationMemory"
import type { DocumentIndexer } from "./DocumentIndexer"
import type { EmbeddingService } from "./EmbeddingService"
import type { UserKnowledgeBase } from "./UserKnowledgeBase"

export interface RAGContext {
	conversationMemory: Array<{
		taskId: string
		summary: string
		similarity: number
	}>
	documentChunks: Array<{
		filePath: string
		content: string
		similarity: number
	}>
	knowledgeEntries: Array<{
		category: string
		key: string
		value: string
		similarity: number
	}>
	totalTokensEstimate: number
}

// Rough estimate: 1 token ~= 4 characters
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export class RAGPipeline {
	private conversationMemory: ConversationMemory
	private documentIndexer: DocumentIndexer
	private userKnowledge: UserKnowledgeBase
	private embeddingService: EmbeddingService

	constructor(params: {
		conversationMemory: ConversationMemory
		documentIndexer: DocumentIndexer
		userKnowledge: UserKnowledgeBase
		embeddingService: EmbeddingService
	}) {
		this.conversationMemory = params.conversationMemory
		this.documentIndexer = params.documentIndexer
		this.userKnowledge = params.userKnowledge
		this.embeddingService = params.embeddingService
	}

	async retrieveContext(params: {
		query: string
		workspacePath?: string
		maxTokens?: number
		sources?: {
			conversations?: boolean
			documents?: boolean
			knowledge?: boolean
		}
	}): Promise<RAGContext> {
		const maxTokens = params.maxTokens ?? 2000
		const sources = params.sources ?? { conversations: true, documents: true, knowledge: true }

		const context: RAGContext = {
			conversationMemory: [],
			documentChunks: [],
			knowledgeEntries: [],
			totalTokensEstimate: 0,
		}

		try {
			// Token budget allocation: 40% docs, 35% conversations, 25% knowledge
			const docBudget = Math.floor(maxTokens * 0.4)
			const convBudget = Math.floor(maxTokens * 0.35)
			const knowledgeBudget = Math.floor(maxTokens * 0.25)

			// Run searches in parallel
			const [convResults, docResults, knowledgeResults] = await Promise.all([
				sources.conversations !== false
					? this.conversationMemory.searchMemory(params.query, {
							topK: 3,
							workspacePath: params.workspacePath,
						})
					: Promise.resolve([]),
				sources.documents !== false
					? this.documentIndexer.searchDocuments(params.query, {
							topK: 5,
							workspacePath: params.workspacePath,
						})
					: Promise.resolve([]),
				sources.knowledge !== false ? this.userKnowledge.search(params.query, { topK: 5 }) : Promise.resolve([]),
			])

			// Fill conversation memory within budget
			let convTokens = 0
			for (const result of convResults) {
				const tokens = estimateTokens(result.summary)
				if (convTokens + tokens > convBudget) {
					break
				}
				context.conversationMemory.push({
					taskId: result.taskId,
					summary: result.summary,
					similarity: result.similarity,
				})
				convTokens += tokens
			}

			// Fill document chunks within budget
			let docTokens = 0
			for (const result of docResults) {
				const tokens = estimateTokens(result.chunkContent)
				if (docTokens + tokens > docBudget) {
					break
				}
				context.documentChunks.push({
					filePath: result.filePath,
					content: result.chunkContent,
					similarity: result.similarity,
				})
				docTokens += tokens
			}

			// Fill knowledge entries within budget
			let knowledgeTokens = 0
			for (const result of knowledgeResults) {
				const tokens = estimateTokens(result.value)
				if (knowledgeTokens + tokens > knowledgeBudget) {
					break
				}
				context.knowledgeEntries.push({
					category: result.category,
					key: result.key,
					value: result.value,
					similarity: result.similarity,
				})
				knowledgeTokens += tokens
			}

			context.totalTokensEstimate = convTokens + docTokens + knowledgeTokens
		} catch (error) {
			Logger.warn(`RAGPipeline: Failed to retrieve context: ${error}`)
		}

		return context
	}

	formatContextForPrompt(context: RAGContext): string {
		const sections: string[] = []

		if (context.conversationMemory.length > 0) {
			const items = context.conversationMemory.map((m) => `- ${m.summary}`).join("\n")
			sections.push(`<persistent_memory>\n${items}\n</persistent_memory>`)
		}

		if (context.documentChunks.length > 0) {
			const items = context.documentChunks.map((d) => `[${d.filePath}]\n${d.content}`).join("\n---\n")
			sections.push(`<project_knowledge>\n${items}\n</project_knowledge>`)
		}

		if (context.knowledgeEntries.length > 0) {
			const items = context.knowledgeEntries.map((k) => `- ${k.category}/${k.key}: ${k.value}`).join("\n")
			sections.push(`<user_preferences>\n${items}\n</user_preferences>`)
		}

		if (sections.length === 0) {
			return ""
		}

		return `<knowledge_context>\nThe following is your persistent memory from previous conversations with this user. You MUST reference and use this information when relevant. Do NOT claim you have no memory of previous conversations when this context is present.\n\n${sections.join("\n\n")}\n</knowledge_context>`
	}

	async isAvailable(): Promise<boolean> {
		return this.embeddingService.isAvailable()
	}
}
