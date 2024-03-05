import { type SearchPanelFile, displayPathBasename } from '@sourcegraph/cody-shared'
import { throttle } from 'lodash'
import * as vscode from 'vscode'
import { INPUT_TITLE } from '..'
import { firstInterestingLine } from '../../../webviews/SearchPanel'
import { clearSearchResultPreviews, previewSearchResult } from '../../search/SearchViewProvider'
import { type GetItemsResult, createQuickPick } from '../shared/quick-pick'

export const DOCUMENT_ITEM: vscode.QuickPickItem = {
    label: '$(book) Document Code',
    alwaysShow: true,
}

export const TEST_ITEM: vscode.QuickPickItem = {
    label: '$(package) Generate Tests',
    alwaysShow: true,
}

export interface SearchItem extends vscode.QuickPickItem {
    range: vscode.Range
    uri: vscode.Uri
}

const getSearchItems = async (query: string): Promise<GetItemsResult> => {
    if (query.trim().length === 0) {
        return { items: [] }
    }

    const searchItems: SearchPanelFile[] = await vscode.commands.executeCommand(
        'cody.search.submit',
        query
    )

    const items: vscode.QuickPickItem[] = []

    for (const { uri, snippets } of searchItems) {
        const seperator = {
            label: displayPathBasename(uri),
            kind: vscode.QuickPickItemKind.Separator,
        }
        const results = snippets.map(snippet => ({
            label: firstInterestingLine(snippet.contents),
            range: snippet.range,
            uri: uri,
            alwaysShow: true,
        }))
        items.push(seperator, ...results)
    }

    return { items }
}

export const showSearchInput = (): Promise<void> => {
    return new Promise(resolve => {
        let activeQuery = ''
        const updateActiveQuery = throttle(
            async (query: string) => {
                activeQuery = query
                searchInput.input.items = (await getSearchItems(activeQuery)).items
                searchInput.input.busy = false
            },
            250,
            { leading: false, trailing: true }
        )

        const searchInput = createQuickPick({
            title: INPUT_TITLE,
            placeHolder: 'Search for code using a natural language query',
            getItems: () => ({
                // We do not currently support opening this input with a pre-filled query.
                items: [],
            }),
            onDidHide: () => clearSearchResultPreviews(),
            onDidChangeValue: async value => {
                if (value !== activeQuery) {
                    // Clear existing query and results
                    updateActiveQuery.cancel()
                    searchInput.input.items = []
                    clearSearchResultPreviews()
                }
                searchInput.input.busy = true
                await updateActiveQuery(value)
            },
            onDidChangeActive: async items => {
                const item = items[0] as SearchItem
                if (item) {
                    return previewSearchResult(item.range, item.uri)
                }
            },
            onDidAccept: () => {
                // Just hide the input, we have already opened the file via the preview function
                searchInput.input.hide()
                resolve()
            },
        })

        searchInput.render('')
        searchInput.input.activeItems = []
    })
}