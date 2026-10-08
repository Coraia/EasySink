// Geometry is the accepted paper-shape model. This facade retains the
// production lighting and GPU diagnostic contract, independent of navigation.
import { paperVertex } from "./paper-model.js?v=20261008-paper";
export {
  paperForPointer as foldForPointer,
  paperMesh,
} from "./paper-model.js?v=20261008-paper";
export const foldVertex = paperVertex
  .replace(
    "varying float v_radius;",
    "varying float v_radius;\nvarying float v_bindingDistance;",
  )
  .replace(
    "v_normal=vec3(0.0,0.0,1.0);v_uv=a_uv;",
    "v_normal=vec3(0.0,0.0,1.0);v_uv=a_uv;v_bindingDistance=local.x;",
  )
  .replace(
    "v_distance=source.x-u_curve.z;v_radius=u_curve.y;",
    "v_distance=source.x-u_curve.z;v_radius=u_curve.y;v_bindingDistance=source.x;",
  );
export const foldFragment = `
precision mediump float;
uniform sampler2D u_front;
uniform sampler2D u_back;
uniform float u_plane;
uniform float u_mirror;
uniform float u_progress;
uniform float u_dark;
uniform float u_light;
uniform float u_debug;
uniform float u_binding_debug;
uniform float u_grab;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
varying float v_bindingDistance;
void main(){
  if(u_plane>0.5){
    float d=(v_distance-v_radius*0.5)/(v_radius*1.8);
    float soft=exp(-d*d)*0.28;
    float contact=exp(-abs(v_distance)/max(1.0,v_radius*0.32))*0.16;
    float hinge=0.0;
    if(abs(v_bindingDistance)<20.0) hinge=exp(-abs(v_bindingDistance)/3.0)*0.1;
    float shadow=(soft+contact+hinge)*sin(3.14159265*u_progress)*u_light;
    gl_FragColor=vec4(0.08,0.09,0.07,shadow);return;
  }
  bool front=u_mirror>0.0?gl_FrontFacing:!gl_FrontFacing;
  vec2 uv=v_uv;
  uv.x=front?(u_mirror>0.0?uv.x:1.0-uv.x):(u_mirror>0.0?1.0-uv.x:uv.x);
  vec4 paper=front?texture2D(u_front,uv):texture2D(u_back,uv);
  vec3 n=normalize(front?v_normal:-v_normal);
  vec3 key=normalize(vec3(-0.45,-0.25,1.0));
  vec3 fill=normalize(vec3(0.7,0.25,0.75));
  float diffuse=0.52+0.37*max(dot(n,key),0.0)+0.14*max(dot(n,fill),0.0);
  float reflection=0.24*pow(max(dot(n,normalize(key+vec3(0.0,0.0,1.0))),0.0),18.0)
    +0.08*pow(max(dot(n,normalize(fill+vec3(0.0,0.0,1.0))),0.0),28.0);
  // Matte paper: stronger sheen at the bend, minimal illumination on flat text.
  float bend=1.0-abs(n.z);
  float crease=0.09*pow(bend,3.0);
  vec3 lit=paper.rgb*mix(1.0,diffuse,bend)-paper.rgb*crease
    +vec3(reflection*bend*(1.0-u_dark*0.6));
  vec3 rgb=mix(paper.rgb,lit,u_light);
  gl_FragColor=vec4(rgb,1.0);
  // Opt-in acceptance marker on the GPU-rendered grabbed edge, never in the
  // normal experience. Pixel location can verify the actual projected mesh.
  if(u_debug>0.5 && v_uv.x>0.988 && abs(v_uv.y-u_grab)<0.007)
    gl_FragColor=vec4(1.0,0.0,1.0,1.0);
  // Diagnostic LINE_STRIP uses the very same deformed x=0 material vertices.
  if(u_binding_debug>1.5) gl_FragColor=vec4(0.0,1.0,0.0,1.0);
}`;
