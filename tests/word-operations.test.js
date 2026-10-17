import test from 'node:test';
import assert from 'node:assert/strict';
import { attachedStrokePoints, outlineBounds } from '../src/geometry.js';
import { splitNode, mergeNodes } from '../src/word-operations.js';

const measure = text => ({ width: text.length * 10 + 16, height: 32 });
const node = (id, text, x, y, extra = {}) => ({ id, text, x, y, ...measure(text), fontSize: 24, fontFamily: 'sans', color: '#527eaf', shape: 'capsule', outlined: true, bold: true, italic: false, underline: false, strike: false, align: 'left', ...extra });
const makeBoard = nodes => ({ nodes, strokes: [], connections: [], settings: { color: '#343a42', shape: 'capsule' } });
const factory = () => { let index = 0; return () => `new-${++index}`; };
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

test('split preserves punctuation, formatting, original position and wraps words at the phrase width', () => {
  const source = freeze(makeBoard([node('phrase', 'Первое,  второе\nтретье!', 20, 30, { width: 220 })]));
  const before = structuredClone(source);
  const result = splitNode(source, 'phrase', measure, factory());
  assert.deepEqual(result.selectedIds, ['phrase', 'new-1', 'new-2']);
  assert.deepEqual(result.board.nodes.map(node => node.text), ['Первое,', 'второе', 'третье!']);
  assert.deepEqual(result.board.nodes.map(node => [node.x, node.y]), [[20, 30], [144, 30], [20, 100]]);
  assert.ok(result.board.nodes.every(node => node.shape === 'capsule' && node.bold && node.outlined && node.color === '#527eaf'));
  assert.deepEqual(source, before);
});

test('split leaves at least 18px between actual outlines, including tall square frames', () => {
  for (const shape of ['capsule', 'square', 'rectangle', 'none']) {
    const source = makeBoard([node('phrase', 'а б длинноеслово в г', 20, 30, { width: 320, shape })]);
    const result = splitNode(source, 'phrase', text => ({ width: text.length * 10 + 16, height: 70 }), factory());
    const bounds = result.board.nodes.map(outlineBounds);
    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const a = bounds[first];
        const b = bounds[second];
        const horizontal = Math.max(b.x - a.x - a.width, a.x - b.x - b.width);
        const vertical = Math.max(b.y - a.y - a.height, a.y - b.y - b.height);
        assert.ok(Math.max(horizontal, vertical) >= 18 - 0.001, `${shape}: no visible outline collision`);
      }
    }
    assert.deepEqual([result.board.nodes[0].x, result.board.nodes[0].y], [20, 30]);
  }
});

test('split keeps incoming links on the first word, outgoing links on the last, and attached tail visually still', () => {
  const phrase = node('phrase', 'один два', 20, 30);
  const source = makeBoard([node('before', 'до', -200, 30), phrase, node('after', 'после', 500, 30)]);
  source.connections = [
    { id: 'incoming', from: 'before', to: 'phrase', bend: { x: -20, y: 100 } },
    { id: 'outgoing', from: 'phrase', to: 'after' },
  ];
  source.strokes = [{ id: 'tail', points: [{ x: -100, y: 40 }, { x: 100, y: 40 }, { x: 300, y: 40 }], attachment: { nodeId: 'phrase', origin: { x: 100, y: 40 } } }];
  const visibleBefore = attachedStrokePoints(source.strokes[0], phrase);
  freeze(source);
  const result = splitNode(source, 'phrase', measure, factory());
  assert.equal(result.board.connections[0].to, result.selectedIds[0]);
  assert.equal(result.board.connections[1].from, result.selectedIds.at(-1));
  assert.deepEqual(result.board.connections[0].bend, { x: -20, y: 100 });
  const first = result.board.nodes.find(node => node.id === result.selectedIds[0]);
  assert.deepEqual(attachedStrokePoints(result.board.strokes[0], first), visibleBefore);
  assert.equal(result.board.strokes[0].attachment.nodeId, first.id);
});

test('merge reads rows left to right despite small y offsets and keeps the first word formatting', () => {
  const source = freeze(makeBoard([
    node('bottom', 'Третье.', 10, 120, { color: '#b98551' }),
    node('right', 'второе', 200, 8, { bold: false }),
    node('left', 'Первое,', 20, 12),
    node('outside', 'Другое', 800, 12),
  ]));
  const before = structuredClone(source);
  const result = mergeNodes(source, ['bottom', 'right', 'left'], measure, factory());
  const merged = result.board.nodes.find(node => node.id === result.selectedIds[0]);
  assert.equal(merged.text, 'Первое, второе Третье.');
  assert.equal(merged.bold, true);
  assert.equal(merged.color, '#527eaf');
  assert.deepEqual([merged.x, merged.y], [10, 8]);
  assert.equal(result.board.nodes.length, 2);
  assert.deepEqual(source, before);
});

test('merge removes internal edges, redirects and deduplicates external edges, preserving tails without a jump', () => {
  const first = node('a', 'слово', 10, 10);
  const second = node('b', 'другое', 200, 10);
  const source = makeBoard([first, second, node('outside', 'вне', 600, 10)]);
  source.connections = [
    { id: 'internal', from: 'a', to: 'b' },
    { id: 'external-a', from: 'a', to: 'outside', bend: { x: 300, y: 90 } },
    { id: 'external-b', from: 'outside', to: 'b' },
  ];
  source.strokes = [{ id: 'tail', points: [{ x: 150, y: 20 }, { x: 250, y: 20 }, { x: 400, y: 20 }], attachment: { nodeId: 'b', origin: { x: 250, y: 20 } } }];
  const expectedTail = attachedStrokePoints(source.strokes[0], second);
  freeze(source);
  const result = mergeNodes(source, ['a', 'b'], measure, factory());
  const merged = result.board.nodes.find(node => node.id === result.selectedIds[0]);
  assert.deepEqual(result.board.connections, [{ id: 'external-a', from: merged.id, to: 'outside', bend: { x: 300, y: 90 } }]);
  assert.equal(result.board.strokes[0].attachment.nodeId, merged.id);
  assert.deepEqual(attachedStrokePoints(result.board.strokes[0], merged), expectedTail);
});

test('missing or indivisible selections are no-ops and duplicate selections are safe', () => {
  const source = freeze(makeBoard([node('a', 'один', 0, 0)]));
  assert.equal(splitNode(source, 'a', measure, factory()).board, source);
  assert.deepEqual(splitNode(source, 'missing', measure, factory()).selectedIds, []);
  assert.equal(mergeNodes(source, ['a', 'a'], measure, factory()).board, source);
  assert.deepEqual(mergeNodes(source, [], measure, factory()).selectedIds, []);
});

test('operations reject invalid measurements, excessive output and colliding ID factories', () => {
  const source = makeBoard([node('a', 'один два', 0, 0), node('b', 'три', 200, 0)]);
  assert.throws(() => splitNode(source, 'a', () => ({ width: NaN, height: 10 }), factory()), /размер текста/);
  assert.throws(() => mergeNodes(source, ['a', 'b'], () => ({ width: 10, height: 0 }), factory()), /размер текста/);
  assert.throws(() => splitNode(source, 'a', measure, () => 'a'), /уникальный идентификатор/);
  const many = makeBoard([node('a', 'a '.repeat(1501), 0, 0)]);
  assert.throws(() => splitNode(many, 'a', measure, factory()), /слишком много слов/);
  const long = makeBoard([node('a', 'a'.repeat(15000), 0, 0), node('b', 'b'.repeat(15000), 100, 0)]);
  assert.throws(() => mergeNodes(long, ['a', 'b'], measure, factory()), /20 000 символов/);
});
