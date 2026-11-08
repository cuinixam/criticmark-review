import * as os from 'os';
import * as vscode from 'vscode';
import { Card, cards, short } from './markup/cards';
import {
    TextEdit, addComment, checkSelection, commentOnNode, deleteComment, deleteThread, editComment, isCurrent, reply, resolveSuggestion, setResolved,
} from './markup/edits';
import { parse } from './markup/parse';
import { acceptEdit, addEntry, cardAt, entryOf, placeCards, quoteAt, removeEntry, sidecarEnabled } from './markup/sidecar';
import { Decorations } from './ui/Decorations';
import { PanelMessage, ReviewPanel, VIEW_ID } from './ui/ReviewPanel';

const DEBOUNCE_MS = 200;
const STALE = 'The file changed since this thread was shown. Try again.';

function today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function author(): string {
    const configured = vscode.workspace.getConfiguration('criticmarkReview').get<string>('author', '');
    if (configured) {
        return configured;
    }
    try {
        return os.userInfo().username || 'User';
    } catch {
        // os.userInfo() throws when the user has no name or home directory, e.g. in some containers.
        return 'User';
    }
}

function usesSidecar(document: vscode.TextDocument): boolean {
    const extensions = vscode.workspace.getConfiguration('criticmarkReview').get<string[]>('sidecarExtensions', ['*']);
    return document.uri.scheme === 'file' && document.languageId !== 'markdown' && sidecarEnabled(document.fileName, extensions);
}

function reviewable(document: vscode.TextDocument): boolean {
    return document.languageId === 'markdown' || usesSidecar(document);
}

function sidecarUri(document: vscode.TextDocument): vscode.Uri {
    return document.uri.with({ path: `${document.uri.path}.review` });
}

// A comment being written in the panel for a selection. It reaches the file only on submit.
interface Draft {
    uri: string;
    from: number;
    to: number;
    selected: string;
}

export function activate(context: vscode.ExtensionContext): { handle: (message: PanelMessage) => Promise<boolean>; cards: () => Card[] } {
    const decorations = new Decorations();
    const timers = new Map<string, NodeJS.Timeout>();
    // The text of each open file's sidecar, as last read from disk. Empty when it has none.
    const sidecars = new Map<string, string>();
    // The file the panel shows, and its cards as last drawn.
    let current: vscode.TextDocument | undefined;
    let shown: Card[] = [];
    let draft: Draft | undefined;
    let selected: string | undefined;
    // Set while an edit runs, so a double click cannot write the same reply twice.
    let busy = false;
    let hideResolved = context.globalState.get('hideResolved', false);
    vscode.commands.executeCommand('setContext', 'criticmarkReview.hideResolved', hideResolved);

    const sidecarText = (document: vscode.TextDocument) => sidecars.get(document.uri.toString()) ?? '';

    // Returns false when the sidecar exists but cannot be read, so nothing overwrites it.
    const loadSidecar = async (document: vscode.TextDocument): Promise<boolean> => {
        try {
            sidecars.set(document.uri.toString(), new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri(document))));
        } catch (e) {
            if (!(e instanceof vscode.FileSystemError && e.code === 'FileNotFound')) {
                vscode.window.showErrorMessage(`Cannot read the review file: ${(e as Error).message}`);
                return false;
            }
            sidecars.set(document.uri.toString(), '');
        }
        return true;
    };

    const decorate = (document: vscode.TextDocument): Card[] => {
        const sidecar = usesSidecar(document);
        const parsed = sidecar ? parse(sidecarText(document), true) : parse(document.getText());
        const placed = sidecar ? placeCards(parsed, document.getText()) : cards(parsed);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === document) {
                if (sidecar) {
                    decorations.applyCards(editor, parsed, placed);
                } else {
                    decorations.apply(editor, parsed);
                }
            }
        }
        return placed;
    };

    // Keeps the draft on its text while the file changes above it; drops it when its text itself changes.
    const moveDraft = (target: Draft, changes: readonly vscode.TextDocumentContentChangeEvent[]) => {
        let shift = 0;
        for (const change of changes) {
            const start = change.rangeOffset;
            const end = start + change.rangeLength;
            if (end <= target.from) {
                shift += change.text.length - change.rangeLength;
            } else if (start < target.to) {
                draft = undefined;
                vscode.window.showWarningMessage('The text you were commenting on changed, so the new comment was dropped.');
                return;
            }
        }
        target.from += shift;
        target.to += shift;
    };

    const cardAtCursor = (): Card | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== current) {
            return undefined;
        }
        const from = current.offsetAt(editor.selection.start);
        const to = current.offsetAt(editor.selection.end);
        if (usesSidecar(current)) {
            return cardAt(shown, from, to);
        }
        return shown.find(c => from === to ? c.from < from && from < c.to : c.from < to && from < c.to);
    };

    // Switches the editor context menu between Add Comment and the actions for the markup under the cursor.
    const updateCursorContext = () => {
        const card = cardAtCursor();
        const at = !card ? undefined : card.suggestion === null ? 'thread' : 'suggestion';
        vscode.commands.executeCommand('setContext', 'criticmarkReview.at', at);
        if (card && card.id !== selected) {
            panel.select(card.id);
        }
        selected = card?.id;
    };

    const render = () => {
        vscode.commands.executeCommand('setContext', 'criticmarkReview.active', current !== undefined);
        shown = current ? decorate(current) : [];
        const showDraft = draft && current && draft.uri === current.uri.toString();
        panel.render({
            file: current ? current.uri.toString() : null,
            cards: shown,
            draft: showDraft ? { from: draft!.from, anchor: short(draft!.selected) } : null,
            hideResolved,
        });
        updateCursorContext();
    };

    const refresh = async (document: vscode.TextDocument) => {
        if (await loadSidecar(document)) {
            if (document === current) {
                render();
            } else {
                decorate(document);
            }
        }
    };

    const setCurrent = (editor: vscode.TextEditor | undefined) => {
        if (editor) {
            current = reviewable(editor.document) ? editor.document : undefined;
            render();
            if (current && usesSidecar(current)) {
                void refresh(current);
            }
        }
    };

    const applyEdit = async (document: vscode.TextDocument, build: () => TextEdit): Promise<boolean> => {
        let edit: TextEdit;
        try {
            edit = build();
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
            return false;
        }
        if (!isCurrent(document.getText(), edit)) {
            vscode.window.showWarningMessage(STALE);
            return false;
        }
        const workspaceEdit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(document.positionAt(edit.from), document.positionAt(edit.to));
        workspaceEdit.replace(document.uri, range, edit.insert);
        const ok = await vscode.workspace.applyEdit(workspaceEdit);
        // Save right away: the agent reads the file on disk, and an unsaved buffer would not pick up its replies.
        if (ok && !document.isUntitled) {
            await document.save();
        }
        return ok;
    };

    // The agent reads this file directly and no editor has it open, so it goes straight to disk.
    const writeSidecar = async (document: vscode.TextDocument, build: () => TextEdit): Promise<boolean> => {
        const text = sidecarText(document);
        let edit: TextEdit;
        try {
            edit = build();
        } catch (e) {
            vscode.window.showErrorMessage((e as Error).message);
            return false;
        }
        if (!isCurrent(text, edit)) {
            vscode.window.showWarningMessage(STALE);
            return false;
        }
        const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
        const empty = next.trim() === '';
        try {
            if (empty) {
                await vscode.workspace.fs.delete(sidecarUri(document));
            } else {
                await vscode.workspace.fs.writeFile(sidecarUri(document), new TextEncoder().encode(next));
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Cannot write the review file: ${(e as Error).message}`);
            return false;
        }
        sidecars.set(document.uri.toString(), empty ? '' : next);
        return true;
    };

    const applyReview = (document: vscode.TextDocument, build: () => TextEdit) =>
        usesSidecar(document) ? writeSidecar(document, build) : applyEdit(document, build);

    // Finds a card again in the file as it is now, since the panel may show an older version.
    // A reply may land on a thread that got new replies meanwhile; other actions need the card unchanged.
    const locate = (id: string, allowNewReplies: boolean) => {
        if (!current) {
            return undefined;
        }
        const sidecar = usesSidecar(current);
        const parsed = sidecar ? parse(sidecarText(current), true) : parse(current.getText());
        const fresh = sidecar ? placeCards(parsed, current.getText()) : cards(parsed);
        const card = fresh.find(c => c.id === id);
        const seen = shown.find(c => c.id === id);
        // With identical cards the occurrence number alone may point at another one, so the position must match too.
        const key = id.slice(id.indexOf(':'));
        const twins = fresh.filter(c => c.id.slice(c.id.indexOf(':')) === key).length > 1;
        if (!card || !seen || (!allowNewReplies && card.raw !== seen.raw) || (twins && card.from !== seen.from)) {
            vscode.window.showWarningMessage(STALE);
            render();
            return undefined;
        }
        return { document: current, parsed, card };
    };

    const reveal = async (card: Card) => {
        if (!current) {
            return;
        }
        const editor = vscode.window.visibleTextEditors.find(e => e.document === current)
            ?? await vscode.window.showTextDocument(current, { preserveFocus: true });
        if (card.from === card.to) {
            return;
        }
        const range = new vscode.Range(current.positionAt(card.from), current.positionAt(card.to));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    };

    // Returns whether the file was changed, so the panel can clear a text box only when its text was written.
    const handle = async (message: PanelMessage): Promise<boolean> => {
        if (message.type === 'ready' || busy) {
            return false;
        }
        busy = true;
        try {
            return await run(message);
        } finally {
            busy = false;
        }
    };

    const run = async (message: PanelMessage): Promise<boolean> => {
        if (message.type === 'ready') {
            return false;
        }
        if (message.type === 'reveal') {
            const card = shown.find(c => c.id === message.id);
            if (card) {
                await reveal(card);
            }
            return false;
        }
        if (message.type === 'focusEditor') {
            return false;
        }
        if (message.type === 'setHideResolved') {
            setHideResolved(message.hide);
            return false;
        }
        if (message.type === 'cancelDraft') {
            draft = undefined;
            render();
            return false;
        }
        if (message.type === 'submitDraft') {
            const target = draft;
            if (!target || !current || target.uri !== current.uri.toString()) {
                return false;
            }
            const document = current;
            let build = () => addComment(
                parse(document.getText()), target.from, target.to, message.body, author(), today(), target.selected);
            if (usesSidecar(document)) {
                // The agent looks for the quote on disk. A save can also reformat the text and drop the draft.
                if (document.isDirty && !await document.save()) {
                    vscode.window.showErrorMessage('The file could not be saved, so the comment was not written.');
                    render();
                    return false;
                }
                if (draft !== target || !await loadSidecar(document)) {
                    render();
                    return false;
                }
                const line = target.selected ? document.positionAt(target.from).line + 1 : null;
                build = () => addEntry(sidecarText(document), target.selected, line, message.body, author(), today());
            }
            const ok = await applyReview(document, build);
            if (ok) {
                draft = undefined;
            }
            render();
            return ok;
        }
        if (message.type === 'delete' || message.type === 'deleteComment') {
            const answer = message.type === 'delete'
                ? await vscode.window.showWarningMessage(
                    'Delete this thread?', { modal: true, detail: 'All its comments are removed from the file.' }, 'Delete')
                : await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
            if (answer !== 'Delete') {
                return false;
            }
        }
        if (current && usesSidecar(current) && !await loadSidecar(current)) {
            return false;
        }
        const found = locate(message.id, message.type === 'reply');
        if (!found) {
            return false;
        }
        const { document, parsed, card } = found;
        const thread = card.thread === null ? undefined : parsed.threads[card.thread];
        const sidecar = usesSidecar(document);
        const removeCard = () => removeEntry(sidecarText(document), entryOf(sidecarText(document), card.raw));
        // On a suggestion, deleting the discussion keeps the suggestion, as it does inline.
        const removesEntry = sidecar && card.suggestion === null;
        let ok = false;
        switch (message.type) {
            case 'reply':
                ok = await applyReview(document, () => thread
                    ? reply(parsed, thread, message.body, author(), today())
                    : commentOnNode(parsed, card.suggestion!, message.body, author(), today()));
                break;
            case 'edit': {
                const comment = card.comments[message.position];
                if (comment) {
                    ok = await applyReview(document, () => editComment(parsed, comment.nodeIndex, message.body));
                }
                break;
            }
            case 'deleteComment': {
                const comment = card.comments[message.position];
                if (thread && comment) {
                    ok = await applyReview(document, () => removesEntry && card.comments.length === 1 ? removeCard() : deleteComment(parsed, thread, comment.nodeIndex));
                }
                break;
            }
            case 'delete':
                if (thread) {
                    ok = await applyReview(document, () => removesEntry ? removeCard() : deleteThread(parsed, thread));
                }
                break;
            case 'accept':
            case 'reject':
                if (card.suggestion !== null) {
                    if (!sidecar) {
                        ok = await applyEdit(document, () => resolveSuggestion(parsed, card.suggestion!, message.type === 'accept'));
                    } else if (message.type === 'reject') {
                        ok = await writeSidecar(document, removeCard);
                    } else if (await applyEdit(document, () => acceptEdit(parsed, card, document.getText()))) {
                        // The save can take a while, and the agent may write to the sidecar meanwhile.
                        if (document.isDirty) {
                            vscode.window.showErrorMessage('The file could not be saved, so the suggestion was kept.');
                        } else if (await loadSidecar(document)) {
                            ok = await writeSidecar(document, removeCard);
                        }
                    }
                }
                break;
            case 'resolve':
                if (thread) {
                    ok = await applyReview(document, () => setResolved(parsed, thread, message.resolved));
                }
                break;
        }
        render();
        return ok;
    };

    const panel = new ReviewPanel(context.extensionUri, async message => {
        const ok = await handle(message);
        if (message.type === 'reply' || message.type === 'edit' || message.type === 'submitDraft') {
            panel.result(ok);
        }
        // Hand the keyboard back to the file after a comment, so a review needs no mouse.
        if (current && ((ok && (message.type === 'reply' || message.type === 'submitDraft')) || message.type === 'cancelDraft' || message.type === 'focusEditor')) {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === current);
            await vscode.window.showTextDocument(current, editor?.viewColumn);
        }
    });

    const setHideResolved = (hide: boolean) => {
        hideResolved = hide;
        void context.globalState.update('hideResolved', hide);
        vscode.commands.executeCommand('setContext', 'criticmarkReview.hideResolved', hide);
        render();
    };

    const atCursor = (type: 'delete' | 'accept' | 'reject') => () => {
        const card = cardAtCursor();
        if (card) {
            void handle({ type, id: card.id });
        }
    };

    const showReview = (editor: vscode.TextEditor) => {
        if (usesSidecar(editor.document)) {
            void refresh(editor.document);
        } else if (reviewable(editor.document)) {
            decorate(editor.document);
        }
    };

    // Agent replies land in the sidecar, which no editor has open, so its changes are only visible on disk.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.review');
    const onSidecarChange = (uri: vscode.Uri) => {
        const source = uri.path.slice(0, -'.review'.length);
        const document = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.path === source);
        if (document && usesSidecar(document)) {
            void refresh(document);
        }
    };

    context.subscriptions.push(
        decorations,
        vscode.window.registerWebviewViewProvider(VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.window.onDidChangeActiveTextEditor(setCurrent),
        vscode.window.onDidChangeTextEditorSelection(updateCursorContext),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (!reviewable(e.document)) {
                return;
            }
            const key = e.document.uri.toString();
            if (draft?.uri === key) {
                moveDraft(draft, e.contentChanges);
            }
            clearTimeout(timers.get(key));
            timers.set(key, setTimeout(() => e.document === current ? render() : decorate(e.document), DEBOUNCE_MS));
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (draft?.uri === document.uri.toString()) {
                draft = undefined;
            }
            sidecars.delete(document.uri.toString());
            if (document === current) {
                current = undefined;
                render();
            }
        }),
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            editors.forEach(showReview);
        }),
        watcher,
        ...[watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete].map(event => event(onSidecarChange)),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('criticmarkReview.sidecarExtensions')) {
                vscode.window.visibleTextEditors.forEach(editor => {
                    if (reviewable(editor.document)) {
                        showReview(editor);
                    } else {
                        decorations.applyCards(editor, parse('', true), []);
                    }
                });
                setCurrent(vscode.window.activeTextEditor);
            }
        }),

        vscode.commands.registerCommand('criticmarkReview.addComment', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !reviewable(editor.document)) {
                return;
            }
            const document = editor.document;
            const from = document.offsetAt(editor.selection.start);
            const to = document.offsetAt(editor.selection.end);
            // The menu may still show Add Comment when the right-click just moved the cursor into markup.
            const inside = cardAtCursor();
            if (inside) {
                await panel.focus(inside.id);
                return;
            }
            const sidecar = usesSidecar(document);
            const error = sidecar ? null : checkSelection(parse(document.getText()), from, to);
            if (error) {
                vscode.window.showErrorMessage(error);
                return;
            }
            const target = sidecar ? quoteAt(document.getText(), from, to) : { from, to, quote: document.getText(editor.selection) };
            current = document;
            draft = { uri: document.uri.toString(), from: target.from, to: target.to, selected: target.quote };
            render();
            await panel.focus(null);
        }),
        // Both open the card under the cursor with the focus in its reply box; the titles differ for threads and suggestions.
        ...['criticmarkReview.openReply', 'criticmarkReview.commentSuggestion'].map(id => vscode.commands.registerCommand(id, async () => {
            const card = cardAtCursor();
            if (card) {
                await panel.focus(card.id);
            }
        })),
        vscode.commands.registerCommand('criticmarkReview.deleteThread', atCursor('delete')),
        vscode.commands.registerCommand('criticmarkReview.expandAll', () => panel.command('expandAll')),
        vscode.commands.registerCommand('criticmarkReview.collapseAll', () => panel.command('collapseAll')),
        vscode.commands.registerCommand('criticmarkReview.hideResolved', () => setHideResolved(true)),
        vscode.commands.registerCommand('criticmarkReview.showResolved', () => setHideResolved(false)),
        vscode.commands.registerCommand('criticmarkReview.accept', atCursor('accept')),
        vscode.commands.registerCommand('criticmarkReview.reject', atCursor('reject')),
    );

    vscode.window.visibleTextEditors.forEach(showReview);
    setCurrent(vscode.window.activeTextEditor);
    // The integration tests drive the panel through these.
    return { handle, cards: () => shown };
}

export function deactivate(): void {}
