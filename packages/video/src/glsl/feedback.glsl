// Feedback composite: out = max(scene, transformed previous frame * fb). Zoom > 1 trails outward, rot spins them, hue shifts their colour.
in vec2 vUv; out vec4 frag;
uniform sampler2D uScene, uPrev; uniform float uFb, uFbZoom, uFbRot, uFbHue, uAsp;
vec3 hueRot(vec3 c, float a){ const vec3 k=vec3(.57735); float co=cos(a*6.2831853);
  return c*co + cross(k,c)*sin(a*6.2831853) + k*dot(k,c)*(1.-co); }
void main(){
  vec3 sc = texture(uScene, vUv).rgb;
  vec2 c = vUv-.5; c.x*=uAsp; float s=sin(uFbRot), co=cos(uFbRot);
  c = mat2(co,-s,s,co)*c/uFbZoom; c.x/=uAsp;
  vec3 pr = max(hueRot(texture(uPrev, c+.5).rgb, uFbHue), 0.);
  frag = vec4(max(sc, pr*uFb), 1.);
}
