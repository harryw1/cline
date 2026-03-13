import { KnowledgeStoreManager } from "@/core/storage/knowledge/KnowledgeStoreManager"
import { Logger } from "@/shared/services/Logger"
import type { PromptVariant, SystemPromptContext } from "../types"

/**
 * Injects static, session-wide knowledge into the system prompt.
 * Only includes user knowledge entries and recent conversation memory summaries.
 * Per-message RAG (document chunks, semantic search) is handled by MessageRAGInjector
 * which prepends context to user messages at API call time.
 */
export async function getKnowledgeContextSection(_variant: PromptVariant, _context: SystemPromptContext): Promise<string> {
	try {
		const manager = KnowledgeStoreManager.getInstance()
		if (!manager) {
			return ""
		}

		const sections: string[] = []

		// Recent conversation memory summaries (recency-based, no embeddings needed)
		try {
			const conversationMemory = manager.getConversationMemory()
			const recentMemories = conversationMemory.getRecentMemories({ limit: 5 })
			if (recentMemories.length > 0) {
				const items = recentMemories.map((m) => `- ${m.summary}`).join("\n")
				sections.push(`<persistent_memory>\n${items}\n</persistent_memory>`)
			}
		} catch (error) {
			Logger.debug(`Knowledge context: Failed to get recent memories: ${error}`)
		}

		// User knowledge entries (small, stable, relevant to every message)
		try {
			const userKnowledge = manager.getUserKnowledge()
			const categories = await userKnowledge.listCategories()
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
		} catch (error) {
			Logger.debug(`Knowledge context: Failed to get user knowledge: ${error}`)
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
