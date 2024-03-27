import { LRUCache } from 'lru-cache'
import type * as vscode from 'vscode'

import { isDefined } from '@sourcegraph/cody-shared'

import { getLastNGraphContextIdentifiersFromString } from '../../completions/context/retrievers/graph/identifiers'
import type { SymbolContextSnippet } from '../../completions/types'
import { commonKeywords } from './languages'
import { createLimiter } from './limiter'
import {
    getDefinitionLocations,
    getHover,
    getImplementationLocations,
    getTextFromLocation,
    getTypeDefinitionLocations,
} from './lsp'

const limiter = createLimiter({
    // The concurrent requests limit is chosen very conservatively to avoid blocking the language
    // server.
    limit: 3,
    // If any language server API takes more than 2 seconds to answer, we should cancel the request
    timeout: 2000,
})

interface SymbolSnippetsRequest {
    symbolName: string
    uri: vscode.Uri
    position: vscode.Position
    nodeType: string
    languageId: string
}

type DefinitionCacheEntryPath = `${UriString}::${DefinitionCacheKey}`
interface SymbolSnippetInflightRequest extends SymbolContextSnippet {
    key: DefinitionCacheEntryPath
    relatedDefinitionKeys?: Set<DefinitionCacheEntryPath>
    location: vscode.Location
}

interface GetSymbolSnippetForNodeTypeParams {
    symbolSnippetRequest: SymbolSnippetsRequest
    recursionLimit: number
    parentDefinitionCacheEntryPaths?: Set<DefinitionCacheEntryPath>
    abortSignal: AbortSignal
}

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>
type PartialSymbolSnippetInflightRequest = Optional<SymbolSnippetInflightRequest, 'content'>

function updateParentDefinitionKeys(
    parentDefinitionCacheEntryPaths: GetSymbolSnippetForNodeTypeParams['parentDefinitionCacheEntryPaths'],
    symbolContextSnippet: PartialSymbolSnippetInflightRequest
) {
    if (parentDefinitionCacheEntryPaths) {
        for (const parentDefinitionCacheEntryPath of parentDefinitionCacheEntryPaths) {
            const [uriKey, definitionKey] = parentDefinitionCacheEntryPath.split('::')
            definitionCache.cache
                .get(uriKey)
                ?.get(definitionKey)
                ?.relatedDefinitionKeys?.add(symbolContextSnippet.key)
        }
    }
}

async function getSymbolSnippetForNodeType(
    params: GetSymbolSnippetForNodeTypeParams
): Promise<SymbolSnippetInflightRequest[] | undefined> {
    const {
        recursionLimit,
        symbolSnippetRequest,
        symbolSnippetRequest: { uri, position, nodeType, symbolName, languageId },
        parentDefinitionCacheEntryPaths,
        abortSignal,
    } = params
    async function getSnippetForLocationGetter(
        locationGetter: typeof getDefinitionLocations
    ): Promise<PartialSymbolSnippetInflightRequest | undefined> {
        let definitionLocations = definitionLocationCache.get(symbolSnippetRequest)

        if (!definitionLocations) {
            definitionLocations = await limiter(() => locationGetter(uri, position))
        }

        if (definitionLocations.length === 0) {
            console.log(`no definition locations for ${symbolName} at ${uri} and ${position}`)
            definitionLocationCache.delete(symbolSnippetRequest)
            return undefined
        }

        const [definitionLocation] = definitionLocations

        const { uri: definitionUri, range: definitionRange } = definitionLocation
        const definitionUriString = definitionUri.toString()
        const definitionCacheKey = `${definitionRange.start.line}:${definitionRange.start.character}`

        const symbolContextSnippet = {
            key: `${definitionUriString}::${definitionCacheKey}`,
            uri: definitionUri,
            startLine: definitionRange.start.line,
            endLine: definitionRange.end.line,
            symbol: symbolName,
            location: definitionLocation,
        } satisfies Omit<SymbolSnippetInflightRequest, 'content'>

        const cachedDefinition = definitionCache.get(definitionLocation)
        if (cachedDefinition) {
            updateParentDefinitionKeys(parentDefinitionCacheEntryPaths, symbolContextSnippet)

            return {
                ...symbolContextSnippet,
                ...cachedDefinition,
            }
        }

        let definitionString: string | undefined

        switch (nodeType) {
            case 'property_identifier':
            case 'type_identifier': {
                definitionString = await getTextFromLocation(definitionLocation)
                break
            }
            default: {
                const hoverContent = await limiter(
                    () => getHover(definitionLocation.uri, definitionLocation.range.start),
                    abortSignal
                )
                definitionString = extractHoverContent(hoverContent).join('\n')

                if (isUnhelpfulSymbolSnippet(symbolName, definitionString)) {
                    definitionString = await getTextFromLocation(definitionLocation)

                    if (isUnhelpfulSymbolSnippet(symbolName, definitionString)) {
                        return symbolContextSnippet
                    }
                }

                break
            }
        }

        definitionLocationCache.set(symbolSnippetRequest, definitionLocations)

        return {
            ...symbolContextSnippet,
            content: definitionString,
        }
    }

    let getters = [getTypeDefinitionLocations, getImplementationLocations, getDefinitionLocations]
    if (['property_identifier', 'type_identifier'].includes(nodeType)) {
        getters = [getDefinitionLocations, getTypeDefinitionLocations, getImplementationLocations]
    }

    let symbolContextSnippet: PartialSymbolSnippetInflightRequest | undefined
    for (const getter of getters) {
        symbolContextSnippet = await getSnippetForLocationGetter(getter)

        if (symbolContextSnippet?.content !== undefined) {
            break
        }
    }

    if (!symbolContextSnippet) {
        console.log(
            `failed to find definition location for symbol ${symbolName} at ${uri} and ${position}`
        )
        return undefined
    }

    if (symbolContextSnippet.content === undefined) {
        console.log(
            `no definition for symbol ${symbolName} at ${symbolContextSnippet.uri} and ${symbolContextSnippet.startLine}`
        )
        definitionCache.delete(symbolContextSnippet.location)
        return undefined
    }

    const { location: definitionLocation, content: definitionString } = symbolContextSnippet

    definitionCache.set(definitionLocation, { content: definitionString })
    updateParentDefinitionKeys(parentDefinitionCacheEntryPaths, symbolContextSnippet)

    const symbolsSnippetRequests = getLastNGraphContextIdentifiersFromString({
        n: 5,
        uri: definitionLocation.uri,
        languageId,
        source: definitionString,
    })
        .filter(request => {
            return symbolName !== request.symbolName && !commonKeywords.has(request.symbolName)
        })
        .map(request => ({
            ...request,
            position: request.position.translate({
                lineDelta: definitionLocation.range.start.line,
                characterDelta: definitionLocation.range.start.character,
            }),
        }))

    if (symbolsSnippetRequests.length === 0) {
        return [symbolContextSnippet as SymbolSnippetInflightRequest]
    }

    const definitionCacheEntry = {
        content: definitionString,
        relatedDefinitionKeys: new Set(),
    } satisfies DefinitionCacheEntry

    definitionCache.set(definitionLocation, definitionCacheEntry)

    await getSymbolContextSnippetsRecursive({
        symbolsSnippetRequests,
        abortSignal,
        recursionLimit: recursionLimit - 1,
        parentDefinitionCacheEntryPaths: new Set([
            symbolContextSnippet.key,
            ...(parentDefinitionCacheEntryPaths || []),
        ]),
    })

    return [
        {
            ...symbolContextSnippet,
            ...definitionCacheEntry,
        },
    ]
}

interface GetSymbolContextSnippetsRecursive extends GetSymbolContextSnippetsParams {
    parentDefinitionCacheEntryPaths?: Set<DefinitionCacheEntryPath>
}

async function getSymbolContextSnippetsRecursive(
    params: GetSymbolContextSnippetsRecursive
): Promise<SymbolSnippetInflightRequest[]> {
    const { symbolsSnippetRequests, recursionLimit, parentDefinitionCacheEntryPaths, abortSignal } =
        params

    if (recursionLimit === 0) {
        return []
    }

    const contextSnippets = await Promise.all(
        symbolsSnippetRequests.map(symbolSnippetRequest => {
            console.log(`requesting for "${symbolSnippetRequest.symbolName}"`)
            return getSymbolSnippetForNodeType({
                symbolSnippetRequest,
                recursionLimit,
                parentDefinitionCacheEntryPaths,
                abortSignal,
            })
        })
    )

    return contextSnippets.flat().filter(isDefined)
}

interface GetSymbolContextSnippetsParams {
    symbolsSnippetRequests: SymbolSnippetsRequest[]
    abortSignal: AbortSignal
    recursionLimit: number
}

export async function getSymbolContextSnippets(
    params: GetSymbolContextSnippetsParams
): Promise<SymbolContextSnippet[]> {
    const start = performance.now()
    const result = await getSymbolContextSnippetsRecursive(params)

    const resultWithRelatedSnippets = result.flatMap(snippet => {
        if (!snippet.relatedDefinitionKeys) {
            return snippet
        }

        const relatedDefinitions = Array.from(snippet.relatedDefinitionKeys?.values())
            .flatMap(key => {
                const [uriKey, definitionKey] = key.split('::')

                if (key === snippet.key) {
                    return undefined
                }

                return definitionCache.cache.get(uriKey)?.get(definitionKey)?.content
            })
            .filter(isDefined)

        return {
            ...snippet,
            content: [...relatedDefinitions, snippet.content].join('\n'),
        }
    })

    console.log(`Got symbol snippets in ${performance.now() - start}ms`)
    // biome-ignore lint/complexity/noForEach: <explanation>
    resultWithRelatedSnippets.forEach(r => {
        console.log(`Context for "${r.symbol}":\n`, r.content)
    })

    return resultWithRelatedSnippets
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

interface DefinitionCacheEntry {
    content: string
    relatedDefinitionKeys?: Set<DefinitionCacheEntryPath>
}

type UriString = string
type DefinitionCacheKey = string
type LocationCacheKey = string
type LocationCacheEntryPath = `${UriString}::${LocationCacheKey}`

const MAX_CACHED_DOCUMENTS = 100
const MAX_CACHED_DEFINITION_LOCATIONS = 100
const MAX_CACHED_DEFINITIONS = 100

class DefinitionCache {
    public cache = new LRUCache<UriString, LRUCache<DefinitionCacheKey, DefinitionCacheEntry>>({
        max: MAX_CACHED_DOCUMENTS,
    })

    public toDefinitionCacheKey(location: vscode.Location): DefinitionCacheKey {
        return `${location.range.start.line}:${location.range.start.character}`
    }

    public get(location: vscode.Location): DefinitionCacheEntry | undefined {
        const documentCache = this.cache.get(location.uri.toString())
        if (!documentCache) {
            return undefined
        }

        return documentCache.get(this.toDefinitionCacheKey(location))
    }

    public set(location: vscode.Location, locations: DefinitionCacheEntry): void {
        const uri = location.uri.toString()
        let documentCache = this.cache.get(uri)
        if (!documentCache) {
            documentCache = new LRUCache({
                max: MAX_CACHED_DEFINITIONS,
            })
            this.cache.set(uri, documentCache)
        }

        documentCache.set(this.toDefinitionCacheKey(location), locations)
    }

    public delete(location: vscode.Location): void {
        const documentCache = this.cache.get(location.uri.toString())

        if (documentCache) {
            documentCache.delete(this.toDefinitionCacheKey(location))
        }
    }

    public deleteDocument(uri: string) {
        this.cache.delete(uri)
    }
}

const definitionCache = new DefinitionCache()

class DefinitionLocationCache {
    public cache = new LRUCache<UriString, LRUCache<LocationCacheKey, vscode.Location[]>>({
        max: MAX_CACHED_DOCUMENTS,
    })

    /**
     * Keeps track of the cache keys for each document so that we can quickly
     * invalidate the cache when a document is changed.
     */
    public documentToLocationCacheKeyMap = new Map<UriString, Set<LocationCacheEntryPath>>()

    public toLocationCacheKey(request: SymbolSnippetsRequest): LocationCacheKey {
        const { position, nodeType, symbolName } = request
        return `${position.line}:${position.character}:${nodeType}:${symbolName}`
    }

    public get(request: SymbolSnippetsRequest): vscode.Location[] | undefined {
        const documentCache = this.cache.get(request.uri.toString())
        if (!documentCache) {
            return undefined
        }

        return documentCache.get(this.toLocationCacheKey(request))
    }

    public set(request: SymbolSnippetsRequest, locations: vscode.Location[]): void {
        const uri = request.uri.toString()
        let documentCache = this.cache.get(uri)
        if (!documentCache) {
            documentCache = new LRUCache({
                max: MAX_CACHED_DEFINITION_LOCATIONS,
            })
            this.cache.set(uri, documentCache)
        }

        const locationCacheKey = this.toLocationCacheKey(request)
        documentCache.set(locationCacheKey, locations)

        for (const location of locations) {
            this.addToDocumentToCacheKeyMap(location.uri.toString(), `${uri}::${locationCacheKey}`)
        }
    }

    public delete(request: SymbolSnippetsRequest): void {
        const documentCache = this.cache.get(request.uri.toString())

        if (documentCache) {
            documentCache.delete(this.toLocationCacheKey(request))
        }
    }

    addToDocumentToCacheKeyMap(uri: string, cacheKey: LocationCacheEntryPath) {
        if (!this.documentToLocationCacheKeyMap.has(uri)) {
            this.documentToLocationCacheKeyMap.set(uri, new Set())
        }
        this.documentToLocationCacheKeyMap.get(uri)!.add(cacheKey)
    }

    removeFromDocumentToCacheKeyMap(uri: string, cacheKey: LocationCacheEntryPath) {
        if (this.documentToLocationCacheKeyMap.has(uri)) {
            this.documentToLocationCacheKeyMap.get(uri)!.delete(cacheKey)
            if (this.documentToLocationCacheKeyMap.get(uri)!.size === 0) {
                this.documentToLocationCacheKeyMap.delete(uri)
            }
        }
    }

    invalidateEntriesForDocument(uri: string) {
        if (this.documentToLocationCacheKeyMap.has(uri)) {
            const cacheKeysToRemove = this.documentToLocationCacheKeyMap.get(uri)!
            for (const cacheKey of cacheKeysToRemove) {
                const [uri, key] = cacheKey.split('::')
                this.cache.get(uri)?.delete(key)
                this.removeFromDocumentToCacheKeyMap(uri, cacheKey)
            }
        }
    }
}

const definitionLocationCache = new DefinitionLocationCache()

export function invalidateDocumentCache(document: vscode.TextDocument) {
    const uriString = document.uri.toString()

    // Remove cache items that depend on the updated document
    definitionCache.deleteDocument(uriString)
    definitionLocationCache.invalidateEntriesForDocument(uriString)
}

function isUnhelpfulSymbolSnippet(symbolName: string, symbolSnippet: string): boolean {
    const trimmed = symbolSnippet.trim()
    return (
        symbolSnippet === '' ||
        symbolSnippet === symbolName ||
        !symbolSnippet.includes(symbolName) ||
        trimmed === `interface ${symbolName}` ||
        trimmed === `class ${symbolName}` ||
        trimmed === `enum ${symbolName}` ||
        trimmed === `type ${symbolName}`
    )
}
