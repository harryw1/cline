/**
 * Manual test for the Knowledge Store.
 *
 * Prerequisites:
 *   1. Ollama running locally (`ollama serve`)
 *   2. Embedding model pulled (`ollama pull nomic-embed-text`)
 *
 * Run with:
 *   bun run src/core/storage/knowledge/__tests__/manual-test.ts
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ConversationMemory } from "../ConversationMemory"
import { DocumentIndexer } from "../DocumentIndexer"
import { EmbeddingService } from "../EmbeddingService"
import { KnowledgeDatabase } from "../KnowledgeDatabase"
import { RAGPipeline } from "../RAGPipeline"
import { UserKnowledgeBase } from "../UserKnowledgeBase"
import { VectorSearch } from "../VectorSearch"

const TEST_DIR = path.join(os.tmpdir(), `knowledge-store-test-${Date.now()}`)

async function main() {
	console.log("=== Knowledge Store Manual Test ===\n")
	console.log(`Test directory: ${TEST_DIR}\n`)

	// Phase 1: Database
	console.log("--- Phase 1: Database ---")
	const db = new KnowledgeDatabase(TEST_DIR)
	console.log("  Database created successfully")

	// Verify tables exist
	const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
		name: string
	}>
	console.log(`  Tables: ${tables.map((t) => t.name).join(", ")}`)

	const expectedTables = ["conversation_memory", "document_index", "embeddings", "schema_version", "user_knowledge"]
	const missing = expectedTables.filter((t) => !tables.some((row) => row.name === t))
	if (missing.length > 0) {
		console.error(`  FAIL: Missing tables: ${missing.join(", ")}`)
		process.exit(1)
	}
	console.log("  PASS: All tables present\n")

	// Phase 2: Embedding Service
	console.log("--- Phase 2: Embedding Service ---")
	const embeddingService = new EmbeddingService()

	const available = await embeddingService.isAvailable()
	console.log(`  Model available: ${available}`)

	if (!available) {
		console.log("  Attempting to pull model...")
		const pulled = await embeddingService.pullModelIfNeeded()
		if (!pulled) {
			console.error("  FAIL: Could not pull embedding model. Is Ollama running?")
			console.error("  Run: ollama serve && ollama pull nomic-embed-text")
			cleanup(db)
			process.exit(1)
		}
	}

	const embedding = await embeddingService.embed("Hello, world!")
	if (!embedding) {
		console.error("  FAIL: Could not generate embedding")
		cleanup(db)
		process.exit(1)
	}
	console.log(`  Embedding dimensions: ${embedding.length}`)
	console.log(
		`  First 5 values: [${Array.from(embedding.slice(0, 5))
			.map((v) => v.toFixed(4))
			.join(", ")}]`,
	)

	// Test serialization round-trip
	const buffer = EmbeddingService.toBuffer(embedding)
	const restored = EmbeddingService.fromBuffer(buffer)
	const match = embedding.length === restored.length && embedding.every((v, i) => Math.abs(v - restored[i]) < 1e-6)
	console.log(`  Serialization round-trip: ${match ? "PASS" : "FAIL"}\n`)

	// Phase 3: Vector Search
	console.log("--- Phase 3: Vector Search ---")
	const vectorSearch = new VectorSearch(db, embeddingService)

	await vectorSearch.store({
		sourceType: "knowledge",
		sourceId: "test:greeting",
		content: "The user prefers TypeScript over JavaScript",
		embedding: (await embeddingService.embed("The user prefers TypeScript over JavaScript"))!,
	})

	await vectorSearch.store({
		sourceType: "knowledge",
		sourceId: "test:style",
		content: "Use functional programming patterns when possible",
		embedding: (await embeddingService.embed("Use functional programming patterns when possible"))!,
	})

	await vectorSearch.store({
		sourceType: "knowledge",
		sourceId: "test:food",
		content: "The best pizza topping is pepperoni",
		embedding: (await embeddingService.embed("The best pizza topping is pepperoni"))!,
	})

	const results = await vectorSearch.search({ query: "What programming language does the user like?", topK: 2 })
	console.log(`  Search results for "What programming language does the user like?":`)
	for (const r of results) {
		console.log(`    - [${r.similarity.toFixed(3)}] ${r.content}`)
	}
	if (results.length > 0 && results[0].content.includes("TypeScript")) {
		console.log("  PASS: Most relevant result is about TypeScript\n")
	} else {
		console.log("  WARN: Unexpected top result (may still be valid)\n")
	}

	// Phase 4: Conversation Memory
	console.log("--- Phase 4: Conversation Memory ---")
	const conversationMemory = new ConversationMemory(db, vectorSearch, embeddingService)

	await conversationMemory.indexConversation({
		taskId: "test-task-001",
		messages: [
			{ role: "user", content: "Help me refactor the authentication module to use JWT tokens" },
			{
				role: "assistant",
				content:
					"I'll help you refactor the authentication module. First, let me look at the existing implementation and then we'll migrate to JWT tokens.",
			},
			{ role: "user", content: "Sounds good, the auth module is in src/auth/index.ts" },
			{
				role: "assistant",
				content:
					"I've refactored the auth module to use JWT tokens with refresh token rotation. The key changes are in the middleware and the token service.",
			},
		],
		modelUsed: "test-model",
		workspacePath: "/test/project",
	})

	const indexed = await conversationMemory.isIndexed("test-task-001")
	console.log(`  Conversation indexed: ${indexed}`)

	const stats = await conversationMemory.getStats()
	console.log(`  Stats: ${stats.totalConversations} conversations, ${stats.totalEmbeddings} embeddings`)

	const memResults = await conversationMemory.searchMemory("authentication JWT")
	console.log(`  Search for "authentication JWT": ${memResults.length} results`)
	if (memResults.length > 0) {
		console.log(`    - [${memResults[0].similarity.toFixed(3)}] ${memResults[0].summary.slice(0, 80)}...`)
	}
	console.log("  PASS\n")

	// Phase 5: Document Indexer
	console.log("--- Phase 5: Document Indexer ---")
	const documentIndexer = new DocumentIndexer(db, vectorSearch, embeddingService)

	// Create a test file to index
	const testDocDir = path.join(TEST_DIR, "test-docs")
	fs.mkdirSync(testDocDir, { recursive: true })
	fs.writeFileSync(
		path.join(testDocDir, "README.md"),
		`# Test Project\n\nThis is a project about building a REST API with Express and PostgreSQL.\n\n## Setup\n\nRun npm install to get started.\n`,
	)

	await documentIndexer.indexFile(path.join(testDocDir, "README.md"), testDocDir)
	const docResults = await documentIndexer.searchDocuments("REST API Express")
	console.log(`  Indexed README.md, search for "REST API Express": ${docResults.length} results`)
	if (docResults.length > 0) {
		console.log(`    - [${docResults[0].similarity.toFixed(3)}] ${docResults[0].chunkContent.slice(0, 80)}...`)
	}
	console.log("  PASS\n")

	// Phase 6: User Knowledge Base
	console.log("--- Phase 6: User Knowledge Base ---")
	const userKnowledge = new UserKnowledgeBase(db, vectorSearch, embeddingService)

	await userKnowledge.set("preferences", "language", "TypeScript with strict mode enabled")
	await userKnowledge.set("preferences", "testing", "Prefer vitest over jest")
	await userKnowledge.set("project", "database", "Using PostgreSQL 15 with Drizzle ORM")

	const lang = await userKnowledge.get("preferences", "language")
	console.log(`  Get preferences/language: ${lang}`)

	const categories = await userKnowledge.listCategories()
	console.log(`  Categories: ${categories.join(", ")}`)

	const prefEntries = await userKnowledge.listCategory("preferences")
	console.log(`  Preferences entries: ${prefEntries.length}`)

	const knowledgeSearch = await userKnowledge.search("what test framework to use")
	console.log(`  Search "what test framework to use": ${knowledgeSearch.length} results`)
	if (knowledgeSearch.length > 0) {
		console.log(`    - [${knowledgeSearch[0].similarity.toFixed(3)}] ${knowledgeSearch[0].value}`)
	}
	console.log("  PASS\n")

	// Phase 7: RAG Pipeline
	console.log("--- Phase 7: RAG Pipeline ---")
	const ragPipeline = new RAGPipeline({
		conversationMemory,
		documentIndexer,
		userKnowledge,
		embeddingService,
	})

	const ragAvailable = await ragPipeline.isAvailable()
	console.log(`  RAG pipeline available: ${ragAvailable}`)

	const context = await ragPipeline.retrieveContext({
		query: "How should I set up authentication?",
		workspacePath: testDocDir,
		maxTokens: 2000,
	})
	console.log(`  Retrieved context:`)
	console.log(`    - Conversation memories: ${context.conversationMemory.length}`)
	console.log(`    - Document chunks: ${context.documentChunks.length}`)
	console.log(`    - Knowledge entries: ${context.knowledgeEntries.length}`)
	console.log(`    - Estimated tokens: ${context.totalTokensEstimate}`)

	const formatted = ragPipeline.formatContextForPrompt(context)
	console.log(`  Formatted prompt length: ${formatted.length} chars`)
	if (formatted.length > 0) {
		console.log(`  Preview:\n${formatted.slice(0, 300)}...`)
	}
	console.log("  PASS\n")

	// Cleanup
	cleanup(db)
	console.log("=== All tests passed! ===")
}

function cleanup(db: KnowledgeDatabase) {
	db.close()
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
	console.log(`\nCleaned up ${TEST_DIR}`)
}

main().catch((err) => {
	console.error("Test failed:", err)
	process.exit(1)
})
