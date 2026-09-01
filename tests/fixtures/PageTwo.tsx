import React from 'react';
import OldButton from './OldButton.vue';
import NewButton from './NewButton.vue';

export function PageTwo() {
  return (
    <div>
      <OldButton>Legacy</OldButton>
      <NewButton variant="primary">Modern</NewButton>
    </div>
  );
}
