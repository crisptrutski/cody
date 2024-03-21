import type * as vscode from 'vscode'
import type { URI } from 'vscode-uri'

import type { DocumentContext } from './get-current-doc-context'
import type { LastInlineCompletionCandidate } from './get-inline-completions'

/**
 * @see vscode.InlineCompletionItem
 */
export interface InlineCompletionItem {
    insertText: string
    /**
     * The range to replace.
     * Must begin and end on the same line.
     *
     * Prefer replacements over insertions to provide a better experience when the user deletes typed text.
     */
    range?: vscode.Range
}

/**
 * Keep property names in sync with the `EmbeddingsSearchResult` type.
 */
interface FileContextSnippet {
    uri: URI
    startLine: number
    endLine: number
    content: string
}
export interface SymbolContextSnippet extends FileContextSnippet {
    symbol: string
}
export type ContextSnippet = FileContextSnippet | SymbolContextSnippet

export interface ContextRetrieverOptions {
    document: vscode.TextDocument
    position: vscode.Position
    docContext: DocumentContext
    hints: {
        maxChars: number
        maxMs: number
    }
    lastCandidate?: LastInlineCompletionCandidate
    abortSignal?: AbortSignal
}

/**
 * Interface for a general purpose retrieval strategy. During the retrieval phase, all retrievers
 * that are outlined in the execution plan will be called concurrently.
 */
export interface ContextRetriever extends vscode.Disposable {
    /**
     * The identifier of the retriever. Used for logging purposes.
     */
    identifier: string

    /**
     * Start a retrieval processes. Implementers should observe the hints to return the best results
     * in the available time.
     *
     * The client hints signalize _soft_ timeouts. When a hard timeout is reached, the retriever's
     * results will not be taken into account anymore so it's suggested to return _something_ during
     * the maxMs time.
     *
     * The abortSignal can be used to detect when the completion request becomes invalidated. When
     * triggered, any further work is ignored so you can stop immediately.
     */
    retrieve(options: ContextRetrieverOptions): Promise<ContextSnippet[]>

    /**
     * Return true if the retriever supports the given languageId.
     */
    isSupportedForLanguageId(languageId: string): boolean
}

export interface PreciseContext {
    symbol: {
        fuzzyName?: string
    }
    hoverText: string[]
    definitionSnippet: string
    filePath: string
    range?: {
        startLine: number
        startCharacter: number
        endLine: number
        endCharacter: number
    }
}

export interface HoverContext {
    symbolName: string
    sourceSymbolName?: string
    content: string[]
    uri: string
    range: {
        startLine: number
        startCharacter: number
        endLine: number
        endCharacter: number
    }
}
