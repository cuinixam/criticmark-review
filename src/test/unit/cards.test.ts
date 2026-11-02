import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { cards } from '../../markup/cards';
import { parse } from '../../markup/parse';

const sample = fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/sample.md'), 'utf8');

suite('cards', () => {
    test('one card per thread and per bare suggestion, in file order', () => {
        const result = cards(parse(sample));
        assert.deepStrictEqual(result.map(c => c.anchor), [
            'important', 'Added: really', 'Deleted: never', 'Replaced: tabs with spaces', '',
        ]);
        assert.deepStrictEqual(result[0].comments.map(c => c.text), ['Why?', 'Because.', 'Agreed.']);
        assert.strictEqual(result[0].comments[1].author, 'Claude');
        assert.strictEqual(result[1].thread, null);
        assert.strictEqual(result[1].suggestion, 4);
        assert.deepStrictEqual(result[1].comments, []);
        assert.strictEqual(result[4].comments[0].author, 'Claude');
        assert.deepStrictEqual(result.slice(1, 4).map(c => c.change), [
            { old: null, new: 'really ' }, { old: 'never ', new: null }, { old: 'tabs', new: 'spaces' },
        ]);
        assert.strictEqual(result[0].change, null);
    });

    test('a thread on a suggestion is one card', () => {
        const [card] = cards(parse('a {++x++}{>>why<<} b'));
        assert.strictEqual(card.suggestion, 0);
        assert.strictEqual(card.thread, 0);
        assert.strictEqual(card.anchor, 'Added: x');
    });

    test('ids are stable and unique for identical threads', () => {
        const text = '{==a==}{>>c<<}\n\n{==a==}{>>c<<}';
        const ids = cards(parse(text)).map(c => c.id);
        assert.strictEqual(new Set(ids).size, 2);
        assert.deepStrictEqual(cards(parse('zz\n' + text)).map(c => c.id), ids);
    });

    test('ids survive a reply, a resolve tick and an edit of a highlighted thread', () => {
        const before = cards(parse('{==a==}{>>c<<}\n{>>lone<<}'));
        const after = cards(parse('{==a==}{status="resolved">>changed<<}{>>r<<}\n{>>lone<<}{>>r<<}'));
        assert.deepStrictEqual(after.map(c => c.id), before.map(c => c.id));
        assert.notStrictEqual(after[0].raw, before[0].raw);
    });

    test('a suggestion keeps its id when it gets its first comment', () => {
        assert.strictEqual(cards(parse('{++x++}{>>why<<}'))[0].id, cards(parse('{++x++}'))[0].id);
    });

    test('resolved comes from the first comment', () => {
        const [resolved, open] = cards(parse('{==a==}{status="resolved">>c<<}{>>r<<}\n{>>d<<}{status="resolved">>e<<}'));
        assert.strictEqual(resolved.resolved, true);
        assert.strictEqual(open.resolved, false);
    });
});
