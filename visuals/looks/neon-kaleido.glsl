// @look neon-kaleido
// @title Neon Kaleido
// @fits drop, peak, bridge, build
// @mood psychedelic, symmetrical, colourful
// @desc A kaleidoscope folded Julia fractal. The Julia constant wobbles with the bass so the shape breathes with a Reese/wobble bass; colour hue steps every few beats. Calm settings make a mandala for bridges; fast spin + strobe make a build.
// @param folds 6         kaleidoscope segments
// @param spin 0          rotation (radians) – use an expression like "t*.15"
// @param zoom 1.25
// @param cAngle 2.5
// @param wobble 0.045    how much the bass bends the fractal
// @param iters 72
// @param hue 0
// @param palD 0.85,0.15,0.55  palette phase offsets (0,0.33,0.67 = rainbow)
// @param base 0.55       brightness between hits
// @param kickGain 1.1
// @param snareGain 0.8
// @param punch 0.09
vec3 look(vec2 uv){
  vec2 p = uv*(1.-P_punch*uKick-P_punch*.55*uSnare);
  vec2 c = juliaC(P_cAngle + P_wobble*uBass + .02*uSub);
  p = kaleido(rot(P_spin)*p, P_folds);
  p = p*P_zoom - vec2(P_zoom*.35, 0.);
  vec3 j = julia(p, c, int(P_iters));
  vec3 col;
  if(j.z<.5){
    float b = 1.-exp(-j.x*.09);
    col = pal(j.x*.035+P_hue, vec3(.5),vec3(.5),vec3(1.),P_palD)*b*b*1.3;
  } else {
    col = pal(j.y*2.+P_hue+.3, vec3(.5),vec3(.5),vec3(1.),P_palD)*exp(-j.y*4.)*.7;
  }
  return col*(P_base + P_kickGain*uKick + P_snareGain*uSnare);
}
