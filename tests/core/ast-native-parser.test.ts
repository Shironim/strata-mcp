import { describe, expect, it } from 'bun:test';
import {
  extractPassedProps,
  extractRenderedPassedProps,
  extractRenderedCustomTags,
  extractComponentContextNodes,
  isRenderedInContent,
} from '../../src/engine/tree';
import { extractComponentContract } from '../../src/engine/contract';

describe('AST-Native Parser Migration (Brief 3)', () => {
  it('Scenario 1: extracts multiline and complex object passed props accurately without line truncation', () => {
    const vueTemplate = `
      <template>
        <UserCard
          :profile="{
            id: user.id,
            role: 'admin'
          }"
          data-testid="user-card"
        />
      </template>
    `;

    const props = extractRenderedPassedProps(vueTemplate, ['UserCard']);
    expect(props.length).toBe(2);

    const profileProp = props.find((p) => p.propName === 'profile');
    expect(profileProp).toBeDefined();
    expect(profileProp!.expression).toContain("role: 'admin'");
    expect(profileProp!.expression).toContain('id: user.id');

    const testIdProp = props.find((p) => p.propName === 'data-testid');
    expect(testIdProp).toBeDefined();
    expect(testIdProp!.expression).toBe('"user-card"');

    // Also verify extractPassedProps alias behaves identically
    const originalAliasProps = extractPassedProps(vueTemplate, ['UserCard']);
    expect(originalAliasProps).toEqual(props);
  });

  it('Scenario 2: extracts Vue provide and inject with TypeScript symbols and injection keys', () => {
    const vueCode = `
      <script setup lang="ts">
      import { provide, inject, ref } from 'vue';
      import { THEME_KEY, USER_CONFIG_KEY } from './keys';

      const currentTheme = ref('dark');
      provide(THEME_KEY, currentTheme);
      provide('staticKey', 'constantValue');

      const theme = inject(THEME_KEY);
      const config = inject<UserConfig>(USER_CONFIG_KEY);
      </script>
      <template>
        <div>Content</div>
      </template>
    `;

    const { providers, consumers } = extractComponentContextNodes('/src/components/ThemeConsumer.vue', vueCode);

    expect(providers.length).toBe(2);
    const themeProvider = providers.find((p) => p.key === 'THEME_KEY');
    expect(themeProvider).toBeDefined();
    expect(themeProvider!.type).toBe('vue-provide');
    expect(themeProvider!.valueSnippet).toBe('currentTheme');

    const staticProvider = providers.find((p) => p.key === 'staticKey');
    expect(staticProvider).toBeDefined();
    expect(staticProvider!.valueSnippet).toBe("'constantValue'");

    expect(consumers.length).toBe(2);
    const themeConsumer = consumers.find((c) => c.key === 'THEME_KEY');
    expect(themeConsumer).toBeDefined();
    expect(themeConsumer!.type).toBe('vue-inject');

    const configConsumer = consumers.find((c) => c.key === 'USER_CONFIG_KEY');
    expect(configConsumer).toBeDefined();
    expect(configConsumer!.type).toBe('vue-inject');
  });

  it('extracts Vue dynamic component dictionary mappings using AST', () => {
    const vueSfc = `
      <template>
        <component :is="componentMap[activeTab]" />
        <component :is="DirectModal" />
      </template>
      <script setup>
      import TabOverview from './TabOverview.vue';
      import TabAnalytics from './TabAnalytics.vue';
      import DirectModal from './DirectModal.vue';
      import UnusedTab from './UnusedTab.vue';

      const componentMap = {
        overview: TabOverview,
        analytics: TabAnalytics,
      };
      </script>
    `;

    const tags = extractRenderedCustomTags(vueSfc);
    expect(tags).toContain('TabOverview');
    expect(tags).toContain('TabAnalytics');
    expect(tags).toContain('DirectModal');
    expect(tags).not.toContain('UnusedTab');
  });

  it('extracts React Context Providers and useContext from JSX using TypeScript AST', () => {
    const reactComponent = `
      import React, { createContext, useContext, useState } from 'react';

      export const ThemeContext = createContext('light');

      export function ThemeProvider({ children }) {
        const [theme, setTheme] = useState('dark');
        return (
          <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
          </ThemeContext.Provider>
        );
      }

      export function ThemedButton() {
        const { theme } = useContext(ThemeContext);
        return <button className={theme}>Click</button>;
      }
    `;

    const { providers, consumers } = extractComponentContextNodes('/src/components/ThemeContext.tsx', reactComponent);

    expect(providers.length).toBe(1);
    expect(providers[0].key).toBe('ThemeContext');
    expect(providers[0].type).toBe('react-provider');
    expect(providers[0].valueSnippet).toBe('{ theme, setTheme }');

    expect(consumers.length).toBe(1);
    expect(consumers[0].key).toBe('ThemeContext');
    expect(consumers[0].type).toBe('react-use-context');
  });

  it('extracts JSX attributes and spread props accurately', () => {
    const jsxCode = `
      export default function Layout(props) {
        return (
          <div>
            <HeaderCard
              title="Dashboard"
              active
              details={{
                users: 42,
                status: 'online'
              }}
              {...props}
            />
          </div>
        );
      }
    `;

    const props = extractRenderedPassedProps(jsxCode, ['HeaderCard']);
    expect(props.length).toBeGreaterThanOrEqual(3);

    const titleProp = props.find((p) => p.propName === 'title');
    expect(titleProp).toBeDefined();
    expect(titleProp!.expression).toBe('"Dashboard"');

    const activeProp = props.find((p) => p.propName === 'active');
    expect(activeProp).toBeDefined();
    expect(activeProp!.expression).toBe('"true"');

    const detailsProp = props.find((p) => p.propName === 'details');
    expect(detailsProp).toBeDefined();
    expect(detailsProp!.expression).toContain("status: 'online'");

    const spreadProp = props.find((p) => p.propName === '...spread');
    expect(spreadProp).toBeDefined();
    expect(spreadProp!.expression).toBe('props');
  });

  it('resolves component rendering using AST-extracted custom tags without regex fragility', () => {
    const code = `
      <template>
        <component :is="activeComponentMap[tab]" />
        <UI.Dialog open />
      </template>
      <script setup>
      import DashboardView from './DashboardView.vue';
      import SettingsView from './SettingsView.vue';
      import UnrenderedView from './UnrenderedView.vue';

      const activeComponentMap = {
        dashboard: DashboardView,
        settings: SettingsView,
      };
      </script>
    `;

    expect(isRenderedInContent(code, 'DashboardView')).toBe(true);
    expect(isRenderedInContent(code, 'SettingsView')).toBe(true);
    expect(isRenderedInContent(code, 'Dialog')).toBe(true);
    expect(isRenderedInContent(code, 'UnrenderedView')).toBe(false);
  });

  it('extracts withDefaults complex multiline defaults using TypeScript Compiler AST without line truncation', async () => {
    const sfcCode = `
      <script setup lang="ts">
      interface Props {
        title?: string;
        fetcher?: () => Promise<string>;
      }
      const props = withDefaults(defineProps<Props>(), {
        title: 'Default Title',
        fetcher: () => {
          return Promise.resolve('ok');
        },
      });
      </script>
      <template><div>{{ title }}</div></template>
    `;

    const contract = await extractComponentContract('/src/components/MyCard.vue', sfcCode);
    const fetcherProp = contract.props.find((p) => p.name === 'fetcher');
    expect(fetcherProp).toBeDefined();
    expect(fetcherProp!.default).toContain("Promise.resolve('ok')");
    expect(fetcherProp!.default).toContain('return');
  });
});
