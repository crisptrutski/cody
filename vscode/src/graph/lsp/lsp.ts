import * as vscode from 'vscode'

// TODO: test with languages without a definition provider
// Add try/catch and analytics
export async function getDefinitionLocations(
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

export async function getImplementationLocations(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.Location[]> {
    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeImplementationProvider',
        uri,
        position
    )

    return definitions.map(locationLinkToLocation)
}

export async function getTypeDefinitionLocations(
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

export async function getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
    return vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position)
}

export async function getTextFromLocation(location: vscode.Location): Promise<string> {
    const document = await vscode.workspace.openTextDocument(location.uri)

    return document.getText(location.range)
}

// TODO: experiment with workspace symbols to get symbol kind to help determine how to extract context snippet text
// const symbolInfo = await getWorkspaceSymbols(symbolName)
export async function getWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    return vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
    )
}

/**
 * Convert the given Location or LocationLink into a Location.
 */
export const locationLinkToLocation = (
    value: vscode.Location | vscode.LocationLink
): vscode.Location => {
    return isLocationLink(value) ? new vscode.Location(value.targetUri, value.targetRange) : value
}

export const isLocationLink = (
    value: vscode.Location | vscode.LocationLink
): value is vscode.LocationLink => {
    return 'targetUri' in value
}
