import * as T from "./vendor/three-0.186.0/three.module.js";

// Sculpted geometry and pigment shading: the scene remains real, rotatable 3D.
// Noise is anchored in world space, so paper/pigment do not crawl with the camera.
export function buildPaintedWorld({ world, scene }) {
  const cache = new Map();
  let seed = 2121;
  const random = () =>
    (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  function paint(color) {
    if (cache.has(color)) return cache.get(color);
    const material = new T.MeshStandardMaterial({
      color,
      roughness: 1,
      metalness: 0,
      side: T.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        `varying vec3 vPigment;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
         vec4 pigmentPosition = vec4(position, 1.0);
         #ifdef USE_INSTANCING
           pigmentPosition = instanceMatrix * pigmentPosition;
         #endif
         vPigment = (modelMatrix * pigmentPosition).xyz;`,
        );
      shader.fragmentShader = `varying vec3 vPigment;
        float pigmentHash(vec3 p) {
          p = fract(p * .3183099 + vec3(.11, .27, .41));
          p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float pigmentNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(mix(pigmentHash(i), pigmentHash(i+vec3(1,0,0)),f.x),
                         mix(pigmentHash(i+vec3(0,1,0)),pigmentHash(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(pigmentHash(i+vec3(0,0,1)),pigmentHash(i+vec3(1,0,1)),f.x),
                         mix(pigmentHash(i+vec3(0,1,1)),pigmentHash(i+vec3(1,1,1)),f.x),f.y),f.z);
        }\n${shader.fragmentShader}`
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
         float wash = pigmentNoise(vPigment * vec3(7., 13., 7.));
         float brush = pigmentNoise(vPigment * vec3(39., 9., 29.));
         diffuseColor.rgb *= .82 + wash*.23 + brush*.09;
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.92,.82,.64), .035*brush);`,
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
         float tooth = pigmentHash(floor(vPigment * 320.));
         gl_FragColor.rgb += (tooth-.5)*.035;
         gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(.96,.91,.80), .035);`,
        );
    };
    material.customProgramCacheKey = () => "storybook-pigment-v1";
    cache.set(color, material);
    return material;
  }
  const sphere = new T.SphereGeometry(1, 32, 24);
  const cylinder = new T.CylinderGeometry(1, 1, 1, 12);
  const detailBall = new T.SphereGeometry(1, 8, 6);
  const straw = new T.CylinderGeometry(1, 1, 1, 4);
  const leafShape = new T.Shape();
  leafShape.moveTo(0, 0);
  leafShape.bezierCurveTo(-0.47, 0.27, -0.39, 0.78, 0, 1);
  leafShape.bezierCurveTo(0.34, 0.75, 0.43, 0.25, 0, 0);
  const leafGeo = new T.ShapeGeometry(leafShape, 8);
  // Slightly curved leaves catch separate light even at oblique angles.
  const lp = leafGeo.attributes.position;
  for (let i = 0; i < lp.count; i++)
    lp.setZ(i, Math.sin(lp.getY(i) * Math.PI) * 0.12);
  leafGeo.computeVertexNormals();
  function group(parent, position = [0, 0, 0]) {
    const result = new T.Group();
    result.position.set(...position);
    parent.add(result);
    return result;
  }
  function mesh(
    parent,
    geometry,
    color,
    position = [0, 0, 0],
    scale = [1, 1, 1],
    shadow = false,
  ) {
    const result = new T.Mesh(geometry, paint(color));
    result.position.set(...position);
    result.scale.set(...scale);
    result.castShadow = shadow;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  }
  const ball = (parent, color, pos, scale, shadow = false) =>
    mesh(parent, sphere, color, pos, scale, shadow);
  function tube(parent, points, radius, color, segments = 20) {
    const curve = new T.CatmullRomCurve3(
      points.map((p) => new T.Vector3(...p)),
    );
    return mesh(
      parent,
      new T.TubeGeometry(curve, segments, radius, 8, false),
      color,
    );
  }
  function tapered(parent, points, radii, color, sides = 14) {
    const curve = new T.CatmullRomCurve3(
      points.map((p) => new T.Vector3(...p)),
    );
    const n = 48,
      frames = curve.computeFrenetFrames(n, false),
      positions = [],
      normals = [],
      uv = [],
      indices = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n,
        p = curve.getPointAt(t),
        rIndex = t * (radii.length - 1),
        j = Math.floor(rIndex);
      const r = T.MathUtils.lerp(
        radii[j],
        radii[Math.min(j + 1, radii.length - 1)],
        rIndex - j,
      );
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2,
          normal = frames.normals[i]
            .clone()
            .multiplyScalar(Math.cos(a))
            .addScaledVector(frames.binormals[i], Math.sin(a));
        positions.push(
          p.x + normal.x * r,
          p.y + normal.y * r,
          p.z + normal.z * r,
        );
        normals.push(normal.x, normal.y, normal.z);
        uv.push(k / sides, t);
        if (i < n && k < sides) {
          const x = i * (sides + 1) + k;
          indices.push(
            x,
            x + 1,
            x + sides + 1,
            x + 1,
            x + sides + 2,
            x + sides + 1,
          );
        }
      }
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute(
      "position",
      new T.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    return mesh(parent, geometry, color, [0, 0, 0], [1, 1, 1], true);
  }
  const dummy = new T.Object3D();
  function instances(parent, geometry, color, items, shadow = false) {
    const result = new T.InstancedMesh(geometry, paint(color), items.length);
    items.forEach((item, i) => {
      dummy.position.set(...item.p);
      dummy.rotation.set(...(item.r || [0, 0, 0]));
      dummy.scale.set(...item.s);
      dummy.updateMatrix();
      result.setMatrixAt(i, dummy.matrix);
    });
    result.castShadow = shadow;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  }
  scene.background = new T.Color(0xe4e9db);
  scene.fog = new T.Fog(0xe6ddc6, 18, 48);
  scene.add(new T.HemisphereLight(0xf9eddb, 0x64734c, 1.7));
  const sunlight = new T.DirectionalLight(0xffdc9e, 2.9);
  sunlight.position.set(-3, 7, 4);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, {
    left: -6,
    right: 6,
    top: 7,
    bottom: -5,
  });
  sunlight.shadow.normalBias = 0.025;
  sunlight.shadow.bias = -0.0003;
  sunlight.shadow.radius = 3;
  scene.add(sunlight);
  const rim = new T.DirectionalLight(0xe5e2ed, 0.9);
  rim.position.set(4, 4, -5);
  scene.add(rim);
  const sun = ball(scene, 0xffdea0, [-5, 4.5, -12], [1.05, 1.05, 0.3]);
  sun.material = new T.MeshBasicMaterial({ color: 0xffe6b1, fog: false });
  const clouds = [];
  for (let i = 0; i < 5; i++) {
    const c = group(scene, [-7 + i * 4, 4.9 + Math.sin(i) * 0.5, -15 - i]);
    for (let j = 0; j < 5; j++)
      ball(
        c,
        0xf8e8d4,
        [(j - 2) * 0.58, Math.sin(j * 2) * 0.1, 0],
        [0.75, 0.18, 0.32],
      );
    clouds.push(c);
  }
  // A continuous meadow replaces the toy pedestal, with lavender distant hills.
  const groundGeometry = new T.PlaneGeometry(90, 90, 48, 48);
  groundGeometry.rotateX(-Math.PI / 2);
  const gp = groundGeometry.attributes.position;
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i),
      z = gp.getZ(i);
    gp.setY(i, -0.03 + Math.sin(x * 0.48) * Math.sin(z * 0.38) * 0.045);
  }
  groundGeometry.computeVertexNormals();
  mesh(world, groundGeometry, 0x8c9865);
  for (let i = 0; i < 7; i++) {
    const hill = ball(
      scene,
      [0xa7a0ac, 0xb5a6aa, 0xb6b4a0][i % 3],
      [-16 + i * 5, -0.4, -14 - random() * 9],
      [6, 1.4 + random() * 1.1, 3.2],
    );
    hill.receiveShadow = false;
  }
  // A few distant cypresses, kept outside the interactive clearing.
  const farTrees = [];
  for (let i = 0; i < 38; i++)
    farTrees.push({
      p: [-20 + random() * 40, 0.45, -8 - random() * 15],
      s: [0.15 + random() * 0.18, 0.55 + random() * 0.7, 0.16],
      r: [0, random(), 0.02],
    });
  instances(scene, sphere, 0x7c8668, farTrees);

  const tree = group(world, [-2.5, 0, -0.95]);
  tree.userData.word = "nothing";
  tapered(
    tree,
    [
      [0, 0, 0],
      [-0.17, 1.2, -0.05],
      [-0.1, 2.5, 0],
      [0.22, 3.7, -0.15],
      [0.85, 4.7, -0.15],
    ],
    [0.4, 0.31, 0.23, 0.14, 0.02],
    0x766447,
    20,
  );
  const branches = [
    [
      [-0.08, 2.3, 0],
      [0.7, 3.1, 0.03],
      [1.8, 3.65, 0.12],
      [3.1, 4.1, 0.04],
    ],
    [
      [0.02, 3.1, 0],
      [-0.8, 3.6, 0.05],
      [-1.6, 4.3, 0.25],
      [-2.1, 4.5, 0.25],
    ],
    [
      [0.1, 3.4, -0.1],
      [0.6, 4.15, -0.9],
      [1.1, 4.65, -1.4],
    ],
    [
      [-0.16, 1.6, 0],
      [-0.55, 2.7, 0.65],
      [-0.6, 3.3, 1.0],
    ],
  ];
  for (const points of branches)
    tapered(tree, points, [0.18, 0.13, 0.075, 0.006], 0x897052);
  // Bark follows the trunk as irregular drawn strokes, rather than a cylinder.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2,
      r = 0.31;
    tube(
      tree,
      [
        [Math.cos(a) * r, 0.1, Math.sin(a) * r],
        [Math.cos(a) * 0.24 - 0.15, 1.1, Math.sin(a) * 0.25],
        [Math.cos(a) * 0.18 - 0.1, 2.3, Math.sin(a) * 0.2],
      ],
      0.008,
      i % 2 ? 0x61553e : 0xa38b60,
      16,
    );
  }
  const canopy = [];
  const leafColors = [0x647746, 0x85934b, 0xa4a95a, 0xc3b565, 0x778848];
  for (let c = 0; c < leafColors.length; c++) {
    const leaves = [];
    for (let i = 0; i < 210; i++) {
      const a = random() * Math.PI * 2,
        r = Math.sqrt(random()) * 2.7;
      const x = 0.45 + Math.cos(a) * r,
        z = Math.sin(a) * r * 0.7;
      leaves.push({
        p: [
          x,
          4.0 +
            Math.sqrt(Math.max(0, 1 - (r * r) / 8)) * 0.85 +
            (random() - 0.5) * 0.8,
          z,
        ],
        s: [0.17 + random() * 0.2, 0.24 + random() * 0.28, 1],
        r: [-0.8 + random() * 1.9, random() * 6.28, random() * 6.28],
      });
    }
    canopy.push(instances(tree, leafGeo, leafColors[c], leaves, true));
  }
  const apples = [];
  for (let i = 0; i < 16; i++) {
    const a = i * 2.399,
      r = 0.5 + random() * 1.8;
    const apple = group(tree, [
      0.45 + Math.cos(a) * r,
      3.5 + random() * 0.8,
      Math.sin(a) * r * 0.6,
    ]);
    ball(apple, 0xb95636, [-0.04, 0, 0], [0.14, 0.15, 0.14], true);
    ball(apple, 0xc8773f, [0.055, 0, 0], [0.13, 0.155, 0.135], true);
    tube(
      apple,
      [
        [0, 0.1, 0],
        [0.02, 0.25, 0],
      ],
      0.013,
      0x6d5940,
      5,
    );
    const l = mesh(apple, leafGeo, 0x7b8950, [0.02, 0.21, 0], [0.1, 0.15, 0.1]);
    l.rotation.z = -0.8;
    apples.push(apple);
  }
  // Fox: tapered muzzle, chest ruff, curved ears, fur silhouette and tapered tail.
  const fox = group(world, [0.85, 0.12, 0.55]);
  fox.rotation.y = -0.35;
  fox.userData.word = "fox";
  ball(fox, 0xbc683b, [0, 0.64, -0.07], [0.32, 0.38, 0.64], true);
  ball(fox, 0xd78b4c, [0, 0.72, 0.32], [0.28, 0.38, 0.28], true);
  ball(fox, 0xf1ddba, [0, 0.72, 0.48], [0.23, 0.34, 0.15], true);
  const legs = [];
  for (const x of [-0.22, 0.22])
    for (const z of [-0.4, 0.38]) {
      const leg = group(fox, [x, 0.46, z]);
      tapered(
        leg,
        [
          [0, 0.02, 0],
          [0.015, -0.18, 0.025],
          [0.01, -0.41, 0.045],
        ],
        [0.09, 0.058, 0.047],
        0x795036,
        10,
      );
      ball(leg, 0x4d4435, [0.01, -0.39, 0.09], [0.075, 0.065, 0.14], true);
      legs.push(leg);
    }
  const foxHead = group(fox, [0, 1.15, 0.43]);
  ball(foxHead, 0xce8046, [0, 0, 0], [0.32, 0.29, 0.28], true);
  ball(foxHead, 0xe1a267, [0, 0.02, 0.16], [0.24, 0.19, 0.23], true);
  // Elongated, narrowing nose instead of a round plush-toy muzzle.
  tapered(
    foxHead,
    [
      [0, -0.06, 0.11],
      [0, -0.1, 0.3],
      [0, -0.095, 0.53],
    ],
    [0.185, 0.12, 0.035],
    0xf3e2c3,
    18,
  );
  ball(foxHead, 0x3e392e, [0, -0.09, 0.54], [0.057, 0.039, 0.045]);
  for (const side of [-1, 1]) {
    ball(foxHead, 0xf2ddbb, [side * 0.22, -0.105, 0.1], [0.11, 0.085, 0.17]);
    for (let i = 0; i < 5; i++) {
      const tuft = mesh(
        foxHead,
        leafGeo,
        0xf1dfbe,
        [side * (0.18 + i * 0.025), -0.08 - i * 0.025, 0.1],
        [0.08, 0.18, 0.08],
      );
      tuft.rotation.z = side * (1.1 + i * 0.12);
      tuft.rotation.x = 0.2;
    }
    tube(
      foxHead,
      [
        [side * 0.09, -0.16, 0.4],
        [side * 0.2, -0.16, 0.23],
        [side * 0.24, -0.11, 0.17],
      ],
      0.007,
      0x75533a,
      10,
    );
    ball(foxHead, 0x3c3a2e, [side * 0.18, 0.065, 0.244], [0.036, 0.027, 0.023]);
    ball(
      foxHead,
      0xf8edcf,
      [side * 0.173, 0.074, 0.263],
      [0.009, 0.008, 0.006],
    );
    tube(
      foxHead,
      [
        [side * 0.12, 0.11, 0.24],
        [side * 0.18, 0.125, 0.225],
        [side * 0.23, 0.1, 0.19],
      ],
      0.009,
      0x8c5c36,
      10,
    );
  }
  const ears = [];
  const earShape = new T.Shape();
  earShape.moveTo(-0.15, 0);
  earShape.bezierCurveTo(-0.18, 0.19, -0.1, 0.45, 0.015, 0.63);
  earShape.bezierCurveTo(0.11, 0.39, 0.19, 0.13, 0.15, 0);
  earShape.quadraticCurveTo(0, -0.06, -0.15, 0);
  const earGeo = new T.ExtrudeGeometry(earShape, {
    depth: 0.055,
    bevelEnabled: true,
    bevelSegments: 3,
    steps: 1,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    curveSegments: 16,
  });
  for (const side of [-1, 1]) {
    const ear = group(foxHead, [side * 0.215, 0.19, -0.045]);
    ear.rotation.z = side * -0.23;
    mesh(ear, earGeo, 0x97603a, [0, 0, -0.04], [0.85, 0.72, 1], true);
    mesh(ear, earGeo, 0xe8b98d, [0, 0.04, 0.047], [0.52, 0.53, 0.25]);
    ears.push(ear);
  }
  const tail = group(fox, [0.03, 0.64, -0.53]);
  tapered(
    tail,
    [
      [0, 0, 0],
      [0.24, 0.05, -0.34],
      [0.59, 0.23, -0.7],
      [0.7, 0.54, -0.94],
      [0.52, 0.72, -1.05],
    ],
    [0.13, 0.23, 0.25, 0.16, 0.005],
    0xca8147,
    20,
  );
  tapered(
    tail,
    [
      [0.65, 0.4, -0.85],
      [0.7, 0.54, -0.94],
      [0.52, 0.72, -1.05],
    ],
    [0.19, 0.15, 0.004],
    0xf0dfbe,
    20,
  );
  // Short, scattered fur strokes follow the surface; instanced to avoid draw-call growth.
  const foxFur = [];
  for (let i = 0; i < 140; i++) {
    const a = random() * 6.28,
      y = random() * 1.1 - 0.55;
    foxFur.push({
      p: [Math.cos(a) * 0.31, 0.65 + Math.sin(a) * 0.34, y],
      s: [0.012, 0.055 + random() * 0.04, 0.01],
      r: [0.4 + random() * 0.5, a, 0.5],
    });
  }
  instances(fox, leafGeo, 0xe0a16b, foxFur);
  const ruff = [];
  for (let i = 0; i < 32; i++) {
    const a = random() * 6.28;
    ruff.push({
      p: [
        Math.cos(a) * 0.22,
        0.72 + Math.sin(a) * 0.3,
        0.49 + random() * 0.025,
      ],
      s: [0.045, 0.13, 0.025],
      r: [0.3, a * 0.1, Math.PI + 0.3 * Math.sin(a)],
    });
  }
  instances(fox, leafGeo, 0xf4e4c6, ruff);

  // Prince: a slender silhouette, long tailored coat, sculpted curls and tiny hands.
  const prince = group(world, [-0.8, 0.12, 0.65]);
  prince.rotation.y = 0.9;
  prince.userData.word = "prince";
  const princeBody = group(prince);
  for (const x of [-0.12, 0.12]) {
    tapered(
      princeBody,
      [
        [x, 0.12, 0],
        [x, 0.55, 0],
        [x, 0.85, 0],
      ],
      [0.075, 0.07, 0.085],
      0xbda57a,
    );
    ball(princeBody, 0x65523d, [x, 0.085, 0.09], [0.095, 0.085, 0.2], true);
    tube(
      princeBody,
      [
        [x - 0.05, 0.13, 0.1],
        [x, 0.145, 0.15],
        [x + 0.05, 0.13, 0.1],
      ],
      0.008,
      0x927852,
      8,
    );
  }
  // Lathed coat has shaped shoulders/waist and a gently irregular flowing hem.
  const coatPoints = [
    [0.36, 0.55],
    [0.37, 0.65],
    [0.32, 0.85],
    [0.255, 1.15],
    [0.225, 1.42],
    [0.29, 1.72],
    [0.27, 1.95],
    [0.12, 2.02],
  ].map((p) => new T.Vector2(...p));
  const coatGeo = new T.LatheGeometry(coatPoints, 48),
    cp = coatGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i),
      y = cp.getY(i),
      z = cp.getZ(i),
      a = Math.atan2(x, z);
    cp.setXYZ(
      i,
      x * (1 + 0.025 * Math.sin(a * 7)),
      y + (y < 1 ? 0.023 * Math.cos(a * 5) : 0),
      z * 0.8,
    );
  }
  coatGeo.computeVertexNormals();
  mesh(princeBody, coatGeo, 0x426849, [0, 0, 0], [1, 1, 1], true);
  // Front opening, gold piping, cuffs, lapels, belt and seams.
  tube(
    princeBody,
    [
      [0.035, 0.58, 0.29],
      [0.015, 1.05, 0.22],
      [0.01, 1.45, 0.19],
      [0.02, 1.9, 0.19],
    ],
    0.008,
    0xb39b56,
  );
  tube(
    princeBody,
    [
      [-0.3, 0.6, 0.17],
      [-0.28, 0.87, 0.17],
      [-0.21, 1.3, 0.12],
    ],
    0.006,
    0x344e38,
  );
  tube(
    princeBody,
    [
      [0.31, 0.6, 0.17],
      [0.28, 0.87, 0.17],
      [0.21, 1.3, 0.12],
    ],
    0.006,
    0x8c9b68,
  );
  const collarShape = new T.Shape();
  collarShape.moveTo(0, 0);
  collarShape.lineTo(-0.18, 0.18);
  collarShape.lineTo(-0.24, -0.04);
  collarShape.lineTo(-0.065, -0.3);
  collarShape.closePath();
  const collarGeo = new T.ExtrudeGeometry(collarShape, {
    depth: 0.015,
    bevelEnabled: true,
    bevelSize: 0.007,
    bevelThickness: 0.007,
    bevelSegments: 2,
  });
  mesh(princeBody, collarGeo, 0x809364, [0, 1.83, 0.22]);
  const collarR = mesh(princeBody, collarGeo, 0x668459, [0, 1.83, 0.22]);
  collarR.scale.x = -1;
  for (const y of [0.92, 1.12, 1.35, 1.58])
    ball(princeBody, 0xc5a457, [0.055, y, 0.23], [0.022, 0.022, 0.013]);
  const belt = mesh(
    princeBody,
    new T.TorusGeometry(0.235, 0.025, 8, 48),
    0x8c7545,
    [0, 1.32, 0],
    [1, 1, 0.83],
  );
  belt.rotation.x = Math.PI / 2;
  mesh(
    princeBody,
    new T.TorusGeometry(0.036, 0.008, 6, 12),
    0xd1b36b,
    [0, 1.32, 0.215],
    [1, 0.8, 1],
  );
  const head = group(princeBody, [0, 2.43, 0]);
  ball(princeBody, 0xe2b58a, [0, 2.07, 0], [0.085, 0.16, 0.08]);
  ball(head, 0xeac49c, [0, 0, 0], [0.275, 0.335, 0.255], true);
  for (const side of [-1, 1]) {
    ball(head, 0xe2b18a, [side * 0.26, -0.015, -0.005], [0.055, 0.085, 0.04]);
    ball(head, 0x443d31, [side * 0.104, 0.005, 0.234], [0.022, 0.035, 0.017]);
    ball(head, 0xf8edda, [side * 0.1, 0.017, 0.249], [0.006, 0.008, 0.004]);
    ball(head, 0xdcaa8c, [side * 0.16, -0.085, 0.213], [0.049, 0.022, 0.012]);
    tube(
      head,
      [
        [side * 0.07, 0.069, 0.238],
        [side * 0.11, 0.077, 0.23],
        [side * 0.147, 0.063, 0.218],
      ],
      0.006,
      0x9d7b43,
      8,
    );
  }
  ball(head, 0xdfb18a, [0, -0.06, 0.263], [0.029, 0.037, 0.03]);
  tube(
    head,
    [
      [-0.05, -0.139, 0.227],
      [0, -0.15, 0.237],
      [0.05, -0.133, 0.23],
    ],
    0.006,
    0xa47861,
    12,
  );
  ball(head, 0xd1a54e, [0, 0.18, -0.025], [0.29, 0.21, 0.265], true);
  // Distinct swept curls, tapering continuously instead of separate ball hair.
  for (let i = 0; i < 34; i++) {
    const a = i * 2.399,
      r = 0.1 + random() * 0.16;
    const x = Math.cos(a) * r,
      z = Math.sin(a) * r,
      y = 0.16 + random() * 0.08;
    const dx = Math.cos(a) * 0.11,
      dz = Math.sin(a) * 0.11;
    tapered(
      head,
      [
        [x, y, z],
        [x + dx * 0.5, y + 0.095, z + dz * 0.5],
        [x + dx + 0.025, y + 0.06, z + dz],
        [x + dx * 0.9 + 0.05, y - 0.025, z + dz * 1.1],
      ],
      [0.043, 0.061, 0.043, 0.002],
      [0xd6ad50, 0xe4bf64, 0xc3963d, 0xf0ce79][i % 4],
      8,
    );
  }
  for (let i = 0; i < 8; i++) {
    const x = -0.23 + i * 0.06;
    tapered(
      head,
      [
        [x, 0.25, 0.17],
        [x + 0.06, 0.2, 0.25],
        [x + 0.025, 0.12 + Math.sin(i) * 0.035, 0.27],
      ],
      [0.032, 0.04, 0.003],
      0xe7c369,
      8,
    );
  }
  for (let i = 0; i < 11; i++) {
    const a = i * 2.399,
      x = Math.cos(a) * 0.22,
      z = Math.sin(a) * 0.21;
    tapered(
      head,
      [
        [x, 0.25, z],
        [x * 1.24 + 0.025, 0.33, z * 1.2],
        [x * 1.46 + 0.04, 0.28, z * 1.35],
        [x * 1.55 + 0.055, 0.23, z * 1.25],
      ],
      [0.022, 0.026, 0.017, 0.001],
      i % 2 ? 0xf1cf75 : 0xd1a64a,
      8,
    );
  }
  const scarf = mesh(
    princeBody,
    new T.TorusGeometry(0.145, 0.055, 12, 40),
    0xdab252,
    [0, 2.055, 0],
    [1, 1, 0.9],
  );
  scarf.rotation.x = Math.PI / 2;
  const ribbon = group(princeBody, [-0.12, 2.08, -0.07]);
  const ribbonShape = new T.Shape();
  ribbonShape.moveTo(0, 0);
  ribbonShape.bezierCurveTo(-0.35, 0.03, -0.75, -0.24, -1.18, 0.03);
  ribbonShape.lineTo(-1.08, -0.19);
  ribbonShape.bezierCurveTo(-0.75, -0.36, -0.3, -0.13, 0, -0.14);
  ribbonShape.closePath();
  mesh(
    ribbon,
    new T.ExtrudeGeometry(ribbonShape, {
      depth: 0.015,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.008,
      bevelThickness: 0.008,
      curveSegments: 28,
    }),
    0xe0b34e,
  );
  tube(
    ribbon,
    [
      [-0.03, -0.09, 0.025],
      [-0.42, -0.16, 0.025],
      [-0.8, -0.21, 0.025],
      [-1.09, -0.09, 0.025],
    ],
    0.006,
    0xf2d386,
    24,
  );
  const arms = [];
  for (const side of [-1, 1]) {
    const arm = group(princeBody, [side * 0.27, 1.86, 0]);
    arm.rotation.z = side * 0.15;
    tapered(
      arm,
      [
        [0, 0, 0],
        [side * 0.025, -0.29, 0.005],
        [side * 0.03, -0.57, 0.045],
      ],
      [0.1, 0.079, 0.065],
      0x5b7c54,
    );
    const cuff = mesh(arm, new T.TorusGeometry(0.068, 0.012, 8, 24), 0xab995b, [
      side * 0.03,
      -0.53,
      0.045,
    ]);
    cuff.rotation.x = Math.PI / 2;
    ball(arm, 0xe7bf97, [side * 0.03, -0.64, 0.045], [0.057, 0.09, 0.045]);
    ball(arm, 0xe2b58e, [side * -0.018, -0.64, 0.08], [0.022, 0.05, 0.022]);
    for (let j = 0; j < 3; j++)
      tube(
        arm,
        [
          [side * 0.03 + (j - 1) * 0.02, -0.66, 0.08],
          [side * 0.03 + (j - 1) * 0.02, -0.7, 0.073],
        ],
        0.004,
        0xc89d79,
        5,
      );
    arms.push(arm);
  }
  // Detailed stalks: each stem, grain and awn is batched across the meadow.
  const wheat = group(world),
    stems = [],
    grains = [],
    awns = [],
    grass = [],
    petals = [],
    centers = [];
  for (let i = 0; i < 1100; i++) {
    const x = (random() - 0.5) * 22,
      z = (random() - 0.5) * 16 - 3;
    const clearing = ((x + 0.15) / 2.3) ** 2 + ((z - 0.4) / 1.9) ** 2;
    if (clearing < 1) continue;
    const h = 0.4 + random() * 0.46,
      tilt = (random() - 0.5) * 0.16;
    stems.push({
      p: [x, h * 0.5, z],
      s: [0.009, h, 0.009],
      r: [tilt, 0, tilt],
    });
    for (let j = 0; j < 5; j++)
      for (const side of [-1, 1]) {
        grains.push({
          p: [x + side * 0.025, h - 0.035 + j * 0.027, z],
          s: [0.026, 0.045, 0.017],
          r: [0, random() * 0.4, side * -0.38],
        });
        awns.push({
          p: [x + side * 0.05, h + 0.04 + j * 0.027, z],
          s: [0.002, 0.12, 0.002],
          r: [0, 0, side * -0.26],
        });
      }
  }
  instances(wheat, straw, 0xb59b53, stems);
  instances(wheat, detailBall, 0xcfb166, grains);
  instances(wheat, straw, 0xc9b472, awns);
  for (let i = 0; i < 800; i++) {
    const a = random() * 6.28,
      r = Math.sqrt(random()) * 5,
      x = Math.cos(a) * r,
      z = Math.sin(a) * r * 0.7;
    grass.push({
      p: [x, 0.025, z],
      s: [0.017, 0.1 + random() * 0.17, 1],
      r: [0, random() * 6.28, (random() - 0.5) * 0.7],
    });
    if (i % 9 === 0 && Math.abs(x) > 0.6) {
      const h = 0.13 + random() * 0.1;
      centers.push({ p: [x, h, z], s: [0.025, 0.018, 0.025] });
      for (let j = 0; j < 5; j++) {
        const b = (j / 5) * 6.28;
        petals.push({
          p: [x + Math.cos(b) * 0.035, h, z + Math.sin(b) * 0.035],
          s: [0.035, 0.014, 0.023],
          r: [0, -b, 0],
        });
      }
    }
  }
  instances(world, leafGeo, 0x7c8b51, grass);
  instances(world, detailBall, 0xe8d9a7, petals);
  instances(world, detailBall, 0xba9150, centers);
  // Fallen apples and a few stones at the roots supply small-scale detail.
  for (let i = 0; i < 5; i++)
    ball(
      world,
      0xb77347,
      [-2.1 + random() * 1.5, 0.09, -0.5 + random() * 1.3],
      [0.11, 0.12, 0.11],
    );
  const stones = [];
  for (let i = 0; i < 24; i++)
    stones.push({
      p: [-3 + random() * 6, 0.025, -2 + random() * 4],
      s: [
        0.05 + random() * 0.09,
        0.03 + random() * 0.04,
        0.06 + random() * 0.08,
      ],
      r: [0, random() * 6.28, 0],
    });
  instances(world, sphere, 0xb4ae8c, stones);
  const butterflies = [];
  for (let i = 0; i < 3; i++) {
    const b = group(world, [0, 1.3, 0]);
    const left = mesh(b, leafGeo, 0xe1bd76, [-0.015, 0, 0], [0.1, 0.14, 0.1]);
    const right = mesh(b, leafGeo, 0xe1bd76, [0.015, 0, 0], [-0.1, 0.14, 0.1]);
    ball(b, 0x7c6b43, [0, 0.04, 0], [0.009, 0.065, 0.01]);
    butterflies.push({ group: b, left, right });
  }
  const hearts = [];
  const heartShape = new T.Shape();
  heartShape.moveTo(0, 0.1);
  heartShape.bezierCurveTo(-0.5, 0.55, -0.6, -0.05, 0, -0.45);
  heartShape.bezierCurveTo(0.6, -0.05, 0.5, 0.55, 0, 0.1);
  const heartGeo = new T.ShapeGeometry(heartShape, 12);
  for (let i = 0; i < 3; i++) {
    const h = mesh(world, heartGeo, 0xc78e69, [0, 2, 0], [0.09, 0.09, 0.09]);
    h.visible = false;
    hearts.push(h);
  }
  return {
    sunlight,
    sun,
    clouds,
    tree,
    fox,
    legs,
    foxHead,
    ears,
    tail,
    prince,
    princeBody,
    arms,
    head,
    ribbon,
    wheat,
    butterflies,
    hearts,
  };
}
