# Little Prince character look-development samples · 2026-10-19

Reference: existing project illustration `../picturebook-full/key-events-11.webp`, chapter 21 first cell. This is a previously AI-generated project picturebook image, not an original Saint-Exupéry plate.

`fox-design-v1.png` and `prince-design-v1.png` are built-in image_gen design references. They are raster art-direction images, not actual rendered meshes. Original outputs and exact prompts are recorded in `generation.json`; selected originals are copied here without resizing or editing.

`{fox,prince}-{front,three-quarter,side}-{raw,painted}.png` are actual transparent offline Blender 4.5.3 Cycles renders, from one .blend per character with only the camera changed across views. `raw` has no watercolor composite. `painted` uses Blender's anisotropic Kuwahara compositor node, size 2.3. Their appearance does not establish web renderer parity or animation readiness. Model quality is exploratory and remains below the reference painting.

Reproducible script, original .blend assets, final render logs, first unsuccessful pass, inspection and browser evidence: `outputs/picturebook-lookdev-20261019/`. The script-authored geometry and procedural pigment are explicitly not described as an artist-sculpted, UV hand-painted, rigged production asset. No GLB/animation integration is claimed.

Compare in the isolated preview: http://127.0.0.1:18805/static/picturebook-lookdev.html . Original-image crops and design-view slices use CSS only; full source images remain intact.
