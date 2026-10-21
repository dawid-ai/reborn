// @look shock-ring
// @title Shock Ring
// @fits layer: drops, impacts
// @mood punchy
// @desc Layer. An expanding ring fired by every kick.
// @param color 1,0.2,0.3
// @param speed 2.2
// @param width 14
vec3 look(vec2 uv){
  return P_color*exp(-abs(length(uv)-uKT*P_speed)*P_width)*uKick;
}
