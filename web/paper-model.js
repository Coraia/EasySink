// A flat sheet -> conical patch -> flat sheet. No binding-drift subtraction.
// Cone generators stay straight; direction and its angular derivative are
// orthogonal unit vectors, so material lengths are preserved analytically.
const PI = Math.PI;
export function paperForPointer(w, h, p, grab, dy) {
  p = Math.max(0, Math.min(1, p));
  const y = (grab - 0.5) * h,
    x = w * (1 - 2 * p),
    v = dy * h;
  if (p >= 0.999999)
    return {
      model: [2, 0, 1, 0],
      curve: [0, 0, 0, 0],
      x: -w,
      y,
      requested: { x, y: y + v },
      limited: Math.abs(v) > 0.35,
    };
  const r = Math.max(
    0.00001,
    Math.min(
      w * 0.085 * Math.sin(PI * p),
      w * 2 * p * 0.13,
      ((w + x) * 0.9) / PI,
    ),
  );
  if (Math.abs(v) < 0.35 || p < 0.00001) {
    return {
      model: [0, 0, 1, 0],
      curve: [0, r, (w + x - PI * r) / 2, 0],
      x,
      y,
      requested: { x, y: y + v },
      limited: false,
    };
  }
  // The cone tip lies beyond the opposite end of the binding. A gesture
  // away from it can curl the free edge while the entire binding stays flat.
  const sign = v > 0 ? 1 : -1,
    minD = (sign > 0 ? y + h / 2 : h / 2 - y) + w * 0.12,
    target = Math.abs(v);
  function atDistance(d) {
    const R = Math.hypot(w, d),
      s = r / R,
      c = Math.sqrt(1 - s * s),
      alpha = Math.atan2(w, d);
    function point(phi) {
      const delta = alpha - phi,
        cp = Math.cos(phi),
        sp = Math.sin(phi);
      let a, b, z;
      if (delta <= PI * s) {
        const t = delta / s,
          k = Math.cos(t);
        a = 1 - s * s * (1 - k);
        b = s * Math.sin(t);
        z = s * c * (1 - k);
      } else {
        const t = delta - PI * s,
          k = Math.cos(t);
        a = (1 - 2 * s * s) * k;
        b = -Math.sin(t);
        z = 2 * s * c * k;
      }
      return {
        x: R * (a * sp + b * cp),
        up: R * (a * cp - b * sp) - d,
        z: R * z,
      };
    }
    let lo = 0,
      hi = alpha;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (point(mid).x < x) lo = mid;
      else hi = mid;
    }
    const phi = (lo + hi) / 2,
      pointAt = point(phi);
    return { d, s, phi, ...pointAt, minX: point(0).x };
  }
  let low = minD,
    nearest = atDistance(low);
  // At deep turns, a cone too close to the tip cannot reach the requested x.
  for (let i = 0; i < 18 && nearest.minX > x + 0.01; i++) {
    low *= 1.6;
    nearest = atDistance(low);
  }
  let result = nearest;
  if (target < nearest.up) {
    let high = Math.max(low * 2, (w * w) / Math.max(0.35, target));
    for (let i = 0; i < 10 && atDistance(high).up > target; i++) high *= 2;
    for (let i = 0; i < 19; i++) {
      const mid = (low + high) / 2,
        m = atDistance(mid);
      if (m.up > target) low = mid;
      else high = mid;
    }
    result = atDistance((low + high) / 2);
  }
  const pinY = y + sign * result.up;
  return {
    model: [1, y - sign * result.d, sign, result.s],
    curve: [result.phi, r, 0, 0],
    x: result.x,
    y: pinY,
    requested: { x, y: y + v },
    limited: Math.hypot(result.x - x, pinY - y - v) > 1,
  };
}
export const paperVertex = `
precision highp float;
attribute vec2 a_uv;
uniform vec2 u_view;
uniform vec4 u_leaf;
uniform vec4 u_model;
uniform vec4 u_curve;
uniform float u_progress;
uniform float u_mirror;
uniform float u_plane;
uniform float u_grab;
uniform vec2 u_pin;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
vec3 paperPoint(vec2 source,out vec3 normal){
  normal=vec3(0.0,0.0,1.0);
  if(u_model.x>1.5){normal.z=-1.0;return vec3(-source.x,source.y,0.0);}
  if(u_model.x<0.5){
    float d=source.x-u_curve.z,r=u_curve.y,t=clamp(d/r,0.0,3.14159265);
    normal=vec3(-sin(t),0.0,cos(t));
    if(d<=0.0)return vec3(source,0.0);
    return vec3(u_curve.z+r*sin(t)-max(0.0,d-3.14159265*r),source.y,r*(1.0-cos(t)));
  }
  float apex=u_model.y,side=u_model.z,s=u_model.w,c=sqrt(1.0-s*s);
  float d=side*(source.y-apex),R=length(vec2(source.x,d)),phi=atan(source.x,d);
  float start=u_curve.x,delta=phi-start;
  if(delta<=0.0)return vec3(source,0.0);
  vec3 a=vec3(sin(start),side*cos(start),0.0),b=vec3(cos(start),-side*sin(start),0.0);
  vec3 direction,tangent;
  if(delta<=3.14159265*s){
    float t=delta/s,k=cos(t),j=sin(t);
    direction=(1.0-s*s*(1.0-k))*a+s*j*b+vec3(0.0,0.0,s*c*(1.0-k));
    tangent=k*b-s*j*a+vec3(0.0,0.0,c*j);
  }else{
    float t=delta-3.14159265*s,k=cos(t),j=sin(t);
    vec3 end=(1.0-2.0*s*s)*a+vec3(0.0,0.0,2.0*s*c);
    direction=k*end-j*b;tangent=-j*end-k*b;
  }
  normal=normalize(-side*cross(direction,tangent));
  return vec3(R*direction.x,apex+R*direction.y,R*direction.z);
}
void main(){
  float w=u_leaf.z,h=u_leaf.w,origin=u_leaf.x;
  if(u_plane>0.5){
    vec2 p=a_uv*u_view,local=vec2((p.x-origin)*u_mirror,p.y-u_leaf.y-h/2.0);
    if(u_model.x<0.5){v_distance=local.x-u_curve.z;v_radius=u_curve.y;}
    else {float d=u_model.z*(local.y-u_model.y);v_distance=local.x*cos(u_curve.x)-d*sin(u_curve.x);v_radius=max(1.0,length(vec2(local.x,d))*u_model.w);}
    v_normal=vec3(0.0,0.0,1.0);v_uv=a_uv;
    gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,.9,1.0);return;
  }
  vec2 source=vec2(a_uv.x*w,(a_uv.y-.5)*h);
  vec3 normal,paper=paperPoint(source,normal);
  float z=paper.z;
  vec2 p=vec2(origin+u_mirror*paper.x,u_leaf.y+h/2.0+paper.y);
  vec2 pin=vec2(origin+u_mirror*u_pin.x,u_leaf.y+h/2.0+u_pin.y);
  p=(p-pin)/(1.0-z/(w*6.0))+pin;
  v_uv=a_uv;v_normal=vec3(u_mirror*normal.x,normal.y,normal.z);
  v_distance=source.x-u_curve.z;v_radius=u_curve.y;
  gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,-z/w,1.0);
}`;

// Conform triangles to both joins. A rectangular mesh can span a narrow curl
// diagonally and leave sawtooth silhouettes even when the surface is isometric.
export function paperMesh(w, h, model, curve) {
  const uv = [],
    indices = [];
  if (model[0] !== 1) {
    const start = curve[2] / w,
      end = (curve[2] + PI * curve[1]) / w;
    const nodes = [0, 1];
    if (model[0] === 0) {
      for (let i = 0; i <= 64; i++) {
        const x = start + ((end - start) * i) / 64;
        if (x > 0 && x < 1) nodes.push(x);
      }
    }
    nodes.sort((a, b) => a - b);
    for (const x of nodes) uv.push(x, 0, x, 1);
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = 2 * i;
      indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
    }
  } else {
    const [, apex, side, s] = model,
      start = curve[0],
      near = side > 0 ? -h / 2 - apex : apex - h / 2,
      far = near + h;
    const maximum = Math.atan2(w, near),
      corner = Math.atan2(w, far),
      finish = start + PI * s;
    const angles = [0, maximum, corner];
    for (const [a, b, n] of [
      [0, Math.min(start, maximum), 4],
      [start, Math.min(finish, maximum), 64],
      [finish, maximum, 4],
    ]) {
      if (b > a)
        for (let i = 0; i <= n; i++) {
          const t = a + ((b - a) * i) / n;
          if (t >= 0 && t <= maximum) angles.push(t);
        }
    }
    const nodes = [...new Set(angles)].sort((a, b) => a - b);
    for (const t of nodes) {
      const sin = Math.sin(t),
        cos = Math.cos(t),
        low = near / cos,
        high = Math.min(far / cos, sin > 0 ? w / sin : Infinity);
      for (let j = 0; j <= 2; j++) {
        const r = low + ((high - low) * j) / 2,
          x = (r * sin) / w,
          y = (apex + side * r * cos) / h + 0.5;
        uv.push(Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)));
      }
    }
    for (let i = 0; i < nodes.length - 1; i++)
      for (let j = 0; j < 2; j++) {
        const a = 3 * i + j;
        // Material x/y orientation reverses when the apex is below the page.
        const triangle = [a, a + 3, a + 1, a + 3, a + 4, a + 1];
        if (side < 0)
          for (let k = 0; k < 6; k += 3) {
            const v = triangle[k + 1];
            triangle[k + 1] = triangle[k + 2];
            triangle[k + 2] = v;
          }
        indices.push(...triangle);
      }
  }
  return { uv: new Float32Array(uv), indices: new Uint16Array(indices) };
}
