# chrome-auto-close

Chrome extension that closes the tabs left behind when a Slack, Zoom, Asana, Discord or Teams link hands off to the desktop app.

Clicking a link such as `https://edgesecure.slack.com/archives/C0808NMRU93/p1790596658215339` opens the Slack desktop app, and the browser tab it came through stays open for nothing. With this extension, that tab closes itself after a short delay (5 seconds by default, long enough to answer Chrome's "Open Slack?" prompt).

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension/` folder.

To try it without touching your own profile, `npm run launch` opens a separate Chrome window with the extension already installed (profile kept in `.e2e-profile/`).

## Behavior

- A tab closes only when it **opened** on a matching URL: a link opened in a new tab or window, from another app, or through a redirect chain (mail link wrappers, Slack's logged-out `/?redir=` hop). Redirects and in-page route changes after that do not cancel the close.
- A URL you type into a new tab, or a link you follow inside a tab you are already using, never triggers a close. Turn off **Only close tabs that open on a matching URL** in the settings to close those too.
- Navigating the tab to a page that no longer matches cancels the close.
- While a close is pending, the toolbar badge counts down the seconds. The popup shows the status and has a **Keep this tab open** button, plus a switch that turns the extension off.

## Default rules

| Rule | Patterns |
|---|---|
| Slack | `https://*.slack.com/archives/*`, `https://*.slack.com/app_redirect*` |
| Zoom | `https://*.zoom.us/j/*`, `https://*.zoom.us/s/*`, `https://*.zoom.us/my/*` |
| Asana | `https://app.asana.com/0/*`, `https://app.asana.com/1/*` |
| Discord | `https://discord.com/channels/*`, `https://discord.com/invite/*`, `https://discord.gg/*` |
| Microsoft Teams | `https://teams.microsoft.com/l/*` |

Web-app pages such as `app.slack.com/client` or `app.zoom.us/wc`, and Asana attachments (`app.asana.com/app/asana/-/get_asset`), are left out on purpose. Updating from 1.0.0 moves an Asana rule you never edited off the old `https://app.asana.com/*` pattern. Edit, disable or add rules from the extension's options page; settings sync through your Chrome account.

## Delays

The options page sets one **Default delay** (5 seconds unless you change it). Each rule's **Close after** is either **Default**, which follows that setting, or **Custom**, a delay of its own. Every default rule and every new rule starts on **Default**.

## Patterns

- `*` matches any run of characters. In the host it stops at the end of the host, so `https://*.slack.com/*` cannot match `https://evil.com/?x=.slack.com/`.
- A host starting with `*.` also matches the bare domain: `https://*.zoom.us/j/*` matches `https://zoom.us/j/123`.
- Matching ignores case and covers the whole URL, including the query string. Only `http` and `https` pages are ever closed.

The options page has a **Test a URL** box that shows which rule, if any, a URL hits.

## Development

No dependencies and no build step: the `extension/` folder is the extension.

```sh
npm test       # unit tests for matching and close decisions
npm run e2e    # installs the extension into headless Chrome and drives real tabs
npm run launch # visible Chrome with the extension installed
```

Chrome 137 and later ignore `--load-extension`, so the scripts install the extension through the DevTools protocol (`Extensions.loadUnpacked` over `--remote-debugging-pipe`). Set `CHROME_PATH` if Chrome is not in its default location. The e2e test answers Slack URLs locally, so it needs no network access.
