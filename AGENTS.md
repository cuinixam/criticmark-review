# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Commands

- `npm run watch`: esbuild and `tsc --noEmit` watchers; the dev loop while editing.
- `npm run compile`: type-check, lint, and build `dist/extension.js`.
- `npm test`: unit tests, then integration tests. The `pretest` hook compiles both first.
- `npm run test:unit`: Mocha against `out/test/unit/**/*.test.js`. Run `npm run compile-tests` first when not going through `npm test`.
- `npm run test:integration`: runs `out/test/suite/**/*.test.js` in a real VS Code (downloaded to `.vscode-test/` on first run).
- `npx vsce package`: builds the `.vsix`.

## Rules

- The file format must round trip with the Obsidian Track Changes plugin. [docs/format.md](docs/format.md) is the reference; [src/markup/parse.ts](src/markup/parse.ts) mirrors the plugin's parser. Change both together.
- The extension is not on the Marketplace. Distribution is the `.vsix` file only.

## Architecture

- [src/markup/](src/markup/): pure CriticMarkup logic, no `vscode` import. `parse.ts` turns text into nodes and threads; `edits.ts` builds text edits for add, reply, delete, accept and reject. Every edit carries the text it replaces (`expected`), so a stale edit is refused instead of landing at a wrong offset. `sidecar.ts` places the entries of a `.review` file on its source and builds their edits.
- [src/ui/](src/ui/): VS Code adapters. `ThreadManager` owns the comment controller and rebuilds threads after each change, reusing a thread whose text did not change so an open reply box survives. `Decorations` colours suggestions and highlights.
- [src/extension.ts](src/extension.ts): `activate()`, the document listeners (debounced 200 ms) and all command handlers.

## Testing

- Unit tests ([src/test/unit/](src/test/unit/)) run plain Mocha (`tdd` UI) and must not import `vscode`. Put the logic in `src/markup/` and test it there.
- Integration tests ([src/test/suite/](src/test/suite/)) run in the Extension Host. They load from `out/`, so recompile after edits; `npm test` does that.
