export {};
declare global {
  const useOrderStore: typeof import('../stores/useOrderStore')['useOrderStore'];
  const useOrderApi: typeof import('../composables/useOrderApi')['useOrderApi'];
}
