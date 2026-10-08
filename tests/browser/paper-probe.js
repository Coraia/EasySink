export async function probePaper(
  page,
  override = null,
  selectors = { article: "#article", layer: "#page-curl-layer" },
) {
  return page.evaluate(
    ({ override, selectors }) => {
      const live = document.querySelector(".curl-canvas").getContext("webgl");
      const program = live.getParameter(live.CURRENT_PROGRAM);
      const vertex = live
        .getAttachedShaders(program)
        .find(
          (s) =>
            live.getShaderParameter(s, live.SHADER_TYPE) === live.VERTEX_SHADER,
        );
      // Use the linked production shader and actual pointer uniforms. Only the
      // output stage is changed to encode unprojected paper vertices into pixels.
      const liveSource = live.getShaderSource(vertex);
      const precision = liveSource.match(/precision (\w+) float;/)[1];
      let source = (override || liveSource)
        .replace(/precision \w+ float;/, `precision ${precision} float;`)
        .replace("void main()", "void shapeMain()");
      source =
        "varying vec3 captured;varying vec3 capturedNormal;varying vec2 projected;\n" +
        source.replace(
          "float z=paper.z;",
          "captured=paper;capturedNormal=normal;float z=paper.z;",
        );
      source +=
        "\nvoid main(){shapeMain();projected=gl_Position.xy;gl_Position=vec4((a_uv.x*96.0+0.5)/97.0*2.0-1.0,(a_uv.y*24.0+0.5)/25.0*2.0-1.0,0.0,1.0);gl_PointSize=1.0;}";
      const canvas = new OffscreenCanvas(97, 25),
        gl = canvas.getContext("webgl", { antialias: false });
      const compile = (type, code) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, code);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, source));
      gl.attachShader(
        p,
        compile(
          gl.FRAGMENT_SHADER,
          `precision highp float;varying vec3 captured;varying vec3 capturedNormal;varying vec2 projected;
      uniform float axis;uniform vec4 u_leaf;
      void main(){float v=axis<0.5?captured.x/u_leaf.z:(axis<1.5?captured.y/u_leaf.w:(axis<2.5?captured.z/u_leaf.z:(axis<3.5?capturedNormal.x:(axis<4.5?capturedNormal.y:(axis<5.5?capturedNormal.z:(axis<6.5?projected.x:projected.y))))));
        float q=floor(clamp(0.5+v*0.125,0.0,1.0)*16777215.0+0.5);
        float hi=floor(q/65536.0),mid=floor(mod(q,65536.0)/256.0),lo=mod(q,256.0);
        gl_FragColor=vec4(hi,mid,lo,255.0)/255.0;}`,
        ),
      );
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p));
      gl.useProgram(p);
      gl.disable(gl.DITHER);
      const uniforms = {};
      for (
        let i = 0;
        i < live.getProgramParameter(program, live.ACTIVE_UNIFORMS);
        i++
      ) {
        const u = live.getActiveUniform(program, i),
          value = live.getUniform(
            program,
            live.getUniformLocation(program, u.name),
          );
        uniforms[u.name] = ArrayBuffer.isView(value)
          ? Array.from(value)
          : value;
        const loc = gl.getUniformLocation(p, u.name);
        if (loc === null) continue;
        if (u.type === gl.FLOAT) gl.uniform1f(loc, value);
        else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(loc, value);
        else if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(loc, value);
      }
      const uv = [];
      for (let y = 0; y <= 24; y++)
        for (let x = 0; x <= 96; x++) uv.push(x / 96, y / 24);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(p, "a_uv");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 97, 25);
      const points = Array.from({ length: 97 * 25 }, () => []);
      const grip = [];
      for (let axis = 0; axis < 8; axis++) {
        gl.uniform1f(gl.getUniformLocation(p, "axis"), axis);
        gl.drawArrays(gl.POINTS, 0, 97 * 25);
        const data = new Uint8Array(97 * 25 * 4);
        gl.readPixels(0, 0, 97, 25, gl.RGBA, gl.UNSIGNED_BYTE, data);
        if (axis < 6)
          for (let i = 0; i < points.length; i++)
            points[i][axis] =
              ((data[i * 4] * 65536 + data[i * 4 + 1] * 256 + data[i * 4 + 2]) /
                16777215 -
                0.5) *
              8;
        // Sample the exact material grip, not the nearest mesh row or its
        // self-reported JS pin. Its projected position comes from the shader.
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          new Float32Array([1, uniforms.u_grab]),
        );
        gl.drawArrays(gl.POINTS, 0, 1);
        const one = new Uint8Array(4);
        gl.readPixels(
          96,
          Math.floor(uniforms.u_grab * 24 + 0.5),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          one,
        );
        grip[axis] =
          ((one[0] * 65536 + one[1] * 256 + one[2]) / 16777215 - 0.5) * 8;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([0, 0]));
      }
      const rows = [];
      let minimumTurn = 0,
        localMinimumTurn = 0,
        worst = null;
      for (let y = 0; y <= 24; y++) {
        const row = points.slice(y * 97, (y + 1) * 97),
          angles = [],
          turns = [];
        for (let x = 1; x < 97; x++)
          angles.push(
            Math.atan2(row[x][2] - row[x - 1][2], row[x][0] - row[x - 1][0]),
          );
        for (let x = 1; x < angles.length; x++) {
          let delta = angles[x] - angles[x - 1];
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta < -Math.PI) delta += 2 * Math.PI;
          turns.push(delta);
          if (x <= 12) localMinimumTurn = Math.min(localMinimumTurn, delta);
          if (delta < minimumTurn) {
            minimumTurn = delta;
            worst = { row: y, segment: x, delta };
          }
        }
        rows.push({ y, points: row, minimumTurn: Math.min(...turns) });
      }
      const error = gl.getError();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      const box = document
          .querySelector(selectors.article)
          .getBoundingClientRect(),
        pin = JSON.parse(document.querySelector(selectors.layer).dataset.pin);
      const actualGrip = {
        x: box.left + ((grip[6] + 1) / 2) * uniforms.u_view[0],
        y: box.top + ((1 - grip[7]) / 2) * uniforms.u_view[1],
      };
      const gripError = Math.hypot(actualGrip.x - pin.x, actualGrip.y - pin.y);
      return {
        minimumTurn,
        localMinimumTurn,
        worst,
        rows,
        uniforms,
        error,
        grip,
        actualGrip,
        pin,
        gripError,
      };
    },
    { override, selectors },
  );
}
