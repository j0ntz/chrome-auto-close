// Decides what a main-frame navigation means for a tab's pending close.
// Pure: the service worker owns storage, timers and chrome.* calls.

import { findMatchingRule, ruleDelaySeconds } from './rules.js'

/**
 * Per-tab state:
 * - opening: the tab is still on the navigation it was created with, or on a
 *   client redirect chained to it (e.g. Gmail's google.com/url hop). Only
 *   these commits count as "the tab opened on this URL".
 * - committed: at least one main-frame commit happened.
 * - kept: the user asked to keep this tab open.
 * - pending: `{ closeAt, ruleName }` while a close is scheduled.
 */
export const UNKNOWN_TAB_STATE = { opening: false, committed: true, kept: false, pending: null }

/**
 * State for a tab that was just created. A tab created on the browser's own
 * new-tab page is never "opening" a link: whatever the user types there next
 * is deliberate, even though it may be the tab's first web commit.
 */
export function createdTabState(initialUrl) {
  const isBrowserPage = typeof initialUrl === 'string' && /^(chrome|chrome-search|edge|about):/i.test(initialUrl) && initialUrl !== 'about:blank'
  return { opening: !isBrowserPage, committed: false, kept: false, pending: null }
}

/**
 * The navigation a tab opened with decides its fate: if it started on a
 * matching URL, the tab closes, wherever the site's redirects or in-page
 * routing take it afterwards (Slack answers a logged-out archive link with a
 * 302 to `/?redir=...`). Only a later cross-document navigation the user made
 * to a non-matching page cancels the close.
 *
 * @param url the committed URL.
 * @param startUrl the URL the navigation started on, before server redirects.
 * @param kind 'commit' | 'client-redirect' | 'same-document'
 * @returns {{ action: 'schedule' | 'cancel' | 'none', rule?: object, tabState: object }}
 */
export function planNavigation({ settings, tabState, url, startUrl = url, kind, now }) {
  // A new tab's initial empty document is not a navigation the user made.
  if (url === 'about:blank' && !tabState.committed) return { action: 'none', tabState }

  const isCommit = kind !== 'same-document'
  const isOpeningCommit = isCommit && tabState.opening && (!tabState.committed || kind === 'client-redirect')
  const next = {
    ...tabState,
    opening: isCommit ? isOpeningCommit : tabState.opening,
    committed: tabState.committed || isCommit
  }
  const active = settings.enabled && !tabState.kept

  if (tabState.pending != null) {
    if (!isCommit || isOpeningCommit) return { action: 'none', tabState: next }
    const stillMatches = active && findMatchingRule(url, settings.rules) != null
    if (stillMatches) return { action: 'none', tabState: next }
    return { action: 'cancel', tabState: { ...next, pending: null } }
  }

  const eligible = active && (isOpeningCommit || (isCommit && !settings.onlyNewTabs))
  if (!eligible) return { action: 'none', tabState: next }
  const rule = findMatchingRule(url, settings.rules) ?? findMatchingRule(startUrl, settings.rules)
  if (rule == null) return { action: 'none', tabState: next }

  const pending = { closeAt: now + ruleDelaySeconds(rule, settings) * 1000, ruleName: rule.name }
  return { action: 'schedule', rule, tabState: { ...next, pending } }
}

/** Re-checks a pending close after settings change. */
export function planSettingsChange({ settings, tabState, url }) {
  if (tabState.pending == null) return { action: 'none', tabState }
  const rule = settings.enabled && !tabState.kept ? findMatchingRule(url, settings.rules) : undefined
  if (rule == null) return { action: 'cancel', tabState: { ...tabState, pending: null } }
  return { action: 'none', tabState }
}

export function secondsLeft(pending, now) {
  return Math.max(0, Math.ceil((pending.closeAt - now) / 1000))
}
