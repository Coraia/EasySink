
precision mediump float;
attribute vec2 a_uv;
uniform vec2 u_view;
uniform vec4 u_leaf;
uniform float u_progress;
uniform float u_mirror;
uniform float u_gap;
uniform float u_plane;
uniform float u_grab;
uniform vec4 u_fold;
uniform vec2 u_pin;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
varying float v_bindingDistance;
vec3 cylinderPoint(vec2 source,vec2 n,float fold,float r,out float angle){
  float d=dot(source,n)-fold;
  angle=clamp(d/r,0.0,3.14159265);
  float bent=d,z=0.0;
  if(d>0.0){bent=r*sin(angle)-max(0.0,d-r*3.14159265);z=r*(1.0-cos(angle));}
  return vec3(source+(bent-d)*n,z);
}
void main(){
  float w=u_leaf.z,h=u_leaf.w,t=u_progress;
  vec2 n=u_fold.xy;
  float fold=u_fold.z,r=u_fold.w;
  // The material's whole inner edge is attached here; it never translates.
  float origin=u_leaf.x;
  if(u_plane>0.5){
    vec2 p=a_uv*u_view;
    vec2 local=vec2((p.x-origin)*u_mirror,p.y-u_leaf.y-h/2.0);
    v_distance=dot(local,n)-fold;v_radius=r;v_normal=vec3(0.0,0.0,1.0);v_uv=a_uv;
    v_bindingDistance=local.x;
    gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,0.9,1.0);return;
  }
  vec2 source=vec2(a_uv.x*w,(a_uv.y-0.5)*h);
  float angle;
  vec3 paper=cylinderPoint(source,n,fold,r,angle);
  vec3 normal=vec3(-n*sin(angle),cos(angle));
  // A fold not crossing this spine row has exactly zero binding drift. The
  // common horizontal turn needs no second cylinder evaluation or warp.
  if(source.y*n.y-fold>0.0 || u_gap*t>0.0){
    vec3 drift=vec3(0.0),spineDerivative=vec3(0.0);
    if(source.y*n.y-fold>0.0){
      float spineAngle;
      vec3 spine=cylinderPoint(vec2(0.0,source.y),n,fold,r,spineAngle);
      drift=spine-vec3(0.0,source.y,0.0);
      spineDerivative=vec3(n*(cos(spineAngle)-1.0),sin(spineAngle));
    }
    // Remove inner-edge drift continuously, with zero correction at the grip.
    float weight=(1.0-a_uv.x)*(1.0-a_uv.x);
    paper-=weight*drift;
    // Analytic tangents of the constrained surface, including its binding warp.
    vec3 bendDerivative=vec3(n*(cos(angle)-1.0),sin(angle));
    vec3 tx=vec3(1.0,0.0,0.0)+n.x*bendDerivative+2.0*(1.0-a_uv.x)/w*drift;
    tx.x-=u_gap*t/w;
    vec3 ty=vec3(0.0,1.0,0.0)+n.y*bendDerivative-weight*n.y*spineDerivative;
    normal=cross(tx,ty);
    normal=length(normal)>0.00001?normalize(normal):vec3(0.0,0.0,1.0);
  }
  // Spread-gap landing correction acts at the free edge, never at the spine.
  paper.x-=u_gap*t*a_uv.x;
  float z=paper.z;
  vec2 p=vec2(origin+u_mirror*paper.x,u_leaf.y+h/2.0+paper.y);
  // Keep the actual grabbed point pinned while other paper points get depth.
  vec2 pin=vec2(origin+u_mirror*(u_pin.x-u_gap*t),u_leaf.y+h/2.0+u_pin.y);
  float perspective=1.0/(1.0-z/(w*6.0));
  p=(p-pin)*perspective+pin;
  v_uv=a_uv;v_normal=vec3(u_mirror*normal.x,normal.y,normal.z);
  v_distance=dot(source,n)-fold;v_radius=r;v_bindingDistance=source.x;
  gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,-z/w,1.0);
}