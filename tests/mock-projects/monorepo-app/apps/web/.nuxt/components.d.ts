export {};
declare module 'vue' {
  export interface GlobalComponents {
    OrderBadge: typeof import('../components/OrderBadge.vue')['default'];
  }
}
