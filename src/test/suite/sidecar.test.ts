import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Card } from '../../markup/cards';
import { PanelMessage } from '../../ui/ReviewPanel';

interface Api {
    handle: (message: PanelMessage) => Promise<boolean>;
    cards: () => Card[];
}

const FIXTURES = path.join(__dirname, '../../../src/test/fixtures');
const SOURCE = fs.readFileSync(path.join(FIXTURES, 'sample.c'), 'utf8');
const REVIEW = fs.readFileSync(path.join(FIXTURES, 'sample.c.review'), 'utf8');

async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('condition not reached');
}

async function open(source: string, review?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'criticmark-'));
    const file = path.join(dir, 'sample.c');
    const sidecar = `${file}.review`;
    fs.writeFileSync(file, source);
    if (review !== undefined) {
        fs.writeFileSync(sidecar, review);
    }
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    const api = await vscode.extensions.getExtension('cuinixam.criticmark-review')!.activate() as Api;
    return { file, sidecar, editor, api };
}

suite('Sidecar review', () => {
    test('shows the threads of a .c file on the source', async () => {
        const { api } = await open(SOURCE, REVIEW);
        await until(() => api.cards().length === 1);
        assert.deepStrictEqual([api.cards()[0].from, api.cards()[0].to], [0, 13]);
    });

    test('submitting a comment on an unsaved file saves it and writes the entry', async () => {
        const { api, editor, file, sidecar } = await open(SOURCE);
        await editor.edit(b => b.insert(new vscode.Position(1, 0), '// new\n'));
        editor.selection = new vscode.Selection(0, 0, 0, 6);
        await vscode.commands.executeCommand('criticmarkReview.addComment');
        assert.strictEqual(await api.handle({ type: 'submitDraft', body: 'Why?' }), true);
        assert.ok(fs.readFileSync(file, 'utf8').includes('// new'));
        assert.match(fs.readFileSync(sidecar, 'utf8'), /^\{line="1" after="[0-9a-f]{8}"==static==\}\{author="[^"]*" date="[^"]*">>Why\?<<\}\n$/);
    });

    test('a comment on a blank line stays on that line', async () => {
        const { api, editor, sidecar } = await open(SOURCE);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand('criticmarkReview.addComment');
        assert.strictEqual(await api.handle({ type: 'submitDraft', body: 'Here' }), true);
        await until(() => api.cards().length === 1);
        const offset = SOURCE.indexOf('\n') + 1;
        assert.deepStrictEqual([api.cards()[0].from, api.cards()[0].to], [offset, offset]);
        assert.match(fs.readFileSync(sidecar, 'utf8'), /^\{line="2" before="[0-9a-f]+" after="[0-9a-f]+" author=/);
    });

    test('a reply goes to the sidecar and leaves the source alone', async () => {
        const { api, file, sidecar } = await open(SOURCE, REVIEW);
        await until(() => api.cards().length === 1);
        assert.strictEqual(await api.handle({ type: 'reply', id: api.cards()[0].id, body: 'Answer' }), true);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE);
        assert.match(fs.readFileSync(sidecar, 'utf8'), /Why static\?<<\}\{author="[^"]*" date="[^"]*">>Answer<<\}\n$/);
    });

    test('accept changes the source and removes the last entry with its file', async () => {
        const { api, file, sidecar } = await open(SOURCE, '{line="1"~~static int x;~>int x;~~}\n');
        await until(() => api.cards().length === 1);
        assert.strictEqual(await api.handle({ type: 'accept', id: api.cards()[0].id }), true);
        assert.ok(fs.readFileSync(file, 'utf8').startsWith('int x;\n'));
        assert.strictEqual(fs.existsSync(sidecar), false);
    });

    test('reject removes the entry and leaves the source alone', async () => {
        const { api, file, sidecar } = await open(SOURCE, '{line="1"~~static int x;~>int x;~~}\n');
        await until(() => api.cards().length === 1);
        assert.strictEqual(await api.handle({ type: 'reject', id: api.cards()[0].id }), true);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE);
        assert.strictEqual(fs.existsSync(sidecar), false);
    });

    test('accept on repeated code with a stale line is refused', async () => {
        const review = '{line="6"~~return 0;~>return 1;~~}\n';
        const { api, file, sidecar } = await open(SOURCE, review);
        await until(() => api.cards().length === 1);
        assert.strictEqual(await api.handle({ type: 'accept', id: api.cards()[0].id }), false);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCE);
        assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), review);
    });

    test('an action on a card that changed on disk is refused', async () => {
        const { api, sidecar } = await open(SOURCE, REVIEW);
        await until(() => api.cards().length === 1);
        const { id } = api.cards()[0];
        const other = '{line="3"==int first==}{author="Agent" date="2026-11-08">>Replaced<<}\n';
        fs.writeFileSync(sidecar, other);
        assert.strictEqual(await api.handle({ type: 'resolve', id, resolved: true }), false);
        assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), other);
    });

    test('an agent write during an accept keeps its entry and removes the accepted one', async () => {
        const accepted = '{line="1"~~static int x;~>int x;~~}\n';
        const { api, file, sidecar } = await open(SOURCE, accepted);
        await until(() => api.cards().length === 1);
        const added = '{line="3"==int first==}{author="Agent" date="2026-11-08">>New<<}\n\n';
        const listener = vscode.workspace.onWillSaveTextDocument(() => fs.writeFileSync(sidecar, added + accepted));
        try {
            assert.strictEqual(await api.handle({ type: 'accept', id: api.cards()[0].id }), true);
        } finally {
            listener.dispose();
        }
        assert.ok(fs.readFileSync(file, 'utf8').startsWith('int x;\n'));
        assert.strictEqual(fs.readFileSync(sidecar, 'utf8').trim(), added.trim());
    });

    test('a comment is not written when the source cannot be saved', async () => {
        const { api, editor, file, sidecar } = await open(SOURCE);
        await editor.edit(b => b.insert(new vscode.Position(1, 0), '// new\n'));
        fs.chmodSync(file, 0o444);
        editor.selection = new vscode.Selection(0, 0, 0, 6);
        await vscode.commands.executeCommand('criticmarkReview.addComment');
        assert.strictEqual(await api.handle({ type: 'submitDraft', body: 'Why?' }), false);
        assert.strictEqual(fs.existsSync(sidecar), false);
    });

    test('an agent edit keeping the anchor makes an older card stale', async () => {
        const { api, sidecar } = await open(SOURCE, REVIEW);
        await until(() => api.cards().length === 1);
        const { id } = api.cards()[0];
        const other = REVIEW.replace('Why static?', 'Edited by the agent');
        fs.writeFileSync(sidecar, other);
        assert.strictEqual(await api.handle({ type: 'resolve', id, resolved: true }), false);
        assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), other);
    });

    test('an agent write to a sidecar in the workspace shows up without a reload', async () => {
        const dir = fs.mkdtempSync(path.join(FIXTURES, 'tmp-'));
        try {
            const file = path.join(dir, 'watched.c');
            fs.writeFileSync(file, SOURCE);
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
            const api = await vscode.extensions.getExtension('cuinixam.criticmark-review')!.activate() as Api;
            await until(() => api.cards().length === 0);
            fs.writeFileSync(`${file}.review`, REVIEW);
            await until(() => api.cards().length === 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an empty extension list limits the review to markdown', async () => {
        const config = vscode.workspace.getConfiguration('criticmarkReview');
        await config.update('sidecarExtensions', [], vscode.ConfigurationTarget.Global);
        try {
            const { api } = await open(SOURCE, REVIEW);
            await until(() => api.cards().length === 0);
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.strictEqual(api.cards().length, 0);
        } finally {
            await config.update('sidecarExtensions', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
