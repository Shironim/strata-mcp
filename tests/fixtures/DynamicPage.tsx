import React from 'react';

const OldButton = React.lazy(() => import('./OldButton.vue'));

export function DynamicPage() {
  return (
    <div>
      <OldButton />
    </div>
  );
}
