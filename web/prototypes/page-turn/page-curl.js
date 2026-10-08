// Temporary paint surface only. The accessible/selectable reader remains ordinary DOM.
// Geometry: rotate into a tilted fold axis, wrap a half cylinder, rotate back.
// No external renderer, experimental browser API, or whole-book capture is required.
const captures = new Map();
const styles = ['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','flex','flex-direction','flex-shrink','grid-template-columns','gap','padding','margin','top','bottom','left','right','overflow','overflow-wrap','font','letter-spacing','color','background-color','border','border-radius','text-align','white-space','vertical-align','opacity'];

export function snapshotSpread(spread) {
  const rect=spread.getBoundingClientRect(), copy=spread.cloneNode(true);
  const source=[spread,...spread.querySelectorAll('*')], target=[copy,...copy.querySelectorAll('*')];
  source.forEach((el,i)=>{
    const clone=target[i], css=getComputedStyle(el);
    clone.removeAttribute('id');clone.removeAttribute('aria-label');
    for(const attr of Array.from(clone.attributes))if(attr.name.startsWith('data-')&&attr.name!=='data-layout')clone.removeAttribute(attr.name);
    // Spans inherit typography; block geometry must not reflow in the SVG viewport.
    if(el.tagName!=='SPAN'||!el.classList.contains('word'))for(const name of styles)clone.style.setProperty(name,css.getPropertyValue(name));
    clone.classList.remove('word','linked','selected-source');
    if(clone.classList.contains('paragraph-tools'))clone.style.display='none';
  });
  Object.assign(copy.style,{position:'absolute',left:'0',top:'0',width:rect.width+'px',height:rect.height+'px',margin:'0',visibility:'visible'});
  const css=getComputedStyle(spread),vars=['--paper','--sheet','--ink','--muted','--line','--accent','--tint','--size','--leading','--font'].map(v=>`${v}:${css.getPropertyValue(v)}`).join(';');
  const leaves=Array.from(spread.querySelectorAll(':scope > .sheet:not([hidden]):not(.translation)')).map(el=>{const r=el.getBoundingClientRect();return {x:r.left-rect.left,y:r.top-rect.top,width:r.width,height:r.height};});
  const rules=Array.from(document.styleSheets).flatMap(sheet=>{try{return Array.from(sheet.cssRules,rule=>rule.cssText);}catch{return [];}}).join('\n');
  const xml=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const markup=`<div xmlns="http://www.w3.org/1999/xhtml" style="${xml(vars)};position:relative;width:${rect.width}px;height:${rect.height}px;color:${css.color};font:14px/1.5 -apple-system,sans-serif"><style>${xml(rules)}</style>${new XMLSerializer().serializeToString(copy)}</div>`;
  const key=markup,ratio=Math.min(devicePixelRatio||1,2);
  if(!captures.has(key)){
    const image=new Image(), svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rect.width*ratio)}" height="${Math.ceil(rect.height*ratio)}" viewBox="0 0 ${rect.width} ${rect.height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
    const ready=new Promise((resolve,reject)=>{
      image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Page texture could not be rendered'));
      image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    });
    captures.set(key,ready);ready.catch(()=>captures.delete(key));
    while(captures.size>4)captures.delete(captures.keys().next().value);
  }
  return {node:copy,rect,leaves,ratio,ready:captures.get(key)};
}

const vertex=`
precision mediump float;
attribute vec2 a_uv;
uniform vec2 u_view;
uniform vec4 u_leaf;
uniform float u_progress;
uniform float u_mirror;
uniform float u_gap;
uniform float u_plane;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
void main(){
  float w=u_leaf.z,h=u_leaf.w,t=u_progress;
  float tilt=0.14*sin(3.14159265*t);
  vec2 n=vec2(cos(tilt),sin(tilt));
  float r=w*(0.025+0.12*sin(3.14159265*t));
  float fold=mix(w+h*0.08,-r*3.14159265/2.0,t);
  float origin=u_leaf.x-u_mirror*u_gap*t;
  if(u_plane>0.5){
    vec2 p=a_uv*u_view;
    vec2 local=vec2((p.x-origin)*u_mirror,p.y-u_leaf.y-h/2.0);
    v_distance=dot(local,n)-fold;v_radius=r;v_normal=vec3(0.0,0.0,1.0);v_uv=a_uv;
    gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,0.9,1.0);return;
  }
  vec2 p=vec2(a_uv.x*w,(a_uv.y-0.5)*h);
  float d=dot(p,n)-fold;
  float angle=clamp(d/r,0.0,3.14159265);
  float bent=d;
  float z=0.0;
  if(d>0.0){bent=r*sin(angle)-max(0.0,d-r*3.14159265);z=r*(1.0-cos(angle));}
  p+=(bent-d)*n;
  p=vec2(origin+u_mirror*p.x,u_leaf.y+h/2.0+p.y);
  // A small perspective lift, not a flat-page rotation.
  float perspective=1.0/(1.0-z/(w*6.0));
  p=(p-u_view*0.5)*perspective+u_view*0.5;
  v_uv=a_uv;v_normal=vec3(-u_mirror*n.x*sin(angle),-n.y*sin(angle),cos(angle));
  v_distance=d;v_radius=r;
  gl_Position=vec4(p.x/u_view.x*2.0-1.0,1.0-p.y/u_view.y*2.0,-z/w,1.0);
}`;
const fragment=`
precision mediump float;
uniform sampler2D u_front;
uniform sampler2D u_back;
uniform float u_plane;
uniform float u_mirror;
uniform float u_progress;
uniform float u_dark;
varying vec2 v_uv;
varying vec3 v_normal;
varying float v_distance;
varying float v_radius;
void main(){
  if(u_plane>0.5){
    float d=(v_distance-v_radius*0.5)/(v_radius*1.8);
    float shadow=exp(-d*d)*0.32*sin(3.14159265*u_progress);
    gl_FragColor=vec4(0.08,0.09,0.07,shadow);return;
  }
  bool front=u_mirror>0.0?gl_FrontFacing:!gl_FrontFacing;
  vec2 uv=v_uv;
  uv.x=front?(u_mirror>0.0?uv.x:1.0-uv.x):(u_mirror>0.0?1.0-uv.x:uv.x);
  vec4 paper=front?texture2D(u_front,uv):texture2D(u_back,uv);
  vec3 n=normalize(front?v_normal:-v_normal);
  vec3 key=normalize(vec3(-0.45,-0.25,1.0));
  vec3 fill=normalize(vec3(0.7,0.25,0.75));
  float diffuse=0.61+0.33*max(dot(n,key),0.0)+0.13*max(dot(n,fill),0.0);
  float reflection=0.19*pow(max(dot(n,normalize(key+vec3(0.0,0.0,1.0))),0.0),18.0)
    +0.08*pow(max(dot(n,normalize(fill+vec3(0.0,0.0,1.0))),0.0),28.0);
  // Matte paper: stronger sheen at the bend, minimal illumination on flat text.
  float bend=1.0-abs(n.z);
  vec3 rgb=paper.rgb*mix(1.0,diffuse,bend)+vec3(reflection*bend*(1.0-u_dark*0.6));
  gl_FragColor=vec4(rgb,1.0);
}`;

export function createCurl(layer,before,after,direction,onEnd,onFallback) {
  let cancelled=false,raf=0,gl=null,program=null,buffer=null,indexBuffer=null,textures=[];
  let lost=false,started=0,frames=0;
  const canvas=document.createElement('canvas');canvas.className='curl-canvas';
  const cancel=()=>{
    cancelled=true;cancelAnimationFrame(raf);
    if(gl&&!lost){textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteBuffer(indexBuffer);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();}
    canvas.remove();
  };
  const fail=error=>{
    if(cancelled)return;
    layer.dataset.failure=error.message;document.body.dataset.curlFallback=error.message;
    console.warn('Page curl fallback:',error.message);cancel();onFallback();
  };
  // Keep the old DOM visible while only these two page textures are being prepared.
  Promise.all([before.ready,after.ready]).then(images=>{
    if(cancelled)return;
    try{
      const rect=after.rect;
      canvas.width=Math.ceil(rect.width*after.ratio);canvas.height=Math.ceil(rect.height*after.ratio);
      gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
      if(!gl)throw new Error('WebGL is unavailable');
      canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;fail(new Error('WebGL context lost'));});
      const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(message);}return s;};
      const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
      program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const uniform=name=>gl.getUniformLocation(program,name);
      const uniforms=Object.fromEntries(['view','leaf','progress','mirror','gap','plane','dark'].map(n=>[n,uniform('u_'+n)]));
      gl.uniform2f(uniforms.view,rect.width,rect.height);gl.uniform1f(uniforms.mirror,direction);
      gl.uniform1f(uniforms.dark,document.body.dataset.theme==='dark'?1:0);
      const double=before.leaves.length===2,frontSnapshot=before,backSnapshot=after;
      const frontLeaf=frontSnapshot.leaves[direction>0&&double?1:0];
      const backLeaf=backSnapshot.leaves[direction<0&&double?1:0];
      const texture=(image,snapshot,leaf,unit)=>{
        const paint=document.createElement('canvas');paint.width=Math.ceil(leaf.width*snapshot.ratio);paint.height=Math.ceil(leaf.height*snapshot.ratio);
        paint.getContext('2d').drawImage(image,leaf.x*snapshot.ratio,leaf.y*snapshot.ratio,leaf.width*snapshot.ratio,leaf.height*snapshot.ratio,0,0,paint.width,paint.height);
        const t=gl.createTexture();textures.push(t);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,paint);gl.uniform1i(uniform(unit===0?'u_front':'u_back'),unit);
      };
      texture(images[0],frontSnapshot,frontLeaf,0);texture(images[1],backSnapshot,backLeaf,1);
      if(gl.getError()!==gl.NO_ERROR)throw new Error('Page texture upload failed');
      const nx=128,ny=32,uv=[],indices=[];
      for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++)uv.push(x/nx,y/ny);
      for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const a=y*(nx+1)+x;indices.push(a,a+1,a+nx+1,a+1,a+nx+2,a+nx+1);}
      buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(uv),gl.STATIC_DRAW);
      const attribute=gl.getAttribLocation(program,'a_uv');gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
      indexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
      gl.viewport(0,0,canvas.width,canvas.height);gl.frontFace(gl.CW);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      layer.replaceChildren();before.node.classList.remove('curl-preparing');
      const under=after.node;under.classList.add('curl-under');layer.append(under);
      if(double){const stationary=before.node;stationary.classList.add('curl-stationary');stationary.style.clipPath=direction>0?'inset(0 50% 0 0)':'inset(0 0 0 50%)';layer.append(stationary);}
      layer.append(canvas);layer.dataset.renderer='webgl-cylinder';layer.dataset.phase='running';
      gl.uniform4f(uniforms.leaf,direction>0?frontLeaf.x:frontLeaf.x+frontLeaf.width,frontLeaf.y,frontLeaf.width,frontLeaf.height);
      gl.uniform1f(uniforms.gap,double?after.leaves[1].x-after.leaves[0].x-after.leaves[0].width:0);
      const frame=now=>{
        if(cancelled)return;
        if(!started)started=now;
        const elapsed=(now-started)/980,p=Math.min(1,elapsed);
        const eased=p*p*(3-2*p),curl=eased;
        gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.uniform1f(uniforms.progress,curl);
        gl.disable(gl.DEPTH_TEST);gl.uniform1f(uniforms.plane,1);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
        gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.uniform1f(uniforms.plane,0);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
        layer.dataset.progress=p.toFixed(3);layer.dataset.frames=String(++frames);
        if(p<1)raf=requestAnimationFrame(frame);else{document.body.dataset.curlFrames=String(frames);onEnd();}
      };
      raf=requestAnimationFrame(frame);
    }catch(error){fail(error);}
  }).catch(fail);
  return cancel;
}
