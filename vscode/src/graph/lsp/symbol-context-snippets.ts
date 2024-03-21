import { isDefined } from '@sourcegraph/cody-shared'
import { LRUCache } from 'lru-cache'
import * as vscode from 'vscode'
import type { SymbolContextSnippet } from '../../completions/types'

interface SymbolSnippetsRequest {
    symbolName: string
    uri: vscode.Uri
    position: vscode.Position
    nodeType: string
}

// TODO: use limiter for underlying LSP requests
async function getSymbolSnippetForNodeType(
    params: SymbolSnippetsRequest
): Promise<SymbolContextSnippet[]> {
    const { uri, position, nodeType, symbolName } = params

    // TODO: use workspace symbols to get symbol kind to help determine how to extract context snippet text
    // const symbolInfo = await getWorkspaceSymbols(symbolName)
    // console.log({ symbolInfo })

    const uriString = uri.toString()
    const locationCacheKey = `${position.line}:${position.character}:${nodeType}:${symbolName}`

    // Get or create the nested cache for the file URI
    let nestedLocationCache = definitionLocationCache.get(uriString)

    if (!nestedLocationCache) {
        nestedLocationCache = new LRUCache({ max: 100 })
        definitionLocationCache.set(uriString, nestedLocationCache)
    }

    // Check if the locations are already cached
    let definitionLocations = nestedLocationCache.get(locationCacheKey)
    if (!definitionLocations) {
        switch (nodeType) {
            case 'property_identifier':
            case 'type_identifier': {
                definitionLocations = await getDefinitionLocations(uri, position)
                break
            }
            default: {
                definitionLocations = await getTypeDefinitionLocations(uri, position)
                break
            }
        }
        definitionLocations = definitionLocations.length === 0 ? undefined : definitionLocations
        nestedLocationCache.set(locationCacheKey, definitionLocations)

        for (const location of definitionLocations || []) {
            addToDocumentToCacheKeyMap(location.uri.toString(), `${uriString}::${locationCacheKey}`)
        }
    }

    if (!definitionLocations) {
        return []
    }

    const hoverSnippets = await Promise.all(
        definitionLocations.map(async location => {
            const { uri: definitionUri, range } = location
            const definitionUriString = definitionUri.toString()
            const definitionCacheKey = `${range.start.line}:${range.start.character}`

            const symbolContextSnippet = {
                uri: definitionUri,
                startLine: range.start.line,
                endLine: range.end.line,
                symbol: symbolName,
            } satisfies Omit<SymbolContextSnippet, 'content'>

            // Get or create the nested cache for the definition URI
            let nestedDefinitionCache = definitionCache.get(definitionUriString)
            if (!nestedDefinitionCache) {
                nestedDefinitionCache = new LRUCache({ max: 100 })
                definitionCache.set(definitionUriString, nestedDefinitionCache)
            }

            // Check if the definition is already cached
            const cachedDefinition = nestedDefinitionCache.get(definitionCacheKey)
            if (cachedDefinition) {
                return {
                    ...symbolContextSnippet,
                    content: cachedDefinition,
                }
            }

            let extractedContent: string | undefined

            switch (nodeType) {
                case 'property_identifier':
                case 'type_identifier': {
                    extractedContent = await getTextFromLocation(location)
                    break
                }
                default: {
                    const hoverContent = await getHover(definitionUri, range.start)
                    // TODO: add retries for interface and types
                    // TODO: add recursion
                    extractedContent = extractHoverContent(hoverContent).join('\n')
                    break
                }
            }

            extractedContent =
                !extractedContent || extractedContent.length === 0 ? undefined : extractedContent

            nestedDefinitionCache.set(definitionCacheKey, extractedContent)
            addToDocumentToCacheKeyMap(
                definitionUriString,
                `${definitionUriString}:${definitionCacheKey}`
            )

            if (extractedContent === undefined) {
                return undefined
            }

            return {
                ...symbolContextSnippet,
                content: extractedContent,
            }
        })
    )

    return hoverSnippets.filter(isDefined).flat()
}

export const getSymbolContextSnippets = async (
    symbolsSnippetRequests: SymbolSnippetsRequest[],
    abortSignal?: AbortSignal
): Promise<SymbolContextSnippet[]> => {
    const start = performance.now()

    const contextSnippets = await Promise.all(symbolsSnippetRequests.map(getSymbolSnippetForNodeType))
    const result = contextSnippets.flat().filter(isDefined)

    console.log(
        `Got symbol snippets in ${performance.now() - start}ms`,
        JSON.stringify(
            result.map(r => ({
                symbol: r.symbol,
                content: r.content,
            })),
            null,
            2
        )
    )

    return result
}

function extractHoverContent(hover: vscode.Hover[]): string[] {
    return hover
        .flatMap(hover => hover.contents.map(c => (typeof c === 'string' ? c : c.value)))
        .map(extractMarkdownCodeBlock)
        .map(s => s.trim())
        .filter(s => s !== '')
}

function extractMarkdownCodeBlock(string: string): string {
    const lines = string.split('\n')
    const codeBlocks: string[] = []
    let isCodeBlock = false

    for (const line of lines) {
        const isCodeBlockDelimiter = line.trim().startsWith('```')

        if (isCodeBlockDelimiter && !isCodeBlock) {
            isCodeBlock = true
        } else if (isCodeBlockDelimiter && isCodeBlock) {
            isCodeBlock = false
        } else if (isCodeBlock) {
            codeBlocks.push(line)
        }
    }

    return codeBlocks.join('\n')
}

/**
 * Convert the given Location or LocationLink into a Location.
 */
const locationLinkToLocation = (value: vscode.Location | vscode.LocationLink): vscode.Location => {
    return isLocationLink(value) ? new vscode.Location(value.targetUri, value.targetRange) : value
}

const isLocationLink = (value: vscode.Location | vscode.LocationLink): value is vscode.LocationLink => {
    return 'targetUri' in value
}

async function getDefinitionLocations(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.Location[]> {
    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position
    )

    return definitions.map(locationLinkToLocation)
}

async function getTypeDefinitionLocations(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.Location[]> {
    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeTypeDefinitionProvider',
        uri,
        position
    )

    return definitions.map(locationLinkToLocation)
}

async function getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
    return vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position)
}

async function getTextFromLocation(location: vscode.Location): Promise<string> {
    const document = await vscode.workspace.openTextDocument(location.uri)

    return document.getText(location.range)
}

async function getWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    return vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
    )
}

const definitionCache = new LRUCache<string, LRUCache<string, string>>({
    max: 100,
})

const definitionLocationCache = new LRUCache<string, LRUCache<string, vscode.Location[]>>({
    max: 100,
})

/**
 * Keeps track of the cache keys for each document so that we can quickly
 * invalidate the cache when a document is changed.
 */
const documentToCacheKeyMap = new Map<string, Set<string>>()

function addToDocumentToCacheKeyMap(documentUri: string, cacheKey: string) {
    const uriString = documentUri.toString()
    if (!documentToCacheKeyMap.has(uriString)) {
        documentToCacheKeyMap.set(uriString, new Set())
    }
    documentToCacheKeyMap.get(uriString)!.add(cacheKey)
}

function removeFromDocumentToCacheKeyMap(documentUri: string, cacheKey: string) {
    const uriString = documentUri.toString()
    if (documentToCacheKeyMap.has(uriString)) {
        documentToCacheKeyMap.get(uriString)!.delete(cacheKey)
        if (documentToCacheKeyMap.get(uriString)!.size === 0) {
            documentToCacheKeyMap.delete(uriString)
        }
    }
}

export function invalidateDocumentCache(document: vscode.TextDocument) {
    const uriString = document.uri.toString()
    definitionCache.delete(uriString)

    // Remove cache items that depend on the updated document
    if (documentToCacheKeyMap.has(uriString)) {
        const cacheKeysToRemove = documentToCacheKeyMap.get(uriString)!
        for (const cacheKey of cacheKeysToRemove) {
            const [uri, key] = cacheKey.split('::')
            definitionLocationCache.get(uri)?.delete(key)
            definitionCache.get(uri)?.delete(key)
            removeFromDocumentToCacheKeyMap(uriString, cacheKey)
        }
    }
}
