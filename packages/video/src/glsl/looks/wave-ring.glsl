// @look wave-ring
// @title Wave Ring
// @fits layer: acid, lead, bridge
// @mood live, oscilloscope
// @desc Layer. The actual audio waveform drawn as a glowing circle (mirrored so it has no seam). Great for showing an acid line or lead entering.
// @param radius 0.55
// @param amp 0.25
// @param color 0.4,1,0.3
// @param cycle 0           >0 cycles the colour through a rainbow at this speed
vec3 look(vec2 uv){
  float a=atan(uv.y,uv.x)/TAU+.5;
  float a2 = a<.5 ? a*2. : (1.-a)*2.;
  float d = abs(length(uv)-(P_radius + wave(a2*.5)*P_amp));
  vec3 c = P_cycle>0. ? pal(uT*P_cycle, vec3(.5),vec3(.5),vec3(1.),vec3(0.,.33,.67)) : P_color;
  return c*(.003/(d+.003));
}
