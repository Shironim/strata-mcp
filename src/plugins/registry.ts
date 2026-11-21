import type { FrameworkPlugin, FrontendFrameworkId, VirtualDocument } from './types';
import { hashSourceContent } from './virtual-doc';
import { vuePlugin } from './vue';
import { sveltePlugin } from './svelte';
import { astroPlugin } from './astro';
import { reactPlugin } from './react';

export class FrameworkPluginRegistry {
  private readonly plugins: FrameworkPlugin[] = [];
  private readonly byId = new Map<FrontendFrameworkId, FrameworkPlugin>();

  constructor(initialPlugins: readonly FrameworkPlugin[] = []) {
    for (const plugin of initialPlugins) {
      this.register(plugin);
    }
  }

  register(plugin: FrameworkPlugin): this {
    this.byId.set(plugin.id, plugin);
    const existingIdx = this.plugins.findIndex((p) => p.id === plugin.id);
    if (existingIdx >= 0) {
      this.plugins[existingIdx] = plugin;
    } else {
      this.plugins.push(plugin);
    }
    return this;
  }

  getById(id: FrontendFrameworkId): FrameworkPlugin | undefined {
    return this.byId.get(id);
  }

  resolveForFile(filePath: string): FrameworkPlugin | undefined {
    return this.plugins.find((p) => p.matchesFile(filePath));
  }

  list(): readonly FrameworkPlugin[] {
    return this.plugins;
  }

  supportedExtensions(): Set<string> {
    const set = new Set<string>();
    for (const plugin of this.plugins) {
      for (const ext of plugin.extensions) {
        set.add(ext.toLowerCase());
      }
    }
    return set;
  }

  projectFile(filePath: string, content: string, sourceHash = hashSourceContent(content)): VirtualDocument | null {
    const plugin = this.resolveForFile(filePath);
    if (!plugin) return null;
    return plugin.projectToVirtualTs(filePath, content, sourceHash);
  }
}

export const defaultPluginRegistry = new FrameworkPluginRegistry([
  vuePlugin,
  sveltePlugin,
  astroPlugin,
  reactPlugin,
]);
