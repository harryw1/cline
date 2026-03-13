import chokidar, { type FSWatcher } from "chokidar"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { KnowledgeStoreManager } from "./KnowledgeStoreManager"

export class WorkspaceIndexer {
	private watcher: FSWatcher | null = null
	private indexingInProgress = false
	private pendingReindex = new Set<string>()
	private debounceTimer: ReturnType<typeof setTimeout> | null = null

	/**
	 * Index a workspace directory and optionally start watching for changes.
	 */
	async indexWorkspace(
		workspacePath: string,
		options?: {
			watch?: boolean
			extensions?: string[]
			maxFiles?: number
		},
	): Promise<void> {
		const manager = KnowledgeStoreManager.getInstance()
		if (!manager) {
			return
		}

		const indexer = manager.getDocumentIndexer()

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
					`${stats.chunksCreated} chunks, skipped ${stats.filesSkipped}`,
			)

			if (options?.watch) {
				this.startWatching(workspacePath, options.extensions)
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
			this.watcher.close().catch(() => {})
		}

		const defaultExts = [
			"md",
			"txt",
			"ts",
			"js",
			"py",
			"rs",
			"go",
			"java",
			"json",
			"yaml",
			"yml",
			"toml",
			"html",
			"css",
			"sql",
		]
		const exts = extensions?.map((e) => e.replace(/^\./, "")) ?? defaultExts
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
			ignoreInitial: true,
		})

		const handleChange = (relativePath: string) => {
			const fullPath = path.join(workspacePath, relativePath)
			this.pendingReindex.add(fullPath)
			this.scheduleReindex(workspacePath)
		}

		this.watcher
			.on("change", handleChange)
			.on("add", handleChange)
			.on("unlink", (relativePath) => {
				const fullPath = path.join(workspacePath, relativePath)
				const manager = KnowledgeStoreManager.getInstance()
				if (manager) {
					manager
						.getDocumentIndexer()
						.removeFile(fullPath)
						.catch(() => {})
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
			if (this.indexingInProgress) {
				return
			}

			const files = [...this.pendingReindex]
			this.pendingReindex.clear()

			const manager = KnowledgeStoreManager.getInstance()
			if (!manager || files.length === 0) {
				return
			}

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
			this.debounceTimer = null
		}
		if (this.watcher) {
			await this.watcher.close()
			this.watcher = null
		}
	}
}
