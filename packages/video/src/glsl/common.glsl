// Shared helpers for every look. Engine-provided uniforms (all looks may read them):
//   uRes (px), uT (song s), uL (scene-local s), uLen (scene length s), uX (= uL/uLen, 0..1)
//   uBeat (beats since 0), uBar (bars since 0)
//   audio envelopes 0..~1.2: uSub uBass uMid uAir uRms uHat
//   drum pulses 0..1 (decaying on each hit): uKick uSnare uHatP ; uKT = s since last kick
//   uCut (count of cut events in scene), uCutT (s since last cut)
//   uRise (0..1 riser progress), uPush (camera travel, integrated)
//   uWave: 512x2 (row 0 waveform -1..1, row 1 log spectrum 0..1)
#define PI 3.14159265
#define TAU 6.2831853
uniform vec2 uRes;
uniform float uT, uL, uLen, uX, uBeat, uBar;
uniform float uSub, uBass, uMid, uAir, uRms, uHat;
uniform float uKick, uSnare, uHatP, uKT, uCutT, uRise, uPush;
uniform int uCut;
uniform sampler2D uWave;

mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d){return a+b*cos(TAU*(c*t+d));}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float hash1(float x){return fract(sin(x*127.1)*43758.5453);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p=rot(.5)*p*2.03+11.7;a*=.5;}return s;}
float fbm3(vec2 p){float s=0.,a=.5;for(int i=0;i<3;i++){s+=a*vnoise(p);p=rot(.5)*p*2.03+11.7;a*=.5;}return s/.875;}
vec2 csqrt(vec2 z){float r=length(z); return vec2(sqrt(.5*(r+z.x)), sign(z.y+1e-12)*sqrt(.5*(r-z.x)));}
float wave(float x){return texture(uWave, vec2(fract(x), .25)).r;}
float spec(float x){return texture(uWave, vec2(clamp(x,0.,1.), .75)).r;}
vec3 lum3(vec3 c){return vec3(dot(c, vec3(.299,.587,.114)));}

vec2 kaleido(vec2 uv, float n){
  float a=atan(uv.y,uv.x), r=length(uv), s=PI/n;
  a=mod(a,2.*s); a=abs(a-s);
  return r*vec2(cos(a),sin(a));
}
// Julia iteration: x = smooth iteration count, y = orbit trap, z = 1 if inside
vec3 julia(vec2 z, vec2 c, int maxIt){
  float trap=1e9, n=0., m2=0.;
  for(int i=0;i<500;i++){
    if(i>=maxIt) break;
    z=vec2(z.x*z.x-z.y*z.y, 2.*z.x*z.y)+c;
    m2=dot(z,z);
    trap=min(trap, abs(m2-.25));
    if(m2>1024.) break;
    n+=1.;
  }
  float inside = (m2<=1024.)?1.:0.;
  float sn = n - log2(max(log2(max(m2,1.0001)),1e-4)) + 4.;
  return vec3(sn, trap, inside);
}
vec2 juliaC(float a){ return 0.7885*vec2(cos(a), sin(a)); }

// Footage: the current clip frame (RGB) and its aspect ratio.
uniform sampler2D uFootage;
uniform float uFootAsp;
// Samples the footage with a "cover" fit; uv runs -asp..asp across and -1..1 down.
vec3 footage(vec2 uv){
  float sa = uRes.x/uRes.y;
  vec2 q = uv/vec2(sa,1.);
  if(uFootAsp > sa) q.x *= sa/uFootAsp; else q.y *= uFootAsp/sa;
  return texture(uFootage, vec2(q.x*.5+.5, .5-q.y*.5)).rgb;
}
