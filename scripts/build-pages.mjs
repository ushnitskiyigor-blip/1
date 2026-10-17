import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
await mkdir(new URL('docs/', root), { recursive: true });
await copyFile(new URL('dist/Polotno.html', root), new URL('docs/index.html', root));
await writeFile(new URL('docs/.nojekyll', root), '');
console.log('GitHub Pages files prepared in docs/.');
