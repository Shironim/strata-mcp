import { describe, expect, it } from 'bun:test';
import {
  detectKeyCasing,
  analyzeEgressTransport,
  analyzeIngressTransport,
  analyzeBidirectionalTransport,
} from '../src/engine/transport-analyzer';
import { extractComponentContract } from '../src/engine/contract';
import type { BoundaryContract, FormContract, ComponentPropContract } from '../src/types';

describe('Bidirectional Data Transportation Contract & Risk Engine', () => {
  it('accurately identifies casing conventions on payload keys', () => {
    expect(detectKeyCasing(['firstName', 'lastName', 'emailAddress'])).toBe('camelCase');
    expect(detectKeyCasing(['first_name', 'last_name', 'email_address'])).toBe('snake_case');
    expect(detectKeyCasing(['user_id', 'firstName', 'email'])).toBe('mixed');
    expect(detectKeyCasing(['email', 'id', 'name'])).toBe('unknown');
    expect(detectKeyCasing([])).toBe('unknown');
  });

  it('detects egress transport risks: mixed casing, nested FormData, and empty string vs null', () => {
    const mockBoundaries: BoundaryContract[] = [
      {
        boundaryType: 'inertia-form',
        method: 'POST',
        targetEndpoint: '/api/v1/users',
        endpointSource: 'literal',
        payloadKeys: ['user_id', 'firstName', 'avatar', 'settings', 'age'],
      },
    ];

    const mockForms: FormContract[] = [
      {
        binding: 'form',
        isMultipart: true,
        fields: [
          { key: 'avatar', type: 'file', required: false },
          { key: 'settings', type: 'unknown', required: false },
          { key: 'age', type: 'number', required: false },
        ],
      },
    ];

    const content = `
      <template>
        <input v-model="form.age" type="number" />
        <input type="file" @change="e => form.avatar = e.target.files[0]" />
      </template>
      <script setup>
      const form = useForm({ user_id: 1, firstName: 'John', avatar: null, settings: { theme: 'dark' }, age: 25 });
      </script>
    `;

    const egress = analyzeEgressTransport(mockBoundaries, mockForms, content);
    expect(egress.length).toBe(1);

    const item = egress[0];
    expect(item.serialization).toBe('multipart/form-data');
    expect(item.casing).toBe('mixed');

    // Should flag mixed naming convention
    expect(item.potentialRisks.some((r) => r.includes('Mixed naming convention'))).toBe(true);

    // Should flag nested object in FormData
    expect(item.potentialRisks.some((r) => r.includes('nested object in a multipart/form-data'))).toBe(true);

    // Should flag numeric field empty string vs null hazard
    expect(item.potentialRisks.some((r) => r.includes('Numeric/temporal field'))).toBe(true);
  });

  it('detects ingress transport traps: pagination unwrapping and unguarded nullability', () => {
    const props: ComponentPropContract[] = [
      { name: 'users', type: 'any', required: true },
      { name: 'customer', type: 'any', required: true },
    ];

    const content = `
      <template>
        <!-- Pagination Trap: accessing users.data and users.links, but iterating users directly -->
        <div v-for="user in users" :key="user.id">
          {{ user.name }}
        </div>
        <pagination :links="users.links" />
        <span v-if="users.data">Total: {{ users.total }}</span>

        <!-- Unguarded Nullability: customer.profile.address lacks ?. -->
        <div>{{ customer.profile.address }}</div>
      </template>
      <script setup>
      const props = defineProps({ users: Object, customer: Object });
      </script>
    `;

    const ingress = analyzeIngressTransport(props, content);
    expect(ingress.length).toBe(2);

    const usersIngress = ingress.find((i) => i.rootPropName === 'users');
    expect(usersIngress).toBeDefined();
    expect(usersIngress?.expectedShape).toBe('paginated-collection');
    expect(usersIngress?.potentialRisks.some((r) => r.includes('CRITICAL Pagination Trap'))).toBe(true);

    const customerIngress = ingress.find((i) => i.rootPropName === 'customer');
    expect(customerIngress).toBeDefined();
    expect(customerIngress?.potentialRisks.some((r) => r.includes('Unguarded nested access'))).toBe(true);
  });

  it('synthesizes bidirectional transport contract in extractComponentContract', async () => {
    const sfcCode = `
      <template>
        <form @submit.prevent="form.post('/api/checkout')">
          <input v-model="form.user_name" />
          <input v-model="form.shippingAddress" />
        </form>
        <div v-for="order in orders" :key="order.id">
          {{ order.title }}
        </div>
        <div v-if="orders.links">Page {{ orders.meta.current_page }}</div>
      </template>
      <script setup lang="ts">
      import { useForm } from '@inertiajs/vue3';
      const props = defineProps<{ orders: any }>();
      const form = useForm({ user_name: '', shippingAddress: '' });
      </script>
    `;

    const contract = await extractComponentContract('src/CheckoutView.vue', sfcCode);
    expect(contract.transportContract).toBeDefined();
    expect(contract.transportContract?.egress.length).toBeGreaterThanOrEqual(1);
    expect(contract.transportContract?.ingress.length).toBeGreaterThanOrEqual(1);

    // Should detect transport risks
    expect(contract.transportContract?.transportRisks.length).toBeGreaterThanOrEqual(1);
    expect(contract.transportContract?.transportRisks.some((r) => r.includes('EGRESS'))).toBe(true);
  });

  it('extracts Zod validation schemas with field types and constraints', () => {
    const code = `
      import { z } from 'zod';

      export const CheckoutSchema = z.object({
        email: z.string().email().min(5),
        age: z.number().int().positive().optional(),
        scheduledAt: z.date().nullable(),
        items: z.array(),
      });
    `;

    const { extractValidationSchemas } = require('../src/engine/transport-analyzer');
    const schemas = extractValidationSchemas(code);
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('CheckoutSchema');
    expect(schemas[0].schemaLibrary).toBe('zod');

    const emailField = schemas[0].fields.find((f: any) => f.field === 'email');
    expect(emailField).toBeDefined();
    expect(emailField?.baseType).toBe('string');
    expect(emailField?.constraints).toContain('email()');
    expect(emailField?.constraints).toContain('min(5)');

    const ageField = schemas[0].fields.find((f: any) => f.field === 'age');
    expect(ageField?.isOptional).toBe(true);
    expect(ageField?.baseType).toBe('number');

    const schedField = schemas[0].fields.find((f: any) => f.field === 'scheduledAt');
    expect(schedField?.isNullable).toBe(true);
  });

  it('audits error handling bindings and detects unhandled 422 payload keys', () => {
    const { auditErrorHandling } = require('../src/engine/transport-analyzer');
    const egress = [
      {
        endpoint: '/api/v1/register',
        method: 'POST',
        clientKind: 'inertia-form',
        serialization: 'json',
        payloadKeys: ['email', 'password', 'couponCode'],
        casing: 'mixed',
        potentialRisks: [],
      },
    ];

    const content = `
      <template>
        <input v-model="form.email" />
        <span v-if="form.errors.email">{{ form.errors.email }}</span>

        <input v-model="form.password" type="password" />
        <span v-if="form.errors.password">{{ form.errors.password }}</span>

        <!-- couponCode is sent in payload, but has NO error binding! -->
        <input v-model="form.couponCode" />
      </template>
    `;

    const audit = auditErrorHandling(content, egress);
    expect(audit.hasErrorBinding).toBe(true);
    expect(audit.boundErrorFields).toContain('email');
    expect(audit.boundErrorFields).toContain('password');
    expect(audit.boundErrorFields).not.toContain('couponCode');
    expect(audit.unhandledPayloadKeys).toContain('couponCode');
  });

  it('extracts cache invalidations and flags dangling mutations without re-fetch', () => {
    const { extractInvalidationGraph } = require('../src/engine/transport-analyzer');
    const mutatingEgress = [
      {
        endpoint: '/api/v1/comments',
        method: 'POST',
        clientKind: 'axios',
        serialization: 'json',
        payloadKeys: ['body'],
        casing: 'unknown',
        potentialRisks: [],
      },
    ];

    // Case A: With TanStack Query invalidation
    const validCode = `
      function addComment() {
        axios.post('/api/v1/comments', { body }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['comments', postId] });
        });
      }
    `;
    const graphA = extractInvalidationGraph(validCode, mutatingEgress);
    expect(graphA.invalidations.length).toBe(1);
    expect(graphA.invalidations[0].mechanism).toBe('tanstack-invalidate');
    expect(graphA.hasDanglingMutation).toBe(false);

    // Case B: Dangling mutation with zero cache invalidation
    const danglingCode = `
      function addComment() {
        axios.post('/api/v1/comments', { body });
      }
    `;
    const graphB = extractInvalidationGraph(danglingCode, mutatingEgress);
    expect(graphB.invalidations.length).toBe(0);
    expect(graphB.hasDanglingMutation).toBe(true);
    expect(graphB.danglingMutations).toContain('[POST] /api/v1/comments');
  });
});
