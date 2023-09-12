import { mkdir, mkdtempSync, rmSync, writeFile } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

import { test as base, Frame, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'

import { run, sendTestInfo } from '../fixtures/mock-server'

import { installDeps } from './install-deps'

export const test = base
    .extend<{}>({
        page: async ({ page: _page }, use, testInfo) => {
            void _page

            const vscodeRoot = path.resolve(__dirname, '..', '..')

            const vscodeExecutablePath = await installDeps()
            const extensionDevelopmentPath = vscodeRoot

            const userDataDirectory = mkdtempSync(path.join(tmpdir(), 'cody-vsce'))
            const extensionsDirectory = mkdtempSync(path.join(tmpdir(), 'cody-vsce'))

            const workspaceDirectory = path.join(vscodeRoot, 'test', 'completions-2', 'workspace')

            await buildWorkSpaceSettings(workspaceDirectory)

            sendTestInfo(testInfo.title, testInfo.testId)

            // See: https://github.com/microsoft/vscode-test/blob/main/lib/runTest.ts
            const app = await electron.launch({
                executablePath: vscodeExecutablePath,
                args: [
                    // https://github.com/microsoft/vscode/issues/84238
                    '--no-sandbox',
                    // https://github.com/microsoft/vscode-test/issues/120
                    '--disable-updates',
                    '--skip-welcome',
                    '--skip-release-notes',
                    '--disable-workspace-trust',
                    '--extensionDevelopmentPath=' + extensionDevelopmentPath,
                    `--user-data-dir=${userDataDirectory}`,
                    `--extensions-dir=${extensionsDirectory}`,
                    workspaceDirectory,
                ],
            })

            await waitUntil(() => app.windows().length > 0)

            const page = await app.firstWindow()

            // Bring the cody sidebar to the foreground
            await page.click('[aria-label="Cody"]')
            // Ensure that we remove the hover from the activity icon
            await page.getByRole('heading', { name: 'Cody: Chat' }).hover()
            // Wait for Cody to become activated
            // TODO(philipp-spiess): Figure out which playwright matcher we can use that works for
            // the signed-in and signed-out cases
            await new Promise(resolve => setTimeout(resolve, 500))

            await run(async () => {
                await use(page)
            })

            await app.close()

            rmSync(userDataDirectory, { recursive: true })
            rmSync(extensionsDirectory, { recursive: true })
        },
    })
    .extend<{ sidebar: Frame }>({
        sidebar: async ({ page }, use) => {
            const sidebar = await getCodySidebar(page)
            await use(sidebar)
        },
    })

export async function getCodySidebar(page: Page): Promise<Frame> {
    async function findCodySidebarFrame(): Promise<null | Frame> {
        for (const frame of page.frames()) {
            try {
                const title = await frame.title()
                if (title === 'Cody') {
                    return frame
                }
            } catch (error: any) {
                // Skip over frames that were detached in the meantime.
                if (error.message.indexOf('Frame was detached') === -1) {
                    throw error
                }
            }
        }
        return null
    }
    await waitUntil(async () => (await findCodySidebarFrame()) !== null)
    return (await findCodySidebarFrame()) || page.mainFrame()
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
    let delay = 10
    while (!(await predicate())) {
        await new Promise(resolve => setTimeout(resolve, delay))
        delay <<= 1
    }
}

// Build a workspace settings file that enables the experimental inline mode
export async function buildWorkSpaceSettings(workspaceDirectory: string): Promise<void> {
    const settings = {
        'cody.experimental.commandLenses': true,
        'cody.experimental.editorTitleCommandIcon': true,
        'editor.inlineSuggest.showToolbar': 'always',
    }
    // create a temporary directory with settings.json and add to the workspaceDirectory
    const workspaceSettingsPath = path.join(workspaceDirectory, '.vscode', 'settings.json')
    const workspaceSettingsDirectory = path.join(workspaceDirectory, '.vscode')
    mkdir(workspaceSettingsDirectory, { recursive: true }, () => {})
    await new Promise<void>((resolve, reject) => {
        writeFile(workspaceSettingsPath, JSON.stringify(settings), error => {
            if (error) {
                reject(error)
            } else {
                resolve()
            }
        })
    })
}