import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Extension Integration Test Suite', () => {
    test('shows threads for a markdown file', async () => {
        const file = path.join(__dirname, '../../../src/test/fixtures/sample.md');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));

        const ext = vscode.extensions.getExtension('cuinixam.criticmark-review');
        assert.ok(ext, 'extension cuinixam.criticmark-review is not installed in the test host');
        await ext.activate();
        assert.ok(ext.isActive);

        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'criticmarkReview.addComment',
            'criticmarkReview.reply',
            'criticmarkReview.deleteThread',
            'criticmarkReview.accept',
            'criticmarkReview.reject',
        ]) {
            assert.ok(commands.includes(id), `missing command: ${id}`);
        }
    });
});
