import { expect, test } from 'bun:test';
import { collectVuePatchOmissions } from '../../src/engine/patch-coverage';

test('Vue coverage reports forwarding and dynamic usage with original source spans', () => {
  const template = '<Child old="ok" v-bind="$attrs" :[name]="value"><template #[slot]>🙂</template></Child><component :is="chosen" />';
  const offset = 51;
  const omissions = collectVuePatchOmissions(template, offset, 'App.vue', 'a'.repeat(64), new Set(['Child']));
  expect(omissions.map(o => o.code)).toEqual(['OBJECT_FORWARDING', 'DYNAMIC_ARGUMENT', 'DYNAMIC_ARGUMENT', 'DYNAMIC_COMPONENT']);
  expect(omissions.map(o => template.slice(o.sourceRef!.startOffset - offset, o.sourceRef!.endOffset - offset))).toEqual([
    'v-bind="$attrs"', ':[name]="value"', '#[slot]', '<component :is="chosen" />',
  ]);
  expect(omissions.at(-1)?.resolution).toBe('candidate');
  expect(omissions.every(o => o.sourceRef?.sha256 === 'a'.repeat(64))).toBe(true);
});

test('static target usages and forwarding on unrelated components are not omissions', () => {
  expect(collectVuePatchOmissions('<Child old="ok" /><Other v-bind="props" />', 0, 'App.vue', 'b'.repeat(64), new Set(['Child']))).toEqual([]);
});

test('malformed templates fail instead of becoming analyzed without omissions', () => {
  expect(() => collectVuePatchOmissions('<Child><div></Child>', 0, 'App.vue', 'c'.repeat(64), new Set(['Child']))).toThrow();
});
