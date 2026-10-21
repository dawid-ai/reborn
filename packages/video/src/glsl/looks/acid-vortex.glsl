// @look acid-vortex
// @title Acid Vortex
// @fits drop, switch-up, heavy
// @mood toxic, aggressive, glitchy
// @desc Two interlocking logarithmic spirals being sucked inward, warped by noise that grows with the bass. Snares tear the image into horizontal glitch slices.
// @param colA 0.75,1,0.05   acid colour
// @param colB 1,0.25,0.02   hot colour
// @param arms 5
// @param slices 0.25        glitch slice displacement on snare
// @param base 0.6
// @param kickGain 1.2
// @param snareGain 0.9
// @param punch 0.08
vec3 look(vec2 uv){
  vec2 p = uv*(1.-P_punch*uKick-P_punch*.6*uSnare);
  float sl = floor(p.y*14.+floor(uBeat*2.)*3.);
  p.x += (hash1(sl+floor(uBeat*2.))-.5)*P_slices*uSnare;
  vec2 w = p + .12*(vec2(fbm3(p*2.5+uT*.3), fbm3(p*2.5+9.-uT*.3))-.5)*(1.+2.*uBass);
  float r=length(w)+1e-3, a=atan(w.y,w.x), lr=log(r);
  float s1 = sin(P_arms*a + 7.*lr - uPush*2.2);
  float s2 = sin(-3.*a + 11.*lr - uPush*1.3 + 1.5);
  float band = smoothstep(.65,.95,s1) + .6*smoothstep(.8,.98,s2);
  float edge = exp(-abs(s1-.8)*12.);
  vec3 col = mix(P_colB, P_colA, .5+.5*sin(lr*3.-uPush*.5))*band*.9 + vec3(1.,.95,.7)*edge*.35*(.5+uKick);
  col *= smoothstep(0.,.35,r);
  col += vec3(.06,.0,.03)*fbm3(w*4.);
  return col*(P_base + P_kickGain*uKick + P_snareGain*uSnare);
}
