export interface AstroOpeningTag {
  name: string;
  attributes: string;
  start: number;
  end: number;
}

function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { i = astroExpressionEnd(text, i + 1) - 1; continue; }
    if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** Balanced source boundary only; this does not evaluate Astro expressions. */
export function astroExpressionEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = quotedEnd(text, i) - 1; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Static opening tags with source offsets; not an Astro compiler or runtime render graph. */
export function astroOpeningTags(template: string): AstroOpeningTag[] {
  const tags: AstroOpeningTag[] = [];
  let expressionDepth = 0;
  for (let i = 0; i < template.length;) {
    if (template.startsWith('<!--', i)) {
      const end = template.indexOf('-->', i + 4); i = end < 0 ? template.length : end + 3; continue;
    }
    const c = template[i];
    if (expressionDepth && (c === '"' || c === "'" || c === '`')) { i = quotedEnd(template, i); continue; }
    if (expressionDepth && template.startsWith('//', i)) {
      const end = template.indexOf('\n', i + 2); i = end < 0 ? template.length : end; continue;
    }
    if (expressionDepth && template.startsWith('/*', i)) {
      const end = template.indexOf('*/', i + 2); i = end < 0 ? template.length : end + 2; continue;
    }
    if (c === '{') { expressionDepth++; i++; continue; }
    if (c === '}') { expressionDepth = Math.max(0, expressionDepth - 1); i++; continue; }
    if (c !== '<') { i++; continue; }
    const name = /^<([A-Za-z][\w.:-]*)(?=[\s/>])/.exec(template.slice(i));
    if (!name) { i++; continue; }
    const start = i;
    const attrsStart = i + name[0].length;
    let end = attrsStart;
    while (end < template.length && template[end] !== '>') {
      if (template[end] === '"' || template[end] === "'") end = quotedEnd(template, end);
      else if (template[end] === '{') end = astroExpressionEnd(template, end);
      else end++;
    }
    if (end >= template.length) break;
    tags.push({ name: name[1], attributes: template.slice(attrsStart, end).replace(/\/\s*$/, ''), start, end: end + 1 });
    i = end + 1;
    if (['script', 'style', 'textarea', 'title'].includes(name[1].toLowerCase())) {
      const closing = new RegExp(`</${name[1]}\\s*>`, 'ig'); closing.lastIndex = i;
      const match = closing.exec(template); i = match ? closing.lastIndex : template.length;
    }
  }
  return tags;
}
