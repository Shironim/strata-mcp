import { describe, expect, it } from 'bun:test';
import { extractComponentContract, formatContractAsText } from '../../src/engine/contract';
import { auditEventHandlers } from '../../src/engine/reactivity';

describe('Sprint 3 — Props, Emits, Models & Contract Intelligence', () => {
  it('extracts defineModel (Vue 3.4+) macros into models, props, and emits contracts', async () => {
    const vueCode = `
<script setup lang="ts">
const model = defineModel<string>();
const isOpen = defineModel<boolean>('isOpen', { required: true });
const count = defineModel('count', { type: Number, default: 0 });
</script>
<template>
  <div>
    <slot name="item" :data="model" :active="isOpen" />
    <slot name="footer" />
  </div>
</template>
`;

    const contract = await extractComponentContract('DummyModel.vue', vueCode);

    expect(contract.models).toBeDefined();
    expect(contract.models?.length).toBe(3);

    // 1. Default model
    const defaultModel = contract.models?.find((m) => m.name === 'modelValue');
    expect(defaultModel).toBeDefined();
    expect(defaultModel?.type).toBe('string');

    // 2. Custom argument model with required
    const isOpenModel = contract.models?.find((m) => m.name === 'isOpen');
    expect(isOpenModel).toBeDefined();
    expect(isOpenModel?.type).toBe('boolean');
    expect(isOpenModel?.required).toBe(true);

    // 3. Custom argument model with default
    const countModel = contract.models?.find((m) => m.name === 'count');
    expect(countModel).toBeDefined();
    expect(countModel?.default).toBe('0');

    // Dual registration in props
    expect(contract.props.some((p) => p.name === 'modelValue')).toBe(true);
    expect(contract.props.some((p) => p.name === 'isOpen' && p.required)).toBe(true);

    // Dual registration in emits
    expect(contract.emits.some((e) => e.name === 'update:modelValue')).toBe(true);
    expect(contract.emits.some((e) => e.name === 'update:isOpen')).toBe(true);

    // Scoped slots detail & payload
    expect(contract.slotDetails).toBeDefined();
    const itemSlot = contract.slotDetails?.find((s) => s.name === 'item');
    expect(itemSlot?.isScoped).toBe(true);
    expect(itemSlot?.bindings).toContain('data');
    expect(itemSlot?.bindings).toContain('active');
    expect(itemSlot?.payload).toBeDefined();
    expect(itemSlot?.payload?.data).toBe('model');
    expect(itemSlot?.payload?.active).toBe('isOpen');

    const footerSlot = contract.slotDetails?.find((s) => s.name === 'footer');
    expect(footerSlot?.isScoped).toBe(false);

    // Text formatting
    const formatted = formatContractAsText(contract);
    expect(formatted).toContain('Models (Two-Way Bindings):');
    expect(formatted).toContain('v-model (string)');
    expect(formatted).toContain('v-model:isOpen (boolean) [REQUIRED]');
    expect(formatted).toContain('item (scoped payload: { data: model, active: isOpen })');
    expect(formatted).toContain('- footer');
  });

  it('extracts union literal props and default values with high precision', async () => {
    const vueCode = `
<script setup lang="ts">
interface Props {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  label: string;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
});
</script>
<template>
  <button :class="['btn', variant, size]">{{ label }}</button>
</template>
`;

    const contract = await extractComponentContract('ButtonWithUnion.vue', vueCode);

    const variantProp = contract.props.find((p) => p.name === 'variant');
    expect(variantProp).toBeDefined();
    expect(variantProp?.isUnion).toBe(true);
    expect(variantProp?.unionMembers).toEqual(["'primary'", "'secondary'", "'ghost'"]);
    expect(variantProp?.default).toBe("'primary'");

    const sizeProp = contract.props.find((p) => p.name === 'size');
    expect(sizeProp).toBeDefined();
    expect(sizeProp?.isUnion).toBe(true);
    expect(sizeProp?.unionMembers).toEqual(["'sm'", "'md'", "'lg'"]);
    expect(sizeProp?.default).toBe("'md'");

    const formatted = formatContractAsText(contract);
    expect(formatted).toContain("variant: 'primary' | 'secondary' | 'ghost' (optional, default: 'primary') [options: 'primary' | 'secondary' | 'ghost']");
  });

  it('extracts layout traps and style tokens from Tailwind CSS classes', async () => {
    const vueCode = `
<template>
  <div class="fixed inset-0 z-[999] overflow-hidden flex items-center justify-center">
    <div class="relative z-50 overflow-y-auto max-w-lg">
      <slot />
    </div>
  </div>
</template>
`;

    const contract = await extractComponentContract('ModalTrap.vue', vueCode);
    expect(contract.styleTokens).toBeDefined();
    expect(contract.styleTokens?.overflow).toContain('overflow-hidden');
    expect(contract.styleTokens?.overflow).toContain('overflow-y-auto');
    expect(contract.styleTokens?.zIndices).toContain('z-[999]');
    expect(contract.styleTokens?.zIndices).toContain('z-50');
    expect(contract.styleTokens?.positioning).toContain('fixed');
    expect(contract.styleTokens?.layoutTraps).toContain('overflow-hidden');
    expect(contract.styleTokens?.layoutTraps).toContain('fixed');
    expect(contract.styleTokens?.layoutTraps).toContain('z-[999]');

    const formatted = formatContractAsText(contract);
    expect(formatted).toContain('Layout & Style Tokens (Tailwind/CSS):');
    expect(formatted).toContain('Layout Traps:');
    expect(formatted).toContain('Z-Indices:');
  });

  it('audits v-model two-way reactivity bindings in Vue template', async () => {
    // Audit reactivity handles v-model directives against declared script refs
    const vueFile = `
<script setup>
import { ref } from 'vue';
const searchQuery = ref('');
const isModalOpen = ref(false);
</script>
<template>
  <div>
    <input v-model="searchQuery" />
    <Modal v-model:isOpen="isModalOpen" />
    <input v-model="missingState" />
  </div>
</template>
`;

    // Write temporary test file or test auditEventHandlers
    const result = await auditEventHandlers({
      path: 'TempModelAudit.vue',
      code: vueFile,
    } as any);

    // Should detect valid v-model and v-model:isOpen, and broken missingState
    const validEvents = result.validHandlers.map((h) => h.event);
    expect(validEvents).toContain('v-model');
    expect(validEvents).toContain('v-model:isOpen');

    const brokenEvents = result.brokenHandlers.map((h) => h.event);
    expect(brokenEvents).toContain('v-model');
  });
});
