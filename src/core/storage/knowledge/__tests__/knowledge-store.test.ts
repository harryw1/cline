import { expect } from "chai"
import * as fs from "fs"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { ConversationMemory } from "../ConversationMemory"
import { DocumentIndexer } from "../DocumentIndexer"
import { EmbeddingService } from "../EmbeddingService"
import { KnowledgeDatabase } from "../KnowledgeDatabase"
import { RAGPipeline } from "../RAGPipeline"
import { UserKnowledgeBase } from "../UserKnowledgeBase"
import { VectorSearch } from "../VectorSearch"

function createTestDir(): string {
	const dir = path.join(os.tmpdir(), `knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	fs.mkdirSync(dir, { recursive: true })
	return dir
}

function cleanupDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true })
	} catch {
		// best-effort cleanup
	}
}

/** Create a deterministic mock embedding of given dimensions */
function mockEmbedding(seed: number, dims = 768): Float32Array {
	const arr = new Float32Array(dims)
	for (let i = 0; i < dims; i++) {
		arr[i] = Math.sin(seed * (i + 1))
	}
	// Normalize
	let norm = 0
	for (let i = 0; i < dims; i++) {
		norm += arr[i] * arr[i]
	}
	const mag = Math.sqrt(norm)
	for (let i = 0; i < dims; i++) {
		arr[i] /= mag
	}
	return arr
}

describe("KnowledgeDatabase", () => {
	let testDir: string
	let db: KnowledgeDatabase

	beforeEach(() => {
		testDir = createTestDir()
		db = new KnowledgeDatabase(testDir)
	})

	afterEach(() => {
		db.close()
		cleanupDir(testDir)
	})

	it("should create the database file", () => {
		const dbPath = path.join(testDir, "knowledge.db")
		expect(fs.existsSync(dbPath)).to.be.true
	})

	it("should create all required tables", () => {
		const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
			name: string
		}>
		const names = tables.map((t) => t.name)
		expect(names).to.include("embeddings")
		expect(names).to.include("conversation_memory")
		expect(names).to.include("document_index")
		expect(names).to.include("user_knowledge")
		expect(names).to.include("schema_version")
	})

	it("should set schema version to 1", () => {
		const row = db.getDb().prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as {
			version: number
		}
		expect(row.version).to.equal(1)
	})

	it("should support re-opening an existing database", () => {
		db.close()
		const db2 = new KnowledgeDatabase(testDir)
		const tables = db2.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
		expect(tables.length).to.be.greaterThan(0)
		db2.close()
	})
})

describe("EmbeddingService serialization", () => {
	it("should round-trip Float32Array through Buffer", () => {
		const original = new Float32Array([1.0, -2.5, 3.14, 0.0, -0.001])
		const buffer = EmbeddingService.toBuffer(original)
		const restored = EmbeddingService.fromBuffer(buffer)
		expect(restored.length).to.equal(original.length)
		for (let i = 0; i < original.length; i++) {
			expect(restored[i]).to.be.closeTo(original[i], 1e-6)
		}
	})

	it("should handle empty Float32Array", () => {
		const original = new Float32Array(0)
		const buffer = EmbeddingService.toBuffer(original)
		const restored = EmbeddingService.fromBuffer(buffer)
		expect(restored.length).to.equal(0)
	})

	it("should handle large embeddings (768 dims)", () => {
		const original = mockEmbedding(42)
		const buffer = EmbeddingService.toBuffer(original)
		const restored = EmbeddingService.fromBuffer(buffer)
		expect(restored.length).to.equal(768)
		for (let i = 0; i < original.length; i++) {
			expect(restored[i]).to.be.closeTo(original[i], 1e-6)
		}
	})
})

describe("VectorSearch", () => {
	let testDir: string
	let db: KnowledgeDatabase
	let embeddingService: EmbeddingService
	let vectorSearch: VectorSearch
	let embedStub: sinon.SinonStub

	beforeEach(() => {
		testDir = createTestDir()
		db = new KnowledgeDatabase(testDir)
		embeddingService = new EmbeddingService({ baseUrl: "http://localhost:11434" })
		vectorSearch = new VectorSearch(db, embeddingService)

		// Stub embed to return deterministic embeddings
		embedStub = sinon.stub(embeddingService, "embed")
	})

	afterEach(() => {
		sinon.restore()
		db.close()
		cleanupDir(testDir)
	})

	it("should store and retrieve embeddings", async () => {
		const emb = mockEmbedding(1)
		await vectorSearch.store({
			sourceType: "knowledge",
			sourceId: "test:key1",
			content: "TypeScript is great",
			embedding: emb,
		})

		// When searching, embed returns a similar embedding
		embedStub.resolves(mockEmbedding(1))

		const results = await vectorSearch.search({ query: "TypeScript", threshold: 0.5 })
		expect(results.length).to.equal(1)
		expect(results[0].content).to.equal("TypeScript is great")
		expect(results[0].similarity).to.be.closeTo(1.0, 0.01)
	})

	it("should filter by source type", async () => {
		await vectorSearch.store({
			sourceType: "knowledge",
			sourceId: "k1",
			content: "knowledge content",
			embedding: mockEmbedding(1),
		})
		await vectorSearch.store({
			sourceType: "document",
			sourceId: "d1",
			content: "document content",
			embedding: mockEmbedding(2),
		})

		embedStub.resolves(mockEmbedding(1))

		const knowledgeResults = await vectorSearch.search({
			query: "test",
			sourceType: "knowledge",
			threshold: 0.0,
		})
		expect(knowledgeResults.every((r) => r.sourceType === "knowledge")).to.be.true
	})

	it("should respect threshold", async () => {
		await vectorSearch.store({
			sourceType: "knowledge",
			sourceId: "k1",
			content: "similar",
			embedding: mockEmbedding(1),
		})
		await vectorSearch.store({
			sourceType: "knowledge",
			sourceId: "k2",
			content: "different",
			embedding: mockEmbedding(100),
		})

		embedStub.resolves(mockEmbedding(1))

		const highThreshold = await vectorSearch.search({ query: "test", threshold: 0.99 })
		expect(highThreshold.length).to.equal(1)
		expect(highThreshold[0].sourceId).to.equal("k1")
	})

	it("should delete by source", async () => {
		await vectorSearch.store({
			sourceType: "knowledge",
			sourceId: "k1",
			content: "to delete",
			embedding: mockEmbedding(1),
		})

		await vectorSearch.deleteBySource("knowledge", "k1")

		embedStub.resolves(mockEmbedding(1))
		const results = await vectorSearch.search({ query: "test", threshold: 0.0 })
		expect(results.length).to.equal(0)
	})

	it("should return empty results when embed fails", async () => {
		embedStub.resolves(null)
		const results = await vectorSearch.search({ query: "test" })
		expect(results).to.deep.equal([])
	})
})

describe("UserKnowledgeBase", () => {
	let testDir: string
	let db: KnowledgeDatabase
	let embeddingService: EmbeddingService
	let vectorSearch: VectorSearch
	let knowledge: UserKnowledgeBase

	beforeEach(() => {
		testDir = createTestDir()
		db = new KnowledgeDatabase(testDir)
		embeddingService = new EmbeddingService({ baseUrl: "http://localhost:11434" })
		vectorSearch = new VectorSearch(db, embeddingService)
		knowledge = new UserKnowledgeBase(db, vectorSearch, embeddingService)

		// Stub embedding to no-op (we're testing CRUD, not embeddings)
		sinon.stub(embeddingService, "embed").resolves(null)
	})

	afterEach(() => {
		sinon.restore()
		db.close()
		cleanupDir(testDir)
	})

	it("should set and get a knowledge entry", async () => {
		await knowledge.set("preferences", "language", "TypeScript")
		const value = await knowledge.get("preferences", "language")
		expect(value).to.equal("TypeScript")
	})

	it("should return null for non-existent entry", async () => {
		const value = await knowledge.get("preferences", "nonexistent")
		expect(value).to.be.null
	})

	it("should update existing entry", async () => {
		await knowledge.set("preferences", "editor", "vim")
		await knowledge.set("preferences", "editor", "vscode")
		const value = await knowledge.get("preferences", "editor")
		expect(value).to.equal("vscode")
	})

	it("should delete an entry", async () => {
		await knowledge.set("preferences", "color", "blue")
		await knowledge.delete("preferences", "color")
		const value = await knowledge.get("preferences", "color")
		expect(value).to.be.null
	})

	it("should list entries in a category", async () => {
		await knowledge.set("project", "name", "Cline")
		await knowledge.set("project", "language", "TypeScript")
		await knowledge.set("other", "unrelated", "data")

		const entries = await knowledge.listCategory("project")
		expect(entries.length).to.equal(2)
		expect(entries.map((e) => e.key).sort()).to.deep.equal(["language", "name"])
	})

	it("should list all categories", async () => {
		await knowledge.set("preferences", "a", "1")
		await knowledge.set("project", "b", "2")
		await knowledge.set("patterns", "c", "3")

		const categories = await knowledge.listCategories()
		expect(categories.sort()).to.deep.equal(["patterns", "preferences", "project"])
	})

	it("should export to markdown", async () => {
		await knowledge.set("preferences", "editor", "vscode")
		await knowledge.set("project", "name", "Cline")

		const md = await knowledge.exportToMarkdown()
		expect(md).to.include("# Knowledge Base")
		expect(md).to.include("## preferences")
		expect(md).to.include("### editor")
		expect(md).to.include("vscode")
	})

	it("should import from markdown", async () => {
		const mdPath = path.join(testDir, "test.md")
		fs.writeFileSync(
			mdPath,
			`# Knowledge
## First Topic
Some content here.

## Second Topic
More content.
`,
		)

		const count = await knowledge.importFromMarkdown(mdPath, "docs")
		expect(count).to.equal(2)

		const value = await knowledge.get("docs", "First Topic")
		expect(value).to.include("Some content here.")
	})
})

describe("ConversationMemory", () => {
	let testDir: string
	let db: KnowledgeDatabase
	let embeddingService: EmbeddingService
	let vectorSearch: VectorSearch
	let memory: ConversationMemory

	beforeEach(() => {
		testDir = createTestDir()
		db = new KnowledgeDatabase(testDir)
		embeddingService = new EmbeddingService({ baseUrl: "http://localhost:11434" })
		vectorSearch = new VectorSearch(db, embeddingService)
		memory = new ConversationMemory(db, vectorSearch, embeddingService)

		sinon.stub(embeddingService, "embed").resolves(null)
	})

	afterEach(() => {
		sinon.restore()
		db.close()
		cleanupDir(testDir)
	})

	it("should index a conversation", async () => {
		await memory.indexConversation({
			taskId: "task-001",
			messages: [
				{ role: "user", content: "How do I write tests in TypeScript?" },
				{ role: "assistant", content: "You can use Mocha with chai assertions." },
			],
			modelUsed: "gpt-4",
			workspacePath: "/home/user/project",
		})

		const indexed = await memory.isIndexed("task-001")
		expect(indexed).to.be.true
	})

	it("should not double-index a conversation", async () => {
		const messages = [{ role: "user", content: "Hello" }]
		await memory.indexConversation({ taskId: "task-002", messages })
		await memory.indexConversation({ taskId: "task-002", messages })

		const stats = await memory.getStats()
		expect(stats.totalConversations).to.equal(1)
	})

	it("should report stats", async () => {
		await memory.indexConversation({
			taskId: "task-a",
			messages: [{ role: "user", content: "Test" }],
		})
		await memory.indexConversation({
			taskId: "task-b",
			messages: [{ role: "user", content: "Test 2" }],
		})

		const stats = await memory.getStats()
		expect(stats.totalConversations).to.equal(2)
	})
})

describe("RAGPipeline", () => {
	let testDir: string
	let db: KnowledgeDatabase
	let embeddingService: EmbeddingService
	let vectorSearch: VectorSearch
	let pipeline: RAGPipeline

	beforeEach(() => {
		testDir = createTestDir()
		db = new KnowledgeDatabase(testDir)
		embeddingService = new EmbeddingService({ baseUrl: "http://localhost:11434" })
		vectorSearch = new VectorSearch(db, embeddingService)

		const conversationMemory = new ConversationMemory(db, vectorSearch, embeddingService)
		const documentIndexer = new DocumentIndexer(db, vectorSearch, embeddingService)
		const userKnowledge = new UserKnowledgeBase(db, vectorSearch, embeddingService)

		pipeline = new RAGPipeline({
			conversationMemory,
			documentIndexer,
			userKnowledge,
			embeddingService,
		})

		sinon.stub(embeddingService, "embed").resolves(null)
		sinon.stub(embeddingService, "isAvailable").resolves(false)
	})

	afterEach(() => {
		sinon.restore()
		db.close()
		cleanupDir(testDir)
	})

	it("should return empty context when embeddings unavailable", async () => {
		const context = await pipeline.retrieveContext({ query: "test" })
		expect(context.conversationMemory).to.deep.equal([])
		expect(context.documentChunks).to.deep.equal([])
		expect(context.knowledgeEntries).to.deep.equal([])
	})

	it("should format empty context as empty string", () => {
		const formatted = pipeline.formatContextForPrompt({
			conversationMemory: [],
			documentChunks: [],
			knowledgeEntries: [],
			totalTokensEstimate: 0,
		})
		expect(formatted).to.equal("")
	})

	it("should format non-empty context with XML tags", () => {
		const formatted = pipeline.formatContextForPrompt({
			conversationMemory: [{ taskId: "t1", summary: "Built a feature", similarity: 0.9 }],
			documentChunks: [{ filePath: "src/index.ts", content: "export default {}", similarity: 0.85 }],
			knowledgeEntries: [{ category: "preferences", key: "style", value: "functional", similarity: 0.8 }],
			totalTokensEstimate: 500,
		})
		expect(formatted).to.include("<knowledge_context>")
		expect(formatted).to.include("</knowledge_context>")
		expect(formatted).to.include("Built a feature")
		expect(formatted).to.include("src/index.ts")
		expect(formatted).to.include("functional")
	})

	it("should report unavailable when embedding service is down", async () => {
		const available = await pipeline.isAvailable()
		expect(available).to.be.false
	})
})
