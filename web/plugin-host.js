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
      if (!catalog.some((p) => p.id === id && (p.enabled || p.always_readable))) {
        dispose?.();
        this.active.delete(id);
      }
    for (const p of catalog.filter((p) => p.enabled || p.always_readable))
      if (!this.active.has(p.id)) {
        try {
          const module = await import(
            new URL(
              `./plugins/${p.id}.js?v=20261018-import-fixes`,
              import.meta.url,
            ).href
          );
          this.active.set(p.id, await module.install(this.ctx));
        } catch (error) {
          console.error(`Plugin ${p.id}`, error);
          toast(`${p.name} 加载失败，其余功能仍可使用`);
        }
      }
    $$("[data-feature-nav]").forEach(
      (el) => {
        const id = el.dataset.featureNav;
        const readable = catalog.some(p => p.id === id && p.always_readable) && this.active.has(id);
        el.hidden = !this.enabled(id) && !readable;
      },
    );
    const count = document.getElementById("feature-count");
    if (count) count.textContent = String(catalog.length);
  }
}
