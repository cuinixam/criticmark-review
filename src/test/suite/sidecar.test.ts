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
