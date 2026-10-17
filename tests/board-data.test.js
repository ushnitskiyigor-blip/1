import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_FORMAT, parseBoard, serializeBoard } from '../src/board-data.js';

const node = (id, extra = {}) => ({
  id, text: 'Мысль <без HTML>', x: 10, y: -20, width: 150, height: 44,
  fontFamily: 'serif', fontSize: 28, color: '#527eaf', shape: 'rectangle',
  outlined: true, bold: true, italic: false, underline: true, strike: false, align: 'center', ...extra,
});
const board = () => ({
  nodes: [node('one'), node('two', { x: 400, shape: 'capsule' })],
  strokes: [{ id: 'stroke', points: [{ x: 5, y: 6 }, { x: 50, y: 60 }], color: '#343a42', width: 2.2, attachment: { nodeId: 'one', origin: { x: 85, y: 2 } } }],
  connections: [{ id: 'link', from: 'one', to: 'two', color: '#b98551', bend: { x: 200, y: 100 } }],
  settings: { fontFamily: 'mono', fontSize: 24, color: '#343a42', shape: 'square', bold: false, italic: true, underline: false, strike: true, align: 'left' },
});

test('portable boards round trip text, styles, bent links, attached strokes and view without mutation', () => {
  const source = board();
  const before = structuredClone(source);
  const view = { x: -120, y: 80, scale: 0.75 };
  const text = serializeBoard(source, view);
  const data = JSON.parse(text);
  assert.equal(BOARD_FORMAT, 'polotno');
  assert.equal(data.format, BOARD_FORMAT);
  assert.equal(data.version, 1);
  assert.ok(text.includes('\n  "format"'));
  assert.deepEqual(parseBoard(text), { board: source, view });
  assert.deepEqual(source, before);
});

test('legacy boards receive defaults and unsupported old outlines become capsules', () => {
  const source = { nodes: [node('one', { shape: 'ellipse' }), node('two', { shape: 'triangle' })], strokes: [], connections: [], settings: { shape: 'ellipse' } };
  const result = parseBoard(JSON.stringify(source));
  assert.deepEqual(result.view, { x: 0, y: 0, scale: 1 });
  assert.equal(result.board.settings.shape, 'capsule');
  assert.ok(result.board.nodes.every(node => node.shape === 'capsule'));
  assert.equal(result.board.settings.fontSize, 24);
  assert.deepEqual(parseBoard(serializeBoard(result.board)).board, result.board);
});

test('unknown properties and prototype keys never become imported application state', () => {
  const source = JSON.parse('{"nodes":[{"id":"__proto__","text":"<img src=x onerror=alert(1)>","x":0,"y":0,"__proto__":{"polluted":true},"onclick":"alert(1)"}],"strokes":[],"connections":[],"settings":{"__proto__":{"polluted":true}},"constructor":{"prototype":{"polluted":true}}}');
  const result = parseBoard(JSON.stringify(source));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.board.nodes[0]), Object.prototype);
  assert.equal(result.board.nodes[0].text, '<img src=x onerror=alert(1)>');
  assert.equal(Object.hasOwn(result.board.nodes[0], 'onclick'), false);
  assert.equal(Object.hasOwn(result.board, 'constructor'), false);
  assert.equal(Object.hasOwn(result.board.settings, '__proto__'), false);
});

test('malformed JSON, wrong formats and unsupported versions have understandable errors', () => {
  assert.throws(() => parseBoard('not JSON'), /корректный JSON/);
  assert.throws(() => parseBoard('null'), /нет полотна/);
  assert.throws(() => parseBoard('{"format":"another","version":1,"board":{}}'), /не является полотном/);
  assert.throws(() => parseBoard('{"format":"polotno","version":2,"board":{}}'), /версия файла не поддерживается/);
  assert.throws(() => parseBoard('{}'), /нужны слова, линии и связи/);
  assert.equal(parseBoard(`\uFEFF${serializeBoard(board())}`).board.nodes.length, 2);
});

test('invalid geometry, line endpoints, styles and IDs are rejected instead of silently discarded', () => {
  const cases = [
    [b => { b.nodes[0].x = Infinity; }, /слово, X/],
    [b => { b.nodes[0].width = -2; }, /ширина слова/],
    [b => { b.strokes[0].points[0].y = NaN; }, /точка линии, Y/],
    [b => { b.nodes[1].id = 'one'; }, /повторяются идентификаторы/],
    [b => { b.strokes[0].id = 'one'; }, /повторяются идентификаторы/],
    [b => { b.connections[0].to = 'missing'; }, /нет в полотне/],
    [b => { b.connections[0].to = 'one'; }, /два разных слова/],
    [b => { b.strokes[0].attachment.nodeId = 'missing'; }, /нет в полотне/],
    [b => { b.connections[0].bend.x = null; }, /изгиб связи, X/],
    [b => { b.nodes[0].color = 'url(javascript:alert(1))'; }, /Некорректный цвет/],
    [b => { b.nodes[0].fontFamily = '<style>'; }, /fontFamily/],
    [b => { b.nodes[0].bold = 'yes'; }, /начертание/],
  ];
  for (const [change, error] of cases) {
    const source = board();
    change(source);
    assert.throws(() => serializeBoard(source), error);
    assert.throws(() => parseBoard(JSON.stringify(source)), error);
  }
  assert.throws(() => serializeBoard(board(), { x: 0, y: 0, scale: 0 }), /масштаб/);
});

test('board, line, text, point and byte limits reject excessive files', () => {
  const source = board();
  source.nodes = Array.from({ length: 1501 }, (_, index) => node(`n${index}`));
  assert.throws(() => serializeBoard(source), /слишком много слов/);
  const lines = board();
  lines.connections = Array.from({ length: 5001 }, (_, index) => ({ id: `c${index}`, from: 'one', to: 'two' }));
  assert.throws(() => serializeBoard(lines), /слишком много линий/);
  const longText = board();
  longText.nodes[0].text = 'a'.repeat(20001);
  assert.throws(() => serializeBoard(longText), /20 000 символов/);
  const points = board();
  points.strokes[0].points = Array.from({ length: 200001 }, () => ({ x: 0, y: 0 }));
  assert.throws(() => serializeBoard(points), /слишком много точек/);
  assert.throws(() => parseBoard(' '.repeat(5 * 1024 * 1024 + 1)), /5 МБ/);
  assert.throws(() => parseBoard(`"${'я'.repeat(3 * 1024 * 1024)}"`), /5 МБ/);
});
