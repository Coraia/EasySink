# Fox and Little Prince — painted character study 02

These are AI-generated watercolor/gouache textures for a live **2.5D** sample, not rendered full-3D model images. All three final assets are copied into this repository, with generated alpha preserved.

The reference is the project's existing `../picturebook-full/key-events-11.webp` (first panel), supported by the previous character design sheets. The existing illustration is project artwork, not an original Saint-Exupéry plate.

Generated with the built-in `image_gen` tool. Exact prompts are in `generation.json`.

Source outputs, under `/Users/fish/.codex/generated_images/01a1500f-1753-7e92-866b-8dd5f1033a39/`:

- Fox first pass: `exec-7cf67683-6445-4128-87f9-ff6810031ffe.png` (retained at source).
- `fox.png`: `exec-b1f49963-c905-46e3-b237-44eb743e1cf7.png` (clean-cutout follow-up).
- `prince.png`: `exec-fa19c8d7-2863-440e-8931-38eb55bc7034.png`.
- `meadow.png`: `exec-04d4e17b-6e9a-4bb3-90e1-5d634a4a7022.png`.

`../../picturebook-lookdev-v2.js` builds two 120×120 relief grids with authored depth and continuous semantic deformation weights. The texture contains the painting's lighting. The scene does not claim free-angle 3D, physically relightable materials, skeletal rigging, UV hand painting, or image-to-3D reconstruction.

Open `/static/picturebook-lookdev.html` on the isolated preview server. `/static/picturebook-lookdev-v1.html` retains the previous comparison page. The reader route and its previous experimental 3D scene are unchanged.
