// @look footage-kaleido
// @title Footage Kaleido
// @fits bridge, peak, psychedelic breakdowns
// @mood trippy, mirrored, colour-cycling
// @desc Folds the footage into a rotating kaleidoscope and cycles its colours. Turns any clip (a face, a crowd, waves) into a mandala.
// @param folds 6
// @param spin 0          rotation, e.g. "t*.2"
// @param zoom 0.8
// @param cycle 0.6       amount of hue cycling
// @param speed 0.1       hue cycle speed
// @param base 0.85
// @param kickGain 0.5
vec3 look(vec2 uv){
  vec2 p = kaleido(rot(P_spin)*uv, P_folds)*P_zoom*(1.-.06*uKick);
  p = vec2(p.x - .2, p.y);
  vec3 c = footage(p);
  float l = dot(c, vec3(.299,.587,.114));
  vec3 cyc = pal(l*1.5 + uT*P_speed, vec3(.5),vec3(.5),vec3(1.),vec3(0.,.33,.67));
  c = mix(c, cyc*(.4+.9*l), P_cycle);
  return c*(P_base + P_kickGain*uKick);
}
