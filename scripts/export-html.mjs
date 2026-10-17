import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function localAsset(directory, reference) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) {
    throw new Error(`Standalone export cannot load an external asset: ${reference}`);
  }
  const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const resolved = path.resolve(directory, pathname.replace(/^\/+/, ''));
  const relative = path.relative(directory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Asset is outside the build directory: ${reference}`);
  }
  return resolved;
}

async function replaceAsync(source, expression, replacement) {
  const matches = [...source.matchAll(expression)];
  const replacements = await Promise.all(matches.map(match => replacement(match[0])));
  let result = '';
  let offset = 0;
  matches.forEach((match, index) => {
    result += source.slice(offset, match.index) + replacements[index];
    offset = match.index + match[0].length;
  });
  return result + source.slice(offset);
}

/** Inline the application's Vite assets, keeping its original index.html intact. */
export async function exportHtml(directory, filename = 'Polotno.html') {
  const buildDirectory = path.resolve(directory);
  let html = await readFile(path.join(buildDirectory, 'index.html'), 'utf8');

  html = await replaceAsync(html, /<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script\s*>/gi, async (tag) => {
    const source = attribute(tag, 'src');
    const javascript = await readFile(localAsset(buildDirectory, source), 'utf8');
    // Vite currently emits one self-contained entry bundle. Fail explicitly if
    // future code splitting would otherwise create a deceptively portable file.
    if (/(?:\bimport\s*(?:\(|["'{*A-Za-z_$])|\bexport\s*\{[^}]*\}\s*from\s*["'])/.test(javascript)) {
      throw new Error(`JavaScript asset still imports another file: ${source}`);
    }
    return `<script type="module">\n${javascript.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });

  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (tag) => {
    const relation = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) || [];
    if (relation.includes('modulepreload')) return '';
    if (!relation.includes('stylesheet')) throw new Error(`Unsupported linked asset: ${tag}`);
    const source = attribute(tag, 'href');
    const css = await readFile(localAsset(buildDirectory, source), 'utf8');
    const cssResources = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
    if (/@import\b/i.test(css) || cssResources.some(match => !/^(?:data:|#)/i.test(match[2].trim()))) {
      throw new Error(`Stylesheet still loads another asset: ${source}`);
    }
    return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
  });

  if (/<(?:script|img|source|audio|video|iframe)\b[^>]*\bsrc\s*=/i.test(html)
    || /<link\b[^>]*\bhref\s*=/i.test(html)) {
    throw new Error('Standalone export still contains a linked resource.');
  }

  const output = path.join(buildDirectory, filename);
  await writeFile(output, html, 'utf8');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await exportHtml(fileURLToPath(new URL('../dist/', import.meta.url)));
    console.log(`Standalone HTML: ${output}`);
  } catch (error) {
    console.error(`Standalone export failed: ${error.message}`);
    process.exitCode = 1;
  }
}
