import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const nodes = page => page.locator('.text-node');
const node = (page, text) => page.getByRole('group', { name: text, exact: true });
const connectors = page => page.locator('path.connector');
const lineTool = page => page.locator('#line-tool');

async function addText(page, text, x = 220, y = 260) {
  await page.mouse.dblclick(x, y);
  await expect(page.locator('.node-content[contenteditable="true"]')).toBeFocused();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 18 });
  await page.mouse.up();
}

async function connect(page, from, to) {
  await lineTool(page).click();
  await drag(page, await center(from), await center(to));
  await page.keyboard.press('Escape');
  await expect(connectors(page)).toHaveCount(1);
}

async function pathPoint(locator, fraction = 0.5) {
  return locator.evaluate((path, at) => {
    const point = path.getPointAtLength(path.getTotalLength() * at);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, fraction);
}

async function selectConnection(page) {
  const midpoint = await pathPoint(page.locator('.connection-hit').first());
  await page.mouse.click(midpoint.x, midpoint.y);
  await expect(page.locator('#connection-actions')).toBeVisible();
  await expect(page.locator('[data-connection-handle]')).toHaveCount(3);
}

async function openSettings(page) {
  if (!(await page.locator('#settings-popover').isVisible())) await page.locator('#text-tool').click();
}

async function closeSettings(page) {
  if (await page.locator('#settings-popover').isVisible()) await page.locator('#close-settings').click();
}

async function exportBoard(page) {
  await openSettings(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#save-board').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.polotno$/);
  return readFile(await download.path());
}

async function importBoard(page, buffer) {
  await openSettings(page);
  await page.locator('#board-file').setInputFiles({ name: 'Мысли.polotno', mimeType: 'application/json', buffer });
}

async function selectWords(page, words) {
  await page.mouse.click(1120, 720);
  await node(page, words[0]).click();
  for (const text of words.slice(1)) await node(page, text).click({ modifiers: ['Shift'] });
  await expect(page.locator('.text-node.selected')).toHaveCount(words.length);
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('splitting and combining words work through visible actions and keyboard shortcuts', async ({ page }) => {
  await addText(page, 'Ясная новая мысль');
  await node(page, 'Ясная новая мысль').click();
  await expect(page.locator('#selection-actions')).toBeVisible();
  await expect(page.locator('#split-text')).toBeEnabled();
  await expect(page.locator('#merge-text')).toBeHidden();
  await page.locator('#split-text').click();
  await expect(page.locator('.node-content')).toHaveText(['Ясная', 'новая', 'мысль']);
  await selectWords(page, ['мысль', 'Ясная', 'новая']);
  await expect(page.locator('#merge-text')).toBeEnabled();
  await page.keyboard.press('Control+g');
  await expect(page.locator('.node-content')).toHaveText('Ясная новая мысль');
  await page.keyboard.press('Control+Shift+g');
  await expect(nodes(page)).toHaveCount(3);
  await selectWords(page, ['Ясная', 'новая', 'мысль']);
  await page.locator('#merge-text').click();
  await expect(page.locator('.node-content')).toHaveText('Ясная новая мысль');
  await page.keyboard.press('Control+z');
  await expect(nodes(page)).toHaveCount(3);
});

test('split and merge preserve an external connection that follows the merged text', async ({ page }) => {
  await addText(page, 'Первая вторая', 200, 290);
  await addText(page, 'Итог', 720, 290);
  await connect(page, node(page, 'Первая вторая'), node(page, 'Итог'));
  await node(page, 'Первая вторая').click();
  await page.locator('#split-text').click();
  await expect(nodes(page)).toHaveCount(3);
  for (const text of ['Первая', 'вторая', 'Итог']) await expect(node(page, text)).toBeVisible();
  await expect(connectors(page)).toHaveCount(1);
  await selectWords(page, ['Первая', 'вторая']);
  await page.locator('#merge-text').click();
  await expect(nodes(page)).toHaveCount(2);
  await expect(connectors(page)).toHaveCount(1);
  const before = await connectors(page).getAttribute('d');
  const start = await center(node(page, 'Первая вторая'));
  await drag(page, start, { x: start.x + 60, y: start.y + 160 });
  expect(await connectors(page).getAttribute('d')).not.toBe(before);
  await expect(page.locator('.node-outline:visible')).toHaveCount(2);
});

test('capsule, rectangle and square are the available outline shapes with distinct geometry', async ({ page }) => {
  await addText(page, 'Длинная мысль для рамки');
  await openSettings(page);
  await expect(page.locator('#shape-options').getByRole('button', { name: 'Треугольник', exact: true })).toHaveCount(0);
  await expect(page.locator('#shape-options').getByRole('button', { name: 'Овал', exact: true })).toHaveCount(0);
  const outline = page.locator('.node-outline:visible path');
  for (const label of ['Капсула', 'Прямоугольник', 'Квадрат']) {
    const button = page.locator('#shape-options').getByRole('button', { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(outline).toBeVisible();
    const geometry = await outline.evaluate(path => {
      const bounds = path.getBBox();
      const length = path.getTotalLength();
      const top = Array.from({ length: 501 }, (_, i) => path.getPointAtLength(length * i / 500))
        .filter(point => Math.abs(point.y - bounds.y) < 0.5);
      return { width: bounds.width, height: bounds.height, flatTopWidth: Math.max(...top.map(p => p.x)) - Math.min(...top.map(p => p.x)) };
    });
    if (label === 'Квадрат') expect(Math.abs(geometry.width - geometry.height)).toBeLessThan(1);
    else expect(geometry.width).toBeGreaterThan(geometry.height * 2);
    if (label === 'Капсула') expect(geometry.flatTopWidth).toBeGreaterThan(geometry.width * 0.3);
  }
});

test('the bend handle reshapes a connection, straightening and deletion can be undone', async ({ page }) => {
  await addText(page, 'Начало', 200, 280);
  await addText(page, 'Конец', 750, 280);
  await connect(page, node(page, 'Начало'), node(page, 'Конец'));
  await selectConnection(page);
  const straightMidpoint = await pathPoint(connectors(page));
  const bend = page.locator('[data-connection-handle="bend"]');
  const bendStart = await center(bend);
  await drag(page, bendStart, { x: bendStart.x, y: bendStart.y + 140 });
  const curved = await connectors(page).getAttribute('d');
  const bentMidpoint = await pathPoint(connectors(page));
  expect(bentMidpoint.y - straightMidpoint.y).toBeGreaterThan(45);
  await page.locator('#reset-connection').click();
  const resetMidpoint = await pathPoint(connectors(page));
  expect(Math.abs(resetMidpoint.y - straightMidpoint.y)).toBeLessThan(1);
  await page.keyboard.press('Control+z');
  await expect(connectors(page)).toHaveAttribute('d', curved);
  await selectConnection(page);
  await page.locator('#delete-connection').click();
  await expect(connectors(page)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(connectors(page)).toHaveAttribute('d', curved);
});

test('connection endpoints reconnect to another word and an empty drop keeps the original link', async ({ page }) => {
  await addText(page, 'Источник', 180, 250);
  await addText(page, 'Старая цель', 650, 250);
  await addText(page, 'Новая цель', 650, 540);
  await connect(page, node(page, 'Источник'), node(page, 'Старая цель'));
  await selectConnection(page);
  const endpoint = page.locator('[data-connection-handle="to"]');
  const original = await connectors(page).getAttribute('d');
  await drag(page, await center(endpoint), { x: 1050, y: 650 });
  await expect(connectors(page)).toHaveAttribute('d', original);
  await drag(page, await center(endpoint), await center(node(page, 'Новая цель')));
  await expect(connectors(page)).toHaveCount(1);
  expect(await connectors(page).getAttribute('d')).not.toBe(original);
  const target = await node(page, 'Новая цель').boundingBox();
  const end = await pathPoint(connectors(page), 1);
  expect(end.x).toBeGreaterThanOrEqual(target.x - 15);
  expect(end.x).toBeLessThanOrEqual(target.x + target.width + 15);
  expect(end.y).toBeGreaterThanOrEqual(target.y - 15);
  expect(end.y).toBeLessThanOrEqual(target.y + target.height + 15);
  const connected = await connectors(page).getAttribute('d');
  const oldStart = await center(node(page, 'Старая цель'));
  await drag(page, oldStart, { x: oldStart.x + 100, y: oldStart.y });
  await expect(connectors(page)).toHaveAttribute('d', connected);
  const newStart = await center(node(page, 'Новая цель'));
  await drag(page, newStart, { x: newStart.x + 100, y: newStart.y + 80 });
  expect(await connectors(page).getAttribute('d')).not.toBe(connected);
});

test('saved files restore text, formatting, strokes and connections and opening is undoable', async ({ page }) => {
  await addText(page, 'Память', 180, 240);
  await openSettings(page);
  await page.locator('#font-size').fill('32');
  await page.locator('#font-size').press('Tab');
  await page.locator('#format-options').getByRole('button', { name: 'Полужирный', exact: true }).click();
  await page.locator('#shape-options').getByRole('button', { name: 'Капсула', exact: true }).click();
  await closeSettings(page);
  await addText(page, 'Связь', 700, 240);
  await connect(page, node(page, 'Память'), node(page, 'Связь'));
  await selectConnection(page);
  const bendStart = await center(page.locator('[data-connection-handle="bend"]'));
  await drag(page, bendStart, { x: bendStart.x, y: bendStart.y + 100 });
  await lineTool(page).click();
  await drag(page, { x: 300, y: 560 }, { x: 750, y: 620 });
  await page.keyboard.press('Escape');
  const savedPaths = await page.locator('path.connector, path.stroke').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
  const file = await exportBoard(page);
  expect(() => JSON.parse(file.toString('utf8'))).not.toThrow();
  await closeSettings(page);
  await addText(page, 'Лишняя мысль', 900, 430);
  await importBoard(page, file);
  await expect(page.locator('.node-content')).toHaveText(['Память', 'Связь']);
  await expect(node(page, 'Память')).toHaveCSS('font-size', '32px');
  await expect(node(page, 'Память')).toHaveCSS('font-weight', '650');
  await expect(connectors(page)).toHaveCount(1);
  await expect(page.locator('path.stroke')).toHaveCount(1);
  expect(await page.locator('path.connector, path.stroke').evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(savedPaths);
  await closeSettings(page);
  await page.keyboard.press('Control+z');
  await expect(node(page, 'Лишняя мысль')).toBeVisible();
  await expect(nodes(page)).toHaveCount(3);
});

test('invalid board files report an error while keeping the current board', async ({ page }) => {
  await addText(page, 'Не потерять');
  const before = await nodes(page).boundingBox();
  await importBoard(page, Buffer.from('{"nodes":'));
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#toast')).toContainText(/не удалось|ошиб|некоррект|формат/i);
  await expect(page.locator('.node-content')).toHaveText('Не потерять');
  expect(await nodes(page).boundingBox()).toEqual(before);
  await importBoard(page, Buffer.from('{}'));
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('.node-content')).toHaveText('Не потерять');
  await closeSettings(page);
  await page.keyboard.press('Control+z');
  await expect(nodes(page)).toHaveCount(0);
});

test('typing, editing and dragging use the correct position after zooming', async ({ page }) => {
  await addText(page, 'Ориентир', 220, 280);
  const originalWidth = (await nodes(page).boundingBox()).width;
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#zoom-reset')).not.toHaveText(/100\s*%/);
  expect((await node(page, 'Ориентир').boundingBox()).width).toBeGreaterThan(originalWidth * 1.2);
  await page.mouse.dblclick(850, 450);
  await expect(page.locator('.node-content[contenteditable="true"]')).toBeFocused();
  await page.keyboard.insertText('При масштабе');
  await page.keyboard.press('Enter');
  const editedNode = node(page, 'При масштабе');
  const created = await editedNode.boundingBox();
  expect(created.x).toBeLessThan(850);
  expect(created.x + created.width).toBeGreaterThan(850);
  expect(created.y).toBeLessThan(450);
  expect(created.y + created.height).toBeGreaterThan(450);
  const start = await center(editedNode);
  await drag(page, start, { x: start.x + 90, y: start.y + 75 });
  const moved = await editedNode.boundingBox();
  expect(moved.x - created.x).toBeCloseTo(90, 0);
  expect(moved.y - created.y).toBeCloseTo(75, 0);
  await editedNode.dblclick();
  await page.keyboard.insertText('!');
  await page.keyboard.press('Enter');
  await expect(page.locator('.node-content').last()).toHaveText('При масштабе!');
  await page.locator('#zoom-reset').click();
  await expect(page.locator('#zoom-reset')).toHaveText(/100\s*%/);
  expect((await node(page, 'Ориентир').boundingBox()).width).toBeCloseTo(originalWidth, 0);
});

test('Ctrl-wheel zooms around the pointer and ordinary wheel pans without changing scale', async ({ page }) => {
  await addText(page, 'Опорная точка', 420, 360);
  const start = await center(nodes(page));
  await page.mouse.move(start.x, start.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -250);
  await page.keyboard.up('Control');
  await expect(page.locator('#zoom-reset')).not.toHaveText(/100\s*%/);
  const zoomed = await center(nodes(page));
  expect(Math.abs(zoomed.x - start.x)).toBeLessThan(2);
  expect(Math.abs(zoomed.y - start.y)).toBeLessThan(2);
  const zoomLabel = await page.locator('#zoom-reset').textContent();
  await page.mouse.wheel(0, 180);
  await expect.poll(async () => (await center(nodes(page))).y).toBeLessThan(zoomed.y - 100);
  await expect(page.locator('#zoom-reset')).toHaveText(zoomLabel);
});

test('a real two-finger pinch zooms text without moving the word in the saved board', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:5173' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#start-typing').tap();
    await page.keyboard.insertText('Жест');
    await page.keyboard.press('Enter');
    const beforeFile = JSON.parse((await exportBoard(page)).toString('utf8'));
    await closeSettings(page);
    const original = await nodes(page).boundingBox();
    const anchor = await center(nodes(page));
    const session = await context.newCDPSession(page);
    const touches = distance => [
      { x: anchor.x - distance, y: anchor.y, radiusX: 4, radiusY: 4, force: 1, id: 1 },
      { x: anchor.x + distance, y: anchor.y, radiusX: 4, radiusY: 4, force: 1, id: 2 },
    ];
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(25) });
    for (const distance of [30, 40, 50, 60]) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(distance) });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#zoom-reset')).not.toHaveText(/100\s*%/);
    const zoomed = await nodes(page).boundingBox();
    expect(zoomed.width).toBeGreaterThan(original.width * 1.7);
    const afterCenter = await center(nodes(page));
    expect(Math.abs(afterCenter.x - anchor.x)).toBeLessThan(3);
    expect(Math.abs(afterCenter.y - anchor.y)).toBeLessThan(3);
    const afterFile = JSON.parse((await exportBoard(page)).toString('utf8'));
    expect(afterFile.board.nodes[0].x).toBe(beforeFile.board.nodes[0].x);
    expect(afterFile.board.nodes[0].y).toBe(beforeFile.board.nodes[0].y);
    await expect(page.locator('path.stroke')).toHaveCount(0);
    await expect(nodes(page)).toHaveCount(1);
  } finally { await context.close(); }
});

test('show all brings distant text and freehand lines into the viewport', async ({ page }) => {
  await addText(page, 'Далеко вверху', 180, 230);
  await page.mouse.move(1050, 600);
  await page.mouse.wheel(0, 1600);
  await expect.poll(async () => (await node(page, 'Далеко вверху').boundingBox()).y).toBeLessThan(0);
  await addText(page, 'Далеко внизу', 900, 450);
  await lineTool(page).click();
  await drag(page, { x: 250, y: 650 }, { x: 700, y: 700 });
  await page.keyboard.press('Escape');
  await page.locator('#fit-board').click();
  await expect.poll(async () => {
    const boxes = await Promise.all([node(page, 'Далеко вверху').boundingBox(), node(page, 'Далеко внизу').boundingBox(), page.locator('path.stroke').boundingBox()]);
    return boxes.every(box => box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800);
  }).toBe(true);
  const scale = Number((await page.locator('#zoom-reset').textContent()).replace(/[^\d.]/g, ''));
  expect(scale).toBeLessThan(100);
});

test('dragging pushes a neighboring word away while the dragged word follows the pointer', async ({ page }) => {
  await addText(page, 'Передвигаемая', 200, 300);
  await addText(page, 'Соседняя', 650, 300);
  const moving = node(page, 'Передвигаемая');
  const neighbor = node(page, 'Соседняя');
  const neighborBefore = await neighbor.boundingBox();
  const destination = await center(neighbor);
  await drag(page, await center(moving), destination);
  await expect.poll(async () => {
    const box = await neighbor.boundingBox();
    return Math.hypot(box.x - neighborBefore.x, box.y - neighborBefore.y);
  }).toBeGreaterThan(20);
  const moved = await center(moving);
  expect(Math.abs(moved.x - destination.x)).toBeLessThan(2);
  expect(Math.abs(moved.y - destination.y)).toBeLessThan(2);
  await expect.poll(async () => {
    const a = await moving.boundingBox(), b = await neighbor.boundingBox();
    return Math.max(b.x - a.x - a.width, a.x - b.x - b.width, b.y - a.y - a.height, a.y - b.y - b.height);
  }).toBeGreaterThanOrEqual(8);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.abs((await neighbor.boundingBox()).x - neighborBefore.x)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await neighbor.boundingBox()).y - neighborBefore.y)).toBeLessThan(1);
});
