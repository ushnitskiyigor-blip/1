import { test, expect } from '@playwright/test';

const nodes = page => page.locator('.text-node');
const content = page => page.locator('.node-content');
const strokes = page => page.locator('path.stroke');
const lineTool = page => page.getByRole('button', { name: 'Рисовать линии', exact: true });
async function addText(page, text, x = 250, y = 250) {
  await page.mouse.dblclick(x, y);
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}
async function draw(page, from, to, button = 'left') {
  await page.mouse.move(...from);
  await page.mouse.down({ button });
  await page.mouse.move(...to, { steps: 16 });
  await page.mouse.up({ button });
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('starts with a blank canvas and three tools, double click creates editable text', async ({ page }) => {
  await expect(page.getByRole('toolbar', { name: 'Инструменты полотна' }).getByRole('button')).toHaveCount(3);
  await expect(nodes(page)).toHaveCount(0);
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.dblclick(250, 250);
  await expect(content(page)).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.insertText('Первая мысль');
  await page.keyboard.press('Enter');
  await expect(content(page)).toHaveText('Первая мысль');
  await expect(content(page)).toHaveAttribute('contenteditable', 'false');
});

test('the empty canvas provides a focused text entry button', async ({ page }) => {
  await page.getByRole('button', { name: 'Начать писать', exact: true }).click();
  await expect(content(page)).toBeFocused();
  await page.keyboard.type('Hello');
  await page.keyboard.insertText(' — можно писать');
  await page.keyboard.press('Enter');
  await expect(content(page)).toHaveText('Hello — можно писать');
  await expect(page.locator('#empty-state')).toBeHidden();
});

test('double click enters text even when the drawing tool is active', async ({ page }) => {
  await lineTool(page).click();
  await page.mouse.dblclick(250, 250);
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(content(page)).toBeFocused();
  await page.keyboard.insertText('Текст после рисования');
  await page.keyboard.press('Enter');
  await expect(content(page)).toHaveText('Текст после рисования');
  await expect(strokes(page)).toHaveCount(0);
});

test('typing after a single canvas click creates text without losing the first letter', async ({ page }) => {
  await page.mouse.click(200, 230);
  await page.keyboard.type('line');
  await page.keyboard.press('Enter');
  await expect(content(page)).toHaveText('line');
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
});

test('text creation and drawing work without the secure-context randomUUID API', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined }));
  await page.reload();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await addText(page, 'Обычный браузер');
  await lineTool(page).click();
  await draw(page, [600, 500], [850, 550]);
  await expect(content(page)).toHaveText('Обычный браузер');
  await expect(strokes(page)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('real touch double taps create and re-edit text, including in drawing mode', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:5173' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await lineTool(page).tap();
    await page.touchscreen.tap(100, 240); await page.touchscreen.tap(100, 240);
    await expect(content(page)).toBeFocused();
    await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.insertText('Касание'); await page.keyboard.press('Enter');
    await page.touchscreen.tap(100, 240); await page.touchscreen.tap(100, 240);
    await expect(content(page)).toBeFocused();
    await page.keyboard.insertText('!'); await page.keyboard.press('Enter');
    await expect(content(page)).toHaveText('Касание!');
    await expect(nodes(page)).toHaveCount(1);
  } finally { await context.close(); }
});

test('live and saved strokes share stabilization while retaining a deliberate bend', async ({ page }) => {
  await lineTool(page).click();
  await page.mouse.move(180, 400); await page.mouse.down();
  for (let i = 1; i <= 80; i++) {
    const x = 180 + i * 5;
    const y = 400 - 75 * Math.sin(Math.PI * i / 80) + (i % 2 ? 6 : -6);
    await page.mouse.move(x, y);
  }
  const previewPath = await page.locator('#drawing-layer g > path').last().getAttribute('d');
  await page.mouse.up();
  await expect(strokes(page)).toHaveAttribute('d', previewPath);
  const samples = await strokes(page).evaluate(path => {
    const length = path.getTotalLength();
    return Array.from({length:21}, (_,i) => { const p = path.getPointAtLength(length*i/20); return {x:p.x,y:p.y}; });
  });
  expect(Math.min(...samples.map(p => p.y))).toBeLessThan(340);
  const changes = samples.slice(1).map((p,i) => Math.sign(p.y-samples[i].y)).filter(Boolean);
  const directionChanges = changes.slice(1).filter((value,i) => value !== changes[i]).length;
  expect(directionChanges).toBeLessThanOrEqual(3);
});

test('ordinary left drag moves text without drawing; double click edits it', async ({ page }) => {
  await addText(page, 'Мысль');
  const before = await nodes(page).boundingBox();
  await draw(page, [before.x + 35, before.y + 25], [before.x + 155, before.y + 115]);
  const after = await nodes(page).boundingBox();
  expect(after.x - before.x).toBeCloseTo(120);
  expect(after.y - before.y).toBeCloseTo(90);
  await expect(strokes(page)).toHaveCount(0);
  await nodes(page).dblclick();
  await page.keyboard.insertText('!');
  await page.keyboard.press('Escape');
  await expect(content(page)).toHaveText('Мысль!');
});

test('drawing is explicit, uses only the left button and exits with toggle or Escape', async ({ page }) => {
  await draw(page, [150, 250], [400, 400]);
  await expect(strokes(page)).toHaveCount(0);
  await lineTool(page).click();
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'true');
  await draw(page, [150, 250], [400, 400], 'right');
  await expect(strokes(page)).toHaveCount(0);
  await draw(page, [150, 250], [400, 400]);
  await expect(strokes(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
  await draw(page, [600, 250], [800, 400]);
  await expect(strokes(page)).toHaveCount(1);
  await lineTool(page).click();
  await lineTool(page).click();
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
});

test('Escape during a stroke cancels it and returns to ordinary control', async ({ page }) => {
  await lineTool(page).click();
  await page.mouse.move(180, 300); await page.mouse.down(); await page.mouse.move(450, 400, { steps: 10 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(strokes(page)).toHaveCount(0);
});

test('a line joins two words and follows their movement', async ({ page }) => {
  await addText(page, 'Идея', 200, 280);
  await addText(page, 'Результат', 650, 280);
  const first = await nodes(page).nth(0).boundingBox(), second = await nodes(page).nth(1).boundingBox();
  await lineTool(page).click();
  await draw(page, [first.x + first.width / 2, first.y + first.height / 2], [second.x + second.width / 2, second.y + second.height / 2]);
  const connector = page.locator('path.connector');
  await expect(connector).toHaveCount(1);
  await expect(page.locator('.node-outline:visible')).toHaveCount(2);
  const beforePath = await connector.getAttribute('d');
  await page.keyboard.press('Escape');
  await draw(page, [first.x + 30, first.y + 25], [first.x + 80, first.y + 170]);
  expect(await connector.getAttribute('d')).not.toBe(beforePath);
  await expect(connector).toHaveAttribute('d', /^M .+ L .+/);
});

test('a stroke crossing a word produces its outline', async ({ page }) => {
  await addText(page, 'Обвести');
  const box = await nodes(page).boundingBox();
  await lineTool(page).click();
  await draw(page, [box.x - 20, box.y + box.height / 2], [box.x + box.width + 20, box.y + box.height / 2]);
  await expect(page.locator('.node-outline:visible')).toHaveCount(1);
  await expect(strokes(page)).toHaveCount(0);
});

test('a long stroke keeps a flexible tail attached to the outlined word', async ({ page }) => {
  await addText(page, 'Мысль');
  const box = await nodes(page).boundingBox();
  await lineTool(page).click();
  await draw(page, [box.x + box.width / 2, box.y + box.height / 2], [650, 480]);
  await expect(strokes(page)).toHaveCount(1);
  await expect(page.locator('.node-outline:visible')).toHaveCount(1);
  const before = await strokes(page).getAttribute('d');
  await page.keyboard.press('Escape');
  await draw(page, [box.x + 30, box.y + 25], [box.x + 130, box.y + 100]);
  expect(await strokes(page).getAttribute('d')).not.toBe(before);
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(0);
  await expect(strokes(page)).toHaveCount(0);
});

test('settings stay scrollable on short landscape screens', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('button', { name: 'Шрифт и обводка', exact: true }).click();
  const popover = page.locator('#settings-popover');
  const box = await popover.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Капсула', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Капсула', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('font and shape settings apply to selected words and right click opens formatting', async ({ page }) => {
  await addText(page, 'Форма');
  await page.getByRole('button', { name: 'Шрифт и обводка', exact: true }).click();
  await page.getByRole('button', { name: 'Прямоугольник', exact: true }).click();
  await page.locator('#font-size').fill('36');
  await page.locator('#font-size').press('Tab');
  await expect(nodes(page)).toHaveCSS('font-size', '36px');
  await expect(page.locator('.node-outline:visible path')).toHaveAttribute('d', / H /);
  await page.getByRole('button', { name: 'Закрыть настройки' }).click();
  await nodes(page).click({ button: 'right' });
  await expect(page.locator('#text-menu')).toBeVisible();
  await page.locator('#text-menu').getByRole('button', { name: 'Подчёркнутый', exact: true }).click();
  await expect(content(page)).toHaveCSS('text-decoration-line', 'underline');
  await page.mouse.click(1000, 650);
  await expect(page.locator('#text-menu')).toBeHidden();
});

test('font size commits when settings are opened during text editing', async ({ page }) => {
  await addText(page, 'Размер');
  await nodes(page).dblclick(); await page.keyboard.insertText('!');
  await page.getByRole('button', { name: 'Шрифт и обводка', exact: true }).click();
  await page.locator('#font-size').fill('48');
  await page.locator('#font-size').press('Enter');
  await page.mouse.click(1000, 650);
  await expect(nodes(page)).toHaveCSS('font-size', '48px');
  await expect(content(page)).toHaveText('Размер!');
});

test('undo and redo restore text and drawing changes', async ({ page }) => {
  await addText(page, 'Сохранить');
  await lineTool(page).click();
  await draw(page, [550, 500], [850, 550]);
  await expect(strokes(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(strokes(page)).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(1);
  await page.keyboard.press('Control+Shift+z');
  await expect(strokes(page)).toHaveCount(1);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expect(nodes(page)).toHaveCount(0);
});

test('saved text and lines survive reload without runtime errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await addText(page, 'Останется здесь');
  await lineTool(page).click(); await draw(page, [550, 500], [850, 550]);
  await page.reload();
  await expect(content(page)).toHaveText('Останется здесь');
  await expect(strokes(page)).toHaveCount(1);
  await expect(lineTool(page)).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('words keep a gap when dragged onto each other', async ({ page }) => {
  await addText(page, 'Первая', 220, 280);
  await addText(page, 'Вторая', 550, 280);
  const first = await nodes(page).nth(0).boundingBox(), second = await nodes(page).nth(1).boundingBox();
  await draw(page, [first.x + 25, first.y + 25], [second.x + 25, second.y + 25]);
  await expect.poll(async () => {
    const a = await nodes(page).nth(0).boundingBox(), b = await nodes(page).nth(1).boundingBox();
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }).toBe(false);
});

test('marquee selects several words and deletion removes their connections', async ({ page }) => {
  await addText(page, 'Первое', 220, 280); await addText(page, 'Второе', 500, 280);
  await draw(page, [150, 200], [800, 400]);
  await expect(page.locator('.text-node.selected')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(nodes(page)).toHaveCount(2);
});

test('tools and settings fit a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await addText(page, 'Мобильное полотно', 55, 250);
  await page.getByRole('button', { name: 'Шрифт и обводка', exact: true }).click();
  const bounds = await page.locator('#settings-popover').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Закрыть настройки' }).click();
  await nodes(page).click({ button: 'right' });
  const menu = await page.locator('#text-menu').boundingBox();
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(375);
});
