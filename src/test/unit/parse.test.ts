import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../../markup/parse';

const sample = fs.readFileSync(path.join(__dirname, '../../../src/test/fixtures/sample.md'), 'utf8');

suite('parse', () => {
    test('parses each element kind', () => {
        const { nodes } = parse(sample);
        assert.deepStrictEqual(nodes.map(n => n.kind), [
            'highlight', 'comment', 'comment', 'comment',
            'addition', 'deletion', 'substitution',
            'comment', 'aitext',
        ]);
        assert.strictEqual(nodes[0].text, 'important');
        assert.strictEqual(nodes[4].text, 'really ');
        assert.strictEqual(nodes[5].text, 'never ');
        assert.strictEqual(nodes[6].oldText, 'tabs');
        assert.strictEqual(nodes[6].text, 'spaces');
        assert.strictEqual(nodes[8].text, 'written by AI');
    });

    test('reads author and date attributes', () => {
        const [node] = parse('{author="Max" date="2026-11-02">>hi<<}').nodes;
        assert.strictEqual(node.author, 'Max');
        assert.strictEqual(node.date, '2026-11-02');
        assert.strictEqual(node.text, 'hi');
    });

    test('legacy author prefix', () => {
        const [node] = parse('{>>Claude: ok<<}').nodes;
        assert.strictEqual(node.author, 'Claude');
        assert.strictEqual(node.text, 'ok');
    });

    test('groups replies separated by spaces or tabs', () => {
        const one = parse('{>>a<<} \t{>>b<<}{>>c<<}');
        assert.strictEqual(one.threads.length, 1);
        assert.deepStrictEqual(one.threads[0].replyIndexes, [1, 2]);
        assert.strictEqual(parse('{>>a<<}\n{>>b<<}').threads.length, 2);
    });

    test('groups the sample thread', () => {
        const { threads } = parse(sample);
        assert.strictEqual(threads.length, 2);
        assert.strictEqual(threads[0].replyIndexes.length, 2);
    });

    test('anchors a thread to the element right before it', () => {
        for (const text of ['{==x==}{>>a<<}', '{++x++}{>>a<<}']) {
            const { threads } = parse(text);
            assert.strictEqual(threads[0].anchorIndex, 0, text);
            assert.strictEqual(threads[0].from, 0, text);
        }
        const loose = parse('{==x==} {>>a<<}');
        assert.strictEqual(loose.threads[0].anchorIndex, null);
        assert.strictEqual(loose.threads[0].from, 8);
    });

    test('ignores markup in code', () => {
        assert.deepStrictEqual(parse('```\n{>>a<<}\n```\n').nodes, []);
        assert.deepStrictEqual(parse('~~~md\n{++a++}\n~~~').nodes, []);
        assert.deepStrictEqual(parse('see `{>>a<<}` here').nodes, []);
    });

    test('ignores markup in an indented code block', () => {
        assert.deepStrictEqual(parse('para\n\n    {>>x<<}\n').nodes, []);
        assert.deepStrictEqual(parse('\t{>>x<<}').nodes, []);
        assert.strictEqual(parse('para\n    {>>x<<}').nodes.length, 1);
    });

    test('ignores unclosed and overlapping markup', () => {
        assert.deepStrictEqual(parse('{>>open').nodes, []);
        assert.deepStrictEqual(parse('{>>open').threads, []);
        const { nodes } = parse('{==a {>>b<<} c==}');
        assert.strictEqual(nodes.length, 1);
    });

    test('handles CRLF', () => {
        const crlf = sample.replace(/\n/g, '\r\n');
        const parsed = parse(crlf);
        assert.strictEqual(parsed.threads.length, 2);
        for (const node of parsed.nodes) {
            assert.strictEqual(crlf.slice(node.from, node.to), node.raw);
        }
    });
});
