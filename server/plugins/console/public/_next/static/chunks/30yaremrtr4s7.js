(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,96980,e=>{"use strict";let t={sampleWidth:128,sampleHeight:72,downsampleFactor:2,frameRate:0,smoothing:0},i=(e,t,i,r)=>"number"==typeof e&&Number.isFinite(e)?Math.min(r,Math.max(i,e)):t,r=e=>"naturalWidth"in e?[e.naturalWidth,e.naturalHeight]:"videoWidth"in e?[e.videoWidth,e.videoHeight]:"displayWidth"in e?[e.displayWidth,e.displayHeight]:[e.width,e.height],o=`
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`,a=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform float u_offset;
  varying vec2 v_texCoord;

  void main() {
    highp vec2 texelSize = 1.0 / u_resolution;
    highp vec4 color = vec4(0.0);

    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, u_offset) * texelSize);

    gl_FragColor = color * 0.25;
  }
`,s=`
  precision highp float;
  uniform sampler2D u_texture1;
  uniform sampler2D u_texture2;
  uniform float u_blend;
  varying vec2 v_texCoord;

  void main() {
    vec4 color1 = texture2D(u_texture1, v_texCoord);
    vec4 color2 = texture2D(u_texture2, v_texCoord);
    gl_FragColor = mix(color1, color2, u_blend);
  }
`,n=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec3 u_tintColor;
  uniform float u_tintIntensity;
  varying vec2 v_texCoord;

  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // darkMask: 1.0 for black, 0.0 for luma >= 0.5
    float darkMask = 1.0 - smoothstep(0.0, 0.5, luma);

    // Blend dark areas toward tint color
    color.rgb = mix(color.rgb, u_tintColor, darkMask * u_tintIntensity);

    gl_FragColor = color;
  }
`,h=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_time;
  uniform float u_intensity;
  varying vec2 v_texCoord;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 uv = v_texCoord;
    float t = u_time * 0.05;

    vec2 center = uv - 0.5;
    float centerWeight = 1.0 - smoothstep(0.0, 0.7, length(center));

    // Large-scale movement (slow, big blobs)
    float n1 = snoise(uv * 0.35 + vec2(t, t * 0.7));
    float n2 = snoise(uv * 0.35 + vec2(-t * 0.8, t * 0.5) + vec2(50.0, 50.0));

    // Medium-scale detail (adds organic movement)
    float n3 = snoise(uv * 0.9 + vec2(t * 1.2, -t) + vec2(100.0, 0.0));
    float n4 = snoise(uv * 0.9 + vec2(-t, t * 1.1) + vec2(0.0, 100.0));

    // Combine two octaves
    vec2 warp = vec2(
      n1 * 0.65 + n3 * 0.35,
      n2 * 0.65 + n4 * 0.35
    ) * centerWeight;

    vec2 warpedUV = uv + warp * u_intensity;
    warpedUV = clamp(warpedUV, 0.0, 1.0);

    gl_FragColor = texture2D(u_texture, warpedUV);
  }
`,u=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_saturation;
  uniform float u_dithering;
  uniform float u_time;
  uniform float u_scale;
  uniform vec2 u_resolution;
  varying vec2 v_texCoord;

  highp float hash(highp vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec2 uv = (v_texCoord - 0.5) / u_scale + 0.5;
    uv = clamp(uv, 0.0, 1.0);

    vec4 color = texture2D(u_texture, uv);

    vec2 center = v_texCoord - 0.5;
    float vignette = 1.0 - dot(center, center) * 0.3;
    color.rgb *= vignette;

    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(gray), color.rgb, u_saturation);

    highp vec2 pixelPos = floor(v_texCoord * u_resolution);
    highp float noise = hash(vec3(pixelPos, floor(u_time * 60.0)));
    color.rgb += (noise - 0.5) * u_dithering;

    gl_FragColor = color;
  }
`,l=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  varying vec2 v_texCoord;

  void main() {
    vec2 offset = u_texelSize * 0.25;
    gl_FragColor = 0.25 * (
      texture2D(u_texture, v_texCoord + vec2(-offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(-offset.x, offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, offset.y))
    );
  }
`,m=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform sampler2D u_history;
  uniform float u_response;
  uniform float u_minStep;
  varying vec2 v_texCoord;

  void main() {
    vec4 history = texture2D(u_history, v_texCoord);
    vec4 current = texture2D(u_texture, v_texCoord);
    vec4 blended = mix(history, current, u_response);
    vec4 remaining = current - history;
    vec4 minimal = history + sign(remaining) * min(abs(remaining), vec4(u_minStep));
    gl_FragColor = mix(
      minimal,
      blended,
      step(abs(minimal - history), abs(blended - history))
    );
  }
`;class d{canvas;gl;halfFloatExt=null;halfFloatLinearExt=null;blurProgram;blendProgram;tintProgram;warpProgram;outputProgram;positionBuffer;texCoordBuffer;sourceTexture;blurFBO1;blurFBO2;currentAlbumFBO;nextAlbumFBO;warpFBO;animationId=null;lastFrameTime=0;accumulatedTime=0;isPlaying=!1;disposed=!1;isTransitioning=!1;transitionStartTime=0;_transitionDuration;_warpIntensity;_blurPasses;_animationSpeed;_targetAnimationSpeed;_saturation;_tintColor;_tintIntensity;_dithering;_scale;hasImage=!1;gl2;halfFloatRenderTargets=!1;float32RenderTargets=!1;floatLinearFiltering=!1;_highPrecisionOutput=!1;highPrecisionInputRequested;activeSourceTexture;imageSourceWidth=0;imageSourceHeight=0;videoFrameWidth=0;videoFrameHeight=0;video=null;videoLoadCount=0;shownVideoLoad=0;videoOptions={...t};videoCallbackId=null;videoUploadTexture=null;videoStages=[];videoHistory=[];videoHistoryIndex=0;hasVideoHistory=!1;videoHistoryStep=0;videoSampleSlot=-1/0;videoTargetsStale=!0;videoSourceWidth=0;videoSourceHeight=0;videoFrameTime=0;videoMediaTime=0;videoFrameShown=!1;videoFramePending=!1;retainedVideoFrame=null;samplingPrograms=null;sampleTargets=[];sampleTargetsLayout=[0,0,0];pendingSampleSize=0;samplePixelBuffer=null;pendingSample=null;attribs;uniforms;constructor(e,t={}){this.canvas=e;const i={alpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!0,powerPreference:"high-performance"},r=t.highPrecisionInput||t.highPrecisionOutput?e.getContext("webgl2",i):null,l=r??e.getContext("webgl",i);if(!l)throw Error("WebGL not supported");this.gl=l,this.gl2=r,this.highPrecisionInputRequested=!!r&&!!t.highPrecisionInput,this.halfFloatExt=l.getExtension("OES_texture_half_float"),this.halfFloatLinearExt=l.getExtension("OES_texture_half_float_linear"),r&&(this.float32RenderTargets=!!r.getExtension("EXT_color_buffer_float"),this.halfFloatRenderTargets=this.float32RenderTargets||!!r.getExtension("EXT_color_buffer_half_float"),this.floatLinearFiltering=!!r.getExtension("OES_texture_float_linear")),this._warpIntensity=t.warpIntensity??1,this._blurPasses=t.blurPasses??8,this._animationSpeed=t.animationSpeed??1,this._targetAnimationSpeed=this._animationSpeed,this._transitionDuration=t.transitionDuration??1e3,this._saturation=t.saturation??1.5,this._tintColor=t.tintColor??[.157,.157,.235],this._tintIntensity=t.tintIntensity??.15,this._dithering=t.dithering??.008,this._scale=t.scale??1,this.blurProgram=this.createProgram(o,a),this.blendProgram=this.createProgram(o,s),this.tintProgram=this.createProgram(o,n),this.warpProgram=this.createProgram(o,h),this.outputProgram=this.createProgram(o,u),this.attribs={position:l.getAttribLocation(this.blurProgram,"a_position"),texCoord:l.getAttribLocation(this.blurProgram,"a_texCoord")},this.uniforms={blur:{resolution:l.getUniformLocation(this.blurProgram,"u_resolution"),texture:l.getUniformLocation(this.blurProgram,"u_texture"),offset:l.getUniformLocation(this.blurProgram,"u_offset")},blend:{texture1:l.getUniformLocation(this.blendProgram,"u_texture1"),texture2:l.getUniformLocation(this.blendProgram,"u_texture2"),blend:l.getUniformLocation(this.blendProgram,"u_blend")},warp:{texture:l.getUniformLocation(this.warpProgram,"u_texture"),time:l.getUniformLocation(this.warpProgram,"u_time"),intensity:l.getUniformLocation(this.warpProgram,"u_intensity")},tint:{texture:l.getUniformLocation(this.tintProgram,"u_texture"),tintColor:l.getUniformLocation(this.tintProgram,"u_tintColor"),tintIntensity:l.getUniformLocation(this.tintProgram,"u_tintIntensity")},output:{texture:l.getUniformLocation(this.outputProgram,"u_texture"),saturation:l.getUniformLocation(this.outputProgram,"u_saturation"),dithering:l.getUniformLocation(this.outputProgram,"u_dithering"),time:l.getUniformLocation(this.outputProgram,"u_time"),scale:l.getUniformLocation(this.outputProgram,"u_scale"),resolution:l.getUniformLocation(this.outputProgram,"u_resolution")}},this.positionBuffer=this.createBuffer(new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1])),this.texCoordBuffer=this.createBuffer(new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1])),this.sourceTexture=this.createTexture(),this.activeSourceTexture=this.sourceTexture,this.blurFBO1=this.createFramebuffer(128,128,!0),this.blurFBO2=this.createFramebuffer(128,128,!0),this.currentAlbumFBO=this.createFramebuffer(128,128,!0),this.nextAlbumFBO=this.createFramebuffer(128,128,!0);const m=Math.max(1,e.width||640),d=Math.max(1,e.height||360);this.warpFBO=this.createFramebuffer(m,d,!0),t.highPrecisionOutput&&this.applyFloatDrawingBuffer()}get highPrecisionOutput(){return this._highPrecisionOutput}get highPrecisionInput(){return this.highPrecisionInputRequested&&this.float32RenderTargets}get warpIntensity(){return this._warpIntensity}set warpIntensity(e){this._warpIntensity=Math.max(0,Math.min(1,e))}get blurPasses(){return this._blurPasses}set blurPasses(e){let t=Math.max(0,Math.min(40,Math.floor(e)));t!==this._blurPasses&&(this._blurPasses=t,this.hasImage&&this.reblurCurrentImage())}get animationSpeed(){return this._targetAnimationSpeed}set animationSpeed(e){this._targetAnimationSpeed=Math.max(0,Math.min(16,e))}get transitionDuration(){return this._transitionDuration}set transitionDuration(e){this._transitionDuration=Math.max(0,Math.min(5e3,e))}get saturation(){return this._saturation}set saturation(e){this._saturation=Math.max(0,Math.min(3,e))}get tintColor(){return this._tintColor}set tintColor(e){let t=e.map(e=>Math.max(0,Math.min(1,e)));t.some((e,t)=>e!==this._tintColor[t])&&(this._tintColor=t,this.hasImage&&this.reblurCurrentImage())}get tintIntensity(){return this._tintIntensity}set tintIntensity(e){let t=Math.max(0,Math.min(1,e));t!==this._tintIntensity&&(this._tintIntensity=t,this.hasImage&&this.reblurCurrentImage())}get dithering(){return this._dithering}set dithering(e){this._dithering=Math.max(0,Math.min(.1,e))}get scale(){return this._scale}set scale(e){this._scale=Math.max(.01,Math.min(4,e))}setOptions(e){void 0!==e.warpIntensity&&(this.warpIntensity=e.warpIntensity),void 0!==e.blurPasses&&(this.blurPasses=e.blurPasses),void 0!==e.animationSpeed&&(this.animationSpeed=e.animationSpeed),void 0!==e.transitionDuration&&(this.transitionDuration=e.transitionDuration),void 0!==e.saturation&&(this.saturation=e.saturation),void 0!==e.tintColor&&(this.tintColor=e.tintColor),void 0!==e.tintIntensity&&(this.tintIntensity=e.tintIntensity),void 0!==e.dithering&&(this.dithering=e.dithering),void 0!==e.scale&&(this.scale=e.scale)}getOptions(){return{warpIntensity:this._warpIntensity,blurPasses:this._blurPasses,animationSpeed:this._targetAnimationSpeed,transitionDuration:this._transitionDuration,saturation:this._saturation,tintColor:this._tintColor,tintIntensity:this._tintIntensity,dithering:this._dithering,scale:this._scale}}async loadImage(e){if(!e)return;let t=this.videoLoadCount,i=null;try{let t=await fetch(e,{mode:"cors"});if(t.ok){let e=await t.blob();i=await createImageBitmap(e)}}catch{}if(i||(i=await new Promise((t,i)=>{let r=new Image;r.crossOrigin="anonymous",r.onload=()=>t(r),r.onerror=()=>i(Error(`Failed to load image: ${e}`)),r.src=e})),this.disposed||this.shownVideoLoad>t){"close"in i&&i.close();return}let o=!!this.video&&this.videoLoadCount!==t,a=this.gl;a.bindTexture(a.TEXTURE_2D,this.sourceTexture),a.pixelStorei(a.UNPACK_FLIP_Y_WEBGL,0),a.texImage2D(a.TEXTURE_2D,0,a.RGBA,a.RGBA,a.UNSIGNED_BYTE,i),[this.imageSourceWidth,this.imageSourceHeight]=r(i),"close"in i&&"function"==typeof i.close&&i.close(),this.processNewImage(this.sourceTexture,o)}loadImageElement(e){this.showImageElement(e,!1)}showImageElement(e,t){this.gl.bindTexture(this.gl.TEXTURE_2D,this.sourceTexture),this.gl.texImage2D(this.gl.TEXTURE_2D,0,this.gl.RGBA,this.gl.RGBA,this.gl.UNSIGNED_BYTE,e),[this.imageSourceWidth,this.imageSourceHeight]=r(e),this.processNewImage(this.sourceTexture,t)}loadImageData(e,t,i){this.gl.bindTexture(this.gl.TEXTURE_2D,this.sourceTexture),this.gl.texImage2D(this.gl.TEXTURE_2D,0,this.gl.RGBA,t,i,0,this.gl.RGBA,this.gl.UNSIGNED_BYTE,e instanceof Uint8ClampedArray?new Uint8Array(e.buffer):e),this.imageSourceWidth=t,this.imageSourceHeight=i,this.processNewImage()}loadFromImageData(e){this.loadImageData(e.data,e.width,e.height)}async loadBlob(e){let t=this.videoLoadCount,i=await createImageBitmap(e);if(this.disposed||this.shownVideoLoad>t)return void i.close();let r=!!this.video&&this.videoLoadCount!==t;this.showImageElement(i,r),i.close()}loadBase64(e){let t=e.startsWith("data:")?e:`data:image/png;base64,${e}`;return this.loadImage(t)}async loadArrayBuffer(e,t="image/png"){let i=new Blob([e],{type:t});return this.loadBlob(i)}loadGradient(e,t=135){let i=document.createElement("canvas");i.width=512,i.height=512;let r=i.getContext("2d");if(!r)return;let o=t*Math.PI/180,a=256-512*Math.cos(o),s=256-512*Math.sin(o),n=256+512*Math.cos(o),h=256+512*Math.sin(o),u=r.createLinearGradient(a,s,n,h);e.forEach((t,i)=>{u.addColorStop(i/(e.length-1),t)}),r.fillStyle=u,r.fillRect(0,0,512,512),this.loadImageElement(i)}loadVideo(e,r={}){if(this.disposed)return;if("function"!=typeof e.requestVideoFrameCallback)throw Error("Video sources require requestVideoFrameCallback");let o=this.video!==e;o&&(this.videoLoadCount++,this.unloadVideo(),this.video=e,this.videoFrameShown=!1,this.hasVideoHistory=!1,this.videoSampleSlot=-1/0);let a={sampleWidth:Math.round(i(r.sampleWidth,t.sampleWidth,1,1024)),sampleHeight:Math.round(i(r.sampleHeight,t.sampleHeight,1,1024)),downsampleFactor:i(r.downsampleFactor,t.downsampleFactor,1.25,4),frameRate:i(r.frameRate,t.frameRate,0,240),smoothing:i(r.smoothing,t.smoothing,0,1e4),onError:r.onError},s=this.videoOptions;(o||a.sampleWidth!==s.sampleWidth||a.sampleHeight!==s.sampleHeight||a.downsampleFactor!==s.downsampleFactor||a.smoothing>0!=s.smoothing>0)&&(this.videoTargetsStale=!0),this.videoOptions=a,this.requestVideoFrame(),e.readyState>=e.HAVE_CURRENT_DATA&&(o||e.paused&&this.videoTargetsStale)&&this.processVideoFrame(performance.now(),e.currentTime)}unloadVideo(){let e=this.video;e&&(null!==this.videoCallbackId&&(e.cancelVideoFrameCallback(this.videoCallbackId),this.videoCallbackId=null),e.removeEventListener("pause",this.resumeVideoCallbacks),this.video=null,this.videoFramePending=!1,this.releaseVideoTargets(),this.videoUploadTexture&&(this.gl.deleteTexture(this.videoUploadTexture),this.videoUploadTexture=null))}sampleSource(e=32){if(this.disposed||!this.hasImage)return Promise.resolve(null);let t=Math.round(i(e,32,1,128));if(this.pendingSample)return this.pendingSampleSize===t?this.pendingSample:this.pendingSample.then(()=>this.sampleSource(t));let r=this.gl,[o,a]=this.activeSourceTexture===this.sourceTexture?[this.imageSourceWidth,this.imageSourceHeight]:[this.videoFrameWidth,this.videoFrameHeight];this.prepareSampleTargets(o,a,t);let s=this.activeSourceTexture;for(let e of this.sampleTargets)this.drawDownsample(s,e),s=e.texture;let n=new Uint8Array(t*t*4),h=this.gl2;if(!h)return r.readPixels(0,0,t,t,r.RGBA,r.UNSIGNED_BYTE,n),Promise.resolve(n);this.samplePixelBuffer??=h.createBuffer(),h.bindBuffer(h.PIXEL_PACK_BUFFER,this.samplePixelBuffer),h.bufferData(h.PIXEL_PACK_BUFFER,n.byteLength,h.STREAM_READ),h.readPixels(0,0,t,t,h.RGBA,h.UNSIGNED_BYTE,0),h.bindBuffer(h.PIXEL_PACK_BUFFER,null);let u=h.fenceSync(h.SYNC_GPU_COMMANDS_COMPLETE,0);if(!u)return Promise.resolve(null);h.flush();let l=new Promise(e=>{let t=()=>{if(this.disposed){h.deleteSync(u),e(null);return}let i=h.clientWaitSync(u,0,0);i===h.TIMEOUT_EXPIRED?setTimeout(t,4):(h.deleteSync(u),i===h.WAIT_FAILED)?e(null):(h.bindBuffer(h.PIXEL_PACK_BUFFER,this.samplePixelBuffer),h.getBufferSubData(h.PIXEL_PACK_BUFFER,0,n),h.bindBuffer(h.PIXEL_PACK_BUFFER,null),e(n))};setTimeout(t,0)}).finally(()=>{this.pendingSample=null});return this.pendingSample=l,this.pendingSampleSize=t,l}prepareSampleTargets(e,t,i){let[r,o,a]=this.sampleTargetsLayout;if(e===r&&t===o&&i===a)return;for(let e of this.sampleTargets)this.deleteFramebuffer(e);this.sampleTargets=[];let s=e,n=t;for(;s>2*i||n>2*i;)s=Math.max(i,Math.ceil(s/2)),n=Math.max(i,Math.ceil(n/2)),this.sampleTargets.push(this.createByteFramebuffer(s,n));this.sampleTargets.push(this.createByteFramebuffer(i,i)),this.sampleTargetsLayout=[e,t,i]}createByteFramebuffer(e,t){return this.gl2?this.createSizedFramebuffer(e,t,this.gl2.RGBA8):this.createFramebuffer(e,t)}requestVideoFrame(){this.video&&null===this.videoCallbackId&&(this.videoCallbackId=this.video.requestVideoFrameCallback(this.handleVideoFrame))}handleVideoFrame=(e,t)=>{this.videoCallbackId=null;let i=this.video;if(!i||this.disposed)return;if(!this.isPlaying&&!i.paused){this.videoFramePending=!0,i.addEventListener("pause",this.resumeVideoCallbacks,{once:!0});return}this.requestVideoFrame();let{frameRate:r}=this.videoOptions;r>0&&!i.paused&&e<this.videoSampleSlot+1e3/r*.75||this.processVideoFrame(e,t.mediaTime)};resumeVideoCallbacks=()=>{this.requestVideoFrame()};processVideoFrame(e,t){let i=this.video;if(!i||i.readyState<i.HAVE_CURRENT_DATA||0===i.videoWidth||0===i.videoHeight)return;let r=this.gl,o=e-this.videoFrameTime;try{this.prepareVideoTargets(i.videoWidth,i.videoHeight),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,this.videoUploadTexture),r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!0),r.texImage2D(r.TEXTURE_2D,0,r.RGBA,r.RGBA,r.UNSIGNED_BYTE,i)}catch(t){let{onError:e}=this.videoOptions;this.unloadVideo(),e?.(t);return}finally{r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!1)}let a=this.videoUploadTexture;for(let e of this.videoStages)this.drawDownsample(a,e),a=e.texture;let{smoothing:s}=this.videoOptions;if(s>0){let e=o/1e3*i.playbackRate,r=Math.abs(t-this.videoMediaTime-e)>.25,n=!this.hasVideoHistory||i.paused||r?1:1-Math.exp(-Math.max(0,o)/s);a=this.drawSmoothing(a,n),this.hasVideoHistory=!0}else this.hasVideoHistory=!1;let{frameRate:n}=this.videoOptions;if(n>0){let t=1e3/n;this.videoSampleSlot=e-this.videoSampleSlot>2*t?e:this.videoSampleSlot+t}this.videoFrameTime=e,this.videoMediaTime=t,this.videoFrameWidth=this.videoOptions.sampleWidth,this.videoFrameHeight=this.videoOptions.sampleHeight,this.showVideoFrame(a)}showVideoFrame(e){this.videoFrameShown?(this.activeSourceTexture=e,this.releaseRetainedVideoFrame(),this.blurSourceInto(this.nextAlbumFBO)):(this.videoFrameShown=!0,this.shownVideoLoad=this.videoLoadCount,this.processNewImage(e),this.isPlaying||(this.isTransitioning=!1)),this.isPlaying||this.render(this.accumulatedTime)}prepareVideoTargets(e,t){if(!this.videoTargetsStale&&e===this.videoSourceWidth&&t===this.videoSourceHeight)return;this.releaseVideoTargets(),this.videoUploadTexture??=this.createTexture();let{sampleWidth:i,sampleHeight:r,downsampleFactor:o,smoothing:a}=this.videoOptions,s=e,n=t;for(;s>i*o||n>r*o;){let e=Math.max(i,Math.ceil(s/o)),t=Math.max(r,Math.ceil(n/o));if(e===s&&t===n)break;s=e,n=t,this.videoStages.push(this.createFramebuffer(s,n,!0))}if(this.videoStages.push(this.createFramebuffer(i,r,!0)),a>0){let e=this.highPrecisionInputRequested&&this.float32RenderTargets;for(let t=0;t<2;t++)this.videoHistory.push(this.gl2&&e?this.createSizedFramebuffer(i,r,this.gl2.RGBA32F):this.createFramebuffer(i,r,!0));let t=this.gl2?this.halfFloatRenderTargets:!!(this.halfFloatExt&&this.halfFloatLinearExt);this.videoHistoryStep=e?this.float32RenderTargets?0:1/255:t?1/1024:1/255}this.hasVideoHistory=!1,this.videoSourceWidth=e,this.videoSourceHeight=t,this.videoTargetsStale=!1}releaseVideoTargets(){for(let e of[...this.videoStages,...this.videoHistory])e.texture===this.activeSourceTexture?(this.releaseRetainedVideoFrame(),this.retainedVideoFrame=e):this.deleteFramebuffer(e);this.videoStages=[],this.videoHistory=[],this.videoTargetsStale=!0}releaseRetainedVideoFrame(){this.retainedVideoFrame&&this.retainedVideoFrame.texture!==this.activeSourceTexture&&(this.deleteFramebuffer(this.retainedVideoFrame),this.retainedVideoFrame=null)}getSamplingPrograms(){if(this.samplingPrograms)return this.samplingPrograms;let e=this.gl,t=this.createProgram(o,l),i=this.createProgram(o,m);return this.samplingPrograms={downsample:t,smoothing:i,downsampleUniforms:{texture:e.getUniformLocation(t,"u_texture"),texelSize:e.getUniformLocation(t,"u_texelSize")},smoothingUniforms:{texture:e.getUniformLocation(i,"u_texture"),history:e.getUniformLocation(i,"u_history"),response:e.getUniformLocation(i,"u_response"),minStep:e.getUniformLocation(i,"u_minStep")}},this.samplingPrograms}drawDownsample(e,t){let i=this.gl,r=this.getSamplingPrograms();i.useProgram(r.downsample),this.setupAttributes(),i.bindFramebuffer(i.FRAMEBUFFER,t.framebuffer),i.viewport(0,0,t.width,t.height),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,e),i.uniform1i(r.downsampleUniforms.texture,0),i.uniform2f(r.downsampleUniforms.texelSize,1/t.width,1/t.height),i.drawArrays(i.TRIANGLES,0,6)}drawSmoothing(e,t){let i=this.gl,r=this.getSamplingPrograms(),o=this.videoHistory[this.videoHistoryIndex];this.videoHistoryIndex=1-this.videoHistoryIndex;let a=this.videoHistory[this.videoHistoryIndex];return o&&a?(i.useProgram(r.smoothing),this.setupAttributes(),i.bindFramebuffer(i.FRAMEBUFFER,a.framebuffer),i.viewport(0,0,a.width,a.height),i.activeTexture(i.TEXTURE1),i.bindTexture(i.TEXTURE_2D,o.texture),i.uniform1i(r.smoothingUniforms.history,1),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,e),i.uniform1i(r.smoothingUniforms.texture,0),i.uniform1f(r.smoothingUniforms.response,t),i.uniform1f(r.smoothingUniforms.minStep,this.videoHistoryStep),i.drawArrays(i.TRIANGLES,0,6),a.texture):e}processNewImage(e=this.sourceTexture,t=!1){if(e!==this.sourceTexture||t||this.unloadVideo(),this.activeSourceTexture=e,this.releaseRetainedVideoFrame(),!this.hasImage){this.blurSourceInto(this.nextAlbumFBO),this.blurSourceInto(this.currentAlbumFBO),this.hasImage=!0,this.isTransitioning=!1;return}let i=this.currentAlbumFBO;this.currentAlbumFBO=this.nextAlbumFBO,this.nextAlbumFBO=i,this.blurSourceInto(this.nextAlbumFBO),this.isTransitioning=!0,this.transitionStartTime=performance.now()}reblurCurrentImage(){this.blurSourceInto(this.nextAlbumFBO)}blurSourceInto(e){let t=this.gl;t.useProgram(this.tintProgram),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,this.blurFBO1.framebuffer),t.viewport(0,0,128,128),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.activeSourceTexture),t.uniform1i(this.uniforms.tint.texture,0),t.uniform3fv(this.uniforms.tint.tintColor,this._tintColor),t.uniform1f(this.uniforms.tint.tintIntensity,this._tintIntensity),t.drawArrays(t.TRIANGLES,0,6),t.useProgram(this.blurProgram),this.setupAttributes(),t.uniform2f(this.uniforms.blur.resolution,128,128),t.uniform1i(this.uniforms.blur.texture,0);let i=this.blurFBO1,r=this.blurFBO2;for(let e=0;e<this._blurPasses;e++){t.bindFramebuffer(t.FRAMEBUFFER,r.framebuffer),t.viewport(0,0,128,128),t.bindTexture(t.TEXTURE_2D,i.texture),t.uniform1f(this.uniforms.blur.offset,e+.5),t.drawArrays(t.TRIANGLES,0,6);let o=i;i=r,r=o}t.bindFramebuffer(t.FRAMEBUFFER,e.framebuffer),t.viewport(0,0,128,128),t.bindTexture(t.TEXTURE_2D,i.texture),t.uniform1f(this.uniforms.blur.offset,0),t.drawArrays(t.TRIANGLES,0,6)}resize(){let e=Math.max(1,this.canvas.width),t=Math.max(1,this.canvas.height);(this.warpFBO.width!==e||this.warpFBO.height!==t)&&(this.warpFBO&&this.deleteFramebuffer(this.warpFBO),this.warpFBO=this.createFramebuffer(e,t,!0))}start(){this.disposed||this.isPlaying||(this.isPlaying=!0,this.lastFrameTime=performance.now(),this.video&&(this.video.removeEventListener("pause",this.resumeVideoCallbacks),this.requestVideoFrame(),this.videoFramePending&&(this.videoFramePending=!1,this.processVideoFrame(this.lastFrameTime,this.video.currentTime))),this.animationId=requestAnimationFrame(this.renderLoop))}stop(){this.isPlaying=!1,null!==this.animationId&&(cancelAnimationFrame(this.animationId),this.animationId=null)}renderFrame(e){let t=performance.now();if(void 0!==e)this.render(e,t);else{let e=(t-this.lastFrameTime)/1e3;this.lastFrameTime=t,this._animationSpeed+=(this._targetAnimationSpeed-this._animationSpeed)*.05,this.accumulatedTime+=e*this._animationSpeed,this.render(this.accumulatedTime,t)}}dispose(){if(this.disposed)return;this.disposed=!0,this.stop(),this.unloadVideo();let e=this.gl;for(let e of(this.retainedVideoFrame&&this.deleteFramebuffer(this.retainedVideoFrame),this.sampleTargets))this.deleteFramebuffer(e);this.samplingPrograms&&(e.deleteProgram(this.samplingPrograms.downsample),e.deleteProgram(this.samplingPrograms.smoothing)),this.gl2?.deleteBuffer(this.samplePixelBuffer),e.deleteProgram(this.blurProgram),e.deleteProgram(this.blendProgram),e.deleteProgram(this.tintProgram),e.deleteProgram(this.warpProgram),e.deleteProgram(this.outputProgram),e.deleteBuffer(this.positionBuffer),e.deleteBuffer(this.texCoordBuffer),e.deleteTexture(this.sourceTexture),this.deleteFramebuffer(this.blurFBO1),this.deleteFramebuffer(this.blurFBO2),this.deleteFramebuffer(this.currentAlbumFBO),this.deleteFramebuffer(this.nextAlbumFBO),this.deleteFramebuffer(this.warpFBO)}renderLoop=e=>{if(!this.isPlaying)return;let t=(e-this.lastFrameTime)/1e3;this.lastFrameTime=e,this._animationSpeed+=(this._targetAnimationSpeed-this._animationSpeed)*.05,this.accumulatedTime+=t*this._animationSpeed,this.render(this.accumulatedTime,e),this.animationId=requestAnimationFrame(this.renderLoop)};render(e,t=performance.now()){let i;if(this.disposed||!this.hasImage)return;let r=this.gl,o=Math.max(1,this.canvas.width),a=Math.max(1,this.canvas.height);(this.warpFBO.width!==o||this.warpFBO.height!==a)&&(this.deleteFramebuffer(this.warpFBO),this.warpFBO=this.createFramebuffer(o,a,!0));let s=1;if(this.isTransitioning){let e=Math.max(0,t-this.transitionStartTime);(s=this._transitionDuration>0?Math.min(1,e/this._transitionDuration):1)>=1&&(this.isTransitioning=!1)}if(this.isTransitioning&&s<1){r.useProgram(this.blendProgram),this.setupAttributes(),r.bindFramebuffer(r.FRAMEBUFFER,this.blurFBO1.framebuffer),r.viewport(0,0,128,128),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,this.currentAlbumFBO.texture),r.uniform1i(this.uniforms.blend.texture1,0),r.activeTexture(r.TEXTURE1),r.bindTexture(r.TEXTURE_2D,this.nextAlbumFBO.texture),r.uniform1i(this.uniforms.blend.texture2,1);let e=.5-.5*Math.cos(s*Math.PI);r.uniform1f(this.uniforms.blend.blend,e),r.drawArrays(r.TRIANGLES,0,6),i=this.blurFBO1.texture}else i=this.nextAlbumFBO.texture;r.useProgram(this.warpProgram),this.setupAttributes(),r.bindFramebuffer(r.FRAMEBUFFER,this.warpFBO.framebuffer),r.viewport(0,0,o,a),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,i),r.uniform1i(this.uniforms.warp.texture,0),r.uniform1f(this.uniforms.warp.time,e),r.uniform1f(this.uniforms.warp.intensity,this._warpIntensity),r.drawArrays(r.TRIANGLES,0,6),r.useProgram(this.outputProgram),this.setupAttributes(),r.bindFramebuffer(r.FRAMEBUFFER,null),r.viewport(0,0,o,a),r.bindTexture(r.TEXTURE_2D,this.warpFBO.texture),r.uniform1i(this.uniforms.output.texture,0),r.uniform1f(this.uniforms.output.saturation,this._saturation),r.uniform1f(this.uniforms.output.dithering,this._dithering),r.uniform1f(this.uniforms.output.time,e),r.uniform1f(this.uniforms.output.scale,this._scale),r.uniform2f(this.uniforms.output.resolution,o,a),r.drawArrays(r.TRIANGLES,0,6)}setupAttributes(){let e=this.gl;e.bindBuffer(e.ARRAY_BUFFER,this.positionBuffer),e.enableVertexAttribArray(this.attribs.position),e.vertexAttribPointer(this.attribs.position,2,e.FLOAT,!1,0,0),e.bindBuffer(e.ARRAY_BUFFER,this.texCoordBuffer),e.enableVertexAttribArray(this.attribs.texCoord),e.vertexAttribPointer(this.attribs.texCoord,2,e.FLOAT,!1,0,0)}createShader(e,t){let i=this.gl,r=i.createShader(e);if(!r)throw Error("Failed to create shader");if(i.shaderSource(r,this.gl2&&e===i.FRAGMENT_SHADER?`precision highp sampler2D;
${t}`:t),i.compileShader(r),!i.getShaderParameter(r,i.COMPILE_STATUS)){let e=i.getShaderInfoLog(r);throw i.deleteShader(r),Error(`Shader compile error: ${e}`)}return r}createProgram(e,t){let i=this.gl,r=this.createShader(i.VERTEX_SHADER,e),o=this.createShader(i.FRAGMENT_SHADER,t),a=i.createProgram();if(!a)throw Error("Failed to create program");if(i.attachShader(a,r),i.attachShader(a,o),i.linkProgram(a),!i.getProgramParameter(a,i.LINK_STATUS)){let e=i.getProgramInfoLog(a);throw i.deleteProgram(a),Error(`Program link error: ${e}`)}return i.deleteShader(r),i.deleteShader(o),a}createBuffer(e){let t=this.gl,i=t.createBuffer();if(!i)throw Error("Failed to create buffer");return t.bindBuffer(t.ARRAY_BUFFER,i),t.bufferData(t.ARRAY_BUFFER,e,t.STATIC_DRAW),i}createTexture(){let e=this.gl,t=e.createTexture();if(!t)throw Error("Failed to create texture");return e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),t}createFramebuffer(e,t,i=!1){if(this.gl2)return this.createSizedFramebuffer(e,t,i&&this.halfFloatRenderTargets?this.gl2.RGBA16F:this.gl2.RGBA8);let r=this.gl,o=this.createTexture(),a=i&&this.halfFloatExt&&this.halfFloatLinearExt?this.halfFloatExt.HALF_FLOAT_OES:r.UNSIGNED_BYTE;r.texImage2D(r.TEXTURE_2D,0,r.RGBA,e,t,0,r.RGBA,a,null);let s=r.createFramebuffer();if(!s)throw Error("Failed to create framebuffer");return r.bindFramebuffer(r.FRAMEBUFFER,s),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,o,0),{framebuffer:s,texture:o,width:e,height:t}}createSizedFramebuffer(e,t,i){let r=this.gl2,o=this.createTexture(),a=i===r.RGBA32F?r.FLOAT:i===r.RGBA16F?r.HALF_FLOAT:r.UNSIGNED_BYTE;i!==r.RGBA32F||this.floatLinearFiltering||(r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.NEAREST),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.NEAREST)),r.texImage2D(r.TEXTURE_2D,0,i,e,t,0,r.RGBA,a,null);let s=r.createFramebuffer();if(!s)throw Error("Failed to create framebuffer");return r.bindFramebuffer(r.FRAMEBUFFER,s),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,o,0),i!==r.RGBA8&&r.checkFramebufferStatus(r.FRAMEBUFFER)!==r.FRAMEBUFFER_COMPLETE&&(i===r.RGBA32F?this.float32RenderTargets=!1:this.halfFloatRenderTargets=!1,r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.LINEAR),r.texImage2D(r.TEXTURE_2D,0,r.RGBA8,e,t,0,r.RGBA,r.UNSIGNED_BYTE,null)),{framebuffer:s,texture:o,width:e,height:t}}applyFloatDrawingBuffer(){let e=this.gl2;e?.drawingBufferStorage&&this.halfFloatRenderTargets&&(e.drawingBufferStorage(e.RGBA16F,Math.max(1,this.canvas.width),Math.max(1,this.canvas.height)),this._highPrecisionOutput=e.drawingBufferFormat===e.RGBA16F)}deleteFramebuffer(e){this.gl.deleteFramebuffer(e.framebuffer),this.gl.deleteTexture(e.texture)}}e.s(["Kawarp",0,d])}]);