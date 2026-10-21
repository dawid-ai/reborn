// @look star-sparkle
// @title Star Sparkle
// @fits layer: intro, bells, hats, any
// @mood twinkling, airy
// @desc Layer. A field of twinkling points that flare with the hi-hats (uHat) and the air band. Use as an additive layer over any look.
// @param density 0.12
// @param color 0.75,0.85,1
// @param gain 1.1          extra brightness with hats
// @param spin 0.02
vec3 look(vec2 uv){
  uv = rot(uT*P_spin)*uv;
  float s=0.;
  for(int l=0;l<2;l++){
    vec2 g = uv*(18.+float(l)*21.) + float(l)*7.3;
    vec2 id=floor(g), f=fract(g)-.5;
    float h=hash(id);
    if(h<P_density){
      vec2 o=vec2(hash(id+3.1),hash(id+8.7))-.5;
      float d=length(f-o*.7);
      float tw = .5+.5*sin(uT*(2.+h*6.)+h*40.);
      s += (.003/(d*d+.003))*tw*tw*smoothstep(.5,.0,d);
    }
  }
  return P_color*s*(.15+P_gain*max(uHat, uAir));
}
