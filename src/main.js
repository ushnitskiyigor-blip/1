import './styles.css';
import { smoothPath, stabilizeStroke, pathLength, detectStrokeTargets, connectionGeometry, outlinePath, outlineBounds, attachedStrokePoints, repelNodes } from './geometry.js';
import { serializeBoard, parseBoard } from './board-data.js';
import { splitNode, mergeNodes } from './word-operations.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const nodesLayer = $('#nodes-layer');
const drawingLayer = $('#drawing-layer');
const guidesLayer = $('#guides-layer');
const settings = $('#settings-popover');
const contextMenu = $('#text-menu');
const storageKey = 'thought-canvas:v1';
const svgNS = 'http://www.w3.org/2000/svg';
const fonts = { sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: '"SFMono-Regular", Consolas, monospace' };
const colors = [['#343a42', 'Графит'], ['#527eaf', 'Синий'], ['#6b8c72', 'Зелёный'], ['#b98551', 'Охра'], ['#b56d78', 'Розовый'], ['#8a75a6', 'Фиолетовый']];
const defaults = { fontFamily: 'sans', fontSize: 24, color: '#343a42', shape: 'capsule', bold: false, italic: false, underline: false, strike: false, align: 'left' };
const icons = {
  line: '<path d="M4 18c3-2 3-11 7-11s2 10 6 9c2-.5 2-3 3-5"/>',
  text: '<path d="m5 19 7-14 7 14M7.3 14h9.4"/><path d="M4 21h16" opacity=".35"/>',
  undo: '<path d="M9 6 4 11l5 5M4 11h10a5 5 0 0 1 0 10" transform="translate(0 -3)"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z"/>',
  italic: '<path d="M10 4h9M5 20h9M15 4 9 20"/>',
  underline: '<path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/>',
  strike: '<path d="M17 6a6 6 0 0 0-10-1c-2 4 3 5 5 6m-6 7a6 6 0 0 0 11-2M3 12h18"/>',
  left: '<path d="M4 5h16M4 10h10M4 15h16M4 20h10"/>',
  center: '<path d="M4 5h16M7 10h10M4 15h16M7 20h10"/>',
  right: '<path d="M4 5h16M10 10h10M4 15h16M10 20h10"/>',
  capsule: '<rect x="2" y="6" width="20" height="12" rx="6"/>',
  rectangle: '<rect x="3" y="5" width="18" height="14" rx="1"/>',
  square: '<rect x="4" y="4" width="16" height="16"/>',
  none: '<path d="m5 19 14-14"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
$('#line-tool').innerHTML = icon('line');
$('#text-tool').innerHTML = icon('text');
$('#undo-tool').innerHTML = icon('undo');
$('#close-settings').innerHTML = icon('close');

function emptyDocument() { return { nodes: [], strokes: [], connections: [], settings: { ...defaults } }; }
function loadDocument() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey));
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.strokes) || !Array.isArray(data.connections)) return emptyDocument();
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    data.nodes = data.nodes.filter(n => typeof n.id === 'string' && typeof n.text === 'string' && finite(n.x) && finite(n.y)).map(n => ({ ...defaults, ...n, shape: ['none', 'rectangle', 'square', 'capsule'].includes(n.shape) ? n.shape : 'capsule' }));
    data.strokes = data.strokes.filter(s => typeof s.id === 'string' && Array.isArray(s.points) && s.points.length > 1 && s.points.every(p => finite(p.x) && finite(p.y)));
    data.connections = data.connections.filter(c => data.nodes.some(n => n.id === c.from) && data.nodes.some(n => n.id === c.to));
    data.settings = { ...defaults, ...data.settings };
    if (!['none', 'rectangle', 'square', 'capsule'].includes(data.settings.shape)) data.settings.shape = 'capsule';
    return data;
  } catch { return emptyDocument(); }
}

let board = loadDocument();
let selected = new Set();
let selectedStrokes = new Set();
let selectedConnections = new Set();
let mode = 'select';
let editing = null;
let gesture = null;
let spaceHeld = false;
let view = loadView();
let hoverTargetId = null;
let pinch = null;
const activeTouches = new Map();
const minScale = .01;
const maxScale = 4;
let arrangementTimer;
let arrangementFrame;
let arrangementUntil = 0;
let viewPersistTimer;
let guides = [];
let previewPoints = [];
let lastTap = null;
let suppressDoubleClickUntil = 0;
let insertionPoint = { x: innerWidth / 2 - 80, y: innerHeight / 2 - 20 };
let toastTimer;
let persistTimer;
const undoStack = [];
const redoStack = [];
const nodeElements = new Map();
let idCounter = 0;
const id = () => globalThis.crypto?.randomUUID?.() || `item-${Date.now().toString(36)}-${++idCounter}-${Math.random().toString(36).slice(2)}`;
const snapshot = () => JSON.stringify(board);
const nodeById = (value) => board.nodes.find(n => n.id === value);
const point = (event) => ({ x: (event.clientX - view.x) / view.scale, y: (event.clientY - view.y) / view.scale });
const screenPoint = (p) => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y });
const clone = (value) => JSON.parse(JSON.stringify(value));

function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(`${storageKey}:view`));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.scale) && saved.scale >= .01 && saved.scale <= 4) return saved;
  } catch { /* Storage may be unavailable in a downloaded HTML preview. */ }
  return { x: 0, y: 0, scale: 1 };
}
function saveView() {
  clearTimeout(viewPersistTimer);
  try { localStorage.setItem(`${storageKey}:view`, JSON.stringify(view)); } catch { /* File export remains available. */ }
}
function saveViewSoon() { clearTimeout(viewPersistTimer); viewPersistTimer = setTimeout(saveView, 200); }
function remember(before, beforeView = view, includeView = false) {
  if (before === snapshot() && (!includeView || JSON.stringify(beforeView) === JSON.stringify(view))) return;
  if (undoStack.at(-1)?.document !== before || (includeView && JSON.stringify(undoStack.at(-1)?.view) !== JSON.stringify(beforeView))) undoStack.push({ document: before, view: { ...beforeView } });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  updateUndo();
}
function updateUndo() { $('#undo-tool').disabled = !undoStack.length; }
function persist() {
  clearTimeout(persistTimer);
  try { localStorage.setItem(storageKey, snapshot()); }
  catch { notify('Не удалось сохранить полотно в этом браузере.'); }
  saveView();
}
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 200); }
function notify(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}
function restore(entry) {
  app.classList.remove('arranging');
  board = JSON.parse(entry.document);
  view = { ...entry.view };
  selected.clear(); selectedStrokes.clear(); selectedConnections.clear();
  closeContext(); render(); persist();
}
function undo() {
  finishEdit();
  if (!undoStack.length) return;
  redoStack.push({ document: snapshot(), view: { ...view } });
  restore(undoStack.pop()); updateUndo();
}
function redo() {
  finishEdit();
  if (!redoStack.length) return;
  undoStack.push({ document: snapshot(), view: { ...view } });
  restore(redoStack.pop()); updateUndo();
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function renderNodes() {
  const existing = new Set(board.nodes.map(n => n.id));
  for (const [key, element] of nodeElements) {
    if (!existing.has(key)) { element.remove(); nodeElements.delete(key); }
  }
  for (const node of board.nodes) {
    let element = nodeElements.get(node.id);
    if (!element) {
      element = document.createElement('div');
      element.dataset.nodeId = node.id;
      element.tabIndex = 0;
      element.setAttribute('role', 'group');
      const outline = svgElement('svg', { class: 'node-outline', 'aria-hidden': 'true' });
      outline.append(svgElement('path'));
      const content = document.createElement('div');
      content.className = 'node-content';
      content.dataset.placeholder = 'Напишите мысль…';
      content.setAttribute('role', 'textbox');
      content.setAttribute('aria-multiline', 'true');
      content.setAttribute('aria-label', 'Текст мысли');
      content.setAttribute('spellcheck', 'true');
      content.addEventListener('input', syncEditing);
      content.addEventListener('paste', (event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      });
      content.addEventListener('blur', () => {
        // Toolbar controls can take focus before their click handler runs.
        setTimeout(() => {
          if (editing?.id === node.id && !document.activeElement.closest('.floating-ui') && document.activeElement !== content) finishEdit();
        }, 0);
      });
      element.append(outline, content);
      nodesLayer.append(element);
      nodeElements.set(node.id, element);
    }
    const isEditing = editing?.id === node.id;
    element.className = `text-node${node.outlined ? ' outlined' : ''}${selected.has(node.id) ? ' selected' : ''}${isEditing ? ' editing' : ''}${gesture?.type === 'move' && selected.has(node.id) ? ' is-moving' : ''}${hoverTargetId === node.id ? ' drop-target' : ''}`;
    element.setAttribute('aria-label', node.text || 'Новая мысль');
    element.setAttribute('aria-selected', String(selected.has(node.id)));
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.style.fontSize = `${node.fontSize}px`;
    element.style.fontFamily = fonts[node.fontFamily] || fonts.sans;
    element.style.fontWeight = node.bold ? '650' : '400';
    element.style.fontStyle = node.italic ? 'italic' : 'normal';
    element.style.color = node.color;
    element.style.textAlign = node.align;
    const content = element.querySelector('.node-content');
    content.style.textDecoration = [node.underline && 'underline', node.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
    if (content.contentEditable !== String(isEditing)) content.contentEditable = String(isEditing);
    content.tabIndex = isEditing ? 0 : -1;
    if (!isEditing && content.textContent !== node.text) content.textContent = node.text;
    node.width = element.offsetWidth;
    node.height = element.offsetHeight;
    const outline = element.querySelector('.node-outline');
    outline.style.display = node.outlined && node.shape !== 'none' ? '' : 'none';
    outline.querySelector('path').setAttribute('d', outlinePath({ ...node, x: 0, y: 0 }));
  }
  nodesLayer.style.transformOrigin = '0 0';
  nodesLayer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function geometryForConnection(connection) {
  let from = nodeById(connection.from), to = nodeById(connection.to);
  const visual = node => ({ ...displayedNode(node), shape: node.outlined ? node.shape : 'none' });
  if (!from || !to) return null;
  from = visual(from); to = visual(to);
  if (gesture?.type === 'connection-end' && gesture.connectionId === connection.id) {
    const target = nodeById(hoverTargetId);
    const previewNode = target ? { ...target, outlined: true } : { x: gesture.current.x, y: gesture.current.y, width: 0, height: 0, shape: 'none' };
    if (gesture.end === 'from') from = previewNode; else to = previewNode;
  }
  return connectionGeometry(from, to, connection.bend);
}
function displayedNode(node) {
  if (!node || !app.classList.contains('arranging')) return node;
  const element = nodeElements.get(node.id);
  if (!element) return node;
  const rect = element.getBoundingClientRect();
  return { ...node, x: (rect.x - view.x) / view.scale, y: (rect.y - view.y) / view.scale, width: rect.width / view.scale, height: rect.height / view.scale };
}
function stabilizedInView(points) {
  return stabilizeStroke(points.map(p => ({ x: p.x * view.scale, y: p.y * view.scale }))).map(p => ({ x: p.x / view.scale, y: p.y / view.scale }));
}
function renderPaths() {
  const transform = `translate(${view.x} ${view.y}) scale(${view.scale})`;
  const group = svgElement('g', { transform });
  const appendPath = (d, color, kind, key, isSelected, width) => {
    if (isSelected) group.append(svgElement('path', { d, fill: 'none', stroke: '#c9dcef', 'stroke-width': 8, 'stroke-linecap': 'round', 'pointer-events': 'none', 'vector-effect': 'non-scaling-stroke' }));
    const path = svgElement('path', { d, fill: 'none', stroke: color, 'stroke-width': width, class: kind, 'pointer-events': mode === 'draw' ? 'none' : 'stroke', 'vector-effect': 'non-scaling-stroke' });
    path.dataset[kind === 'stroke' ? 'strokeId' : 'connectionId'] = key;
    group.append(path);
  };
  for (const connection of board.connections) {
    const geometry = geometryForConnection(connection);
    if (!geometry) continue;
    appendPath(geometry.path, connection.color, 'connector', connection.id, selectedConnections.has(connection.id), 1.35);
    const hit = svgElement('path', { d: geometry.path, fill: 'none', stroke: 'transparent', 'stroke-width': 16, class: 'connection-hit', 'vector-effect': 'non-scaling-stroke', 'pointer-events': mode === 'draw' ? 'none' : 'stroke' });
    hit.dataset.connectionId = connection.id;
    group.append(hit);
  }
  for (const stroke of board.strokes) appendPath(smoothPath(attachedStrokePoints(stroke, displayedNode(nodeById(stroke.attachment?.nodeId)))), stroke.color, 'stroke', stroke.id, selectedStrokes.has(stroke.id), stroke.width || 2.2);
  if (previewPoints.length) group.append(svgElement('path', { d: smoothPath(stabilizedInView(previewPoints)), fill: 'none', stroke: board.settings.color, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none', 'vector-effect': 'non-scaling-stroke' }));
  drawingLayer.replaceChildren(group);
  const guideGroup = svgElement('g', { transform });
  for (const guide of guides) {
    guideGroup.append(svgElement('path', { d: `M ${guide.x1} ${guide.y1} L ${guide.x2} ${guide.y2}`, class: 'spacing-guide' }));
    for (const [x, y] of [[guide.x1, guide.y1], [guide.x2, guide.y2]]) guideGroup.append(svgElement('path', { d: `M ${x - 3} ${y - 3} L ${x + 3} ${y + 3} M ${x + 3} ${y - 3} L ${x - 3} ${y + 3}`, class: 'spacing-guide' }));
  }
  if (selectedConnections.size === 1 && mode === 'select' && !editing) {
    const connection = board.connections.find(c => selectedConnections.has(c.id));
    const geometry = connection && geometryForConnection(connection);
    if (geometry) {
      for (const [kind, p, label] of [['from', geometry.start, 'Начало связи'], ['bend', geometry.midpoint, 'Изгиб связи'], ['to', geometry.end, 'Конец связи']]) {
        const handle = svgElement('circle', { cx: p.x, cy: p.y, r: (kind === 'bend' ? 5 : 6) / view.scale, class: `connection-handle ${kind === 'bend' ? 'control-handle' : 'endpoint-handle'}`, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'all', tabindex: 0, role: 'button', 'aria-label': label });
        handle.dataset.connectionHandle = kind; handle.dataset.connectionId = connection.id;
        guideGroup.append(handle);
      }
    }
  }
  guidesLayer.replaceChildren(guideGroup);
}
function render() {
  renderNodes(); renderPaths(); syncSettings(); updateUndo();
  $('#empty-state').hidden = !!(board.nodes.length || board.strokes.length || editing || mode === 'draw');
  updateContextualUI();
  $('#zoom-reset').textContent = `${Math.round(view.scale * 100)} %`;
  $('#zoom-out').disabled = view.scale <= minScale;
  $('#zoom-in').disabled = view.scale >= maxScale;
}

function positionPanel(panel, x, y, anchor) {
  const rect = panel.getBoundingClientRect();
  const clamp = p => ({ x: Math.max(12, Math.min(p.x, innerWidth - rect.width - 12)), y: Math.max(84, Math.min(p.y, innerHeight - rect.height - 70)) });
  const obstacles = board.nodes.map(node => {
    const b = outlineBounds(displayedNode(node)), screen = screenPoint(b);
    return { x: screen.x - 5, y: screen.y - 5, width: b.width * view.scale + 10, height: b.height * view.scale + 10 };
  });
  for (const element of document.querySelectorAll('.toolbar, .viewport-controls')) obstacles.push(element.getBoundingClientRect());
  const a = anchor || { x, y: y - 22, width: 0, height: 0 };
  const candidates = [{ x, y }, { x: a.x, y: a.y - rect.height - 13 }, { x: a.x + a.width + 14, y: a.y }, { x: a.x - rect.width - 14, y: a.y }];
  for (let row = 88; row < innerHeight - rect.height - 65; row += rect.height + 16) {
    candidates.push({ x, y: row }, { x: 12, y: row }, { x: innerWidth - rect.width - 12, y: row });
  }
  const free = candidates.map(clamp).find(p => obstacles.every(b => p.x + rect.width <= b.x || p.x >= b.x + b.width || p.y + rect.height <= b.y || p.y >= b.y + b.height));
  const position = free || clamp({ x: 12, y: innerHeight - rect.height - 22 });
  panel.style.left = `${position.x}px`; panel.style.top = `${position.y}px`;
}
function updateContextualUI() {
  const single = selected.size === 1 ? nodeById([...selected][0]) : null;
  const canSplit = !!single && single.text.trim().split(/\s+/u).length > 1;
  const canMerge = selected.size > 1;
  const textActions = $('#selection-actions');
  textActions.hidden = editing || mode !== 'select' || !contextMenu.hidden || !settings.hidden || (!canSplit && !canMerge);
  $('#split-text').hidden = !canSplit; $('#merge-text').hidden = !canMerge;
  if (!textActions.hidden) {
    const selectedNodes = board.nodes.filter(n => selected.has(n.id));
    const bounds = selectedNodes.map(outlineBounds);
    const x = Math.min(...bounds.map(b => b.x)), top = Math.min(...bounds.map(b => b.y)), right = Math.max(...bounds.map(b => b.x + b.width)), y = Math.max(...bounds.map(b => b.y + b.height));
    const screen = screenPoint({ x, y }), corner = screenPoint({ x, y: top });
    positionPanel(textActions, screen.x, screen.y + 15, { x: corner.x, y: corner.y, width: (right - x) * view.scale, height: (y - top) * view.scale });
  }
  const connection = selectedConnections.size === 1 ? board.connections.find(c => selectedConnections.has(c.id)) : null;
  const actions = $('#connection-actions');
  actions.hidden = !connection || mode !== 'select' || !!editing;
  if (!actions.hidden) {
    const geometry = geometryForConnection(connection);
    if (geometry) { const screen = screenPoint(geometry.midpoint); positionPanel(actions, screen.x + 18, screen.y + 22); }
    $('#reset-connection').disabled = !connection.bend || (!connection.bend.x && !connection.bend.y);
  }
}

function clearSelection() { selected.clear(); selectedStrokes.clear(); selectedConnections.clear(); }
function setMode(next) {
  finishEdit();
  cancelGesture();
  mode = next;
  clearSelection(); closeContext();
  settings.hidden = true;
  $('#text-tool').setAttribute('aria-expanded', 'false');
  app.classList.toggle('drawing-mode', mode === 'draw');
  $('#line-tool').classList.toggle('active', mode === 'draw');
  $('#line-tool').setAttribute('aria-pressed', String(mode === 'draw'));
  $('#mode-indicator').hidden = mode !== 'draw';
  render();
}

function createNode(x, y, text = '') {
  finishEdit();
  const before = snapshot();
  const node = { ...board.settings, id: id(), x: x - 12, y: y - 18, text, width: 40, height: 50, outlined: false };
  board.nodes.push(node);
  beginEdit(node, before);
}
function beginEdit(node, before = snapshot()) {
  finishEdit();
  closeContext();
  clearSelection(); selected.add(node.id);
  editing = { id: node.id, before };
  render();
  const content = nodeElements.get(node.id).querySelector('.node-content');
  content.textContent = node.text;
  content.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(content); range.collapse(false);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  syncEditing();
}

function editAt(clientX, clientY) {
  if (mode === 'draw') setMode('select');
  const element = document.elementFromPoint(clientX, clientY)?.closest('.text-node');
  if (element) {
    if (editing?.id !== element.dataset.nodeId) beginEdit(nodeById(element.dataset.nodeId));
  } else {
    const p = point({ clientX, clientY });
    createNode(p.x, p.y);
  }
}

function activateTouchText(event, isTap) {
  if (event.pointerType === 'mouse' || !isTap || spaceHeld) { lastTap = null; return; }
  const now = performance.now();
  if (lastTap && now - lastTap.time < 420 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 24) {
    event.preventDefault();
    lastTap = null;
    suppressDoubleClickUntil = now + 650;
    editAt(event.clientX, event.clientY);
  } else lastTap = { x: event.clientX, y: event.clientY, time: now };
}
function syncEditing() {
  if (!editing) return;
  const node = nodeById(editing.id);
  const content = nodeElements.get(node.id).querySelector('.node-content');
  node.text = content.innerText.replace(/\r/g, '');
  node.width = nodeElements.get(node.id).offsetWidth;
  node.height = nodeElements.get(node.id).offsetHeight;
  renderNodes(); renderPaths(); persistSoon();
}
function finishEdit(commit = true) {
  if (!editing) return;
  const session = editing;
  if (commit) syncEditing();
  editing = null;
  if (!commit) {
    board = JSON.parse(session.before);
    clearSelection();
  } else {
    const node = nodeById(session.id);
    if (node && !node.text.trim()) {
      board.nodes = board.nodes.filter(n => n.id !== node.id);
      board.connections = board.connections.filter(c => c.from !== node.id && c.to !== node.id);
      selected.delete(node.id);
    } else if (node) { guides = []; keepApart(node); guides = []; }
    remember(session.before);
  }
  window.getSelection()?.removeAllRanges();
  render(); persist();
}

function keepApart(node) {
  if (!node) return;
  const result = repelNodes(board.nodes, selected.has(node.id) ? selected : [node.id], 18);
  let changed = false;
  for (const target of result.nodes) {
    const existing = nodeById(target.id);
    if (existing.x !== target.x || existing.y !== target.y) changed = true;
    existing.x = target.x; existing.y = target.y;
  }
  guides = result.guides;
  if (changed) {
    app.classList.add('arranging'); clearTimeout(arrangementTimer);
    arrangementUntil = performance.now() + 210;
    if (!arrangementFrame) arrangementFrame = requestAnimationFrame(animateArrangement);
    arrangementTimer = setTimeout(() => { app.classList.remove('arranging'); renderPaths(); }, 230);
  }
}
function animateArrangement() {
  renderPaths();
  arrangementFrame = performance.now() < arrangementUntil ? requestAnimationFrame(animateArrangement) : null;
}

function changeStyle(patch) {
  finishEdit();
  const before = snapshot();
  Object.assign(board.settings, patch);
  for (const node of board.nodes) {
    if (!selected.has(node.id)) continue;
    Object.assign(node, patch);
    if ('shape' in patch) node.outlined = patch.shape !== 'none';
  }
  if (patch.color) {
    for (const stroke of board.strokes) if (selectedStrokes.has(stroke.id)) stroke.color = patch.color;
    for (const connection of board.connections) if (selectedConnections.has(connection.id)) connection.color = patch.color;
  }
  renderNodes();
  guides = [];
  keepApart(board.nodes.find(node => selected.has(node.id)));
  guides = [];
  remember(before); render(); persist();
}
function currentStyle() { return nodeById([...selected][0]) || board.settings; }
function buttonFor(name, label, action, className = 'tool-button') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className;
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label); button.title = label;
  button.addEventListener('click', action);
  return button;
}
const formatButtons = [];
for (const [key, label] of [['bold', 'Полужирный'], ['italic', 'Курсив'], ['underline', 'Подчёркнутый'], ['strike', 'Зачёркнутый']]) {
  const button = buttonFor(key, label, () => changeStyle({ [key]: !currentStyle()[key] }), 'icon-option');
  $('#format-options').append(button); formatButtons.push([button, key]);
}
const colorButtons = [];
for (const [color, label] of colors) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'color-swatch';
  button.style.setProperty('--swatch', color); button.style.backgroundColor = color;
  button.setAttribute('aria-label', label); button.title = label;
  button.addEventListener('click', () => changeStyle({ color }));
  $('#color-options').append(button); colorButtons.push([button, color]);
}
const shapeButtons = [];
for (const [shape, label] of [['none', 'Без обводки'], ['rectangle', 'Прямоугольник'], ['square', 'Квадрат'], ['capsule', 'Капсула']]) {
  const button = buttonFor(shape, label, () => changeStyle({ shape }), 'shape-option');
  $('#shape-options').append(button); shapeButtons.push([button, shape]);
}
function syncSettings() {
  const style = currentStyle();
  if (document.activeElement !== $('#font-family')) $('#font-family').value = style.fontFamily;
  if (document.activeElement !== $('#font-size')) $('#font-size').value = style.fontSize;
  for (const [button, key] of formatButtons) { button.classList.toggle('selected', !!style[key]); button.setAttribute('aria-pressed', String(!!style[key])); }
  for (const [button, color] of colorButtons) { button.classList.toggle('selected', style.color === color); button.setAttribute('aria-pressed', String(style.color === color)); }
  for (const [button, shape] of shapeButtons) { button.classList.toggle('selected', style.shape === shape); button.setAttribute('aria-pressed', String(style.shape === shape)); }
  contextMenu.querySelectorAll('[data-format]').forEach(button => {
    const key = button.dataset.format;
    const active = ['left', 'center', 'right'].includes(key) ? style.align === key : !!style[key];
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
function closeContext() { contextMenu.hidden = true; }
function openContext(x, y) {
  $('#selection-actions').hidden = true;
  contextMenu.replaceChildren();
  for (const [key, label] of [['bold', 'Полужирный'], ['italic', 'Курсив'], ['underline', 'Подчёркнутый'], ['strike', 'Зачёркнутый']]) {
    const button = buttonFor(key, label, () => changeStyle({ [key]: !currentStyle()[key] }));
    button.dataset.format = key; contextMenu.append(button);
  }
  const separator = document.createElement('span'); separator.className = 'toolbar-divider'; contextMenu.append(separator);
  for (const [align, label] of [['left', 'По левому краю'], ['center', 'По центру'], ['right', 'По правому краю']]) {
    const button = buttonFor(align, label, () => changeStyle({ align }));
    button.dataset.format = align; contextMenu.append(button);
  }
  const input = document.createElement('input');
  input.type = 'number'; input.min = 12; input.max = 96;
  input.className = 'font-size-input'; input.value = currentStyle().fontSize;
  input.setAttribute('aria-label', 'Размер шрифта');
  input.addEventListener('change', () => { changeStyle({ fontSize: Math.min(96, Math.max(12, Number(input.value) || 24)) }); input.value = currentStyle().fontSize; });
  contextMenu.append(input);
  const ink = document.createElement('input');
  ink.type = 'color'; ink.value = currentStyle().color; ink.setAttribute('aria-label', 'Цвет текста');
  ink.addEventListener('input', () => changeStyle({ color: ink.value }));
  contextMenu.append(ink);
  contextMenu.append(buttonFor('trash', 'Удалить', deleteSelected));
  contextMenu.hidden = false;
  const rect = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(12, Math.min(x, innerWidth - rect.width - 12))}px`;
  contextMenu.style.top = `${Math.max(84, Math.min(y, innerHeight - rect.height - 12))}px`;
  syncSettings();
}
function deleteSelected() {
  if (!selected.size && !selectedStrokes.size && !selectedConnections.size) return;
  finishEdit();
  const before = snapshot();
  board.nodes = board.nodes.filter(n => !selected.has(n.id));
  board.strokes = board.strokes.filter(s => !selectedStrokes.has(s.id) && !selected.has(s.attachment?.nodeId));
  board.connections = board.connections.filter(c => !selectedConnections.has(c.id) && !selected.has(c.from) && !selected.has(c.to));
  clearSelection(); closeContext(); remember(before); render(); persist();
}

$('#line-tool').addEventListener('click', () => setMode(mode === 'draw' ? 'select' : 'draw'));
$('#start-typing').addEventListener('click', () => {
  if (mode === 'draw') setMode('select');
  createNode(innerWidth / 2 - 70 - view.x, innerHeight / 2 - 20 - view.y);
});
$('#undo-tool').addEventListener('click', undo);
$('#text-tool').addEventListener('click', () => {
  finishEdit();
  closeContext();
  settings.hidden = !settings.hidden;
  $('#text-tool').setAttribute('aria-expanded', String(!settings.hidden));
  syncSettings(); updateContextualUI();
});
$('#close-settings').addEventListener('click', () => { settings.hidden = true; $('#text-tool').setAttribute('aria-expanded', 'false'); updateContextualUI(); });
$('#font-family').addEventListener('change', event => changeStyle({ fontFamily: event.target.value }));
$('#font-size').addEventListener('change', event => {
  const fontSize = Math.min(96, Math.max(12, Number(event.target.value) || 24));
  changeStyle({ fontSize }); event.target.value = fontSize;
});

function measureText(text, style) {
  const element = document.createElement('div');
  element.className = 'text-node';
  Object.assign(element.style, { left: '-10000px', top: '-10000px', fontFamily: fonts[style.fontFamily] || fonts.sans, fontSize: `${style.fontSize}px`, fontWeight: style.bold ? '650' : '400', fontStyle: style.italic ? 'italic' : 'normal' });
  const content = document.createElement('div'); content.className = 'node-content'; content.textContent = text;
  element.append(content); nodesLayer.append(element);
  const dimensions = { width: element.offsetWidth, height: element.offsetHeight };
  element.remove(); return dimensions;
}
function transformWords(operation) {
  finishEdit();
  const before = snapshot();
  try {
    const result = operation();
    board = result.board; clearSelection(); selected = new Set(result.selectedIds);
    closeContext(); renderNodes(); keepApart(board.nodes.find(n => selected.has(n.id))); guides = [];
    remember(before); render(); persist();
  } catch (error) { notify(error.message); }
}
function splitSelected() {
  if (selected.size !== 1) return;
  transformWords(() => splitNode(board, [...selected][0], measureText, id));
}
function mergeSelected() {
  if (selected.size < 2) return;
  transformWords(() => mergeNodes(board, [...selected], measureText, id));
}
$('#split-text').addEventListener('click', splitSelected);
$('#merge-text').addEventListener('click', mergeSelected);
$('#reset-connection').addEventListener('click', () => {
  const before = snapshot();
  for (const connection of board.connections) if (selectedConnections.has(connection.id)) delete connection.bend;
  remember(before); render(); persist();
});
$('#delete-connection').addEventListener('click', deleteSelected);

function saveBoardFile() {
  finishEdit();
  try {
    const blob = new Blob([serializeBoard(board, view)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'Полотно.polotno';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Доска сохранена в файл.');
  } catch (error) { notify(`Не удалось сохранить доску: ${error.message}`); }
}
$('#save-board').addEventListener('click', saveBoardFile);
$('#open-board').addEventListener('click', () => $('#board-file').click());
$('#board-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Максимальный размер файла — 5 МБ.');
    const imported = parseBoard(await file.text());
    setMode('select');
    const before = snapshot(), beforeView = { ...view };
    board = imported.board;
    view = { ...imported.view, scale: Math.min(maxScale, Math.max(minScale, imported.view.scale)) };
    clearSelection(); hoverTargetId = null; closeContext();
    settings.hidden = true; $('#text-tool').setAttribute('aria-expanded', 'false');
    remember(before, beforeView, true); render(); persist();
    notify('Доска открыта. Предыдущее состояние можно вернуть кнопкой отмены.');
  } catch (error) { notify(`Не удалось открыть доску: ${error.message}`); }
  finally { event.target.value = ''; }
});

function applyViewport() {
  nodesLayer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  renderPaths(); closeContext(); updateContextualUI();
  $('#zoom-reset').textContent = `${Math.round(view.scale * 100)} %`;
  $('#zoom-out').disabled = view.scale <= minScale;
  $('#zoom-in').disabled = view.scale >= maxScale;
  saveViewSoon();
}
function zoomAt(scale, clientX = innerWidth / 2, clientY = innerHeight / 2) {
  const anchor = point({ clientX, clientY });
  view.scale = Math.min(maxScale, Math.max(minScale, scale));
  view.x = clientX - anchor.x * view.scale; view.y = clientY - anchor.y * view.scale;
  applyViewport();
}
function fitBoard() {
  finishEdit();
  const points = [];
  for (const node of board.nodes) {
    const b = outlineBounds(node); points.push({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
  }
  for (const stroke of board.strokes) for (const p of attachedStrokePoints(stroke, nodeById(stroke.attachment?.nodeId))) points.push(p);
  for (const connection of board.connections) {
    const from = nodeById(connection.from), to = nodeById(connection.to);
    if (from && to) points.push(connectionGeometry({ ...from, shape: from.outlined ? from.shape : 'none' }, { ...to, shape: to.outlined ? to.shape : 'none' }, connection.bend).control);
  }
  if (!points.length) { view = { x: 0, y: 0, scale: 1 }; applyViewport(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const availableWidth = Math.max(150, innerWidth - 100), availableHeight = Math.max(100, innerHeight - 210);
  view.scale = Math.min(1.5, Math.max(minScale, Math.min(availableWidth / Math.max(100, maxX - minX), availableHeight / Math.max(80, maxY - minY))));
  view.x = innerWidth / 2 - (minX + maxX) / 2 * view.scale;
  view.y = (innerHeight + 40) / 2 - (minY + maxY) / 2 * view.scale;
  applyViewport();
}
$('#zoom-in').addEventListener('click', () => zoomAt(view.scale * 1.2));
$('#zoom-out').addEventListener('click', () => zoomAt(view.scale / 1.2));
$('#zoom-reset').addEventListener('click', () => zoomAt(1));
$('#fit-board').addEventListener('click', fitBoard);

function nearNode(p, padding = 22 / view.scale) {
  return board.nodes.map(n => ({ node: n, visible: displayedNode(n) })).filter(({ visible: n }) => p.x >= n.x - padding && p.x <= n.x + n.width + padding && p.y >= n.y - padding && p.y <= n.y + n.height + padding)
    .sort(({ visible: a }, { visible: b }) => Math.hypot(p.x - a.x - a.width / 2, p.y - a.y - a.height / 2) - Math.hypot(p.x - b.x - b.width / 2, p.y - b.y - b.height / 2))[0]?.node;
}
function finishStroke(points) {
  if (points.length < 2 || pathLength(points) * view.scale < 5) return;
  const before = snapshot();
  const targets = detectStrokeTargets(points, board.nodes);
  const start = nearNode(points[0]);
  const end = nearNode(points.at(-1));
  // Starting/ending at a word makes connecting words possible without crossing the letters.
  if (start && end && start.id !== end.id) {
    if (!targets.includes(start.id)) targets.unshift(start.id);
    if (!targets.includes(end.id)) targets.push(end.id);
  }
  if (targets.length) {
    for (const target of targets) {
      const node = nodeById(target);
      node.outlined = node.shape !== 'none';
    }
    if (targets.length === 1) {
      const node = nodeById(targets[0]);
      const extendsOutside = points.some(p => p.x < node.x - 40 || p.x > node.x + node.width + 40 || p.y < node.y - 40 || p.y > node.y + node.height + 40);
      const isLoop = Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 28 && pathLength(points) > node.width + node.height;
      if (extendsOutside && !isLoop) board.strokes.push({
        id: id(), points, color: board.settings.color, width: 1.35,
        attachment: { nodeId: node.id, origin: { x: node.x + node.width / 2, y: node.y + node.height / 2 } },
      });
    }
    const ordered = targets.map(key => nodeById(key)).sort((a, b) => {
      const firstHit = (n) => points.findIndex(p => p.x > n.x - 25 && p.x < n.x + n.width + 25 && p.y > n.y - 25 && p.y < n.y + n.height + 25);
      return firstHit(a) - firstHit(b);
    });
    for (let i = 1; i < ordered.length; i++) {
      const from = ordered[i - 1].id, to = ordered[i].id;
      if (!board.connections.some(c => (c.from === from && c.to === to) || (c.from === to && c.to === from))) {
        board.connections.push({ id: id(), from, to, color: board.settings.color });
      }
    }
  } else board.strokes.push({ id: id(), points, color: board.settings.color, width: 2.2 });
  remember(before); render(); persist();
}

function cancelGesture() {
  if (gesture?.before && gesture.moved) board = JSON.parse(gesture.before);
  gesture = null; previewPoints = []; guides = []; hoverTargetId = null;
  $('#selection-rect').hidden = true;
  app.classList.remove('panning');
  render();
}
app.addEventListener('pointerdown', event => {
  if (event.target.closest('.floating-ui')) return;
  if (event.button === 2) return;
  if (event.pointerType === 'touch') {
    activeTouches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (activeTouches.size >= 2) {
      finishEdit(); cancelGesture(); lastTap = null;
      const [a, b] = [...activeTouches.values()];
      const center = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
      pinch = { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), scale: view.scale, anchor: point(center) };
      app.setPointerCapture(event.pointerId); app.classList.add('panning'); event.preventDefault(); return;
    }
  }
  const handle = event.target.closest('[data-connection-handle]');
  if (handle && event.button === 0) {
    event.preventDefault(); finishEdit(); closeContext();
    const connection = board.connections.find(c => c.id === handle.dataset.connectionId);
    if (!connection) return;
    const p = point(event), geometry = geometryForConnection(connection);
    clearSelection(); selectedConnections.add(connection.id);
    gesture = { type: handle.dataset.connectionHandle === 'bend' ? 'connection-bend' : 'connection-end', end: handle.dataset.connectionHandle, pointerId: event.pointerId, connectionId: connection.id, start: p, current: p, before: snapshot(), moved: false, bend: { ...connection.bend || { x: 0, y: 0 } }, initialMidpoint: geometry.midpoint };
    app.setPointerCapture(event.pointerId); app.focus({ preventScroll: true }); render(); return;
  }
  if (editing && event.target.closest('.text-node')?.dataset.nodeId === editing.id && mode !== 'draw' && !spaceHeld) return;
  finishEdit(); closeContext();
  settings.hidden = true; $('#text-tool').setAttribute('aria-expanded', 'false');
  if (event.button === 1 || (spaceHeld && event.button === 0)) {
    event.preventDefault();
    gesture = { type: 'pan', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, view: { ...view } };
    app.classList.add('panning'); app.setPointerCapture(event.pointerId); return;
  }
  if (event.button !== 0) return;
  const p = point(event);
  insertionPoint = p;
  app.focus({ preventScroll: true });
  if (mode === 'draw') {
    event.preventDefault();
    gesture = { type: 'draw', pointerId: event.pointerId };
    previewPoints = [p]; app.setPointerCapture(event.pointerId); renderPaths(); return;
  }
  const nodeElement = event.target.closest('.text-node');
  const strokeElement = event.target.closest('[data-stroke-id]');
  const connectionElement = event.target.closest('[data-connection-id]');
  if (nodeElement) {
    event.preventDefault();
    const key = nodeElement.dataset.nodeId;
    if (event.shiftKey) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
    } else if (!selected.has(key)) { clearSelection(); selected.add(key); }
    gesture = { type: 'move', pointerId: event.pointerId, start: p, before: snapshot(), moved: false, positions: board.nodes.filter(n => selected.has(n.id)).map(n => ({ id: n.id, x: n.x, y: n.y })) };
  } else if (strokeElement) {
    event.preventDefault();
    const key = strokeElement.dataset.strokeId;
    if (!event.shiftKey) clearSelection();
    selectedStrokes.add(key);
    gesture = { type: 'move-stroke', pointerId: event.pointerId, start: p, before: snapshot(), moved: false, strokes: board.strokes.filter(s => selectedStrokes.has(s.id)).map(clone) };
  } else if (connectionElement) {
    if (!event.shiftKey) clearSelection();
    selectedConnections.add(connectionElement.dataset.connectionId);
  } else {
    if (!event.shiftKey) clearSelection();
    gesture = { type: 'select', pointerId: event.pointerId, start: p, initial: [...selected], client: { x: event.clientX, y: event.clientY } };
  }
  if (gesture) app.setPointerCapture(event.pointerId);
  render();
});

app.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' && activeTouches.has(event.pointerId)) activeTouches.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
  if (pinch && activeTouches.size >= 2) {
    const [a, b] = [...activeTouches.values()];
    view.scale = Math.min(maxScale, Math.max(minScale, pinch.scale * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.distance));
    view.x = (a.clientX + b.clientX) / 2 - pinch.anchor.x * view.scale;
    view.y = (a.clientY + b.clientY) / 2 - pinch.anchor.y * view.scale;
    applyViewport(); return;
  }
  if (!event.target.closest('.floating-ui') && !gesture) insertionPoint = point(event);
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const p = point(event);
  if (gesture.type === 'pan') {
    view = { ...gesture.view, x: gesture.view.x + event.clientX - gesture.clientX, y: gesture.view.y + event.clientY - gesture.clientY };
    applyViewport(); return;
  }
  if (gesture.type === 'connection-bend' || gesture.type === 'connection-end') {
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) * view.scale < 2) return;
    gesture.moved = true; gesture.current = p;
    const connection = board.connections.find(c => c.id === gesture.connectionId);
    if (gesture.type === 'connection-bend') {
      connection.bend = { x: gesture.bend.x + dx * 2, y: gesture.bend.y + dy * 2 };
      const target = { x: gesture.initialMidpoint.x + dx, y: gesture.initialMidpoint.y + dy };
      for (let i = 0; i < 4; i++) {
        const geometry = geometryForConnection(connection);
        connection.bend.x += 2 * (target.x - geometry.midpoint.x);
        connection.bend.y += 2 * (target.y - geometry.midpoint.y);
      }
    } else {
      const target = nearNode(p);
      const other = connection[gesture.end === 'from' ? 'to' : 'from'];
      hoverTargetId = target && target.id !== other ? target.id : null;
      renderNodes();
    }
    renderPaths(); updateContextualUI(); return;
  }
  if (gesture.type === 'draw') {
    const samples = event.getCoalescedEvents?.() || [event];
    for (const sample of samples.length ? samples : [event]) {
      const next = point(sample), last = previewPoints.at(-1);
      if (Math.hypot(next.x - last.x, next.y - last.y) * view.scale >= 1.4) previewPoints.push(next);
    }
    renderPaths(); return;
  }
  if (gesture.type === 'move' || gesture.type === 'move-stroke') {
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) * view.scale < 3) return;
    gesture.moved = true; guides = [];
    if (gesture.type === 'move') {
      for (const original of gesture.positions) {
        const node = nodeById(original.id);
        node.x = original.x + dx; node.y = original.y + dy;
      }
      keepApart(nodeById(gesture.positions[0]?.id));
      renderNodes();
    } else {
      for (const original of gesture.strokes) {
        const stroke = board.strokes.find(s => s.id === original.id);
        const originalPoints = attachedStrokePoints(original, nodeById(original.attachment?.nodeId));
        stroke.points = originalPoints.map(value => ({ x: value.x + dx, y: value.y + dy }));
        delete stroke.attachment;
      }
    }
    renderPaths(); updateContextualUI();
  } else if (gesture.type === 'select') {
    const x = Math.min(p.x, gesture.start.x), y = Math.min(p.y, gesture.start.y);
    const width = Math.abs(p.x - gesture.start.x), height = Math.abs(p.y - gesture.start.y);
    if (width + height < 5) return;
    gesture.dragged = true;
    const rect = $('#selection-rect'); rect.hidden = false;
    Object.assign(rect.style, { left: `${x * view.scale + view.x}px`, top: `${y * view.scale + view.y}px`, width: `${width * view.scale}px`, height: `${height * view.scale}px` });
    selected = new Set(gesture.initial);
    for (const node of board.nodes) if (node.x < x + width && node.x + node.width > x && node.y < y + height && node.y + node.height > y) selected.add(node.id);
    renderNodes(); syncSettings(); updateContextualUI();
  }
});
app.addEventListener('pointerup', event => {
  activeTouches.delete(event.pointerId);
  if (pinch) {
    if (activeTouches.size < 2) { pinch = null; app.classList.remove('panning'); saveView(); }
    if (app.hasPointerCapture(event.pointerId)) app.releasePointerCapture(event.pointerId);
    return;
  }
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const ended = gesture; gesture = null;
  if (app.hasPointerCapture(event.pointerId)) app.releasePointerCapture(event.pointerId);
  if (ended.type === 'draw') {
    const points = stabilizedInView([...previewPoints, point(event)]); previewPoints = []; finishStroke(points);
    activateTouchText(event, pathLength(points) < 5);
  } else if (ended.type === 'connection-end' && ended.moved) {
    const connection = board.connections.find(c => c.id === ended.connectionId);
    const other = connection[ended.end === 'from' ? 'to' : 'from'];
    const duplicate = board.connections.some(c => c.id !== connection.id && ((c.from === hoverTargetId && c.to === other) || (c.to === hoverTargetId && c.from === other)));
    if (hoverTargetId && !duplicate) {
      connection[ended.end] = hoverTargetId;
      const node = nodeById(hoverTargetId); node.outlined = node.shape !== 'none';
      remember(ended.before); persist();
    } else {
      board = JSON.parse(ended.before);
      if (duplicate) notify('Эти слова уже соединены.');
    }
  } else if (ended.moved && ended.before) { remember(ended.before); persist(); }
  else activateTouchText(event, ['select', 'move'].includes(ended.type) && !ended.dragged);
  hoverTargetId = null; guides = []; $('#selection-rect').hidden = true; app.classList.remove('panning'); render();
});
app.addEventListener('pointercancel', event => { activeTouches.delete(event.pointerId); pinch = null; cancelGesture(); });
app.addEventListener('lostpointercapture', () => { if (gesture) cancelGesture(); });
app.addEventListener('dblclick', event => {
  if (event.button !== 0 || spaceHeld || event.target.closest('.floating-ui') || performance.now() < suppressDoubleClickUntil) return;
  event.preventDefault();
  // Hit-testing also handles browsers that route captured clicks to the board.
  editAt(event.clientX, event.clientY);
});
app.addEventListener('contextmenu', event => {
  if (event.target.closest('.floating-ui')) return;
  event.preventDefault();
  if (mode === 'draw') return;
  const element = event.target.closest('.text-node');
  if (element && !selected.has(element.dataset.nodeId)) { finishEdit(); clearSelection(); selected.add(element.dataset.nodeId); }
  if (selected.size) { renderNodes(); openContext(event.clientX, event.clientY); }
});
app.addEventListener('wheel', event => {
  if (event.target.closest('.floating-ui')) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault(); if (gesture) cancelGesture();
    zoomAt(view.scale * Math.exp(-event.deltaY * .002), event.clientX, event.clientY); return;
  }
  if (editing) return;
  event.preventDefault();
  view.x -= event.deltaX; view.y -= event.deltaY;
  applyViewport();
}, { passive: false });

document.addEventListener('keydown', event => {
  const formInput = event.target.closest('input, select, textarea');
  const modifier = event.metaKey || event.ctrlKey;
  if (!formInput && modifier && event.key.toLowerCase() === 's') { event.preventDefault(); saveBoardFile(); return; }
  if (!formInput && modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); $('#board-file').click(); return; }
  if (!formInput && modifier && ['+', '=', '-', '_', '0'].includes(event.key)) {
    event.preventDefault(); zoomAt(event.key === '0' ? 1 : view.scale * (['+', '='].includes(event.key) ? 1.2 : 1 / 1.2)); return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (editing) { finishEdit(); return; }
    if (gesture) { cancelGesture(); if (mode === 'draw') setMode('select'); return; }
    closeContext(); settings.hidden = true; $('#text-tool').setAttribute('aria-expanded', 'false');
    if (mode === 'draw') setMode('select'); else { clearSelection(); render(); }
    return;
  }
  if (formInput) return;
  if (editing) {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEdit(); }
    if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const key = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
      const node = nodeById(editing.id); node[key] = !node[key]; renderNodes();
    }
    return;
  }
  if (event.target.closest('button') && [' ', 'Enter'].includes(event.key)) return;
  if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  else if (modifier && event.key.toLowerCase() === 'g') { event.preventDefault(); event.shiftKey ? splitSelected() : mergeSelected(); }
  else if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); selected = new Set(board.nodes.map(n => n.id)); render(); }
  else if (['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); deleteSelected(); }
  else if (event.key === ' ' && !event.repeat) { event.preventDefault(); spaceHeld = true; app.classList.add('panning'); }
  else if (event.key.toLowerCase() === 'l' && !modifier && event.altKey) { event.preventDefault(); setMode(mode === 'draw' ? 'select' : 'draw'); }
  else if (event.key === 'Enter' && selected.size === 1) { event.preventDefault(); beginEdit(nodeById([...selected][0])); }
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selected.size) {
    event.preventDefault(); const before = snapshot(), step = event.shiftKey ? 10 : 1;
    for (const node of board.nodes) if (selected.has(node.id)) { node.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0; node.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0; }
    guides = []; keepApart(board.nodes.find(node => selected.has(node.id))); guides = [];
    remember(before); render(); persist();
  }
  else if (event.key === 'Home') { event.preventDefault(); fitBoard(); }
  else if (event.key.length === 1 && !modifier && !event.altKey && !event.isComposing) {
    event.preventDefault();
    const selectedNode = selected.size === 1 ? nodeById([...selected][0]) : null;
    if (mode === 'draw') setMode('select');
    if (selectedNode) {
      beginEdit(selectedNode);
      document.execCommand('insertText', false, event.key);
    } else createNode(insertionPoint.x, insertionPoint.y, event.key);
  }
});
document.addEventListener('keyup', event => { if (event.key === ' ') { spaceHeld = false; if (gesture?.type !== 'pan') app.classList.remove('panning'); } });
window.addEventListener('blur', () => { spaceHeld = false; activeTouches.clear(); pinch = null; if (gesture) cancelGesture(); app.classList.remove('panning'); });
window.addEventListener('pagehide', () => { finishEdit(); persist(); });
window.addEventListener('resize', () => { closeContext(); render(); });

render();
