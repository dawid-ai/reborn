// @look footage-grade
// @title Footage Grade
// @fits any section with stock footage
// @mood cinematic → aggressive, depending on settings
// @desc Plays the scene's footage clips (cut on the scene's cutOn events) through a grading stack: saturation/contrast, optional duotone, posterise, zoom punch, RGB split, snare invert and a VHS layer (scanlines, chroma bleed, tracking wobble).
// @param sat 1            saturation
// @param contrast 1.1
// @param bright 1
// @param duo 0            0 = natural colour, 1 = full duotone
// @param dark 0.05,0,0.12 duotone shadow colour
// @param light 1,0.35,0.6 duotone highlight colour
// @param poster 0         posterise levels (0 = off, try 4-6)
// @param zoom 1           base zoom (1.15-1.2 crops corner watermarks)
// @param punch 0.06       zoom punch on kick
// @param drift 0.04       slow push-in over each clip
// @param split 0.004      RGB split (plus more on kick)
// @param invert 0         invert on snare (0..1)
// @param vhs 0.5          scanlines, chroma bleed, tracking wobble
// @param kickGain 0.35    brightness flash on kick
vec3 fg_tap(vec2 uv){ return footage(uv); }
vec3 look(vec2 uv){
  float zoom = (1. - P_punch*uKick - P_drift*min(uCutT/4.,1.))/P_zoom;
  vec2 p = uv*zoom;
  // VHS tracking wobble: per-line horizontal jitter, bigger in bands
  float line = floor((uv.y*.5+.5)*uRes.y/2.);
  float band = smoothstep(.97,1.,sin(uv.y*3.+uT*1.7));
  p.x += P_vhs*((hash1(line+floor(uT*30.))-.5)*.004 + band*.03*(hash1(floor(uT*15.))-.5));
  float s = P_split*(1.+5.*uKick) + P_vhs*.003;
  vec3 col;
  col.r = fg_tap(p+vec2(s,0.)).r;
  col.g = fg_tap(p).g;
  col.b = fg_tap(p-vec2(s,0.)).b;
  // grade
  col = mix(lum3(col), col, P_sat);
  col = (col-.5)*P_contrast+.5;
  col *= P_bright;
  float l = dot(clamp(col,0.,1.), vec3(.299,.587,.114));
  col = mix(col, mix(P_dark, P_light, smoothstep(.05,.95,l)), P_duo);
  if(P_poster>1.) col = floor(col*P_poster+.5)/P_poster;
  col = mix(col, 1.-col, P_invert*step(.5,uSnare));
  // scanlines + vignette-ish roll
  col *= 1. - P_vhs*.18*(.5+.5*sin(uv.y*uRes.y*1.2));
  col += P_vhs*.04*vec3(hash(uv*uRes+uT));
  col *= 1. + P_kickGain*uKick;
  return max(col,0.);
}
