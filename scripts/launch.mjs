// Opens a visible Chrome window with the extension already installed, in a
// profile kept at .e2e-profile/ so rules edited there survive relaunches.
// Close the window (or press Ctrl+C) to quit.
//
// Usage: node scripts/launch.mjs [url...]

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchWithExtension } from './chrome.mjs'

const userDataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.e2e-profile')
mkdirSync(userDataDir, { recursive: true })

const { cdp, extensionId, child } = await launchWithExtension({ userDataDir, headless: false })
for (const url of process.argv.slice(2)) await cdp.send('Target.createTarget', { url })

console.log(`Auto Close Tabs installed as ${extensionId}.`)
console.log(`Rules: chrome-extension://${extensionId}/options.html`)
process.on('SIGINT', () => child.kill())
child.on('exit', () => process.exit(0))
