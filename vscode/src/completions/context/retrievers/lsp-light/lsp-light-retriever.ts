import { debounce } from 'lodash'
import { LRUCache } from 'lru-cache'
import * as vscode from 'vscode'

import {
    getSymbolContextSnippets,
    invalidateDocumentCache,
} from '../../../../graph/lsp/symbol-context-snippets'
import type {
    ContextRetriever,
    ContextRetrieverOptions,
    ContextSnippet,
    HoverContext,
} from '../../../types'
import { getLastNGraphContextIdentifiersFromDocument } from '../graph/identifiers'

const SUPPORTED_LANGUAGES = new Set([
    'python',
    'go',
    'javascript',
    'javascriptreact',
    'typescript',
    'typescriptreact',
])

export interface GetGraphContextForPositionParams {
    document: vscode.TextDocument
    position: vscode.Position
    abortSignal: AbortSignal
}

export class LspLightRetriever implements ContextRetriever {
    public identifier = 'lsp-light'
    private disposables: vscode.Disposable[] = []
    // private cache: GraphCache = new GraphCache()

    private lastRequestKey: string | null = null
    private abortLastRequest: () => void = () => {}

    constructor(
        // All arguments are optional, because they are only used in tests.
        private window: Pick<typeof vscode.window, 'onDidChangeTextEditorSelection'> = vscode.window,
        private workspace: Pick<typeof vscode.workspace, 'onDidChangeTextDocument'> = vscode.workspace
    ) {
        const onSelectionChange = debounce(this.onDidChangeTextEditorSelection.bind(this), 100)
        const onTextChange = debounce(this.onDidChangeTextDocument.bind(this), 50)

        this.disposables.push(
            this.window.onDidChangeTextEditorSelection(onSelectionChange),
            this.workspace.onDidChangeTextDocument(onTextChange)
        )
    }

    public async retrieve(params: ContextRetrieverOptions): Promise<ContextSnippet[]> {
        const {
            document,
            position,
            hints: { maxChars },
        } = params

        const key = `${document.uri.toString()}█${position.line}█${document.lineAt(position.line).text}`
        if (this.lastRequestKey !== key) {
            this.abortLastRequest()
        }

        const abortController = new AbortController()

        this.lastRequestKey = key
        this.abortLastRequest = () => abortController.abort()

        const contextSnippets = await this.getLspContextForPosition({
            document,
            position,
            abortSignal: abortController.signal,
        })

        if (maxChars === 0) {
            // This is likely just a preloading request, so we don't need to prepare the actual
            // context
            return []
        }

        return contextSnippets
    }

    public isSupportedForLanguageId(languageId: string): boolean {
        return SUPPORTED_LANGUAGES.has(languageId)
    }

    private getLspContextForPosition(
        params: GetGraphContextForPositionParams
    ): Promise<ContextSnippet[]> {
        const { document, position, abortSignal } = params
        const request = {
            document,
            position,
        }

        // const res = this.cache.get(request)
        // if (res) {
        //     return res
        // }

        let finished = false

        const symbolRequests = getLastNGraphContextIdentifiersFromDocument({
            n: 10,
            document,
            position,
        })

        const promise = getSymbolContextSnippets(symbolRequests, abortSignal).then(response => {
            finished = true
            return response
        })

        // Remove the aborted promise from the cache
        // abortSignal.addEventListener('abort', () => {
        //     if (!finished) {
        //         this.cache.delete(request)
        //     }
        // })

        // this.cache.set(request, promise)

        return promise
    }

    public dispose(): void {
        this.abortLastRequest()
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
    }

    /**
     * When the cursor is moving into a new line, we want to fetch the context for the new line.
     */
    private onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
        if (!this.isSupportedForLanguageId(event.textEditor.document.languageId)) {
            return
        }

        // Start a preloading requests as identifier by setting the maxChars to 0
        void this.retrieve({
            document: event.textEditor.document,
            position: event.selections[0].active,
            hints: { maxChars: 0 },
        })
    }

    /**
     * Whenever there are changes to a document, all cached contexts for other documents must be
     * evicted
     */
    private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0 || event.document.uri.scheme !== 'file') {
            return
        }
        // this.cache.evictForOtherDocuments(event.document.uri)
        invalidateDocumentCache(event.document)
    }
}

interface GraphCacheParams {
    document: vscode.TextDocument
    line: number
}
const MAX_CACHED_DOCUMENTS = 10
const MAX_CACHED_LINES = 100
class GraphCache {
    // This is a nested cache. The first level is the file uri, the second level is the line inside
    // the file.
    private cache = new LRUCache<string, LRUCache<string, Promise<HoverContext[]>>>({
        max: MAX_CACHED_DOCUMENTS,
    })

    private toCacheKeys(key: GraphCacheParams): [string, string] {
        return [key.document.uri.toString(), `${key.line}█${key.document.lineAt(key.line).text}`]
    }

    public get(key: GraphCacheParams): Promise<HoverContext[]> | undefined {
        const [docKey, lineKey] = this.toCacheKeys(key)

        const docCache = this.cache.get(docKey)
        if (!docCache) {
            return undefined
        }

        return docCache.get(lineKey)
    }

    public set(key: GraphCacheParams, entry: Promise<HoverContext[]>): void {
        const [docKey, lineKey] = this.toCacheKeys(key)

        let docCache = this.cache.get(docKey)
        if (!docCache) {
            docCache = new LRUCache<string, Promise<HoverContext[]>>({ max: MAX_CACHED_LINES })
            this.cache.set(docKey, docCache)
        }
        docCache.set(lineKey, entry)
    }

    public delete(key: GraphCacheParams): void {
        const [docKey, lineKey] = this.toCacheKeys(key)

        const docCache = this.cache.get(docKey)
        if (!docCache) {
            return undefined
        }
        docCache.delete(lineKey)
    }

    public evictForOtherDocuments(uri: vscode.Uri): void {
        const keysToDelete: string[] = []
        this.cache.forEach((_, otherUri) => {
            if (otherUri === uri.toString()) {
                return
            }
            keysToDelete.push(otherUri)
        })
        for (const key of keysToDelete) {
            this.cache.delete(key)
        }
    }
}
