# CriticMark Review

Review CriticMarkup comments and suggestions in markdown files from the VS Code Comments panel. You never edit the markup by hand: the extension writes it for you. Files stay compatible with the Track Changes plugin for Obsidian, and an AI agent can reply by editing the same file.

## What it does

- Select text, right-click, **Add Comment**. Or click the `+` in the gutter.
- Every thread shows in the gutter and in the **Comments** panel. Reply there, or delete a thread with the trash icon.
- Suggestions (`{++…++}`, `{--…--}`, `{~~…~>…~~}`) are coloured in the editor and listed in the panel with **Accept** and **Reject**.
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

- `criticmarkReview.author`: the name written into new comments and replies. When empty, only the date is written.

## For AI agents

[docs/format.md](docs/format.md) describes the syntax, how threads are grouped, and how to reply, accept and reject.
