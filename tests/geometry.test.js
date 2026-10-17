import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachedStrokePoints, connectionGeometry, connectorPath, detectStrokeTargets, outlineBounds, outlinePath, pathLength, repelNodes, simplifyPoints, smoothPath, stabilizeStroke,
} from '../src/geometry.js';

const word = { id: 'word', x: 20, y: 20, width: 100, height: 24, shape: 'ellipse' };

test('strokes have usable straight and smooth SVG paths and exact polyline lengths', () => {
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([{ x: 3, y: 4 }]), 'M 3 4');
  assert.equal(smoothPath([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 'M 0 0 L 3 4');
  const curve = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 10 }];
  assert.equal(smoothPath(curve), 'M 0 0 Q 10 20 20 15 L 30 10');
  assert.equal(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 }]), 10);
});

test('simplification removes sampling noise while retaining bends and endpoints', () => {
  const points = [{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.deepEqual(simplifyPoints(points, 1), [points[0], points[2], points[3]]);
  assert.deepEqual(simplifyPoints(points, 0), points);
});

test('crossing coverage is based on 30% of word width, including sparse input', () => {
  assert.deepEqual(detectStrokeTargets([{ x: 20, y: 32 }, { x: 49, y: 32 }], [word]), []);
  assert.deepEqual(detectStrokeTargets([{ x: 20, y: 32 }, { x: 50, y: 32 }], [word]), ['word']);
  assert.deepEqual(detectStrokeTargets([{ x: -100, y: 32 }, { x: 200, y: 32 }], [word]), ['word']);
  assert.deepEqual(detectStrokeTargets([{ x: 60, y: -20 }, { x: 60, y: 100 }], [word]), []);
});

test('repeated short scribbles do not count their same coverage repeatedly', () => {
  const scribble = Array.from({ length: 20 }, (_, index) => ({ x: index % 2 ? 40 : 20, y: 32 }));
  assert.deepEqual(detectStrokeTargets(scribble, [word]), []);
});

test('nearby underlines target words but distant strokes do not', () => {
  assert.deepEqual(detectStrokeTargets([{ x: 25, y: 48 }, { x: 115, y: 48 }], [word]), ['word']);
  assert.deepEqual(detectStrokeTargets([{ x: 25, y: 70 }, { x: 115, y: 70 }], [word]), []);
});

test('a closed lasso selects enclosed words and excludes words outside it', () => {
  const lasso = [
    { x: 0, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 65 },
    { x: 0, y: 65 }, { x: 2, y: 2 },
  ];
  const outside = { ...word, id: 'outside', x: 220 };
  assert.deepEqual(detectStrokeTargets(lasso, [word, outside]), ['word']);
});

test('diagonal strokes use their actual intersection with each word', () => {
  const upper = { ...word, id: 'upper', x: 0, y: 0, width: 100, height: 20 };
  const lower = { ...word, id: 'lower', x: 100, y: 100, width: 40, height: 40 };
  assert.deepEqual(detectStrokeTargets([{ x: 0, y: 10 }, { x: 200, y: 210 }], [upper, lower]), ['lower']);
});

test('rectangle and ellipse connectors end on their padded outlines', () => {
  const first = { x: 0, y: 0, width: 100, height: 40, shape: 'rectangle' };
  const second = { x: 300, y: 0, width: 100, height: 40, shape: 'ellipse' };
  assert.equal(connectorPath(first, second), 'M 110 20 L 290 20');
  assert.equal(connectorPath({ ...first, shape: 'none' }, { ...second, shape: 'none' }), 'M 100 20 L 300 20');
});

test('diagonal ellipse endpoints satisfy the ellipse equation', () => {
  const first = { x: 0, y: 0, width: 80, height: 30, shape: 'ellipse' };
  const second = { ...first, x: 200, y: 200 };
  const coordinates = connectorPath(first, second).match(/-?\d+(?:\.\d+)?/g).map(Number);
  const [x, y] = coordinates;
  assert.ok(Math.abs(((x - 40) / 50) ** 2 + ((y - 15) / 25) ** 2 - 1) < 0.001);
});

test('triangle connectors hit triangle edges and overlapping nodes have no gap', () => {
  const first = { x: 0, y: 0, width: 80, height: 20, shape: 'triangle' };
  const second = { ...first, x: 300 };
  assert.equal(connectorPath(first, second), 'M 106.667 10 L 273.333 10');
  assert.equal(connectorPath(first, { ...first }), '');
  assert.equal(connectorPath(first, { ...first, x: 10 }), '');
  assert.match(outlinePath(first), /^M 40 -30 L 140 30 L -60 30 Z$/);
  assert.equal(outlinePath({ ...first, shape: 'none' }), '');
});

test('an attached tail follows a word with arc-length falloff and a fixed far end', () => {
  const stroke = {
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 40, y: 0 }],
    attachment: { nodeId: 'word', origin: { x: 0, y: 0 } },
  };
  const before = structuredClone(stroke);
  const moved = attachedStrokePoints(stroke, { id: 'word', x: 0, y: 10, width: 20, height: 20 });
  assert.deepEqual(moved, [{ x: 10, y: 20 }, { x: 17.5, y: 15 }, { x: 40, y: 0 }]);
  assert.deepEqual(stroke, before);
  assert.notEqual(moved[0], stroke.points[0]);
});

test('attachment at a last endpoint moves that endpoint and fixes the first', () => {
  const stroke = {
    points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }],
    attachment: { nodeId: 'word', origin: { x: 40, y: 0 } },
  };
  assert.deepEqual(attachedStrokePoints(stroke, { id: 'word', x: 40, y: 10, width: 20, height: 20 }), [
    { x: 0, y: 0 }, { x: 25, y: 10 }, { x: 50, y: 20 },
  ]);
});

test('a stroke crossing a word bends around its center with both far ends fixed', () => {
  const stroke = {
    points: [{ x: -40, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }],
    attachment: { nodeId: 'word', origin: { x: 0, y: 0 } },
  };
  assert.deepEqual(attachedStrokePoints(stroke, { id: 'word', x: -10, y: 10, width: 20, height: 20 }), [
    { x: -40, y: 0 }, { x: -10, y: 15 }, { x: 0, y: 20 }, { x: 30, y: 10 }, { x: 60, y: 0 },
  ]);
});

test('a simplified two-point stroke gets a projected interior anchor and keeps both tails', () => {
  const stroke = {
    points: [{ x: -100, y: 0 }, { x: 100, y: 0 }],
    attachment: { nodeId: 'word', origin: { x: 20, y: 5 } },
  };
  const before = structuredClone(stroke);
  assert.deepEqual(attachedStrokePoints(stroke, { id: 'word', x: 10, y: 15, width: 20, height: 20 }), [
    { x: -100, y: 0 }, { x: 20, y: 20 }, { x: 100, y: 0 },
  ]);
  assert.deepEqual(stroke, before);
});

test('unattached, missing, mismatched and unmoved nodes leave points unchanged', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  assert.equal(attachedStrokePoints({ points }, word), points);
  const stroke = { points, attachment: { nodeId: 'word', origin: { x: 0, y: 0 } } };
  assert.equal(attachedStrokePoints(stroke, null), points);
  assert.equal(attachedStrokePoints(stroke, { ...word, id: 'other' }), points);
  assert.deepEqual(attachedStrokePoints(stroke, { id: 'word', x: -10, y: -10, width: 20, height: 20 }), points);
});

test('empty, single-point and repeated-point attachments remain finite', () => {
  const attachment = { nodeId: 'word', origin: { x: 0, y: 0 } };
  const node = { id: 'word', x: 0, y: 10, width: 20, height: 20 };
  assert.deepEqual(attachedStrokePoints({ points: [], attachment }, node), []);
  assert.deepEqual(attachedStrokePoints({ points: [{ x: 0, y: 0 }], attachment }, node), [{ x: 10, y: 20 }]);
  assert.deepEqual(attachedStrokePoints({ points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], attachment }, node), [
    { x: 10, y: 20 }, { x: 5, y: 10 }, { x: 0, y: 0 },
  ]);
});

test('stabilization strongly reduces mouse jitter and backtracking without moving endpoints', () => {
  const noisy = Array.from({ length: 101 }, (_, index) => ({
    x: index * 3 + (index > 0 && index < 100 ? Math.sin(index * 2) * 3 : 0),
    y: index === 0 || index === 100 ? 0 : Math.sin(index * 2.4) * 7 + Math.cos(index * 1.4) * 2,
  }));
  const before = structuredClone(noisy);
  const stable = stabilizeStroke(noisy);
  assert.deepEqual(stable[0], noisy[0]);
  assert.deepEqual(stable.at(-1), noisy.at(-1));
  assert.ok(Math.max(...stable.map(point => Math.abs(point.y))) < 3);
  assert.ok(pathLength(stable) < pathLength(noisy) * 0.55);
  assert.deepEqual(noisy, before);
});

test('stabilization keeps a broad intentional curve instead of straightening it', () => {
  const curve = Array.from({ length: 101 }, (_, index) => {
    const angle = index / 100 * Math.PI / 2;
    const noise = index === 0 || index === 100 ? 0 : Math.sin(index * 2.3) * 5;
    return { x: 120 * Math.sin(angle), y: 120 * (1 - Math.cos(angle)) + noise };
  });
  const stable = stabilizeStroke(curve);
  assert.ok(stable.length > 10);
  assert.ok(stable.some(point => point.x - point.y > 40));
  assert.ok(Math.max(...stable.map(point => Math.abs(Math.hypot(point.x, point.y - 120) - 120))) < 5);
  assert.deepEqual(stable[0], curve[0]);
  assert.deepEqual(stable.at(-1), curve.at(-1));
});

test('a shallow deliberate bend remains curved after stabilization', () => {
  const curve = Array.from({ length: 81 }, (_, index) => ({ x: index * 3, y: Math.sin(index / 80 * Math.PI) * 8 }));
  const stable = stabilizeStroke(curve);
  assert.ok(stable.length > 2);
  assert.ok(Math.max(...stable.map(point => point.y)) > 7);
});

test('stabilized closed lassos retain their enclosure and target detection', () => {
  const loop = Array.from({ length: 121 }, (_, index) => {
    const angle = index / 120 * Math.PI * 2;
    const radius = 80 + (index === 0 || index === 120 ? 0 : Math.sin(index * 2.1) * 5);
    return { x: 100 + Math.cos(angle) * radius, y: 100 + Math.sin(angle) * radius };
  });
  const stable = stabilizeStroke(loop);
  assert.ok(Math.max(...stable.map(point => point.x)) - Math.min(...stable.map(point => point.x)) > 150);
  assert.deepEqual(detectStrokeTargets(stable, [{ id: 'inside', x: 65, y: 80, width: 70, height: 30 }]), ['inside']);
  assert.deepEqual(stable[0], loop[0]);
  assert.deepEqual(stable.at(-1), loop.at(-1));
});

test('stabilization depends on gesture geometry instead of event sampling density', () => {
  const sparse = [{ x: 0, y: 0 }, { x: 80, y: 70 }, { x: 160, y: 0 }];
  const dense = [];
  for (let segment = 1; segment < sparse.length; segment += 1) {
    for (let step = 0; step < 20; step += 1) {
      const fraction = step / 20;
      dense.push({ x: sparse[segment - 1].x + (sparse[segment].x - sparse[segment - 1].x) * fraction, y: sparse[segment - 1].y + (sparse[segment].y - sparse[segment - 1].y) * fraction });
    }
  }
  dense.push(sparse.at(-1));
  const fromSparse = stabilizeStroke(sparse);
  const fromDense = stabilizeStroke(dense);
  assert.equal(fromSparse.length, fromDense.length);
  assert.ok(fromSparse.every((point, index) => Math.hypot(point.x - fromDense[index].x, point.y - fromDense[index].y) < 1e-6));
});

test('empty, repeated and tiny gestures stabilize without invalid coordinates', () => {
  assert.deepEqual(stabilizeStroke([]), []);
  assert.deepEqual(stabilizeStroke([{ x: 5, y: 6 }, { x: 5, y: 6 }]), [{ x: 5, y: 6 }]);
  const tiny = stabilizeStroke([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }]);
  assert.ok(tiny.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.deepEqual(tiny[0], { x: 0, y: 0 });
  assert.deepEqual(tiny.at(-1), { x: 2, y: 0 });
});

test('square outlines use equal sides and hidden outlines retain text bounds', () => {
  const node = { id: 'square', x: 20, y: 40, width: 100, height: 20, shape: 'square', outlined: true };
  assert.deepEqual(outlineBounds(node), { x: 10, y: -10, width: 120, height: 120 });
  assert.equal(outlinePath(node), 'M 10 -10 H 130 V 110 H 10 Z');
  assert.deepEqual(outlineBounds({ ...node, outlined: false }), { x: 20, y: 40, width: 100, height: 20 });
  const below = { ...node, id: 'below', y: 300 };
  assert.equal(connectorPath(node, below), 'M 70 110 L 70 250');
  assert.equal(connectorPath({ ...node, outlined: false }, { ...below, outlined: false }), 'M 70 60 L 70 300');
});

test('capsule outlines have straight sides and connectors meet their rounded ends', () => {
  const node = { id: 'capsule', x: 0, y: 0, width: 100, height: 20, shape: 'capsule' };
  assert.deepEqual(outlineBounds(node), { x: -10, y: -10, width: 120, height: 40 });
  assert.match(outlinePath(node), /^M 10 -10 H 90 A 20 20/);
  const other = { ...node, id: 'other', x: 300 };
  assert.equal(connectorPath(node, other), 'M 110 10 L 290 10');
  const { start } = connectionGeometry(node, other, { x: 0, y: 30 });
  // Right-hand semicircle has center (90, 10), radius 20.
  assert.ok(Math.abs((start.x - 90) ** 2 + (start.y - 10) ** 2 - 400) < 1e-6);
  assert.ok(start.x > 90 && start.x < 110);
});

test('curved connections expose their trimmed ends, control and actual curve midpoint', () => {
  const from = { x: 0, y: 0, width: 80, height: 40, shape: 'rectangle' };
  const to = { ...from, x: 300 };
  const geometry = connectionGeometry(from, to, { x: 0, y: 100 });
  assert.deepEqual(geometry.control, { x: 190, y: 120 });
  assert.deepEqual(geometry.start, { x: 85, y: 50 });
  assert.deepEqual(geometry.end, { x: 295, y: 50 });
  assert.deepEqual(geometry.midpoint, { x: 190, y: 85 });
  assert.equal(geometry.path, 'M 85 50 Q 190 120 295 50');
  assert.equal(connectorPath(from, to, { x: 0, y: 100 }), geometry.path);
  assert.equal(connectionGeometry(from, to).path, 'M 90 20 L 290 20');
  assert.equal(connectionGeometry(from, from, { x: 20, y: 20 }).path, '');
  assert.doesNotMatch(connectionGeometry(from, to, { x: -150, y: 0 }).path, /NaN|Infinity/);
});

function assertVisualGap(nodes, gap) {
  for (let index = 0; index < nodes.length; index += 1) {
    for (let other = index + 1; other < nodes.length; other += 1) {
      const a = outlineBounds(nodes[index]);
      const b = outlineBounds(nodes[other]);
      assert.ok(a.x + a.width + gap <= b.x + 1e-6 || b.x + b.width + gap <= a.x + 1e-6
        || a.y + a.height + gap <= b.y + 1e-6 || b.y + b.height + gap <= a.y + 1e-6,
      `${nodes[index].id} and ${nodes[other].id} must have ${gap}px of visible separation`);
    }
  }
}

test('repulsion cascades through a row, preserves moving anchors and does not mutate input', () => {
  const nodes = Array.from({ length: 4 }, (_, index) => ({ id: String(index), x: index * 50, y: 0, width: 40, height: 100, shape: 'capsule', outlined: true }));
  const before = structuredClone(nodes);
  const result = repelNodes(nodes, ['0']);
  assert.deepEqual(result.nodes.map(node => node.x), [0, 78, 156, 234]);
  assert.deepEqual(result.nodes[0], nodes[0]);
  assertVisualGap(result.nodes, 18);
  assert.ok(result.guides.length > 0);
  assert.ok(result.guides.every(guide => Math.abs(Math.hypot(guide.x2 - guide.x1, guide.y2 - guide.y1) - 18) < 1e-6));
  assert.deepEqual(nodes, before);
  assert.deepEqual(repelNodes(nodes, ['0']), result);
});

test('repulsion accounts for square visual height and handles a word squeezed between anchors', () => {
  const square = { id: 'square', x: 0, y: 0, width: 100, height: 20, shape: 'square', outlined: true };
  const small = { id: 'small', x: 10, y: 45, width: 40, height: 20, shape: 'capsule', outlined: true };
  const result = repelNodes([square, small], ['square']);
  assertVisualGap(result.nodes, 18);
  assert.notDeepEqual(result.nodes[1], small);
  const anchors = [
    { id: 'a', x: 0, y: 0, width: 80, height: 40, shape: 'none' },
    { id: 'b', x: 140, y: 0, width: 80, height: 40, shape: 'none' },
  ];
  const squeezed = { id: 'c', x: 70, y: 0, width: 80, height: 40, shape: 'none' };
  const resolved = repelNodes([squeezed, ...anchors], new Set(['a', 'b']));
  assert.deepEqual(resolved.nodes.slice(1), anchors);
  assertVisualGap(resolved.nodes, 18);
  assert.equal(resolved.nodes[0].y, 58);
});

test('repulsion resolves a dense mix of shapes while preserving a selected group', () => {
  const nodes = Array.from({ length: 18 }, (_, index) => ({
    id: String(index), x: index < 2 ? index * 400 : (index * 59) % 350, y: index < 2 ? 0 : (index * 37) % 120,
    width: 40 + index % 3 * 20, height: 22, shape: ['capsule', 'square', 'rectangle'][index % 3], outlined: index % 4 !== 0,
  }));
  const result = repelNodes(nodes, ['0', '1'], 12);
  assert.deepEqual(result.nodes.slice(0, 2), nodes.slice(0, 2));
  assertVisualGap(result.nodes, 12);
  assert.deepEqual(repelNodes([], []), { nodes: [], guides: [] });
});
