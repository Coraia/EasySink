import { $$, toast } from "./core.js";
export class PluginHost {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = new Map();
    this.catalog = [];
  }
  enabled(id) {
    return (
      this.catalog.some((p) => p.id === id && p.enabled) && this.active.has(id)
    );
  }
  async sync(catalog) {
    this.catalog = catalog;
    for (const [id, dispose] of this.active)
      if (!catalog.some((p) => p.id === id && p.enabled)) {
        dispose?.();
        this.active.delete(id);
      }
    for (const p of catalog.filter((p) => p.enabled))
      if (!this.active.has(p.id)) {
        try {
          const module = await import(
            new URL(`./plugins/${p.id}.js`, import.meta.url).href
          );
          this.active.set(p.id, await module.install(this.ctx));
        } catch (error) {
          console.error(`Plugin ${p.id}`, error);
          toast(`${p.name} 加载失败，其余功能仍可使用`);
        }
      }
    $$("[data-feature-nav]").forEach(
      (el) => (el.hidden = !this.enabled(el.dataset.featureNav)),
    );
  }
}
