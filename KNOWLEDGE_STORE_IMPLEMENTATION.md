# Cline Knowledge Store — Claude Code Implementation Prompt

## How to Use This File

Copy the entire contents of this file and paste it as your prompt to Claude Code. When starting a new session, tell Claude Code:

> "Read `KNOWLEDGE_STORE_IMPLEMENTATION.md` and `PROGRESS.md` in the repo root, then continue from where we left off."

Claude Code will check `PROGRESS.md` to see what's done and pick up from there.

---

## Master Prompt

You are implementing a SQLite-backed knowledge store with vector search for the Cline VS Code extension. The goal is to add persistent memory, RAG (retrieval-augmented generation), and a user knowledge base that automatically enriches prompts sent to local LLMs via Ollama.

### Project Location
Repository root: the current working directory (should be the cloned `cline` repo).

### Progress Tracking
**CRITICAL**: Before doing ANY work, read `PROGRESS.md` in the repo root. If it doesn't exist, create it with the template below. After completing each phase, update `PROGRESS.md` with what was done, what files were created/modified, and what's next. This is how future sessions resume.

```markdown
# Knowledge Store Implementation Progress

## Current Phase: [PHASE NUMBER] — [PHASE NAME]
## Status: [IN_PROGRESS | COMPLETED]
## Last Updated: [TIMESTAMP]

### Completed Phases
- [ ] Phase 1: Core Database & Schema
- [ ] Phase 2: Embedding Service
- [ ] Phase 3: Vector Search
- [ ] Phase 4: Conversation Memory
- [ ] Phase 5: Document Indexer
- [ ] Phase 6: User Knowledge Base
- [ ] Phase 7: RAG Pipeline
- [ ] Phase 8: System Prompt Integration
- [ ] Phase 9: Configuration & Settings
- [ ] Phase 10: Wiring & Initialization
- [ ] Phase 11: Testing & Verification

### Files Created
(list all new files here as they're created)

### Files Modified
(list all modified existing files here)

### Notes for Next Session
(any context the next session needs)
```

---

## Architecture Overview

### Where Things Live in Cline

```
src/
├── core/
│   ├── api/providers/ollama.ts          # Existing Ollama LLM handler
│   ├── storage/
│   │   ├── StateManager.ts              # In-memory state + JSON persistence
│   │   ├── disk.ts                      # File I/O, task history, paths
│   │   └── knowledge/                   # ← NEW: All knowledge store code
│   ├── locks/SqliteLockManager.ts       # Existing SQLite usage (pattern reference)
│   ├── prompts/system-prompt/
│   │   ├── components/index.ts          # Prompt section registry
│   │   ├── templates/placeholders.ts    # Section enum + placeholder defs
│   │   └── registry/PromptBuilder.ts    # Assembles final prompt
│   └── task/index.ts                    # Where createMessage() is called (line ~1938)
├── shared/storage/state-keys.ts         # Single source of truth for all config keys
└── hosts/host-provider.ts               # Platform abstraction
```

### Key Patterns to Follow

1. **SQLite initialization**: Follow `SqliteLockManager.ts` exactly — lock file coordination, sync init, directory creation with `mkdirSync`.
2. **Configuration keys**: Add new fields to the appropriate `*_FIELDS` object in `state-keys.ts`. Use `FieldDefinition<T>` with `default` and optional `transform`.
3. **System prompt components**: Each is a function `(variant, context) => Promise<string>` registered in `components/index.ts`.
4. **Logging**: Use `Logger` from `@/shared/services/Logger` (never `console.log`).
5. **Imports**: Use path aliases (`@/core/...`, `@shared/...`, `@utils/...`).

### Database Location
`~/.cline/data/knowledge.db` — follows the existing pattern from `getClineHomePath()` in `disk.ts`.

### Existing Dependencies Already Available
- `better-sqlite3@12.4.1` — already in package.json
- `ollama@0.5.13` — already in package.json (for embeddings)
- `p-mutex` — already available for concurrency

---

## Phase-by-Phase Implementation

### Phase 1: Core Database & Schema

**Create**: `src/core/storage/knowledge/KnowledgeDatabase.ts`

This is the foundation. It manages the SQLite database connection and schema.

**Schema** (4 tables):

```sql
-- Vector embeddings storage
CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('conversation', 'document', 'knowledge')),
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,          -- Float32Array stored as Buffer
    metadata TEXT DEFAULT '{}',       -- JSON metadata
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_type, source_id)
);

-- Conversation memory (summaries of past conversations)
CREATE TABLE IF NOT EXISTS conversation_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    key_topics TEXT DEFAULT '[]',      -- JSON array of topic strings
    message_count INTEGER DEFAULT 0,
    model_used TEXT,
    workspace_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Document index (for RAG over local files)
CREATE TABLE IF NOT EXISTS document_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,           -- SHA-256 for change detection
    chunk_index INTEGER NOT NULL,      -- Which chunk of the file
    chunk_content TEXT NOT NULL,
    workspace_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(file_path, chunk_index)
);

-- User knowledge base (manually curated facts)
CREATE TABLE IF NOT EXISTS user_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT 'general',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(category, key)
);
```

**Indexes**:
```sql
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(source_type);
CREATE INDEX IF NOT EXISTS idx_conv_memory_task ON conversation_memory(task_id);
CREATE INDEX IF NOT EXISTS idx_conv_memory_workspace ON conversation_memory(workspace_path);
CREATE INDEX IF NOT EXISTS idx_doc_index_path ON document_index(file_path);
CREATE INDEX IF NOT EXISTS idx_doc_index_workspace ON document_index(workspace_path);
CREATE INDEX IF NOT EXISTS idx_user_knowledge_category ON user_knowledge(category);
```

**Class structure**:
```typescript
import Database from "better-sqlite3"
// Follow SqliteLockManager pattern for init: lock file, mkdirSync, etc.
export class KnowledgeDatabase {
    private db!: Database.Database
    private dbPath: string

    constructor(dataDir?: string) // defaults to ~/.cline/data
    private initializeDatabaseWithLockSync(): void  // copy from SqliteLockManager
    private initializeSchema(): void

    getDb(): Database.Database
    close(): void

    // Schema migrations support
    private getSchemaVersion(): number
    private setSchemaVersion(version: number): void
    private runMigrations(): void
}
```

**Also create**: `src/core/storage/knowledge/index.ts` — barrel export for the module.

---

### Phase 2: Embedding Service

**Create**: `src/core/storage/knowledge/EmbeddingService.ts`

Uses Ollama's embedding API to generate vector embeddings locally.

```typescript
import { Ollama } from "ollama"

export class EmbeddingService {
    private client: Ollama
    private model: string  // default: "nomic-embed-text"
    private dimensions: number  // 768 for nomic-embed-text

    constructor(options?: {
        baseUrl?: string    // from ollamaBaseUrl setting
        apiKey?: string     // from ollamaApiKey setting
        model?: string      // configurable embedding model
    })

    // Generate embedding for a single text
    async embed(text: string): Promise<Float32Array>

    // Generate embeddings for multiple texts (batched)
    async embedBatch(texts: string[]): Promise<Float32Array[]>

    // Check if the embedding model is available
    async isAvailable(): Promise<boolean>

    // Get the dimensionality of embeddings
    getDimensions(): number

    // Serialize Float32Array to Buffer for SQLite BLOB storage
    static toBuffer(embedding: Float32Array): Buffer

    // Deserialize Buffer from SQLite back to Float32Array
    static fromBuffer(buffer: Buffer): Float32Array
}
```

**Implementation notes**:
- Use the `ollama` npm package's `embed()` method (not `chat()`)
- The Ollama embed API: `client.embed({ model, input: text })`
- Return `response.embeddings[0]` as Float32Array
- Handle errors gracefully — if Ollama is down or model not pulled, log warning and return null
- Add a `pullModelIfNeeded()` helper that calls `client.pull({ model })` if the embed model isn't available

---

### Phase 3: Vector Search

**Create**: `src/core/storage/knowledge/VectorSearch.ts`

Pure TypeScript cosine similarity search over stored embeddings.

```typescript
export class VectorSearch {
    private db: KnowledgeDatabase
    private embeddingService: EmbeddingService

    constructor(db: KnowledgeDatabase, embeddingService: EmbeddingService)

    // Store an embedding
    async store(params: {
        sourceType: 'conversation' | 'document' | 'knowledge'
        sourceId: string
        content: string
        embedding: Float32Array
        metadata?: Record<string, any>
    }): Promise<void>

    // Search for similar content
    async search(params: {
        query: string
        sourceType?: 'conversation' | 'document' | 'knowledge'  // filter by type
        topK?: number       // default: 5
        threshold?: number  // minimum similarity, default: 0.7
    }): Promise<SearchResult[]>

    // Delete embeddings by source
    async deleteBySource(sourceType: string, sourceId: string): Promise<void>
}

export interface SearchResult {
    sourceType: string
    sourceId: string
    content: string
    similarity: number  // 0-1 cosine similarity
    metadata: Record<string, any>
}
```

**Cosine similarity implementation**:
```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}
```

**Performance note**: For the expected data sizes (thousands, not millions of vectors), a full scan with JS-side cosine similarity is perfectly fast. No need for approximate nearest neighbors.

---

### Phase 4: Conversation Memory

**Create**: `src/core/storage/knowledge/ConversationMemory.ts`

Automatically indexes completed conversations for semantic search.

```typescript
export class ConversationMemory {
    private db: KnowledgeDatabase
    private vectorSearch: VectorSearch
    private embeddingService: EmbeddingService

    constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService)

    // Index a completed conversation (called when a task finishes)
    async indexConversation(params: {
        taskId: string
        messages: Array<{ role: string; content: string }>
        modelUsed?: string
        workspacePath?: string
    }): Promise<void>

    // Search past conversations by semantic similarity
    async searchMemory(query: string, options?: {
        topK?: number
        workspacePath?: string  // scope to current project
    }): Promise<MemoryResult[]>

    // Check if a conversation is already indexed
    async isIndexed(taskId: string): Promise<boolean>

    // Get conversation count
    async getStats(): Promise<{ totalConversations: number; totalEmbeddings: number }>
}

interface MemoryResult {
    taskId: string
    summary: string
    relevantContent: string
    similarity: number
    keyTopics: string[]
}
```

**How conversation indexing works**:
1. When a task completes, read its `api_conversation_history.json`
2. Extract the text content from all messages
3. Create a summary by taking the first user message + key assistant responses (truncate to ~500 tokens)
4. Generate an embedding of the summary
5. Store in `conversation_memory` table + `embeddings` table

---

### Phase 5: Document Indexer

**Create**: `src/core/storage/knowledge/DocumentIndexer.ts`

Indexes local project files for RAG retrieval.

```typescript
import * as crypto from "crypto"

export class DocumentIndexer {
    private db: KnowledgeDatabase
    private vectorSearch: VectorSearch
    private embeddingService: EmbeddingService

    // File extensions to index
    private static INDEXABLE_EXTENSIONS = new Set([
        '.md', '.txt', '.ts', '.js', '.py', '.rs', '.go', '.java',
        '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini',
        '.html', '.css', '.sql', '.sh', '.bash',
        '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
        '.dockerfile', '.env.example', '.gitignore'
    ])

    // Max file size to index (100KB)
    private static MAX_FILE_SIZE = 100 * 1024

    // Chunk size in characters (~500 tokens)
    private static CHUNK_SIZE = 2000
    private static CHUNK_OVERLAP = 200

    constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService)

    // Index a single file
    async indexFile(filePath: string, workspacePath?: string): Promise<void>

    // Index an entire directory (respects .gitignore)
    async indexDirectory(dirPath: string, options?: {
        recursive?: boolean     // default: true
        respectGitignore?: boolean  // default: true
        maxFiles?: number       // default: 500
    }): Promise<IndexingStats>

    // Re-index files that have changed (compare file hash)
    async refreshIndex(workspacePath: string): Promise<IndexingStats>

    // Remove a file from the index
    async removeFile(filePath: string): Promise<void>

    // Search indexed documents
    async searchDocuments(query: string, options?: {
        topK?: number
        workspacePath?: string
    }): Promise<DocumentResult[]>
}

interface IndexingStats {
    filesIndexed: number
    filesSkipped: number
    chunksCreated: number
    errors: string[]
}

interface DocumentResult {
    filePath: string
    chunkContent: string
    chunkIndex: number
    similarity: number
}
```

**Chunking strategy**:
- Split files into overlapping chunks of ~2000 chars with 200 char overlap
- For code files, try to split on function/class boundaries when possible
- For markdown, split on headings
- Each chunk gets its own embedding

**Change detection**:
- Compute SHA-256 hash of file content
- Store in `document_index.file_hash`
- On refresh, only re-embed files whose hash has changed

---

### Phase 6: User Knowledge Base

**Create**: `src/core/storage/knowledge/UserKnowledgeBase.ts`

Persistent storage for user-curated facts, preferences, and notes.

```typescript
export class UserKnowledgeBase {
    private db: KnowledgeDatabase
    private vectorSearch: VectorSearch
    private embeddingService: EmbeddingService

    constructor(db: KnowledgeDatabase, vectorSearch: VectorSearch, embeddingService: EmbeddingService)

    // Add or update a knowledge entry
    async set(category: string, key: string, value: string, metadata?: Record<string, any>): Promise<void>

    // Get a specific entry
    async get(category: string, key: string): Promise<string | null>

    // Delete an entry
    async delete(category: string, key: string): Promise<void>

    // List all entries in a category
    async listCategory(category: string): Promise<KnowledgeEntry[]>

    // List all categories
    async listCategories(): Promise<string[]>

    // Semantic search across all knowledge
    async search(query: string, options?: {
        category?: string
        topK?: number
    }): Promise<KnowledgeSearchResult[]>

    // Import knowledge from a markdown file
    async importFromMarkdown(filePath: string, category?: string): Promise<number>

    // Export all knowledge to markdown
    async exportToMarkdown(): Promise<string>
}

interface KnowledgeEntry {
    category: string
    key: string
    value: string
    metadata: Record<string, any>
    createdAt: number
    updatedAt: number
}

interface KnowledgeSearchResult extends KnowledgeEntry {
    similarity: number
}
```

**Categories** (suggested defaults):
- `preferences` — user coding preferences, style choices
- `project` — project-specific notes and conventions
- `patterns` — common patterns the user likes to use
- `general` — everything else

---

### Phase 7: RAG Pipeline

**Create**: `src/core/storage/knowledge/RAGPipeline.ts`

Orchestrates retrieval from all sources and formats context for injection.

```typescript
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
    })

    // Main entry point: retrieve relevant context for a query
    async retrieveContext(params: {
        query: string               // the user's current message
        workspacePath?: string      // scope document search
        maxTokens?: number          // budget for retrieved context (default: 2000)
        sources?: {                 // which sources to query
            conversations?: boolean  // default: true
            documents?: boolean      // default: true
            knowledge?: boolean      // default: true
        }
    }): Promise<RAGContext>

    // Format retrieved context as a string for system prompt injection
    formatContextForPrompt(context: RAGContext): string

    // Check if the knowledge store is operational
    async isAvailable(): Promise<boolean>
}

interface RAGContext {
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
```

**Context formatting** (what gets injected into the prompt):
```
<knowledge_context>
<persistent_memory>
[Relevant past conversation summaries]
</persistent_memory>

<project_knowledge>
[Relevant document chunks from the workspace]
</project_knowledge>

<user_preferences>
[Relevant user knowledge entries]
</user_preferences>
</knowledge_context>
```

**Token budgeting**: Split the `maxTokens` budget roughly:
- 40% for document chunks (most useful for coding tasks)
- 35% for conversation memory
- 25% for user knowledge

---

### Phase 8: System Prompt Integration

This is where the RAG context gets silently injected into every prompt.

**Modify**: `src/core/prompts/system-prompt/templates/placeholders.ts`

Add a new section to the `SystemPromptSection` enum:
```typescript
KNOWLEDGE_CONTEXT = "KNOWLEDGE_CONTEXT_SECTION",
```

**Create**: `src/core/prompts/system-prompt/components/knowledge_context.ts`

```typescript
import { SystemPromptVariant } from "../variants/types"
import { SystemPromptContext } from "../types"

export async function getKnowledgeContextSection(
    variant: SystemPromptVariant,
    context: SystemPromptContext
): Promise<string> {
    // Import the RAG pipeline singleton
    // Retrieve context based on the current task/objective
    // Return formatted context string, or empty string if unavailable

    // IMPORTANT: Wrap in try/catch — if Ollama is down or embeddings
    // aren't available, return "" silently. Never break the prompt.
}
```

**Modify**: `src/core/prompts/system-prompt/components/index.ts`

Add the new component to the registry array:
```typescript
import { getKnowledgeContextSection } from "./knowledge_context"

// Add to the array in getSystemPromptComponents():
{ id: SystemPromptSection.KNOWLEDGE_CONTEXT, fn: getKnowledgeContextSection },
```

**Modify**: The base prompt template (find it in `src/core/prompts/system-prompt/variants/`) to include the `{{KNOWLEDGE_CONTEXT_SECTION}}` placeholder in an appropriate location (after RULES, before OBJECTIVE).

---

### Phase 9: Configuration & Settings

**Modify**: `src/shared/storage/state-keys.ts`

Add these fields to `USER_SETTINGS_FIELDS`:

```typescript
// Knowledge Store Settings
knowledgeStoreEnabled: { default: true as boolean },
knowledgeStoreEmbeddingModel: { default: "nomic-embed-text" as string },
knowledgeStoreAutoIndexConversations: { default: true as boolean },
knowledgeStoreAutoIndexDocuments: { default: false as boolean },
knowledgeStoreMaxContextTokens: { default: 2000 as number },
knowledgeStoreDocumentExtensions: {
    default: ".md,.txt,.ts,.js,.py,.rs,.go,.java,.json,.yaml,.yml" as string
},
```

These will automatically be available through `StateManager.get().getGlobalStateKey("knowledgeStoreEnabled")` etc.

---

### Phase 10: Wiring & Initialization

**Create**: `src/core/storage/knowledge/KnowledgeStoreManager.ts`

Singleton that initializes and manages all knowledge store components.

```typescript
export class KnowledgeStoreManager {
    private static instance: KnowledgeStoreManager | null = null

    private database: KnowledgeDatabase
    private embeddingService: EmbeddingService
    private vectorSearch: VectorSearch
    private conversationMemory: ConversationMemory
    private documentIndexer: DocumentIndexer
    private userKnowledge: UserKnowledgeBase
    private ragPipeline: RAGPipeline

    private constructor()

    static async initialize(options: {
        ollamaBaseUrl?: string
        ollamaApiKey?: string
        embeddingModel?: string
    }): Promise<KnowledgeStoreManager>

    static getInstance(): KnowledgeStoreManager | null

    // Accessors
    getRAGPipeline(): RAGPipeline
    getConversationMemory(): ConversationMemory
    getDocumentIndexer(): DocumentIndexer
    getUserKnowledge(): UserKnowledgeBase

    // Lifecycle
    async shutdown(): Promise<void>

    // Called when a task completes to auto-index the conversation
    async onTaskComplete(taskId: string, messages: any[], modelUsed?: string, workspacePath?: string): Promise<void>
}
```

**Modify**: Extension initialization (find where `SqliteLockManager` is initialized and add `KnowledgeStoreManager` initialization nearby).

**Modify**: Task completion handler — find where tasks are marked complete in `src/core/task/index.ts` and add `KnowledgeStoreManager.getInstance()?.onTaskComplete(...)`.

---

### Phase 11: Testing & Verification

1. **Verify TypeScript compilation**: Run `npm run compile` (or the project's type-check command) and fix any type errors.
2. **Create a manual test file**: `src/core/storage/knowledge/__tests__/knowledge-store.test.ts` with basic tests:
   - Database creation and schema validation
   - Embedding serialization/deserialization round-trip
   - Vector search with mock embeddings
   - Conversation memory CRUD
   - Document indexer chunking
   - User knowledge CRUD
   - RAG pipeline context assembly
3. **Integration smoke test**: Verify the extension can activate without errors when the knowledge store is enabled/disabled.

---

## Important Constraints

1. **Never break the extension**: All knowledge store code must be wrapped in try/catch. If Ollama is unavailable, the embedding model isn't pulled, or the database fails — log a warning and continue. The extension must work exactly as before even if the knowledge store is completely broken.

2. **Lazy initialization**: Don't block extension startup. Initialize the database synchronously (following the lock manager pattern), but defer embedding model checks to first use.

3. **Respect existing patterns**: Use `Logger`, use path aliases, follow the `better-sqlite3` patterns from `SqliteLockManager`, use `StateManager` for settings.

4. **No new dependencies**: Everything needed (`better-sqlite3`, `ollama`, `p-mutex`) is already in package.json.

5. **File sizes**: Keep individual files under 300 lines. Split into helpers if needed.

6. **TypeScript strict mode**: The project uses strict TypeScript. Ensure all types are explicit and correct.

---

## Session Resumption Instructions

When starting a new Claude Code session:

1. Read `PROGRESS.md` to see current state
2. Read the files listed under "Files Created" to understand what exists
3. Continue from the next incomplete phase
4. After completing work, update `PROGRESS.md`

If you encounter compilation errors from previous phases, fix them before moving forward.

Good luck. Build it phase by phase, test as you go, and keep `PROGRESS.md` updated.
