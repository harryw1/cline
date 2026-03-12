import { Ollama } from "ollama"
import { Logger } from "@/shared/services/Logger"

const DEFAULT_MODEL = "nomic-embed-text"
const DEFAULT_DIMENSIONS = 768

// Lazy-load the proxy-aware fetch to avoid pulling in the heavy @/shared/net
// import chain (which transitively depends on vscode) at module load time.
// Falls back to global fetch when the proxy wrapper is unavailable (e.g., standalone scripts).
let _proxyFetch: typeof globalThis.fetch | undefined
async function getProxyAwareFetch(): Promise<typeof globalThis.fetch> {
	if (_proxyFetch) {
		return _proxyFetch
	}
	try {
		const net = await import("@/shared/net")
		_proxyFetch = net.fetch
	} catch {
		_proxyFetch = globalThis.fetch
	}
	return _proxyFetch
}

export class EmbeddingService {
	private client: Ollama | undefined
	private model: string
	private dimensions: number
	private baseUrl?: string
	private apiKey?: string

	constructor(options?: { baseUrl?: string; apiKey?: string; model?: string }) {
		this.baseUrl = options?.baseUrl
		this.apiKey = options?.apiKey
		this.model = options?.model ?? DEFAULT_MODEL
		this.dimensions = DEFAULT_DIMENSIONS
	}

	private async ensureClient(): Promise<Ollama> {
		if (!this.client) {
			const proxyFetch = await getProxyAwareFetch()
			const clientOptions: Record<string, any> = {
				host: this.baseUrl,
				fetch: proxyFetch,
			}

			if (this.apiKey) {
				clientOptions.headers = {
					Authorization: `Bearer ${this.apiKey}`,
				}
			}

			this.client = new Ollama(clientOptions)
		}
		return this.client
	}

	async embed(text: string): Promise<Float32Array | null> {
		try {
			const client = await this.ensureClient()
			const response = await client.embed({ model: this.model, input: text })
			const values = response.embeddings[0]
			if (!values) {
				return null
			}
			this.dimensions = values.length
			return new Float32Array(values)
		} catch (error) {
			Logger.warn(`EmbeddingService: Failed to generate embedding: ${error}`)
			return null
		}
	}

	async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
		try {
			const client = await this.ensureClient()
			const response = await client.embed({ model: this.model, input: texts })
			return response.embeddings.map((values) => {
				if (!values) {
					return null
				}
				this.dimensions = values.length
				return new Float32Array(values)
			})
		} catch (error) {
			Logger.warn(`EmbeddingService: Failed to generate batch embeddings: ${error}`)
			return texts.map(() => null)
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			const client = await this.ensureClient()
			const models = await client.list()
			return models.models.some((m) => m.name.startsWith(this.model))
		} catch {
			return false
		}
	}

	async pullModelIfNeeded(): Promise<boolean> {
		try {
			const available = await this.isAvailable()
			if (available) {
				return true
			}
			Logger.log(`EmbeddingService: Pulling model ${this.model}...`)
			const client = await this.ensureClient()
			await client.pull({ model: this.model })
			Logger.log(`EmbeddingService: Model ${this.model} pulled successfully`)
			return true
		} catch (error) {
			Logger.warn(`EmbeddingService: Failed to pull model ${this.model}: ${error}`)
			return false
		}
	}

	getDimensions(): number {
		return this.dimensions
	}

	static toBuffer(embedding: Float32Array): Buffer {
		return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
	}

	static fromBuffer(buffer: Buffer): Float32Array {
		const ab = new ArrayBuffer(buffer.length)
		const view = new Uint8Array(ab)
		for (let i = 0; i < buffer.length; i++) {
			view[i] = buffer[i]
		}
		return new Float32Array(ab)
	}
}
