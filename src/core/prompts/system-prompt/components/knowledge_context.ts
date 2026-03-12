import { KnowledgeStoreManager } from "@/core/storage/knowledge/KnowledgeStoreManager"
import { Logger } from "@/shared/services/Logger"
import type { PromptVariant, SystemPromptContext } from "../types"

/**
 * Retrieves relevant knowledge context from the knowledge store and formats it
 * for inclusion in the system prompt. Returns empty string if the knowledge store
 * is unavailable or has no relevant content.
 */
export async function getKnowledgeContextSection(_variant: PromptVariant, _context: SystemPromptContext): Promise<string> {
	try {
		const manager = KnowledgeStoreManager.getInstance()
		if (!manager) {
			return ""
		}

		const userKnowledge = manager.getUserKnowledge()

		// Retrieve all user knowledge entries (these are manually curated, always relevant)
		const categories = await userKnowledge.listCategories()
		if (categories.length === 0) {
			return ""
		}

		const sections: string[] = []

		for (const category of categories) {
			const entries = await userKnowledge.listCategory(category)
			if (entries.length > 0) {
				const items = entries.map((e) => `- ${e.key}: ${e.value}`).join("\n")
				sections.push(`[${category}]\n${items}`)
			}
		}

		if (sections.length === 0) {
			return ""
		}

		return `<knowledge_context>\n<user_preferences>\n${sections.join("\n\n")}\n</user_preferences>\n</knowledge_context>`
	} catch (error) {
		Logger.warn(`Knowledge context section failed: ${error}`)
		return ""
	}
}
