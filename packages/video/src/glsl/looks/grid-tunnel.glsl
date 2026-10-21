// @look grid-tunnel
// @title Grid Tunnel
// @fits drop, techno, cyber
// @mood cold, digital, driving
// @desc A square wireframe corridor rushing past, with random panels lighting up on the bass and a bright wavefront on every kick.
// @param line 0.25,0.85,1      line colour
// @param panel 0.1,0.35,0.9    panel colour
// @param twist 0.12            corridor roll speed
// @param base 0.7
// @param snareGain 0.7
// @param punch 0.07
vec3 look(vec2 uv){
  vec2 q = uv*(1.-P_punch*uKick-P_punch*.6*uSnare);
  vec2 p = rot(uT*P_twist + .25*sin(uT*.3))*q;
  float r = max(abs(p.x),abs(p.y))+1e-3;
  float z = .35/r + uPush;
  bool side = abs(p.x)>abs(p.y);
  float u = side ? p.y/r : p.x/r;
  u += side ? (p.x>0.?0.:4.) : (p.y>0.?2.:6.);
  float zz=z*2., uu=u*2.;
  vec2 gid=floor(vec2(zz,uu));
  float gz=abs(fract(zz)-.5), gu=abs(fract(uu)-.5);
  float lines = max(1.-smoothstep(0., 1.5*fwidth(zz), .5-gz), 1.-smoothstep(0., 1.5*fwidth(uu), .5-gu));
  float h = hash(gid);
  float pan = step(.86-.2*uBass, h)*(.5+.5*sin(uT*3.+h*30.))*.6;
  float front = exp(-abs(z - (uPush + .35/max(.02, uKT*1.6+.02)))*3.);
  vec3 col = P_line*lines*(.6+1.6*uKick) + P_panel*pan*.35 + vec3(.8,.95,1.)*front*lines*uKick*1.5;
  col += vec3(.02,.04,.09)*fbm3(vec2(u,z)*1.5);
  return col*smoothstep(0.,.5,r)*(P_base + P_snareGain*uSnare);
}
