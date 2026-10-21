// @look strobe-deck
// @title Strobe Deck
// @fits switch, breakdown, transition
// @mood frantic, graphic, high-contrast
// @desc Hard-cuts to a different graphic on every cut event (set the scene's cutOn, e.g. kick+snare or beat): inverted fractal silhouette, square rings, acid oscilloscope, ray burst, negative veins, shock ring. Each cut flashes then decays like a strobe.
// @param decay 4        strobe decay speed after each cut
// @param floor 0.25     brightness the strobe decays to
// @param seed 0         shuffles the variant order
// @param tint 1,1,1
vec3 look(vec2 uv){
  float b = float(uCut) + P_seed*13.;
  int v = int(mod(b*7.+floor(hash1(b)*3.),6.));
  float env = exp(-uCutT*P_decay*2.5);
  vec3 col=vec3(0);
  if(v==0){
    vec3 j=julia(uv*1.3, juliaC(2.2+b*.15), 48);
    float m = j.z>.5?1.:smoothstep(10.,25.,j.x);
    col = mix(vec3(.95,.92,1.), vec3(0.), m);
  } else if(v==1){
    float r=max(abs(uv.x),abs(uv.y));
    col = vec3(step(.5, fract(r*6.-uL*3.)))*vec3(1.,.15,.35);
  } else if(v==2){
    float x = uv.x/(uRes.x/uRes.y)*.5+.5;
    float d = abs(uv.y-wave(x)*.75);
    col = vec3(.4,1.,.2)*(.004/(d+.004))*1.2;
  } else if(v==3){
    float a=atan(uv.y,uv.x);
    col = vec3(step(.5,fract(a*12./TAU+uL)))*smoothstep(.0,.6,length(uv))*vec3(.6,.4,1.);
  } else if(v==4){
    float r=length(uv)+1e-3; float a=abs(atan(uv.y,uv.x))/PI;
    float n=fbm(vec2(a*3.5,(.45/r+uPush)*.8));
    col = (1.-vec3(pow(max(1.-abs(2.*n-1.),0.),8.))*vec3(.9,.4,.9))*vec3(.7,.8,1.);
  } else {
    col = vec3(1.,.2,.05)*exp(-abs(length(uv)-min(uCutT,1.)*1.6)*10.)*2.;
  }
  return col*P_tint*(P_floor+.9*env);
}
