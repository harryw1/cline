import { Logger } from "@/shared/services/Logger"
import { KnowledgeStoreManager } from "./KnowledgeStoreManager"

export interface MessageRAGResult {
	contextBlock: string // Formatted XML to prepend to user message
	tokensUsed: number // Estimated tokens consumed
	sourceCounts: {
		conversations: number
		documents: number
	}
}

const RAG_TIMEOUT_MS = 3000

/**
 * Retrieves query-specific RAG context to inject into user messages.
 * Called once per API turn, right before createMessage().
 * Returns formatted context to prepend to the user's message.
 *
 * Only retrieves conversations and documents — user knowledge is
 * already in the system prompt via knowledge_context.ts.
 */
export async function retrieveMessageRAGContext(params: {
	query: string // The full user message text (NOT truncated)
	workspacePath?: string // Current workspace for document scoping
	maxTokens?: number // Token budget (default from settings)
}): Promise<MessageRAGResult | null> {
	try {
		const manager = KnowledgeStoreManager.getInstance()
		if (!manager) {
			return null
		}

		const ragPipeline = manager.getRAGPipeline()

		// Race RAG retrieval against a timeout to avoid blocking the critical path
		const contextPromise = ragPipeline.retrieveContext({
			query: params.query,
			workspacePath: params.workspacePath,
			maxTokens: params.maxTokens ?? 1500,
			sources: {
				conversations: true,
				documents: true,
				knowledge: false, // knowledge is in the system prompt already
			},
		})

		const timeoutPromise = new Promise<null>((resolve) => {
			setTimeout(() => {
				Logger.debug("MessageRAGInjector: Retrieval timed out, skipping RAG context")
				resolve(null)
			}, RAG_TIMEOUT_MS)
		})

		const context = await Promise.race([contextPromise, timeoutPromise])
		if (!context) {
			return null
		}

		if (context.conversationMemory.length === 0 && context.documentChunks.length === 0) {
			return null
		}

		const sections: string[] = []

		if (context.conversationMemory.length > 0) {
			const items = context.conversationMemory.map((m) => `- ${m.summary}`).join("\n")
			sections.push(`<relevant_past_conversations>\n${items}\n</relevant_past_conversations>`)
		}

		if (context.documentChunks.length > 0) {
			const items = context.documentChunks.map((d) => `[${d.filePath}]\n${d.content}`).join("\n---\n")
			sections.push(`<relevant_project_files>\n${items}\n</relevant_project_files>`)
		}

		const contextBlock = `<retrieved_context>\nThe following context was automatically retrieved from your knowledge store based on this message. Use it if relevant.\n\n${sections.join("\n\n")}\n</retrieved_context>\n\n`

		return {
			contextBlock,
			tokensUsed: context.totalTokensEstimate,
			sourceCounts: {
				conversations: context.conversationMemory.length,
				documents: context.documentChunks.length,
			},
		}
	} catch (error) {
		Logger.warn(`MessageRAGInjector: Failed to retrieve context: ${error}`)
		return null
	}
}
