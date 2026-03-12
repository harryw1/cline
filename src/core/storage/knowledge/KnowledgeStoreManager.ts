import { Logger } from "@/shared/services/Logger"
import { ConversationMemory } from "./ConversationMemory"
import { DocumentIndexer } from "./DocumentIndexer"
import { EmbeddingService } from "./EmbeddingService"
import { KnowledgeDatabase } from "./KnowledgeDatabase"
import { RAGPipeline } from "./RAGPipeline"
import { UserKnowledgeBase } from "./UserKnowledgeBase"
import { VectorSearch } from "./VectorSearch"

export class KnowledgeStoreManager {
	private static instance: KnowledgeStoreManager | null = null

	private database: KnowledgeDatabase
	private embeddingService: EmbeddingService
	private vectorSearch: VectorSearch
	private conversationMemory: ConversationMemory
	private documentIndexer: DocumentIndexer
	private userKnowledge: UserKnowledgeBase
	private ragPipeline: RAGPipeline

	private constructor(
		database: KnowledgeDatabase,
		embeddingService: EmbeddingService,
		vectorSearch: VectorSearch,
		conversationMemory: ConversationMemory,
		documentIndexer: DocumentIndexer,
		userKnowledge: UserKnowledgeBase,
		ragPipeline: RAGPipeline,
	) {
		this.database = database
		this.embeddingService = embeddingService
		this.vectorSearch = vectorSearch
		this.conversationMemory = conversationMemory
		this.documentIndexer = documentIndexer
		this.userKnowledge = userKnowledge
		this.ragPipeline = ragPipeline
	}

	static initialize(options: {
		ollamaBaseUrl?: string
		ollamaApiKey?: string
		embeddingModel?: string
	}): KnowledgeStoreManager {
		if (KnowledgeStoreManager.instance) {
			return KnowledgeStoreManager.instance
		}

		try {
			const database = new KnowledgeDatabase()

			const embeddingService = new EmbeddingService({
				baseUrl: options.ollamaBaseUrl,
				apiKey: options.ollamaApiKey,
				model: options.embeddingModel,
			})

			const vectorSearch = new VectorSearch(database, embeddingService)
			const conversationMemory = new ConversationMemory(database, vectorSearch, embeddingService)
			const documentIndexer = new DocumentIndexer(database, vectorSearch, embeddingService)
			const userKnowledge = new UserKnowledgeBase(database, vectorSearch, embeddingService)

			const ragPipeline = new RAGPipeline({
				conversationMemory,
				documentIndexer,
				userKnowledge,
				embeddingService,
			})

			KnowledgeStoreManager.instance = new KnowledgeStoreManager(
				database,
				embeddingService,
				vectorSearch,
				conversationMemory,
				documentIndexer,
				userKnowledge,
				ragPipeline,
			)

			Logger.log("KnowledgeStoreManager: Initialized successfully")
			return KnowledgeStoreManager.instance
		} catch (error) {
			Logger.error(`KnowledgeStoreManager: Failed to initialize: ${error}`)
			throw error
		}
	}

	static getInstance(): KnowledgeStoreManager | null {
		return KnowledgeStoreManager.instance
	}

	getRAGPipeline(): RAGPipeline {
		return this.ragPipeline
	}

	getConversationMemory(): ConversationMemory {
		return this.conversationMemory
	}

	getDocumentIndexer(): DocumentIndexer {
		return this.documentIndexer
	}

	getUserKnowledge(): UserKnowledgeBase {
		return this.userKnowledge
	}

	async onTaskComplete(
		taskId: string,
		messages: Array<{ role: string; content: string }>,
		modelUsed?: string,
		workspacePath?: string,
	): Promise<void> {
		try {
			await this.conversationMemory.indexConversation({
				taskId,
				messages,
				modelUsed,
				workspacePath,
			})
		} catch (error) {
			Logger.warn(`KnowledgeStoreManager: Failed to index task ${taskId}: ${error}`)
		}
	}

	async shutdown(): Promise<void> {
		try {
			this.database.close()
			KnowledgeStoreManager.instance = null
			Logger.log("KnowledgeStoreManager: Shut down successfully")
		} catch (error) {
			Logger.warn(`KnowledgeStoreManager: Error during shutdown: ${error}`)
		}
	}
}
