import * as THREE from "./vendor/three-0.186.0/three.module.js";
const smooth = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const bell = (x, y, cx, cy, rx, ry) =>
  Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) * 2);

// Approved painted relief character shapes, shared by the reading scene.
export function createPaintedActors(scene, state) {
  const actors = [];
  function actor(texture, kind) {
    const aspect = texture.image.width / texture.image.height;
    const height = kind === "fox" ? 4.05 : 7.7;
    const width = height * aspect;
    const geometry = new THREE.PlaneGeometry(width, height, 120, 120);
    const pos = geometry.attributes.position;
    const original = new Float32Array(pos.array);
    const data = [];
    for (let i = 0; i < pos.count; i++) {
      const u = geometry.attributes.uv.getX(i),
        v = 1 - geometry.attributes.uv.getY(i);
      let z;
      if (kind === "fox") {
        z =
          0.46 * bell(u, v, 0.4, 0.5, 0.38, 0.24) +
          0.55 * bell(u, v, 0.24, 0.27, 0.19, 0.24) +
          0.18 * bell(u, v, 0.77, 0.7, 0.22, 0.22);
      } else {
        z =
          0.44 * bell(u, v, 0.61, 0.52, 0.25, 0.31) +
          0.52 * bell(u, v, 0.64, 0.18, 0.23, 0.19) +
          0.2 * bell(u, v, 0.26, 0.43, 0.33, 0.15);
      }
      original[i * 3 + 2] = z;
      data.push({ u, v, z });
    }
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.035,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = kind;
    mesh.renderOrder = kind === "fox" ? 3 : 2;
    material.forceSinglePass = true;
    scene.add(mesh);
    const item = {
      mesh,
      original,
      data,
      width,
      height,
      kind,
      goal: new THREE.Vector3(),
      scale: 1,
    };
    actors.push(item);
    return item;
  }

  function deform(item, t, amount) {
    const { mesh, original, data, width: w, height: h, kind } = item,
      p = mesh.geometry.attributes.position;
    let maxMovement = 0;
    for (let i = 0; i < p.count; i++) {
      const { u, v, z } = data[i];
      let x = original[i * 3],
        y = original[i * 3 + 1],
        zz = z;
      if (kind === "fox") {
        const tail = smooth(0.57, 0.83, u) * smooth(0.36, 0.56, v);
        const ears =
          (1 - smooth(0.14, 0.27, v)) *
          smooth(0.12, 0.18, u) *
          (1 - smooth(0.29, 0.36, u));
        const head = (1 - smooth(0.31, 0.47, v)) * (1 - smooth(0.34, 0.46, u));
        const excited = ["fox", "happy", "alert"].includes(state.action)
          ? amount
          : ["greeting", "bond", "heart", "care", "rose"].includes(state.action)
            ? amount * 0.6
            : 0;
        const wind = ["wind", "gold"].includes(state.action) ? amount : 0;
        y +=
          tail *
          (Math.sin(t * 2.4) * (0.045 + excited * 0.14 + wind * 0.1)) *
          h;
        zz += tail * Math.sin(t * 2.4 + 0.6) * (0.04 + excited * 0.25);
        x += ears * Math.sin(t * 2.2) * (0.004 + excited * 0.025) * w;
        y += ears * excited * 0.022 * h;
        const turn =
          Math.sin(t * 1.7) * (0.007 + excited * 0.034) +
          (state.action === "sad" ? 0.045 : 0);
        const px = (0.29 - 0.5) * w,
          py = (0.5 - 0.39) * h;
        const dx = x - px,
          dy = y - py;
        x += (Math.cos(turn) * dx - Math.sin(turn) * dy - dx) * head;
        y += (Math.sin(turn) * dx + Math.cos(turn) * dy - dy) * head;
        y +=
          Math.sin(t * 1.75) * 0.012 * h * bell(u, v, 0.35, 0.51, 0.24, 0.22);
      } else {
        const scarf =
          (1 - smooth(0.36, 0.5, u)) *
          smooth(0.24, 0.32, v) *
          (1 - smooth(0.54, 0.62, v));
        const hair = (1 - smooth(0.15, 0.26, v)) * smooth(0.38, 0.47, u);
        const head = 1 - smooth(0.24, 0.31, v);
        const greet =
          state.action === "prince" ||
          ["greeting", "bond", "heart", "care", "rose"].includes(state.action)
            ? amount
            : 0;
        const wind = ["wind", "gold"].includes(state.action) ? amount : 0;
        y += scarf * Math.sin(t * 2.6 + u * 5) * (0.012 + wind * 0.035) * h;
        zz += scarf * Math.sin(t * 2.6 + u * 5 + 0.7) * (0.07 + wind * 0.22);
        x += hair * Math.sin(t * 2 + u * 13) * (0.0013 + wind * 0.0035) * w;
        const angle = Math.sin(t * 1.8) * (0.004 + greet * 0.029);
        const px = (0.59 - 0.5) * w,
          py = (0.5 - 0.28) * h,
          dx = x - px,
          dy = y - py;
        x += (Math.cos(angle) * dx - Math.sin(angle) * dy - dx) * head;
        y += (Math.sin(angle) * dx + Math.cos(angle) * dy - dy) * head;
        x += Math.sin(t * 1.7) * 0.005 * w * bell(u, v, 0.61, 0.45, 0.23, 0.2);
        y += Math.sin(t * 1.7) * 0.002 * h * (1 - smooth(0.7, 0.88, v));
      }
      p.setXYZ(i, x, y, zz);
      maxMovement = Math.max(
        maxMovement,
        Math.abs(x - original[i * 3]) + Math.abs(y - original[i * 3 + 1]),
      );
    }
    p.needsUpdate = true;
    item.movement = maxMovement;
  }

  return { actor, deform, actors };
}
