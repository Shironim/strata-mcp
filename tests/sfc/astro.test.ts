import { describe, expect, it } from 'bun:test';
import { parseAstro } from '../../src/engine/astro-sfc';

describe('Astro Parser (Task Brief AC 1)', () => {
  it('parses standard Astro component with frontmatter and template', () => {
    const raw = `---
import VueCounter from '../components/VueCounter.vue';
import ReactButton from '../components/ReactButton.tsx';

const pageTitle = "Astro Multi-Island Page";
---
<Layout title={pageTitle}>
  <main>
    <VueCounter client:visible initialCount={5} />
    <ReactButton client:load label="Submit" />
  </main>
</Layout>`;

    const parsed = parseAstro(raw, 'Index.astro');

    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.template).not.toBeNull();
    expect(parsed.frontmatter!.lang).toBe('ts');

    // Substring reconstruction verification
    const fmSubstring = raw.slice(
      parsed.frontmatter!.loc.start.offset,
      parsed.frontmatter!.loc.end.offset
    );
    expect(fmSubstring).toBe(parsed.frontmatter!.content);

    const tmplSubstring = raw.slice(
      parsed.template!.loc.start.offset,
      parsed.template!.loc.end.offset
    );
    expect(tmplSubstring).toBe(parsed.template!.content);

    // Frontmatter should start at line 2
    expect(parsed.frontmatter!.loc.start.line).toBe(2);

    // Template should start at line 7
    expect(parsed.template!.loc.start.line).toBe(7);
  });

  it('handles Astro component without frontmatter', () => {
    const raw = `<article class="prose">
  <h1>Static Astro Page</h1>
  <p>Zero JavaScript by default.</p>
</article>`;

    const parsed = parseAstro(raw, 'Static.astro');

    expect(parsed.frontmatter).toBeNull();
    expect(parsed.template).not.toBeNull();

    const tmplSubstring = raw.slice(
      parsed.template!.loc.start.offset,
      parsed.template!.loc.end.offset
    );
    expect(tmplSubstring).toBe(parsed.template!.content);
    expect(parsed.template!.loc.start.line).toBe(1);
  });
});
