# Knowledge Store Phase 2 — Per-Message RAG & CLI Integration

## How to Use This File

Copy the entire contents of this file and paste it as your prompt to Claude Code. When starting a new session, tell Claude Code:

> "Read `KNOWLEDGE_STORE_PHASE2.md` and `PROGRESS_PHASE2.md` in the repo root, then continue from where we left off."

Claude Code will check `PROGRESS_PHASE2.md` to see what's done and pick up from there.

---

## Master Prompt

You are continuing work on the SQLite-backed knowledge store for the Cline VS Code extension. Phase 1 (all 11 phases in `KNOWLEDGE_STORE_IMPLEMENTATION.md`) is complete. The core infrastructure — database, embeddings, vector search, conversation memory, document indexer, user knowledge base, RAG pipeline, system prompt integration, and settings — is all built and working.

Phase 2 focuses on three improvements:
1. **Per-message RAG injection** — Move document/conversation retrieval from the system prompt into the user message context, so each turn gets targeted context
2. **Workspace auto-indexing & file watching** — Automatically index project files and re-index when they change
3. **CLI knowledge commands** — Give users `cline knowledge` CLI commands to manage the knowledge store

### Progress Tracking
**CRITICAL**: Before doing ANY work, read `PROGRESS_PHASE2.md` in the repo root. If it doesn't exist, create it from the template at the bottom of this file. After completing each phase, update it.

---

## Architecture Context

### What Already Exists (Phase 1)

All source files are in `src/core/storage/knowledge/`:

| File | Purpose |
|------|---------|
| `KnowledgeDatabase.ts` | SQLite database with schema, lock-file init, migrations |
| `EmbeddingService.ts` | Ollama embedding generation via `ollama` npm package |
| `VectorSearch.ts` | Cosine similarity search over stored BLOB embeddings |
| `ConversationMemory.ts` | Indexes completed conversations, supports semantic + recency search |
| `DocumentIndexer.ts` | Indexes local files with chunking and SHA-256 change detection |
| `UserKnowledgeBase.ts` | User-curated knowledge CRUD with markdown import/export |
| `RAGPipeline.ts` | Orchestrates retrieval from all sources with token budgeting |
| `KnowledgeStoreManager.ts` | Singleton manager, initialized from `src/common.ts` and `cli/src/index.ts` |
| `index.ts` | Barrel exports |

System prompt integration:
- `src/core/prompts/system-prompt/components/knowledge_context.ts` — Registered in all 12 prompt variants
- Uses `_context.taskMessage` (latest user message, truncated to 500 chars) as the RAG query
- Falls back to recency-based retrieval when embeddings are unavailable

Configuration keys in `src/shared/storage/state-keys.ts`:
- `knowledgeStoreEnabled` (default: `true`)
- `knowledgeStoreEmbeddingModel` (default: `"nomic-embed-text"`)
- `knowledgeStoreAutoIndexConversations` (default: `true`)
- `knowledgeStoreAutoIndexDocuments` (default: `false`)
- `knowledgeStoreMaxContextTokens` (default: `2000`)
- `knowledgeStoreDocumentExtensions` (default: `".md,.txt,.ts,.js,.py,.rs,.go,.java,.json,.yaml,.yml"`)

CLI initialization: `cli/src/index.ts` line 546 calls `initializeKnowledgeStore(StateManager.get())` (lines 1154-1169).

### Key Integration Points

1. **`src/core/task/index.ts`** — The main task execution loop
   - `attemptApiRequest()` (line 1787) rebuilds the system prompt on EVERY turn
   - Lines 1878-1891: Extracts `taskMessage` from the latest user message (truncated to 500 chars)
   - Line 1933: `getSystemPrompt(promptContext)` — builds the full prompt with knowledge context
   - Line 1954: `this.api.createMessage(systemPrompt, truncatedConversationHistory, tools)` — the actual API call
   - The system prompt is rebuilt per-turn, so the knowledge_context component IS already per-message via `taskMessage`

2. **`cli/src/index.ts`** — CLI command registration
   - Uses `commander` (the `program` object)
   - Pattern: `program.command("name").description("...").action(handler)`
   - Subcommands: `const mcpCommand = program.command("mcp")` → `mcpCommand.command("add").action(...)`
   - See the `mcp` command group (lines 882-892) for the exact pattern to follow

3. **`src/core/prompts/system-prompt/components/knowledge_context.ts`** — Current RAG injection point
   - When `taskMessage` is truthy, calls `ragPipeline.retrieveContext()` with all three sources
   - Formats results into `<knowledge_context>` XML block in the system prompt

---

## Phase 2A: Per-Message RAG Injection (into User Messages)

### Problem

Currently, ALL retrieved context (conversations, documents, user knowledge) goes into the system prompt. This has drawbacks:
- System prompt grows large, eating into the context window budget every turn
- Document chunks are repeated in every turn even if irrelevant to the current message
- The query is truncated to 500 characters

### Solution

Split the knowledge context into two tiers:

**Tier 1 — System prompt (static, session-wide)**: Keep ONLY user knowledge/preferences here. These are small, stable, and relevant to every message. The `knowledge_context.ts` component handles this.

**Tier 2 — User message prefix (dynamic, per-message)**: Inject document chunks and conversation memory results as a context block prepended to the user's message before it's sent to the API. This is query-specific and changes every turn.

### Implementation

#### Step 1: Refactor `knowledge_context.ts` to only inject user knowledge

**Modify**: `src/core/prompts/system-prompt/components/knowledge_context.ts`

Remove the RAG pipeline call. Keep only the user knowledge and recent memories (the fallback path). The component should:
1. Get `KnowledgeStoreManager.getInstance()`
2. Retrieve user knowledge entries from `userKnowledge.listCategories()` + `listCategory()`
3. Optionally include the last 3-5 recent conversation memory summaries (recency-based, no embeddings needed)
4. Format as `<knowledge_context>` with `<user_preferences>` and `<persistent_memory>` sections
5. Return empty string if nothing available

Do NOT call `ragPipeline.retrieveContext()` here anymore — that moves to Tier 2.

#### Step 2: Create a message-level RAG injector

**Create**: `src/core/storage/knowledge/MessageRAGInjector.ts`

```typescript
import { KnowledgeStoreManager } from "./KnowledgeStoreManager"
import { Logger } from "@/shared/services/Logger"

export interface MessageRAGResult {
    contextBlock: string      // Formatted XML to prepend to user message
    tokensUsed: number        // Estimated tokens consumed
    sourceCounts: {
        conversations: number
        documents: number
    }
}

/**
 * Retrieves query-specific RAG context to inject into user messages.
 * Called once per API turn, right before createMessage().
 * Returns formatted context to prepend to the user's message.
 */
export async function retrieveMessageRAGContext(params: {
    query: string              // The full user message text (NOT truncated)
    workspacePath?: string     // Current workspace for document scoping
    maxTokens?: number         // Token budget (default from settings)
}): Promise<MessageRAGResult | null> {
    try {
        const manager = KnowledgeStoreManager.getInstance()
        if (!manager) return null

        const ragPipeline = manager.getRAGPipeline()
        const available = await ragPipeline.isAvailable()
        if (!available) return null

        const context = await ragPipeline.retrieveContext({
            query: params.query,
            workspacePath: params.workspacePath,
            maxTokens: params.maxTokens ?? 1500,
            sources: {
                conversations: true,
                documents: true,
                knowledge: false,  // knowledge is in the system prompt already
            },
        })

        if (context.conversationMemory.length === 0 && context.documentChunks.length === 0) {
            return null
        }

        const sections: string[] = []

        if (context.conversationMemory.length > 0) {
            const items = context.conversationMemory
                .map((m) => `- ${m.summary}`)
                .join("\n")
            sections.push(`<relevant_past_conversations>\n${items}\n</relevant_past_conversations>`)
        }

        if (context.documentChunks.length > 0) {
            const items = context.documentChunks
                .map((d) => `[${d.filePath}]\n${d.content}`)
                .join("\n---\n")
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
```

#### Step 3: Wire into `task/index.ts`

**Modify**: `src/core/task/index.ts`

In `attemptApiRequest()`, AFTER building the system prompt and getting `contextManagementMetadata`, but BEFORE calling `this.api.createMessage()`:

```typescript
// --- Per-message RAG injection ---
import { retrieveMessageRAGContext } from "@/core/storage/knowledge/MessageRAGInjector"

// Extract full user message text for RAG query (not truncated)
const fullUserMessage = this.getLatestUserMessageText(
    contextManagementMetadata.truncatedConversationHistory
)

let ragEnrichedHistory = contextManagementMetadata.truncatedConversationHistory

if (fullUserMessage && this.stateManager.getGlobalSettingsKey("knowledgeStoreEnabled")) {
    const ragResult = await retrieveMessageRAGContext({
        query: fullUserMessage,
        workspacePath: this.cwd,
        maxTokens: this.stateManager.getGlobalSettingsKey("knowledgeStoreMaxContextTokens"),
    })

    if (ragResult) {
        // Prepend RAG context to the last user message in the history
        ragEnrichedHistory = this.prependRAGToLastUserMessage(
            ragEnrichedHistory,
            ragResult.contextBlock
        )
    }
}

const stream = this.api.createMessage(systemPrompt, ragEnrichedHistory, tools)
```

**Add two helper methods to the Task class**:

```typescript
/**
 * Extract the full text of the latest user message from conversation history.
 * Does NOT truncate — used for RAG query quality.
 */
private getLatestUserMessageText(history: ClineStorageMessage[]): string | undefined {
    const lastUserMsg = [...history].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return undefined
    if (typeof lastUserMsg.content === "string") return lastUserMsg.content
    if (Array.isArray(lastUserMsg.content)) {
        return lastUserMsg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ")
    }
    return undefined
}

/**
 * Clone the conversation history and prepend a RAG context block
 * to the last user message's text content.
 */
private prependRAGToLastUserMessage(
    history: ClineStorageMessage[],
    contextBlock: string
): ClineStorageMessage[] {
    const cloned = [...history]
    for (let i = cloned.length - 1; i >= 0; i--) {
        if (cloned[i].role === "user") {
            const msg = { ...cloned[i] }
            if (typeof msg.content === "string") {
                msg.content = contextBlock + msg.content
            } else if (Array.isArray(msg.content)) {
                // Find the first text block and prepend
                const content = [...msg.content]
                const textIdx = content.findIndex((b) => b.type === "text")
                if (textIdx >= 0) {
                    content[textIdx] = {
                        ...content[textIdx],
                        text: contextBlock + (content[textIdx] as any).text,
                    }
                } else {
                    content.unshift({ type: "text", text: contextBlock })
                }
                msg.content = content
            }
            cloned[i] = msg
            break
        }
    }
    return cloned
}
```

**IMPORTANT**: The `ragEnrichedHistory` must NOT be saved back to persistent storage. It's a temporary modification for the API call only. The original `contextManagementMetadata.truncatedConversationHistory` remains the source of truth.

#### Step 4: Update `RAGPipeline.ts` to support source filtering

The RAG pipeline already supports `sources: { conversations, documents, knowledge }`. Verify this works correctly when `knowledge: false` is passed — it should skip the user knowledge search entirely. If it doesn't, fix it.

---

## Phase 2B: Workspace Auto-Indexing & File Watching

### Step 1: Add workspace indexing trigger

**Create**: `src/core/storage/knowledge/WorkspaceIndexer.ts`

```typescript
import { KnowledgeStoreManager } from "./KnowledgeStoreManager"
import { Logger } from "@/shared/services/Logger"
import * as chokidar from "chokidar"

export class WorkspaceIndexer {
    private watcher: chokidar.FSWatcher | null = null
    private indexingInProgress = false
    private pendingReindex = new Set<string>()
    private debounceTimer: NodeJS.Timeout | null = null

    /**
     * Index a workspace directory and optionally start watching for changes.
     */
    async indexWorkspace(workspacePath: string, options?: {
        watch?: boolean           // Start file watcher (default: false)
        extensions?: string[]     // File extensions to index
        maxFiles?: number         // Max files to index (default: 500)
    }): Promise<void> {
        const manager = KnowledgeStoreManager.getInstance()
        if (!manager) return

        const indexer = manager.getDocumentIndexer()
        const extensions = options?.extensions

        try {
            this.indexingInProgress = true
            Logger.log(`WorkspaceIndexer: Starting index of ${workspacePath}`)

            const stats = await indexer.indexDirectory(workspacePath, {
                recursive: true,
                respectGitignore: true,
                maxFiles: options?.maxFiles ?? 500,
            })

            Logger.log(
                `WorkspaceIndexer: Indexed ${stats.filesIndexed} files, ` +
                `${stats.chunksCreated} chunks, skipped ${stats.filesSkipped}`
            )

            if (options?.watch) {
                this.startWatching(workspacePath, extensions)
            }
        } catch (error) {
            Logger.warn(`WorkspaceIndexer: Failed to index ${workspacePath}: ${error}`)
        } finally {
            this.indexingInProgress = false
        }
    }

    /**
     * Watch for file changes and re-index modified files.
     */
    private startWatching(workspacePath: string, extensions?: string[]): void {
        if (this.watcher) {
            this.watcher.close()
        }

        // Build glob pattern from extensions
        const defaultExts = [
            "md", "txt", "ts", "js", "py", "rs", "go", "java",
            "json", "yaml", "yml", "toml", "html", "css", "sql"
        ]
        const exts = extensions?.map(e => e.replace(/^\./, "")) ?? defaultExts
        const pattern = `**/*.{${exts.join(",")}}`

        this.watcher = chokidar.watch(pattern, {
            cwd: workspacePath,
            ignored: [
                "**/node_modules/**",
                "**/.git/**",
                "**/dist/**",
                "**/build/**",
                "**/.next/**",
                "**/target/**",
                "**/__pycache__/**",
            ],
            persistent: true,
            ignoreInitial: true,  // Don't fire for existing files
        })

        const handleChange = (relativePath: string) => {
            const fullPath = require("path").join(workspacePath, relativePath)
            this.pendingReindex.add(fullPath)
            this.scheduleReindex(workspacePath)
        }

        this.watcher
            .on("change", handleChange)
            .on("add", handleChange)
            .on("unlink", (relativePath) => {
                const fullPath = require("path").join(workspacePath, relativePath)
                const manager = KnowledgeStoreManager.getInstance()
                if (manager) {
                    manager.getDocumentIndexer().removeFile(fullPath).catch(() => {})
                }
            })

        Logger.log(`WorkspaceIndexer: Watching ${workspacePath} for changes`)
    }

    /**
     * Debounced re-index — waits 2 seconds after the last change before re-indexing.
     */
    private scheduleReindex(workspacePath: string): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
        }
        this.debounceTimer = setTimeout(async () => {
            if (this.indexingInProgress) return

            const files = [...this.pendingReindex]
            this.pendingReindex.clear()

            const manager = KnowledgeStoreManager.getInstance()
            if (!manager || files.length === 0) return

            const indexer = manager.getDocumentIndexer()
            for (const filePath of files) {
                try {
                    await indexer.indexFile(filePath, workspacePath)
                } catch (error) {
                    Logger.debug(`WorkspaceIndexer: Failed to re-index ${filePath}: ${error}`)
                }
            }
        }, 2000)
    }

    /**
     * Stop watching and clean up.
     */
    async dispose(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
        }
        if (this.watcher) {
            await this.watcher.close()
            this.watcher = null
        }
    }
}
```

### Step 2: Wire auto-indexing into task startup

**Modify**: `src/core/task/index.ts` or `src/common.ts`

When a task starts and `knowledgeStoreAutoIndexDocuments` is enabled, trigger a background workspace index:

```typescript
// In task initialization or common.ts after knowledge store init:
if (stateManager.getGlobalSettingsKey("knowledgeStoreAutoIndexDocuments")) {
    const { WorkspaceIndexer } = await import("@/core/storage/knowledge/WorkspaceIndexer")
    const workspaceIndexer = new WorkspaceIndexer()
    // Fire and forget — don't block task startup
    workspaceIndexer.indexWorkspace(cwd, { watch: true }).catch(() => {})
}
```

### Step 3: Add WorkspaceIndexer to KnowledgeStoreManager

**Modify**: `src/core/storage/knowledge/KnowledgeStoreManager.ts`

Add a `WorkspaceIndexer` field and expose it:

```typescript
private workspaceIndexer: WorkspaceIndexer | null = null

getWorkspaceIndexer(): WorkspaceIndexer {
    if (!this.workspaceIndexer) {
        this.workspaceIndexer = new WorkspaceIndexer()
    }
    return this.workspaceIndexer
}

// In shutdown():
async shutdown(): Promise<void> {
    if (this.workspaceIndexer) {
        await this.workspaceIndexer.dispose()
    }
    this.database.close()
    // ...
}
```

### Step 4: Add to barrel exports

**Modify**: `src/core/storage/knowledge/index.ts`

```typescript
export { WorkspaceIndexer } from "./WorkspaceIndexer"
export { retrieveMessageRAGContext } from "./MessageRAGInjector"
```

---

## Phase 2C: CLI Knowledge Commands

### Overview

Add a `cline knowledge` command group to the CLI with subcommands for managing the knowledge store. Follow the exact pattern of the existing `cline mcp` command group.

### Step 1: Create CLI command handlers

**Create**: `cli/src/commands/knowledge.ts`

```typescript
import { StateManager } from "@core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

// Handler for: cline knowledge add <category> <key> <value>
export async function addKnowledge(
    category: string,
    key: string,
    value: string,
    options: { metadata?: string }
): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized. Is it enabled in settings?")
        process.exit(1)
    }

    const metadata = options.metadata ? JSON.parse(options.metadata) : undefined
    await manager.getUserKnowledge().set(category, key, value, metadata)
    console.log(`Added: ${category}/${key}`)
}

// Handler for: cline knowledge get <category> <key>
export async function getKnowledge(category: string, key: string): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const value = await manager.getUserKnowledge().get(category, key)
    if (value) {
        console.log(value)
    } else {
        console.error(`Not found: ${category}/${key}`)
        process.exit(1)
    }
}

// Handler for: cline knowledge remove <category> <key>
export async function removeKnowledge(category: string, key: string): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    await manager.getUserKnowledge().delete(category, key)
    console.log(`Removed: ${category}/${key}`)
}

// Handler for: cline knowledge list [category]
export async function listKnowledge(category?: string): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const kb = manager.getUserKnowledge()

    if (category) {
        const entries = await kb.listCategory(category)
        if (entries.length === 0) {
            console.log(`No entries in category: ${category}`)
            return
        }
        for (const entry of entries) {
            console.log(`  ${entry.key}: ${entry.value}`)
        }
    } else {
        const categories = await kb.listCategories()
        if (categories.length === 0) {
            console.log("Knowledge store is empty.")
            return
        }
        for (const cat of categories) {
            const entries = await kb.listCategory(cat)
            console.log(`\n[${cat}] (${entries.length} entries)`)
            for (const entry of entries) {
                console.log(`  ${entry.key}: ${entry.value.slice(0, 100)}${entry.value.length > 100 ? "..." : ""}`)
            }
        }
    }
}

// Handler for: cline knowledge search <query>
export async function searchKnowledge(
    query: string,
    options: { type?: string; limit?: string }
): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const ragPipeline = manager.getRAGPipeline()
    const topK = options.limit ? parseInt(options.limit, 10) : 5

    const sourceFilter = {
        conversations: !options.type || options.type === "conversations",
        documents: !options.type || options.type === "documents",
        knowledge: !options.type || options.type === "knowledge",
    }

    const context = await ragPipeline.retrieveContext({
        query,
        maxTokens: 4000,
        sources: sourceFilter,
    })

    let hasResults = false

    if (context.conversationMemory.length > 0) {
        hasResults = true
        console.log("\n--- Conversation Memory ---")
        for (const m of context.conversationMemory) {
            console.log(`  [${(m.similarity * 100).toFixed(0)}%] Task ${m.taskId}: ${m.summary.slice(0, 120)}...`)
        }
    }

    if (context.documentChunks.length > 0) {
        hasResults = true
        console.log("\n--- Document Chunks ---")
        for (const d of context.documentChunks) {
            console.log(`  [${(d.similarity * 100).toFixed(0)}%] ${d.filePath}`)
            console.log(`    ${d.content.slice(0, 150)}...`)
        }
    }

    if (context.knowledgeEntries.length > 0) {
        hasResults = true
        console.log("\n--- Knowledge Entries ---")
        for (const k of context.knowledgeEntries) {
            console.log(`  [${(k.similarity * 100).toFixed(0)}%] ${k.category}/${k.key}: ${k.value.slice(0, 120)}`)
        }
    }

    if (!hasResults) {
        console.log("No results found.")
    }
}

// Handler for: cline knowledge index [path]
export async function indexDocuments(
    dirPath: string | undefined,
    options: { watch?: boolean; maxFiles?: string }
): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const { WorkspaceIndexer } = await import("@/core/storage/knowledge/WorkspaceIndexer")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const targetPath = dirPath || process.cwd()
    const workspaceIndexer = manager.getWorkspaceIndexer()

    console.log(`Indexing ${targetPath}...`)
    await workspaceIndexer.indexWorkspace(targetPath, {
        watch: options.watch ?? false,
        maxFiles: options.maxFiles ? parseInt(options.maxFiles, 10) : 500,
    })
    console.log("Indexing complete.")

    if (options.watch) {
        console.log("Watching for changes... (Ctrl+C to stop)")
        // Keep process alive
        await new Promise(() => {})
    }
}

// Handler for: cline knowledge import <file>
export async function importKnowledge(
    filePath: string,
    options: { category?: string }
): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const count = await manager.getUserKnowledge().importFromMarkdown(filePath, options.category)
    console.log(`Imported ${count} entries from ${filePath}`)
}

// Handler for: cline knowledge export
export async function exportKnowledge(): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const markdown = await manager.getUserKnowledge().exportToMarkdown()
    console.log(markdown)
}

// Handler for: cline knowledge stats
export async function knowledgeStats(): Promise<void> {
    const { KnowledgeStoreManager } = await import("@/core/storage/knowledge")
    const manager = KnowledgeStoreManager.getInstance()
    if (!manager) {
        console.error("Knowledge store is not initialized.")
        process.exit(1)
    }

    const convStats = await manager.getConversationMemory().getStats()
    const categories = await manager.getUserKnowledge().listCategories()
    let knowledgeCount = 0
    for (const cat of categories) {
        const entries = await manager.getUserKnowledge().listCategory(cat)
        knowledgeCount += entries.length
    }

    console.log("\n=== Knowledge Store Stats ===")
    console.log(`  Conversations indexed: ${convStats.totalConversations}`)
    console.log(`  Total embeddings: ${convStats.totalEmbeddings}`)
    console.log(`  Knowledge entries: ${knowledgeCount}`)
    console.log(`  Categories: ${categories.length > 0 ? categories.join(", ") : "(none)"}`)
}
```

### Step 2: Register CLI commands

**Modify**: `cli/src/index.ts`

Add the knowledge command group after the existing `mcp` command group (around line 892):

```typescript
import {
    addKnowledge,
    getKnowledge,
    removeKnowledge,
    listKnowledge,
    searchKnowledge,
    indexDocuments,
    importKnowledge,
    exportKnowledge,
    knowledgeStats,
} from "./commands/knowledge"

// Knowledge store command group
const knowledgeCommand = program.command("knowledge").alias("kb").description("Manage the knowledge store")

knowledgeCommand
    .command("add <category> <key> <value>")
    .description("Add a knowledge entry")
    .option("--metadata <json>", "JSON metadata to attach")
    .action(addKnowledge)

knowledgeCommand
    .command("get <category> <key>")
    .description("Get a knowledge entry")
    .action(getKnowledge)

knowledgeCommand
    .command("remove <category> <key>")
    .description("Remove a knowledge entry")
    .action(removeKnowledge)

knowledgeCommand
    .command("list [category]")
    .description("List knowledge entries (optionally filtered by category)")
    .action(listKnowledge)

knowledgeCommand
    .command("search <query>")
    .description("Semantic search across all knowledge sources")
    .option("-t, --type <type>", "Filter by source type: conversations, documents, knowledge")
    .option("-n, --limit <n>", "Number of results (default: 5)")
    .action(searchKnowledge)

knowledgeCommand
    .command("index [path]")
    .description("Index documents in a directory for RAG")
    .option("-w, --watch", "Watch for file changes and re-index")
    .option("--max-files <n>", "Maximum files to index (default: 500)")
    .action(indexDocuments)

knowledgeCommand
    .command("import <file>")
    .description("Import knowledge entries from a markdown file")
    .option("-c, --category <category>", "Category for imported entries")
    .action(importKnowledge)

knowledgeCommand
    .command("export")
    .description("Export all knowledge entries as markdown")
    .action(exportKnowledge)

knowledgeCommand
    .command("stats")
    .description("Show knowledge store statistics")
    .action(knowledgeStats)
```

**IMPORTANT**: The knowledge store must be initialized BEFORE these commands run. The existing `initializeKnowledgeStore()` call at line 546 handles this for the main CLI flow. For the `knowledge` subcommands, ensure they're registered after initialization, or add a pre-action hook:

```typescript
knowledgeCommand.hook("preAction", async () => {
    // Ensure knowledge store is initialized
    const stateManager = StateManager.get()
    if (!KnowledgeStoreManager.getInstance()) {
        await initializeKnowledgeStore(stateManager)
    }
})
```

---

## Phase 2D: Testing & Verification

1. **TypeScript compilation**: Run `bun run check-types` (or `npm run compile`). Fix all type errors.
2. **Unit tests**: Add tests for `MessageRAGInjector` and `WorkspaceIndexer` in `src/core/storage/knowledge/__tests__/`.
3. **CLI smoke test**: Run `cline knowledge stats`, `cline knowledge list`, `cline knowledge add test-cat test-key "test value"`, `cline knowledge search "test"` — verify all work.
4. **System prompt snapshots**: If snapshots break because the knowledge_context component changed, update them.
5. **Integration test**: Verify that with Ollama running and `nomic-embed-text` pulled:
   - Index a small directory: `cline knowledge index ./src --max-files 10`
   - Search it: `cline knowledge search "how does the API handler work"`
   - Verify document chunks are returned

---

## Important Constraints

1. **Never break existing functionality**: All new code must be wrapped in try/catch. If anything fails, log a warning and continue. The extension must work identically even if the knowledge store is completely broken.
2. **Don't block the critical path**: RAG retrieval in `task/index.ts` must not significantly slow down message sending. If Ollama is slow, consider adding a timeout (e.g., 3 seconds) and skipping RAG if it takes too long.
3. **No new dependencies**: `chokidar` is already in package.json. Don't add anything new.
4. **Don't save RAG-enriched messages**: The RAG context prepended to user messages is for the API call ONLY. Never persist it to `api_conversation_history.json`.
5. **Respect existing patterns**: Use `Logger`, path aliases, StateManager for settings.
6. **Keep files under 300 lines**: Split into helpers if needed.

---

## PROGRESS_PHASE2.md Template

```markdown
# Knowledge Store Phase 2 Progress

## Current Phase: [PHASE ID] — [PHASE NAME]
## Status: [NOT_STARTED | IN_PROGRESS | COMPLETED]
## Last Updated: [TIMESTAMP]

### Completed Phases
- [ ] Phase 2A-1: Refactor knowledge_context.ts (user knowledge only)
- [ ] Phase 2A-2: Create MessageRAGInjector.ts
- [ ] Phase 2A-3: Wire message-level RAG into task/index.ts
- [ ] Phase 2A-4: Verify RAG pipeline source filtering
- [ ] Phase 2B-1: Create WorkspaceIndexer.ts
- [ ] Phase 2B-2: Wire auto-indexing into task/common startup
- [ ] Phase 2B-3: Add WorkspaceIndexer to KnowledgeStoreManager
- [ ] Phase 2B-4: Update barrel exports
- [ ] Phase 2C-1: Create CLI command handlers (cli/src/commands/knowledge.ts)
- [ ] Phase 2C-2: Register CLI commands in cli/src/index.ts
- [ ] Phase 2D: Testing & verification

### Files Created
(list as they're created)

### Files Modified
(list as they're modified)

### Notes for Next Session
(context for resumption)
```
