import * as os from 'os';
import * as vscode from 'vscode';
import { Card, cards, short } from './markup/cards';
import {
    TextEdit, addComment, checkSelection, commentOnNode, deleteComment, deleteThread, editComment, isCurrent, reply, resolveSuggestion, setResolved,
} from './markup/edits';
import { parse } from './markup/parse';
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

// A comment being written in the panel for a selection. It reaches the file only on submit.
interface Draft {
    uri: string;
    from: number;
    to: number;
    selected: string;
}

export function activate(context: vscode.ExtensionContext): void {
    const decorations = new Decorations();
    const timers = new Map<string, NodeJS.Timeout>();
    // The markdown file the panel shows, and its cards as last drawn.
    let current: vscode.TextDocument | undefined;
    let shown: Card[] = [];
    let draft: Draft | undefined;
    let selected: string | undefined;
    // Set while an edit runs, so a double click cannot write the same reply twice.
    let busy = false;
    let hideResolved = context.globalState.get('hideResolved', false);
    vscode.commands.executeCommand('setContext', 'criticmarkReview.hideResolved', hideResolved);

    const decorate = (document: vscode.TextDocument) => {
        const parsed = parse(document.getText());
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === document) {
                decorations.apply(editor, parsed);
            }
        }
        return parsed;
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
        shown = current ? cards(decorate(current)) : [];
        const showDraft = draft && current && draft.uri === current.uri.toString();
        panel.render({
            file: current ? current.uri.toString() : null,
            cards: shown,
            draft: showDraft ? { from: draft!.from, anchor: short(draft!.selected) } : null,
            hideResolved,
        });
        updateCursorContext();
    };

    const setCurrent = (editor: vscode.TextEditor | undefined) => {
        if (editor) {
            current = editor.document.languageId === 'markdown' ? editor.document : undefined;
            render();
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

    // Finds a card again in the file as it is now, since the panel may show an older version.
    // A reply may land on a thread that got new replies meanwhile; other actions need the card unchanged.
    const locate = (id: string, allowNewReplies: boolean) => {
        if (!current) {
            return undefined;
        }
        const parsed = parse(current.getText());
        const fresh = cards(parsed);
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
            const build = () => addComment(
                parse(document.getText()), target.from, target.to, message.body, author(), today(), target.selected);
            const ok = await applyEdit(document, build);
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
        const found = locate(message.id, message.type === 'reply');
        if (!found) {
            return false;
        }
        const { document, parsed, card } = found;
        const thread = card.thread === null ? undefined : parsed.threads[card.thread];
        let ok = false;
        switch (message.type) {
            case 'reply':
                ok = await applyEdit(document, () => thread
                    ? reply(parsed, thread, message.body, author(), today())
                    : commentOnNode(parsed, card.suggestion!, message.body, author(), today()));
                break;
            case 'edit': {
                const comment = card.comments[message.position];
                if (comment) {
                    ok = await applyEdit(document, () => editComment(parsed, comment.nodeIndex, message.body));
                }
                break;
            }
            case 'deleteComment': {
                const comment = card.comments[message.position];
                if (thread && comment) {
                    ok = await applyEdit(document, () => deleteComment(parsed, thread, comment.nodeIndex));
                }
                break;
            }
            case 'delete':
                if (thread) {
                    ok = await applyEdit(document, () => deleteThread(parsed, thread));
                }
                break;
            case 'accept':
            case 'reject':
                if (card.suggestion !== null) {
                    ok = await applyEdit(document, () => resolveSuggestion(parsed, card.suggestion!, message.type === 'accept'));
                }
                break;
            case 'resolve':
                if (thread) {
                    ok = await applyEdit(document, () => setResolved(parsed, thread, message.resolved));
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

    context.subscriptions.push(
        decorations,
        vscode.window.registerWebviewViewProvider(VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.window.onDidChangeActiveTextEditor(setCurrent),
        vscode.window.onDidChangeTextEditorSelection(updateCursorContext),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId !== 'markdown') {
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
            if (document === current) {
                current = undefined;
                render();
            }
        }),
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            editors.filter(e => e.document.languageId === 'markdown').forEach(e => decorations.apply(e, parse(e.document.getText())));
        }),

        vscode.commands.registerCommand('criticmarkReview.addComment', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'markdown') {
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
            const error = checkSelection(parse(document.getText()), from, to);
            if (error) {
                vscode.window.showErrorMessage(error);
                return;
            }
            current = document;
            draft = { uri: document.uri.toString(), from, to, selected: document.getText(editor.selection) };
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

    vscode.window.visibleTextEditors.filter(e => e.document.languageId === 'markdown').forEach(e => decorate(e.document));
    setCurrent(vscode.window.activeTextEditor);
}

export function deactivate(): void {}
