<script setup lang="ts">
import type { ButtonVariant } from '@acme/shared';

const props = withDefaults(
  defineProps<{
    label: string;
    variant?: ButtonVariant;
    disabled?: boolean;
  }>(),
  {
    variant: 'primary',
    disabled: false,
  }
);

const emit = defineEmits<{
  (e: 'action', payload: { label: string }): void;
}>();

function handleClick() {
  if (!props.disabled) {
    emit('action', { label: props.label });
  }
}
</script>

<template>
  <button :disabled="props.disabled" @click="handleClick">
    <slot name="icon" />
    <span>{{ props.label }}</span>
  </button>
</template>
