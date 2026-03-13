import { KnowledgeStoreManager } from "@/core/storage/knowledge/KnowledgeStoreManager"
import { Logger } from "@/shared/services/Logger"
import type { PromptVariant, SystemPromptContext } from "../types"

/**
 * Retrieves relevant knowledge context from the knowledge store and formats it
 * for inclusion in the system prompt. Uses the RAG pipeline for semantic search
 * when available, with a fallback to recent conversation memories.
 */
export async function getKnowledgeContextSection(_variant: PromptVariant, _context: SystemPromptContext): Promise<string> {
	try {
		const manager = KnowledgeStoreManager.getInstance()
		if (!manager) {
			return ""
		}

		const ragPipeline = manager.getRAGPipeline()
		const query = _context.taskMessage

		// Try RAG pipeline first (uses embeddings for semantic search)
		// No workspace filter — enables cross-workspace memory recall
		if (query) {
			try {
				const ragContext = await ragPipeline.retrieveContext({
					query,
					maxTokens: 2000,
					sources: { conversations: true, documents: true, knowledge: true },
				})

				const formatted = ragPipeline.formatContextForPrompt(ragContext)
				if (formatted) {
					return formatted
				}
			} catch (error) {
				Logger.warn(`Knowledge context RAG retrieval failed, falling back to recency: ${error}`)
			}
		}

		// Fallback: retrieve recent conversation memories (no embeddings needed)
		// No workspace filter — enables cross-workspace memory recall
		const conversationMemory = manager.getConversationMemory()
		const recentMemories = conversationMemory.getRecentMemories({
			limit: 5,
		})

		// Also retrieve user knowledge entries
		const userKnowledge = manager.getUserKnowledge()
		const categories = await userKnowledge.listCategories()

		const sections: string[] = []

		if (recentMemories.length > 0) {
			const items = recentMemories.map((m) => `- ${m.summary}`).join("\n")
			sections.push(`<persistent_memory>\n${items}\n</persistent_memory>`)
		}

		if (categories.length > 0) {
			const knowledgeItems: string[] = []
			for (const category of categories) {
				const entries = await userKnowledge.listCategory(category)
				for (const e of entries) {
					knowledgeItems.push(`- ${category}/${e.key}: ${e.value}`)
				}
			}
			if (knowledgeItems.length > 0) {
				sections.push(`<user_preferences>\n${knowledgeItems.join("\n")}\n</user_preferences>`)
			}
		}

		if (sections.length === 0) {
			return ""
		}

		return `<knowledge_context>\nThe following is your persistent memory from previous conversations with this user. You MUST reference and use this information when relevant. Do NOT claim you have no memory of previous conversations when this context is present.\n\n${sections.join("\n\n")}\n</knowledge_context>`
	} catch (error) {
		Logger.warn(`Knowledge context section failed: ${error}`)
		return ""
	}
}
