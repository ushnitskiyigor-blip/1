import { attachedStrokePoints, outlineBounds } from './geometry.js';

const center = node => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });

function measure(text, node, measureText) {
  const size = measureText(text, node);
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error('Не удалось определить размер текста.');
  }
  return { width: size.width, height: size.height };
}

function allocateId(board, idFactory) {
  const used = new Set([...board.nodes, ...board.strokes, ...board.connections].map(item => item.id));
  return () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = idFactory();
      if (typeof value === 'string' && value.trim() && !used.has(value)) { used.add(value); return value; }
    }
    throw new Error('Не удалось создать уникальный идентификатор слова.');
  };
}

/** Bake a tail's current visible shape before changing its owning word. */
function reattach(stroke, previousNode, nextNode) {
  return {
    ...stroke,
    points: attachedStrokePoints(stroke, previousNode).map(point => ({ ...point })),
    attachment: { nodeId: nextNode.id, origin: center(nextNode) },
  };
}

function dedupeConnections(connections) {
  const seen = new Set();
  return connections.filter(connection => {
    if (connection.from === connection.to) return false;
    const key = JSON.stringify([connection.from, connection.to].sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Split a phrase into movable words without changing punctuation or its external links. */
export function splitNode(board, nodeId, measureText, idFactory) {
  const original = board.nodes.find(node => node.id === nodeId);
  if (!original) return { board, selectedIds: [] };
  const words = original.text.match(/\S+/gu) || [];
  if (words.length < 2) return { board, selectedIds: [original.id] };
  if (board.nodes.length - 1 + words.length > 1500) throw new Error('После разделения получится слишком много слов. Максимум — 1500.');
  const nextId = allocateId(board, idFactory);
  const sizes = words.map(word => measure(word, original, measureText));
  const bounds = sizes.map(size => outlineBounds({ ...original, ...size, x: 0, y: 0 }));
  const lineWidth = Math.max(outlineBounds(original).width, ...bounds.map(bound => bound.width));
  const gap = Math.max(18, (original.fontSize || 24) * 0.5);
  const left = original.x + bounds[0].x;
  let x = left;
  let y = original.y + bounds[0].y;
  let rowHeight = 0;
  const nodes = words.map((text, index) => {
    const size = sizes[index];
    const bound = bounds[index];
    if (x > left && x + bound.width > left + lineWidth + 0.001) {
      x = left;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const node = { ...original, id: index ? nextId() : original.id, text, x: x - bound.x, y: y - bound.y, ...size };
    x += bound.width + gap;
    rowHeight = Math.max(rowHeight, bound.height);
    return node;
  });
  const first = nodes[0];
  const last = nodes.at(-1);
  return {
    board: {
      ...board,
      nodes: board.nodes.flatMap(node => node.id === nodeId ? nodes : [node]),
      strokes: board.strokes.map(stroke => stroke.attachment?.nodeId === nodeId ? reattach(stroke, original, first) : stroke),
      connections: dedupeConnections(board.connections.map(connection => ({
        ...connection,
        from: connection.from === nodeId ? last.id : connection.from,
        to: connection.to === nodeId ? first.id : connection.to,
      }))),
    },
    selectedIds: nodes.map(node => node.id),
  };
}

function readingOrder(nodes) {
  const rows = [];
  for (const node of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const cy = node.y + node.height / 2;
    const row = rows.find(candidate => Math.abs(candidate.center - cy) <= Math.min(candidate.height, node.height) * 0.55);
    if (row) {
      row.nodes.push(node);
      row.center = row.nodes.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.nodes.length;
      row.height = Math.min(row.height, node.height);
    } else rows.push({ center: cy, height: node.height, nodes: [node] });
  }
  return rows.sort((a, b) => Math.min(...a.nodes.map(node => node.y)) - Math.min(...b.nodes.map(node => node.y)))
    .flatMap(row => row.nodes.sort((a, b) => a.x - b.x || a.y - b.y));
}

/** Merge selected words in visual reading order, retaining external links and tails. */
export function mergeNodes(board, nodeIds, measureText, idFactory) {
  const ids = new Set(nodeIds);
  const originals = readingOrder(board.nodes.filter(node => ids.has(node.id)));
  if (originals.length < 2) return { board, selectedIds: originals.map(node => node.id) };
  const first = originals[0];
  const text = originals.map(node => node.text.trim()).filter(Boolean).join(' ');
  if (text.length > 20000) throw new Error('Объединённая мысль слишком длинная. Максимум — 20 000 символов.');
  const merged = {
    ...first, id: allocateId(board, idFactory)(), text,
    x: Math.min(...originals.map(node => node.x)), y: Math.min(...originals.map(node => node.y)),
    ...measure(text, first, measureText),
  };
  const originalById = new Map(originals.map(node => [node.id, node]));
  let inserted = false;
  return {
    board: {
      ...board,
      nodes: board.nodes.flatMap(node => {
        if (!originalById.has(node.id)) return [node];
        if (inserted) return [];
        inserted = true;
        return [merged];
      }),
      strokes: board.strokes.map(stroke => {
        const original = originalById.get(stroke.attachment?.nodeId);
        return original ? reattach(stroke, original, merged) : stroke;
      }),
      connections: dedupeConnections(board.connections.map(connection => ({
        ...connection,
        from: originalById.has(connection.from) ? merged.id : connection.from,
        to: originalById.has(connection.to) ? merged.id : connection.to,
      }))),
    },
    selectedIds: [merged.id],
  };
}
