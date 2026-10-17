export const BOARD_FORMAT = 'polotno';

const VERSION = 1;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_NODES = 1500;
const MAX_LINES = 5000;
const MAX_POINTS = 200000;
const DEFAULT_STYLE = {
  fontFamily: 'sans', fontSize: 24, color: '#343a42', shape: 'capsule',
  bold: false, italic: false, underline: false, strike: false, align: 'left',
};
const DEFAULT_VIEW = { x: 0, y: 0, scale: 1 };
const fail = (message) => { throw new Error(message); };
const own = (object, key) => Object.hasOwn(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function number(value, label, { minimum = -1e8, maximum = 1e8, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`Некорректное значение: ${label}.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(`Некорректный идентификатор: ${label}.`);
  return value;
}

function color(value, fallback = DEFAULT_STYLE.color) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    fail('Некорректный цвет в файле полотна.');
  }
  return value;
}

function style(value = {}, fallback = DEFAULT_STYLE) {
  if (!record(value)) fail('Некорректные настройки текста.');
  const result = {};
  for (const [key, allowed] of [
    ['fontFamily', ['sans', 'serif', 'mono']],
    ['align', ['left', 'center', 'right']],
  ]) {
    result[key] = value[key] === undefined ? fallback[key] : value[key];
    if (!allowed.includes(result[key])) fail(`Неизвестная настройка текста: ${key}.`);
  }
  const shape = value.shape === undefined ? fallback.shape : value.shape;
  result.shape = ['ellipse', 'triangle'].includes(shape) ? 'capsule' : shape;
  if (!['capsule', 'rectangle', 'square', 'none'].includes(result.shape)) fail('Неизвестная форма обрамления.');
  result.fontSize = number(value.fontSize, 'размер шрифта', { minimum: 8, maximum: 256, fallback: fallback.fontSize });
  result.color = color(value.color, fallback.color);
  for (const key of ['bold', 'italic', 'underline', 'strike']) {
    result[key] = value[key] === undefined ? fallback[key] : value[key];
    if (typeof result[key] !== 'boolean') fail('Некорректное начертание текста.');
  }
  return result;
}

function point(value, label) {
  if (!record(value)) fail(`Некорректные координаты: ${label}.`);
  return { x: number(value.x, `${label}, X`), y: number(value.y, `${label}, Y`) };
}

function normalizeBoard(value) {
  if (!record(value) || !Array.isArray(value.nodes) || !Array.isArray(value.strokes) || !Array.isArray(value.connections)) {
    fail('В файле нет корректного полотна: нужны слова, линии и связи.');
  }
  if (value.nodes.length > MAX_NODES) fail(`В полотне слишком много слов: максимум ${MAX_NODES}.`);
  if (value.strokes.length + value.connections.length > MAX_LINES) fail(`В полотне слишком много линий: максимум ${MAX_LINES}.`);
  const settings = style(value.settings === undefined ? {} : value.settings);
  const ids = new Set();
  const claim = (value, label) => {
    const id = identifier(value, label);
    if (ids.has(id)) fail('В файле повторяются идентификаторы объектов.');
    ids.add(id);
    return id;
  };
  const nodes = value.nodes.map((node) => {
    if (!record(node) || typeof node.text !== 'string' || node.text.length > 20000) {
      fail('Некорректный текст: каждая мысль должна содержать не более 20 000 символов.');
    }
    if (node.outlined !== undefined && typeof node.outlined !== 'boolean') fail('Некорректное обрамление слова.');
    return {
      ...style(node, settings), id: claim(node.id, 'слово'), text: node.text,
      ...point(node, 'слово'),
      width: number(node.width, 'ширина слова', { minimum: 1, maximum: 1e6, fallback: 40 }),
      height: number(node.height, 'высота слова', { minimum: 1, maximum: 1e6, fallback: 50 }),
      outlined: node.outlined ?? false,
    };
  });
  const nodeIds = new Set(nodes.map(node => node.id));
  const endpoint = (value) => {
    const id = identifier(value, 'связь со словом');
    if (!nodeIds.has(id)) fail('Линия ссылается на слово, которого нет в полотне.');
    return id;
  };
  let totalPoints = 0;
  const strokes = value.strokes.map((stroke) => {
    if (!record(stroke) || !Array.isArray(stroke.points) || stroke.points.length < 2) fail('Некорректная нарисованная линия.');
    totalPoints += stroke.points.length;
    if (totalPoints > MAX_POINTS) fail('В файле слишком много точек рисования.');
    const result = {
      id: claim(stroke.id, 'линия'), points: stroke.points.map(value => point(value, 'точка линии')),
      color: color(stroke.color),
      width: number(stroke.width, 'толщина линии', { minimum: 0.1, maximum: 100, fallback: 2.2 }),
    };
    if (stroke.attachment !== undefined) {
      if (!record(stroke.attachment)) fail('Некорректное прикрепление линии.');
      result.attachment = {
        nodeId: endpoint(stroke.attachment.nodeId), origin: point(stroke.attachment.origin, 'прикрепление линии'),
      };
    }
    return result;
  });
  const connections = value.connections.map((connection) => {
    if (!record(connection)) fail('Некорректная связь между словами.');
    const result = {
      id: claim(connection.id, 'связь'), from: endpoint(connection.from), to: endpoint(connection.to), color: color(connection.color),
    };
    if (result.from === result.to) fail('Связь должна соединять два разных слова.');
    if (connection.bend !== undefined) result.bend = point(connection.bend, 'изгиб связи');
    return result;
  });
  return { nodes, strokes, connections, settings };
}

function normalizeView(value = DEFAULT_VIEW) {
  if (!record(value)) fail('Некорректный масштаб полотна.');
  return {
    x: number(value.x, 'положение полотна X', { fallback: 0 }),
    y: number(value.y, 'положение полотна Y', { fallback: 0 }),
    scale: number(value.scale, 'масштаб полотна', { minimum: 0.01, maximum: 100, fallback: 1 }),
  };
}

function checkSize(text) {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) fail('Файл слишком большой. Максимальный размер — 5 МБ.');
}

/** Export a validated, portable document without transient DOM or selection data. */
export function serializeBoard(board, view = DEFAULT_VIEW) {
  const text = JSON.stringify({ format: BOARD_FORMAT, version: VERSION, board: normalizeBoard(board), view: normalizeView(view) }, null, 2);
  checkSize(text);
  return text;
}

/** Import the current file format or a legacy unwrapped board. Unknown fields are discarded. */
export function parseBoard(text) {
  if (typeof text !== 'string') fail('Не удалось прочитать файл полотна.');
  checkSize(text);
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { fail('Не удалось открыть файл: это не корректный JSON. Выберите сохранённое полотно.'); }
  if (!record(data)) fail('В файле нет полотна.');
  if (own(data, 'format') || own(data, 'version') || own(data, 'board')) {
    if (data.format !== BOARD_FORMAT) fail('Этот файл не является полотном «Полотно».');
    if (data.version !== VERSION) fail('Эта версия файла не поддерживается. Откройте файл версии 1.');
    return { board: normalizeBoard(data.board), view: normalizeView(data.view) };
  }
  return { board: normalizeBoard(data), view: { ...DEFAULT_VIEW } };
}
