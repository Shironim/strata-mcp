import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  extractComponentContract,
  parseRuntimePropsObject,
} from '../../src/engine/contract';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');

describe('Runtime JS defineProps({...}) extraction', () => {
  it('parses top-level props without confusing nested type/default/required pairs', () => {
    const props = parseRuntimePropsObject(`{
      label: { type: String, required: true },
      count: { type: Number, default: 0 },
      variant: { type: String, default: 'primary' },
      title: String,
    }`);

    expect(props.length).toBe(4);

    const label = props.find((p) => p.name === 'label');
    expect(label).toBeDefined();
    expect(label!.type).toBe('String');
    expect(label!.required).toBe(true);

    const count = props.find((p) => p.name === 'count');
    expect(count).toBeDefined();
    expect(count!.type).toBe('Number');
    expect(count!.required).toBe(false);
    expect(count!.default).toBe('0');

    const variant = props.find((p) => p.name === 'variant');
    expect(variant).toBeDefined();
    expect(variant!.default).toBe("'primary'");

    const title = props.find((p) => p.name === 'title');
    expect(title).toBeDefined();
    expect(title!.type).toBe('String');
  });

  it('preserves full factory function default values containing commas or braces', () => {
    const props = parseRuntimePropsObject(`{
      tags: { type: Array, default: () => ['alpha', 'beta'] },
      config: { type: Object, default: () => ({ enabled: true, count: 1 }) },
    }`);

    expect(props.length).toBe(2);
    const tags = props.find((p) => p.name === 'tags');
    expect(tags?.default).toBe("() => ['alpha', 'beta']");

    const config = props.find((p) => p.name === 'config');
    expect(config?.default).toBe("() => ({ enabled: true, count: 1 })");
  });

  it('extracts runtime JS props from a real .vue component', async () => {
    const contract = await extractComponentContract(
      join(FIXTURES_DIR, 'RuntimePropsButton.vue')
    );

    expect(contract.props.length).toBe(3);
    expect(contract.props.find((p) => p.name === 'label')?.required).toBe(true);
    expect(contract.props.find((p) => p.name === 'count')?.default).toBe('0');
    expect(contract.props.find((p) => p.name === 'variant')?.type).toBe('String');
  });
});
