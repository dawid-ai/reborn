// @look julia-drift
// @title Julia Drift
// @fits intro, build, outro, breakdown
// @mood bright, sparse, floating; dive mode for builds
// @desc A Julia set fractal that drifts and slowly morphs. Animate `zoom` toward 0 with an expression to dive into it for a build-up. Brightness auto-normalises while zooming (engine hook computes `off`).
// @param cAngle 2.25      Julia constant c = 0.7885*e^(i*cAngle). 2.2-2.45 dendrites, 1.6-1.85 & 2.3 connected spirals, 3.0+ basilica
// @param center 0,0      point the camera looks at (complex plane)
// @param zoom 1.6        half-height of view in the complex plane; smaller = deeper
// @param rot 0           view rotation (radians)
// @param iters 140       max iterations (raise when zooming deep)
// @param hue 0.55        palette phase
// @param warp 0.25       gentle domain-warp wobble
// @param palA 0.55,0.5,0.6
// @param palB 0.45,0.45,0.4
// @param palC 1,1,1
// @param palD 0,0.15,0.25
// @param pump 0          brightness pump on kick (0..1)
// @param off 0           (hook) iteration offset that keeps brightness stable while zooming
vec3 look(vec2 uv){
  vec2 p = uv;
  if(P_warp>0.) p += P_warp*(vec2(fbm3(uv*1.5+uT*.05), fbm3(uv*1.5+5.2-uT*.04))-.5);
  vec2 c = juliaC(P_cAngle);
  vec2 z = P_center + rot(P_rot)*p*P_zoom;
  vec3 j = julia(z, c, int(P_iters));
  float sn = max(j.x-P_off, 0.);
  vec3 col;
  if(j.z<.5){
    float b = 1.-exp(-sn*.07);
    col = pal(sn*.028+P_hue, P_palA,P_palB,P_palC,P_palD) * b*b * 1.25;
  } else {
    col = pal(j.y*1.5+P_hue+.5, P_palA,P_palB,P_palC,P_palD) * exp(-j.y*5.)*.45;
  }
  return col*(1.-P_pump*.25 + P_pump*.55*uKick);
}
