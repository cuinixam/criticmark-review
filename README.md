# CriticMark Review

Review CriticMarkup comments and suggestions in markdown files from a side panel in VS Code. You never edit the markup by hand: the extension writes it for you. Files stay compatible with the Track Changes plugin for Obsidian, and an AI agent can reply by editing the same file.

## What it does

- The **Review** panel in the right side bar lists every thread and suggestion of the active markdown file. If you do not see it, run **View: Open View…** and choose **Threads**.
- Select text, right-click, **Add Comment**. A new card opens in the panel with the cursor in its text box. Press **Comment** or `Cmd+Enter` (`Ctrl+Enter` on Windows and Linux) to write it to the file, or **Cancel** or `Escape` to drop it.
- Click a card's header to expand or collapse it and to jump to its text. Expanded, a card shows every comment and a reply box. The **…** menu on a comment has **Edit** and **Delete comment**; deleting the last comment deletes the thread.
- Suggestions show the change as a small diff with **Accept** and **Reject**.
- Click the check circle on a card to mark the thread as resolved. The card and its highlight turn green and the card collapses. Click it again to reopen the thread.
- The panel's title bar has **Hide Resolved Threads**, **Expand All** and **Collapse All**.
- Right-click inside a comment for **Reply** and **Delete Thread**, or inside a suggestion for **Comment on Suggestion**, **Accept** and **Reject**.
- Suggestions (`{++…++}`, `{--…--}`, `{~~…~>…~~}`) are coloured in the editor.
- When the file changes on disk (for example an agent replied), the panel updates.

The extension saves the file after each change, so an agent reading the file on disk sees your comments at once.

## Install

The extension is not on the Marketplace. Build the package and install it:

```bash
npm install
npx vsce package --allow-missing-repository --no-rewrite-relative-links
code --install-extension criticmark-review-0.1.0.vsix
```

You need Node.js and VS Code. The steps are the same on macOS, Ubuntu and Windows.

## Settings

- `criticmarkReview.author`: the name written into new comments and replies. When empty, your system user name is used, or `User` if there is none.

## For AI agents

[docs/format.md](docs/format.md) describes the syntax, how threads are grouped, and how to reply, accept and reject.
