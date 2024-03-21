import * as vscode from 'vscode'
import type { URI } from 'vscode-uri'

import { dedupeWith, isDefined } from '@sourcegraph/cody-shared'

import type { HoverContext } from '../../completions/types'

import { createLimiter } from './limiter'

const limiter = createLimiter(
    // The concurrent requests limit is chosen very conservatively to avoid blocking the language
    // server.
    2,
    // If any language server API takes more than 2 seconds to answer, we should cancel the request
    2000
)

interface HoverRequestParams {
    symbolName: string
    uri: vscode.Uri
    position: vscode.Position
}

interface ResolvedHoverText {
    symbolName: string
    symbolLocation: vscode.Location
    symbol: ResolvedHoverElement
}

interface ResolvedHoverElement {
    symbolName: string
    location: vscode.Location
    hover: vscode.Hover[]
}

/**
 * Query each of the candidate requests for hover texts which are resolved in parallel before return
 */
const gatherHoverText = async (
    hoverRequests: HoverRequestParams[],
    abortSignal?: AbortSignal
): Promise<ResolvedHoverText[]> => {
    const symbolLocations = hoverRequests.map(({ symbolName, uri, position }) => {
        return {
            symbolName,
            symbolLocation: new vscode.Location(uri, position),
        }
    })

    const dedupedSymbolLocations = dedupeWith(symbolLocations, s => locationKeyFn(s.symbolLocation))

    return Promise.all(
        dedupedSymbolLocations.map(async ({ symbolName, symbolLocation }) => {
            const hoverPromise = limiter(
                () => defaultGetHover(symbolLocation.uri, symbolLocation.range.start),
                abortSignal
            )

            return {
                symbolName,
                symbolLocation,
                symbol: {
                    symbolName,
                    location: symbolLocation,
                    hover: await hoverPromise,
                },
            }
        })
    )
}

/**
 * Shim for default LSP executeHoverPRovider call. Can be mocked for testing.
 */
const defaultGetHover = async (uri: URI, position: vscode.Position): Promise<vscode.Hover[]> =>
    vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position)

const hoverToStrings = (hover: vscode.Hover[]): string[] =>
    hover
        .flatMap(hover => hover.contents.map(c => (typeof c === 'string' ? c : c.value)))
        .map(extractMarkdownCodeBlock)
        .map(s => s.trim())
        .filter(s => s !== '')

const hoverContextFromResolvedHoverText = (t: ResolvedHoverText): HoverContext[] =>
    [hoverContextFromElement(t.symbol)].filter(isDefined)

const hoverContextFromElement = (
    element: ResolvedHoverElement | undefined,
    sourceSymbolName?: string
): HoverContext | undefined => {
    if (element === undefined) {
        return undefined
    }

    let content = hoverToStrings(element.hover)

    // Filter out common hover texts that do not provide additional value
    content = content.filter(content => !isUnhelpfulHoverString(element.symbolName, content))

    if (content.length === 0) {
        return undefined
    }

    return {
        symbolName: element.symbolName,
        sourceSymbolName,
        content,
        uri: element.location.uri.toString(),
        range: undefined,
    }
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

function isUnhelpfulHoverString(symbolName: string, hover: string): boolean {
    const trimmed = hover.trim()
    return (
        trimmed === `interface ${symbolName}` ||
        trimmed === `class ${symbolName}` ||
        trimmed === `type ${symbolName}`
    )
}

/**
 * Returns a key unique to a given location for use with `dedupeWith`.
 */
export const locationKeyFn = (location: vscode.Location): string =>
    `${location.uri?.path}?L${location.range.start.line}:${location.range.start.character}`
