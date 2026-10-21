// Final stack: shake, chromatic aberration, mip bloom, strobe, vignette, whiteout, impact flash,
// text layer (with its own glitch / RGB split), tone-map, fade, grain.
in vec2 vUv; out vec4 frag;
uniform sampler2D uImg, uText;
uniform float uCA, uBloom, uGrain, uFlash, uFade, uStrobe, uWhite, uVig, uT;
uniform float uTextCA, uTextGlitch, uTextOn, uTextBlend;
uniform vec2 uShake, uRes;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec4 textTap(vec2 uv){ return texture(uText, vec2(uv.x, 1.-uv.y)); }
void main(){
  vec2 uv = vUv + uShake;
  vec2 d = uv-.5;
  vec3 col;
  col.r = texture(uImg, uv + d*uCA*2.).r;
  col.g = texture(uImg, uv).g;
  col.b = texture(uImg, uv - d*uCA*2.).b;
  col += (textureLod(uImg, uv, 3.).rgb*.45 + textureLod(uImg, uv, 5.).rgb*.55)*uBloom;
  col *= uStrobe;
  col *= clamp(1. - uVig*1.1*dot(d*vec2(1.2,1.),d*vec2(1.2,1.)), 0., 1.);
  if(uTextOn>0.){
    vec2 tv = vUv + uShake*.5;
    float sl = floor(tv.y*40.);
    tv.x += (hash(vec2(sl, floor(uT*20.)))-.5)*uTextGlitch*step(.7, hash(vec2(sl*.3, floor(uT*12.))));
    vec4 tr = textTap(tv+vec2(uTextCA,0.)), tg = textTap(tv), tb = textTap(tv-vec2(uTextCA,0.));
    vec3 tc = vec3(tr.r*tr.a, tg.g*tg.a, tb.b*tb.a);
    float ta = max(max(tr.a,tg.a),tb.a);
    // blend 0 = normal over, 1 = difference (inverts what's underneath)
    vec3 over = col*(1.-ta) + tc;
    vec3 diff = abs(col - tc);
    col = mix(over, diff, uTextBlend);
  }
  col = mix(col, vec3(1.), clamp(uWhite,0.,1.));
  col += vec3(uFlash);
  col = col*(2.51*col+.03)/(col*(2.43*col+.59)+.14);
  col *= uFade;
  col += (hash(vUv*uRes+fract(uT*7.13))-.5)*uGrain*uFade;
  frag = vec4(clamp(col,0.,1.),1.);
}
