// @look vein-tunnel
// @title Vein Tunnel
// @fits drop, heavy
// @mood dark, heavy, organic, pulsing
// @desc Flying down a black tunnel of glowing veins. Veins fatten with the bass envelope, the camera lunges on kicks (set the scene's travel), and the image punches on kick/snare with a shock ring.
// @param thickLo 22         vein sharpness when bass is quiet (higher = thinner)
// @param thickHi 9          vein sharpness at full bass
// @param colA 0.35,0.02,0.25 dim body colour
// @param colB 0.85,0.05,0.18 vein colour
// @param colSnare 1,0.45,0.15 vein colour on snare hits
// @param base 0.3           brightness between hits
// @param kickGain 1.4
// @param snareGain 1.0
// @param punch 0.07         zoom punch on kick
// @param ring 0.6           shock ring strength
vec3 vt_veins(vec2 uv, float push, vec3 cA, vec3 cB, float thick){
  float r=length(uv)+1e-3;
  float a=abs(atan(uv.y,uv.x))/PI;
  float z = .45/r + push;
  vec2 q = vec2(a*3.5, z*.8);
  float w = fbm(q*vec2(1.,.6)+vec2(0.,uT*.15));
  float n = fbm(q*1.3 + 1.7*vec2(w, w*.6));
  float ridge = pow(max(1.-abs(2.*n-1.),0.), thick);
  float ridge2 = pow(max(1.-abs(2.*w-1.),0.), thick*2.5);
  float fog = smoothstep(.05, .7, r)*smoothstep(.0,.25,r);
  return (cA*n*n*n*.3 + cB*(ridge*1.3 + ridge2*.7))*fog;
}
vec3 look(vec2 uv){
  vec2 p = uv*(1.-P_punch*uKick-P_punch*.6*uSnare);
  float thick = mix(P_thickLo, P_thickHi, clamp(uBass,0.,1.));
  vec3 col = vt_veins(p, uPush, P_colA, mix(P_colB, P_colSnare, uSnare), thick);
  col *= P_base + P_kickGain*uKick + P_snareGain*uSnare;
  col += P_colB*1.2*exp(-abs(length(uv)-uKT*2.2)*14.)*uKick*P_ring;
  return col;
}
