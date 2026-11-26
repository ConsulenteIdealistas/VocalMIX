
"use strict";
/* ============================================================
   VocalMIX — Web Audio multitrack mixer
   ============================================================ */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const db2lin=db=>Math.pow(10,db/20), lin2db=l=>20*Math.log10(Math.max(l,1e-6));
const fmtT=s=>{s=Math.max(0,s);const m=Math.floor(s/60),ss=s-m*60;return m+":"+ss.toFixed(3).padStart(6,"0")};
const fmtDb=v=>(v<=-59.5?"-∞":(v>0?"+":"")+v.toFixed(1))+" dB";
let uid=1; const nid=()=>"id"+(uid++);

const TYPES={inst:{label:"Backing",color:"#a8433a",badge:"#86322b"},
             vocal:{label:"Vocal",color:"#4d6f99",badge:"#3c587c"},
             harmony:{label:"Harmony",color:"#5f8a3e",badge:"#4a6d31"}};

/* ---------- state ---------- */
const S={
  ctx:null, master:null, masterComp:null, analyser:null,
  bpm:120, playing:false, playCtxStart:0, playPosStart:0, pos:0,
  tracks:[], buses:[], sources:[],
  selTrack:null, selClip:null, selFx:-1,
  loop:{on:false,start:0,end:8},
  autoMode:"off", snap:true, px:42,
  returns:null, demoLoaded:false, userFxPresets:{}, userMixPresets:[],
  revMuted:false, dlyMuted:false, selBus:null,
};

/* ============================================================
   FX stage modules (stage-2 refactor)
   ------------------------------------------------------------
   No node graph. Instead, each stage of the serial chain is an independent unit:
   - Each stage type registers its definition (defaults) / presets / summary in FXDEF
   - Stages support ON/OFF, reorder, duplicate, reset to defaults and collapse, independently
   - Presets apply per stage type; user presets are kept
     in memory for this session only
   To add a new stage type, add one entry to FXDEF.
   ============================================================ */
function delaySyncSec(sync,bpm){ const b=60/(bpm||120); return {"4":b,"d8":b*0.75,"8":b/2,"16":b/4,"t8":b/3}[sync]||null; }
const FXDEF={
  eq:{ name:"Parametric EQ",
    make(){ return {type:"eq",on:true,bands:[
      {t:"highpass",f:80,g:0,q:0.71,on:true},
      {t:"peaking",f:250,g:0,q:1.0,on:true},
      {t:"peaking",f:1000,g:0,q:1.0,on:true},
      {t:"peaking",f:3500,g:0,q:1.0,on:true},
      {t:"highshelf",f:9000,g:0,q:0.71,on:true}]}; },
    summary(fx){ const onN=fx.bands.filter(b=>b.on).length;
      const hp=fx.bands[0]&&fx.bands[0].on?("HPF "+Math.round(fx.bands[0].f)+"Hz · "):"";
      let pk=null; fx.bands.forEach(b=>{ if(b.on&&Math.abs(b.g)>0&&(!pk||Math.abs(b.g)>Math.abs(pk.g))) pk=b; });
      return hp+(pk?("Peak "+(pk.g>0?"+":"")+pk.g.toFixed(1)+"dB @ "+(pk.f>=1000?(pk.f/1000)+"k":Math.round(pk.f))+"Hz"):"Flat")+"("+onN+"/5 bands)"; },
    presets:[
      {id:"flat",label:"Flat",apply(){}},
      {id:"vocal",label:"Vocal Basic",apply(f){ f.bands[0].f=90; f.bands[1].g=-1; f.bands[3].g=2.5; f.bands[4].g=1.5; }},
      {id:"lowcut",label:"Low Cut Only",apply(f){ f.bands[0].f=110; }},
      {id:"air",label:"Presence & Air",apply(f){ f.bands[1].g=-2; f.bands[3].f=4000; f.bands[3].g=3; f.bands[4].g=4; }},
      {id:"demud",label:"De-Mud",apply(f){ f.bands[0].f=100; f.bands[1].g=-3.5; f.bands[1].q=1.4; f.bands[2].f=800; f.bands[2].g=1; f.bands[3].g=2; }},
    ]},
  comp:{ name:"Compressor",
    make(){ return {type:"comp",on:true,threshold:-18,ratio:3,attack:0.01,release:0.25,knee:18,makeup:0}; },
    summary(fx){ return fx.threshold.toFixed(0)+"dB · "+fx.ratio.toFixed(1)+":1"+(fx.makeup>0?" · MU +"+fx.makeup.toFixed(1)+"dB":""); },
    presets:[
      {id:"std",label:"Cover Standard",apply(){}},
      {id:"light",label:"Light",apply(f){ f.threshold=-14; f.ratio=2; f.attack=0.02; f.release=0.3; f.knee=24; }},
      {id:"strong",label:"Heavy",apply(f){ f.threshold=-24; f.ratio=5; f.attack=0.005; f.release=0.18; f.knee=12; f.makeup=3; }},
      {id:"ballad",label:"Ballad (Slow)",apply(f){ f.threshold=-16; f.ratio=2.5; f.attack=0.03; f.release=0.4; f.knee=30; }},
    ]},
  reverb:{ name:"Reverb",
    make(){ return {type:"reverb",on:true,decay:2.4,mix:0.3,predelay:0.02}; },
    summary(fx){ return fx.decay.toFixed(1)+"s · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"plate",label:"Plate (Standard)",apply(){}},
      {id:"room",label:"Small Room",apply(f){ f.decay=0.9; f.predelay=0.005; f.mix=0.22; }},
      {id:"hall",label:"Hall",apply(f){ f.decay=4.2; f.predelay=0.04; f.mix=0.35; }},
      {id:"subtle",label:"Subtle",apply(f){ f.decay=1.8; f.predelay=0.01; f.mix=0.15; }},
    ]},
  delay:{ name:"Delay",
    make(){ return {type:"delay",on:true,time:0.375,feedback:0.35,mix:0.25,sync:"d8"}; },
    summary(fx){ const s={off:"","4":"Quarter Sync","d8":"Dotted 8th Sync","8":"8th Sync","16":"16th Sync","t8":"8th Triplet Sync"}[fx.sync]||"";
      return Math.round(fx.time*1000)+"ms · FB "+Math.round(fx.feedback*100)+"% · Mix "+Math.round(fx.mix*100)+"%"+(s?" · "+s:""); },
    presets:[
      {id:"dotted",label:"Dotted 8th (BPM Sync)",apply(f,bpm){ f.sync="d8"; f.time=delaySyncSec("d8",bpm); f.feedback=0.35; f.mix=0.25; }},
      {id:"eighth",label:"8th Delay",apply(f,bpm){ f.sync="8"; f.time=delaySyncSec("8",bpm); f.feedback=0.3; f.mix=0.2; }},
      {id:"slap",label:"Slapback",apply(f){ f.sync="off"; f.time=0.09; f.feedback=0.08; f.mix=0.18; }},
      {id:"long",label:"Long (Quarter, High Feedback)",apply(f,bpm){ f.sync="4"; f.time=delaySyncSec("4",bpm); f.feedback=0.5; f.mix=0.22; }},
    ]},
};
function defaultFx(type){ const d=FXDEF[type]; return d?d.make():null; }
function fxSnapshot(fx){ const c=JSON.parse(JSON.stringify(fx)); delete c.on; delete c.collapsed; return c; }
function fxPresetKey(type,preset){ const f=defaultFx(type); preset.apply(f,S.bpm); return JSON.stringify(fxSnapshot(f)); }
function setFxParams(fx,data){ const on=fx.on, col=fx.collapsed; for(const k of Object.keys(fx)) delete fx[k];
  Object.assign(fx,JSON.parse(JSON.stringify(data))); fx.on=on; if(col!=null) fx.collapsed=col; }
function applyFxPreset(tr,i,preset){
  const fx=tr.fx[i]; if(!fx) return;
  if(preset.data){ setFxParams(fx,preset.data); }
  else { const f=defaultFx(fx.type); preset.apply(f,S.bpm); setFxParams(fx,f); }
  applyFxLive(tr,i,true); renderInspector();
  toast("Applied preset \""+preset.label+"\" to "+FXDEF[fx.type].name);
}
/* ============================================================
   Clip / routing modules (stage-3 refactor)
   ------------------------------------------------------------
   The same discipline as stage 1 (pitch layer) and stage 2 (FX stages),
   applied to clips and mixer / routing:
   - Clips are independent units: select, mute (disable), duplicate, delete
     and presets work per clip. Edits (trim / gain / fades /
     mute) change parameters only and never rewrite the source buffer
     (= clip edits are also a non-destructive layer, stacked separately from the pitch layer).
   - Buses / returns are independent units: they carry ON/OFF (mute), volume, pan
     and a summary, and a track's output can be changed from the mixer too.
   - The mixer as a whole has presets (built-in + user-saved =
     this session only) that recall faders / pans / sends / buses /
     returns together. Defaults and the default routing are unchanged.
   ============================================================ */
const CLIP_PRESETS=[
  {id:"plain",label:"Standard (No Fade)",apply(c){ c.gain=0; c.fadeIn=0; c.fadeOut=0; }},
  {id:"click",label:"Click Removal (10ms)",apply(c){ c.fadeIn=Math.min(0.01,c.dur/4); c.fadeOut=Math.min(0.01,c.dur/4); }},
  {id:"smooth",label:"Smooth In & Out",apply(c){ c.fadeIn=Math.min(0.08,c.dur/4); c.fadeOut=Math.min(0.15,c.dur/4); }},
  {id:"longfade",label:"Long Fade",apply(c){ c.fadeIn=Math.min(0.4,c.dur/3); c.fadeOut=Math.min(0.8,c.dur/3); }},
  {id:"down3",label:"Gain −3dB",apply(c){ c.gain=-3; }},
  {id:"up3",label:"Gain +3dB",apply(c){ c.gain=3; }},
];
function clipSummary(cl){
  if(!cl) return "";
  const parts=[cl.start.toFixed(2)+"s → "+(cl.start+cl.dur).toFixed(2)+"s ("+cl.dur.toFixed(2)+"s)",
    "Gain "+fmtDb(cl.gain||0)];
  if(cl.fadeIn>0||cl.fadeOut>0) parts.push("Fade "+(cl.fadeIn||0).toFixed(2)+"/"+(cl.fadeOut||0).toFixed(2)+"s");
  if(cl.muted) parts.push("Muted");
  const L=(typeof pitchLayer==="function")?pitchLayer(cl):null;
  if(L) parts.push("Pitch layer "+(L.enabled?"ON":"OFF")+" · "+L.notes.length+" notes");
  return parts.join(" · ");
}
function clipPresetMatch(cl,p){ const c={gain:cl.gain||0,fadeIn:cl.fadeIn||0,fadeOut:cl.fadeOut||0,dur:cl.dur}; p.apply(c);
  return Math.abs(c.gain-(cl.gain||0))<1e-9&&Math.abs(c.fadeIn-(cl.fadeIn||0))<1e-9&&Math.abs(c.fadeOut-(cl.fadeOut||0))<1e-9; }
function applyClipPreset(cl,p){ p.apply(cl); renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Applied clip preset \""+p.label+"\" (source audio unchanged)"); }
function duplicateClip(tr,cl){
  const nc={id:nid(),name:cl.name+" (Copy)",buffer:cl.buffer,sourceBuffer:cl.sourceBuffer||cl.buffer,
    start:cl.start+cl.dur,offset:cl.offset,dur:cl.dur,gain:cl.gain||0,fadeIn:cl.fadeIn||0,fadeOut:cl.fadeOut||0,muted:!!cl.muted};
  const L=(typeof pitchLayer==="function")?pitchLayer(cl):null;
  if(L){ nc.pitchLayer=JSON.parse(JSON.stringify(L)); nc.pitchLayer.notes.forEach(n=>n.id=nid()); }
  tr.clips.splice(tr.clips.indexOf(cl)+1,0,nc); tr.clips.sort((a,b)=>a.start-b.start);
  S.selClip=nc.id; renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Clip duplicated (source buffer is shared = non-destructive)");
  return nc;
}
/* --- Mixer presets (built-ins that act per track type + whole-mix snapshot save) --- */
function applyMixLiveAll(){
  if(!S.ctx) return; const t=S.ctx.currentTime;
  S.tracks.forEach(tr=>{ if(!tr.nodes) return;
    tr.nodes.fader.gain.setTargetAtTime(db2lin(tr.vol),t,0.03);
    tr.nodes.pan.pan.setTargetAtTime(tr.pan,t,0.03);
    tr.nodes.sRev.gain.setTargetAtTime(tr.sendRev,t,0.03);
    tr.nodes.sDly.gain.setTargetAtTime(tr.sendDly,t,0.03); });
  S.buses.forEach(b=>{ if(b.nodes){ b.nodes.g.gain.setTargetAtTime(b.muted?0:db2lin(b.vol),t,0.03); b.nodes.p.pan.setTargetAtTime(b.pan,t,0.03); } });
  if(S.returns){ S.returns.revOut.gain.setTargetAtTime(S.revMuted?0:0.9,t,0.03); S.returns.dlyOut.gain.setTargetAtTime(S.dlyMuted?0:0.8,t,0.03); }
}
const MIX_PRESETS=[
  {id:"std",label:"Cover Standard",apply(){ S.tracks.forEach(tr=>{
      if(tr.type==="vocal"){ tr.vol=-2; tr.sendRev=0.30; tr.sendDly=0.08; }
      else if(tr.type==="harmony"){ tr.vol=-9; tr.sendRev=0.35; tr.sendDly=0; }
      else { tr.vol=-6; tr.sendRev=0.05; tr.sendDly=0; } }); }},
  {id:"front",label:"Vocal Up Front",apply(){ S.tracks.forEach(tr=>{
      if(tr.type==="vocal"){ tr.vol=0; tr.sendRev=0.22; }
      else if(tr.type==="harmony"){ tr.vol=-12; tr.sendRev=0.3; }
      else { tr.vol=-9; tr.sendRev=0.04; } }); }},
  {id:"wide",label:"Wide Harmony",apply(){ S.tracks.forEach(tr=>{
      if(tr.type==="harmony"){ tr.vol=-7; tr.pan=(tr.pan===0?0.3:tr.pan); tr.sendRev=0.4; }
      else if(tr.type==="vocal"){ tr.vol=-2; tr.pan=0; } }); }},
  {id:"dry",label:"Dry (Minimal Sends)",apply(){ S.tracks.forEach(tr=>{ tr.sendRev=Math.min(tr.sendRev,0.06); tr.sendDly=0; }); }},
  {id:"wet",label:"Wet (Spacious)",apply(){ S.tracks.forEach(tr=>{ if(tr.type!=="inst"){ tr.sendRev=Math.max(tr.sendRev,0.42); } }); if(S.returns) S.returns.decay=Math.max(S.returns.decay,3.4); }},
];
function mixSnapshot(){
  return { tracks:S.tracks.map(tr=>({id:tr.id,vol:tr.vol,pan:tr.pan,sendRev:tr.sendRev,sendDly:tr.sendDly,mute:tr.mute,solo:tr.solo,bus:tr.bus})),
    buses:S.buses.map(b=>({id:b.id,vol:b.vol,pan:b.pan,muted:!!b.muted})),
    ret:S.returns?{decay:S.returns.decay,dlyTime:S.returns.dlyTime,dlyFb:S.returns.dlyFb}:null,
    revMuted:S.revMuted, dlyMuted:S.dlyMuted };
}
function applyMixSnapshot(d){
  if(!d) return;
  (d.tracks||[]).forEach(sv=>{ const tr=S.tracks.find(t=>t.id===sv.id); if(!tr) return;
    tr.vol=sv.vol; tr.pan=sv.pan; tr.sendRev=sv.sendRev; tr.sendDly=sv.sendDly; tr.mute=sv.mute; tr.solo=sv.solo; tr.bus=sv.bus; refreshTrackOut(tr); });
  (d.buses||[]).forEach(sv=>{ const b=S.buses.find(x=>x.id===sv.id); if(!b) return; b.vol=sv.vol; b.pan=sv.pan||0; b.muted=!!sv.muted; });
  if(d.ret&&S.returns){ S.returns.decay=d.ret.decay; S.returns.dlyTime=d.ret.dlyTime; S.returns.dlyFb=d.ret.dlyFb;
    S.returns.conv.buffer=makeIR(S.ctx,d.ret.decay); S.returns.dly.delayTime.value=d.ret.dlyTime; S.returns.fb.gain.value=d.ret.dlyFb; }
  S.revMuted=!!d.revMuted; S.dlyMuted=!!d.dlyMuted;
  applyMixLiveAll(); renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
}
function busSummary(b){
  const n=S.tracks.filter(t=>t.bus===b.id).length;
  return n+" tracks → Master · "+fmtDb(b.vol)+" · "+panLabel(b.pan||0)+(b.muted?" · Muted":"");
}
const RET_PRESETS={
  rev:[ {id:"rstd",label:"Plate Standard",decay:2.6}, {id:"rroom",label:"Small Room",decay:1.0}, {id:"rhall",label:"Hall",decay:4.4}, {id:"rsub",label:"Subtle",decay:1.7} ],
  dly:[ {id:"dstd",label:"Dotted 8th",time:0.375,fb:0.34}, {id:"dslap",label:"Slapback",time:0.09,fb:0.08}, {id:"dlong",label:"Long Repeats",time:0.5,fb:0.55} ],
};
function newTrack(name,type){
  const tr={id:nid(),name,type:type||"vocal",color:TYPES[type||"vocal"].color,
    clips:[],vol:-3,pan:0,mute:false,solo:false,bus:null,
    sendRev:type==="inst"?0:0.28, sendDly:0,
    fx: type==="inst"? [defaultFx("eq")] : [defaultFx("eq"),defaultFx("comp")],
    auto:{volume:[],pan:[]}, nodes:null};
  return tr;
}
function newBus(name){return {id:nid(),name,vol:0,pan:0,muted:false};}
S.buses.push(newBus("Vocal Bus"));

/* ---------- audio engine ---------- */
function ensureCtx(){
  if(S.ctx) { if(S.ctx.state==="suspended") S.ctx.resume(); return S.ctx; }
  const ctx=new (window.AudioContext||window.webkitAudioContext)({latencyHint:"interactive"});
  S.ctx=ctx;
  S.master=ctx.createGain(); S.master.gain.value=db2lin(parseFloat($("#masterVol").value));
  S.masterComp=ctx.createDynamicsCompressor();
  S.masterComp.threshold.value=-3; S.masterComp.ratio.value=12; S.masterComp.attack.value=0.002; S.masterComp.release.value=0.18; S.masterComp.knee.value=4;
  S.analyser=ctx.createAnalyser(); S.analyser.fftSize=256;
  S.master.connect(S.masterComp); S.masterComp.connect(S.analyser); S.analyser.connect(ctx.destination);
  buildReturns(ctx,S.master,true);
  S.tracks.forEach(tr=>buildTrackGraph(tr));
  S.buses.forEach(b=>buildBusGraph(b));
  return ctx;
}
function makeIR(ctx,decay){
  const len=Math.max(1,(decay*ctx.sampleRate)|0), buf=ctx.createBuffer(2,len,ctx.sampleRate);
  for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.6);}
  return buf;
}
function buildReturns(ctx,dest,live){
  const revIn=ctx.createGain(), conv=ctx.createConvolver(), revOut=ctx.createGain();
  conv.buffer=makeIR(ctx,2.6); revOut.gain.value=S.revMuted?0:0.9;
  revIn.connect(conv); conv.connect(revOut); revOut.connect(dest);
  const dlyIn=ctx.createGain(), dly=ctx.createDelay(2), fb=ctx.createGain(), flt=ctx.createBiquadFilter(), dlyOut=ctx.createGain();
  dly.delayTime.value=0.375; fb.gain.value=0.34; flt.type="lowpass"; flt.frequency.value=4200; dlyOut.gain.value=S.dlyMuted?0:0.8;
  dlyIn.connect(dly); dly.connect(flt); flt.connect(fb); fb.connect(dly); flt.connect(dlyOut); dlyOut.connect(dest);
  const R={revIn,conv,revOut,dlyIn,dly,fb,dlyOut,decay:2.6,dlyTime:0.375,dlyFb:0.34};
  if(live) S.returns=R;
  return R;
}
function busDest(ctx,busId,live){
  if(!busId) return live?S.master:null;
  const b=S.buses.find(x=>x.id===busId);
  if(b&&b.nodes) return b.nodes.input;
  return live?S.master:null;
}
function buildBusGraph(b){
  const ctx=S.ctx; if(!ctx) return;
  const input=ctx.createGain(), g=ctx.createGain(), p=ctx.createStereoPanner();
  input.connect(g); g.connect(p); p.connect(S.master);
  g.gain.value=b.muted?0:db2lin(b.vol); p.pan.value=b.pan;
  b.nodes={input,g,p};
}
function fxNodes(ctx,fx){
  /* returns {input,output,parts} chain fragment for one effect */
  const inp=ctx.createGain(), out=ctx.createGain(); const parts={};
  if(!fx.on){ inp.connect(out); return {input:inp,output:out,parts,bypass:true}; }
  if(fx.type==="eq"){
    let prev=inp; parts.bands=[];
    fx.bands.forEach(bd=>{ const f=ctx.createBiquadFilter(); f.type=bd.on?bd.t:"allpass"; f.frequency.value=bd.f; f.gain.value=bd.g; f.Q.value=bd.q;
      prev.connect(f); prev=f; parts.bands.push(f); });
    prev.connect(out);
  }else if(fx.type==="comp"){
    const c=ctx.createDynamicsCompressor(), mk=ctx.createGain();
    c.threshold.value=fx.threshold;c.ratio.value=fx.ratio;c.attack.value=fx.attack;c.release.value=fx.release;c.knee.value=fx.knee;
    mk.gain.value=db2lin(fx.makeup); inp.connect(c); c.connect(mk); mk.connect(out);
    parts.comp=c; parts.mk=mk;
  }else if(fx.type==="reverb"){
    const dry=ctx.createGain(), wet=ctx.createGain(), conv=ctx.createConvolver(), pd=ctx.createDelay(0.2);
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix; conv.buffer=makeIR(ctx,fx.decay); pd.delayTime.value=fx.predelay||0;
    inp.connect(dry); dry.connect(out); inp.connect(pd); pd.connect(conv); conv.connect(wet); wet.connect(out);
    parts.conv=conv; parts.dry=dry; parts.wet=wet; parts.pd=pd;
  }else if(fx.type==="delay"){
    const dry=ctx.createGain(), wet=ctx.createGain(), d=ctx.createDelay(2), fb=ctx.createGain(), fl=ctx.createBiquadFilter();
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix; d.delayTime.value=fx.time; fb.gain.value=fx.feedback; fl.type="lowpass"; fl.frequency.value=5000;
    inp.connect(dry); dry.connect(out); inp.connect(d); d.connect(fl); fl.connect(fb); fb.connect(d); fl.connect(wet); wet.connect(out);
    parts.dly=d; parts.fb=fb; parts.dry=dry; parts.wet=wet;
  }
  return {input:inp,output:out,parts};
}
function buildTrackGraph(tr){
  const ctx=S.ctx; if(!ctx) return;
  if(tr.nodes){ try{tr.nodes.input.disconnect();}catch(e){} }
  const input=ctx.createGain(), autoG=ctx.createGain(), autoP=ctx.createStereoPanner(),
        fader=ctx.createGain(), pan=ctx.createStereoPanner(),
        sRev=ctx.createGain(), sDly=ctx.createGain();
  let prev=input; const liveFx=[];
  tr.fx.forEach(fx=>{ const n=fxNodes(ctx,fx); prev.connect(n.input); prev=n.output; liveFx.push(n); });
  prev.connect(autoG); autoG.connect(autoP); autoP.connect(fader); fader.connect(pan);
  const dest=busDest(ctx,tr.bus,true);
  pan.connect(dest);
  fader.connect(sRev); sRev.connect(S.returns.revIn);
  fader.connect(sDly); sDly.connect(S.returns.dlyIn);
  fader.gain.value=db2lin(tr.vol); pan.pan.value=tr.pan;
  sRev.gain.value=tr.sendRev; sDly.gain.value=tr.sendDly;
  tr.nodes={input,autoG,autoP,fader,pan,sRev,sDly,liveFx,out:dest};
}
function refreshTrackOut(tr){
  if(!tr.nodes||!S.ctx) return;
  try{tr.nodes.pan.disconnect();}catch(e){}
  tr.nodes.pan.connect(busDest(S.ctx,tr.bus,true));
  tr.nodes.out=busDest(S.ctx,tr.bus,true);
}
function applyFxLive(tr,idx,structural){
  if(!S.ctx||!tr.nodes) return;
  const fx=tr.fx[idx], live=tr.nodes.liveFx[idx];
  if(structural||!live||(!!live.bypass!==!fx.on)){
    buildTrackGraph(tr);
    if(S.playing) startSources(currentPos());
    return;
  }
  if(!fx.on) return;
  const p=live.parts, t=S.ctx.currentTime;
  if(fx.type==="eq"&&p.bands){ fx.bands.forEach((b,j)=>{ const n=p.bands[j]; if(!n)return;
    n.type=b.on?b.t:"allpass"; n.frequency.setTargetAtTime(b.f,t,0.02); n.gain.setTargetAtTime(b.g,t,0.02); n.Q.setTargetAtTime(b.q,t,0.02); }); }
  else if(fx.type==="comp"&&p.comp){ p.comp.threshold.setTargetAtTime(fx.threshold,t,0.02);
    p.comp.ratio.setTargetAtTime(fx.ratio,t,0.02); p.comp.attack.setTargetAtTime(fx.attack,t,0.02);
    p.comp.release.setTargetAtTime(fx.release,t,0.02); p.comp.knee.setTargetAtTime(fx.knee,t,0.02);
    p.mk.gain.setTargetAtTime(db2lin(fx.makeup),t,0.02); }
  else if(fx.type==="reverb"&&p.conv){ p.conv.buffer=makeIR(S.ctx,fx.decay);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02);
    p.pd.delayTime.setTargetAtTime(fx.predelay||0,t,0.02); }
  else if(fx.type==="delay"&&p.dly){ p.dly.delayTime.setTargetAtTime(fx.time,t,0.02);
    p.fb.gain.setTargetAtTime(fx.feedback,t,0.02);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
}
/* automation value lookup */
function autoVal(pts,t,def){
  if(!pts.length) return def;
  if(t<=pts[0].t) return pts[0].v;
  for(let i=1;i<pts.length;i++){ if(t<=pts[i].t){ const a=pts[i-1],b=pts[i];
    return a.v+(b.v-a.v)*((t-a.t)/Math.max(1e-6,b.t-a.t)); } }
  return pts[pts.length-1].v;
}
function scheduleAuto(param,pts,fromPos,ctxNow,toLin){
  const now=ctxNow, off=fromPos;
  param.cancelScheduledValues(now);
  param.setValueAtTime(toLin(autoVal(pts,off,NaN)),now);
  pts.forEach(p=>{ if(p.t>off) param.linearRampToValueAtTime(toLin(p.v), now+(p.t-off)); });
}
function projectEnd(){
  let e=24;
  S.tracks.forEach(tr=>tr.clips.forEach(c=>{ e=Math.max(e,c.start+c.dur+3); }));
  return e;
}
/* ---------- playback ---------- */
function startSources(fromPos){
  const ctx=S.ctx, now=ctx.currentTime+0.06;
  stopSources();
  const anySolo=S.tracks.some(t=>t.solo);
  S.tracks.forEach(tr=>{
    if(!tr.nodes) buildTrackGraph(tr);
    const audible=!tr.mute&&(!anySolo||tr.solo);
    /* automation */
    const vg=tr.nodes.autoG.gain, pp=tr.nodes.autoP.pan;
    if(tr.auto.volume.length) scheduleAuto(vg,tr.auto.volume.map(p=>({t:p.t,v:p.v})),fromPos,now,v=>isNaN(v)?1:db2lin(v));
    else { vg.cancelScheduledValues(now); vg.setValueAtTime(1,now); }
    if(tr.auto.pan.length) scheduleAuto(pp,tr.auto.pan,fromPos,now,v=>isNaN(v)?0:v);
    else { pp.cancelScheduledValues(now); pp.setValueAtTime(0,now); }
    if(!audible) return;
    tr.clips.forEach(cl=>{
      if(cl.muted) return;
      const cEnd=cl.start+cl.dur;
      if(cEnd<=fromPos) return;
      const src=ctx.createBufferSource(); src.buffer=clipBuffer(cl);
      const g=ctx.createGain(); src.connect(g); g.connect(tr.nodes.input);
      const skip=Math.max(0,fromPos-cl.start);
      const when=now+Math.max(0,cl.start-fromPos);
      const playDur=cl.dur-skip; if(playDur<=0) return;
      /* fades + clip gain */
      const t0=when, cg=db2lin(cl.gain||0);
      g.gain.setValueAtTime(cl.fadeIn>0&&skip===0?0.0001:cg,t0);
      if(cl.fadeIn>0&&skip<cl.fadeIn) g.gain.linearRampToValueAtTime(cg,t0+(cl.fadeIn-skip));
      else if(skip===0&&cl.fadeIn>0) g.gain.linearRampToValueAtTime(cg,t0+cl.fadeIn);
      const fadeOutStart=t0+playDur-(cl.fadeOut||0);
      if(cl.fadeOut>0){ g.gain.setValueAtTime(cg,Math.max(t0,fadeOutStart)); g.gain.linearRampToValueAtTime(0.0001,t0+playDur); }
      src.start(when,cl.offset+skip,playDur+0.1);
      S.sources.push(src);
    });
  });
  S.playCtxStart=now; S.playPosStart=fromPos;
}
function stopSources(){ S.sources.forEach(s=>{try{s.stop()}catch(e){} try{s.disconnect()}catch(e){}}); S.sources=[]; }
function play(){
  ensureCtx();
  if(!S.tracks.length){ toast("No tracks"); return; }
  if(S.playing){ pause(); return; }
  if(S.pos>=projectEnd()-0.05) S.pos=0;
  startSources(S.pos); S.playing=true; $("#btnPlay").textContent="❚❚"; $("#btnPlay").classList.add("playing");
  const bp=$("#btnBarPlay"); if(bp){ bp.textContent="❚❚"; bp.classList.add("playing"); }
}
function pause(){
  if(!S.playing) return;
  S.pos=currentPos(); stopSources(); S.playing=false;
  $("#btnPlay").textContent="▶"; $("#btnPlay").classList.remove("playing");
  const bp2=$("#btnBarPlay"); if(bp2){ bp2.textContent="▶"; bp2.classList.remove("playing"); }
}
function stopAll(){ pause(); S.pos=0; updatePlayhead(); }
function currentPos(){
  if(!S.playing) return S.pos;
  return S.playPosStart+(S.ctx.currentTime-S.playCtxStart);
}
function seek(t){
  S.pos=clamp(t,0,projectEnd());
  if(S.playing){ startSources(S.pos); }
  updatePlayhead();
}

/* ============================================================
   Demo song generation (renders backing + vocal + harmony with synths)
   ============================================================ */
const NOTE={C3:130.81,D3:146.83,E3:164.81,F3:174.61,G3:196,A3:220,B3:246.94,
  C4:261.63,D4:293.66,E4:329.63,F4:349.23,G4:392,A4:440,B4:493.88,
  C5:523.25,D5:587.33,E5:659.25,F5:698.46,G5:783.99,A5:880};
function env(g,t,a,peak,dur,rel){ g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(peak,t+a);
  g.gain.setValueAtTime(peak,Math.max(t+a,t+dur-rel)); g.gain.linearRampToValueAtTime(0.0001,t+dur); }
function tone(ctx,dest,freq,t,dur,type,peak,lp){
  const o=ctx.createOscillator(),g=ctx.createGain(),fl=ctx.createBiquadFilter();
  o.type=type;o.frequency.value=freq; fl.type="lowpass"; fl.frequency.value=lp||3000;
  o.connect(fl);fl.connect(g);g.connect(dest); env(g,t,0.012,peak,dur,Math.min(0.09,dur*0.4));
  o.start(t);o.stop(t+dur+0.05);
}
function noiseHit(ctx,dest,t,dur,peak,hp){
  const len=Math.ceil(dur*ctx.sampleRate),b=ctx.createBuffer(1,len,ctx.sampleRate),d=b.getChannelData(0);
  for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);
  const s=ctx.createBufferSource();s.buffer=b;const f=ctx.createBiquadFilter();f.type="highpass";f.frequency.value=hp||6000;
  const g=ctx.createGain();g.gain.value=peak;s.connect(f);f.connect(g);g.connect(dest);s.start(t);
}
function voiceNote(ctx,dest,f,t,dur,peak){
  const o=ctx.createOscillator(); o.type="sawtooth"; o.frequency.setValueAtTime(f*0.985,t);
  o.frequency.linearRampToValueAtTime(f,t+Math.min(0.09,dur*0.4));
  const vib=ctx.createOscillator(), vg=ctx.createGain(); vib.frequency.value=5.4; vg.gain.value=0;
  vib.connect(vg); vg.connect(o.frequency);
  vg.gain.setValueAtTime(0,t); vg.gain.linearRampToValueAtTime(f*0.006,t+Math.min(0.35,dur*0.7));
  const f1=ctx.createBiquadFilter(); f1.type="bandpass"; f1.frequency.value=730; f1.Q.value=1.1;
  const f2=ctx.createBiquadFilter(); f2.type="bandpass"; f2.frequency.value=1180; f2.Q.value=2.2;
  const lp=ctx.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=3400;
  const g=ctx.createGain(), g2=ctx.createGain(); g2.gain.value=0.5;
  o.connect(f1); f1.connect(g); o.connect(f2); f2.connect(g2); g2.connect(g); o.connect(lp); lp.connect(g);
  g.connect(dest); env(g,t,0.045,peak,dur,Math.min(0.12,dur*0.45));
  o.start(t); o.stop(t+dur+0.05); vib.start(t); vib.stop(t+dur+0.05);
}
/* Render stems by muting: simpler — render 3 offline passes with gain switches */
async function buildDemoProject(){
  toast("Generating demo song…");
  const sr=44100, bpm=120, beat=60/bpm, bar=beat*4, bars=16, dur=bars*bar+0.5;
  async function pass(want){
    const oc=new OfflineAudioContext(2,sr*dur,sr);
    const mk=()=>{const g=oc.createGain();g.connect(oc.destination);return g;};
    const instBus=mk(), voxBus=mk(), harmBus=mk();
    instBus.gain.value=want==="inst"?0.95:0; voxBus.gain.value=want==="vox"?1:0; harmBus.gain.value=want==="harm"?1:0;
    const prog=[["C3","E3","G3"],["G3","B3","D4"],["A3","C4","E4"],["F3","A3","C4"],
                ["C3","E3","G3"],["G3","B3","D4"],["F3","A3","C4"],["G3","B3","D4"]];
    for(let b=0;b<bars;b++){
      const t0=b*bar, ch=prog[b%8], root=NOTE[ch[0]]/2;
      for(let e=0;e<8;e++) tone(oc,instBus,NOTE[ch[e%3]]*2,t0+e*beat/2,beat*0.55,"triangle",0.10,2600);
      tone(oc,instBus,root,t0,bar*0.95,"sine",0.30,700);
      tone(oc,instBus,root*1.5,t0+beat*2,beat*0.9,"sine",0.12,700);
      for(let q=0;q<4;q++){ const kt=t0+q*beat;
        const ko=oc.createOscillator(),kg=oc.createGain(); ko.type="sine";
        ko.frequency.setValueAtTime(130,kt); ko.frequency.exponentialRampToValueAtTime(42,kt+0.11);
        kg.gain.setValueAtTime(0.85,kt); kg.gain.exponentialRampToValueAtTime(0.001,kt+0.24);
        ko.connect(kg); kg.connect(instBus); ko.start(kt); ko.stop(kt+0.3);
        if(q%2===1) noiseHit(oc,instBus,kt,0.16,0.32,1400);
        noiseHit(oc,instBus,kt,0.05,0.10,7000); noiseHit(oc,instBus,kt+beat/2,0.04,0.06,7000);
      }
      ch.forEach(n=>tone(oc,instBus,NOTE[n],t0,bar,"sine",0.028,1200));
    }
    const mel=[[0,"E4",1],[1,"G4",1],[2,"A4",1.5],[3.5,"G4",0.5],[4,"E4",1],[5,"D4",1],[6,"C4",2],
      [8,"D4",1],[9,"E4",1],[10,"G4",1.5],[11.5,"E4",0.5],[12,"D4",1],[13,"B3",1],[14,"C4",2],
      [16,"E4",1],[17,"G4",1],[18,"A4",1.5],[19.5,"G4",0.5],[20,"C5",1],[21,"A4",1],[22,"G4",2],
      [24,"A4",1],[25,"G4",1],[26,"E4",1.5],[27.5,"D4",0.5],[28,"E4",1],[29,"D4",1],[30,"C4",2],
      [32,"E4",1],[33,"G4",1],[34,"A4",1.5],[35.5,"G4",0.5],[36,"E4",1],[37,"D4",1],[38,"C4",2],
      [40,"D4",1],[41,"E4",1],[42,"G4",1.5],[43.5,"E4",0.5],[44,"D4",1],[45,"B3",1],[46,"C4",2],
      [48,"C5",1],[49,"A4",1],[50,"G4",1.5],[51.5,"A4",0.5],[52,"C5",1],[53,"D5",1],[54,"E5",2],
      [56,"D5",1],[57,"C5",1],[58,"A4",1.5],[59.5,"G4",0.5],[60,"E4",1],[61,"D4",1],[62,"C4",2]];
    const third={C4:"E4",D4:"F4",E4:"G4",G4:"B4",A4:"C5",B3:"D4",C5:"E5",D5:"F5",E5:"G5"};
    mel.forEach(([bt,n,len])=>{ const t=bt*beat;
      voiceNote(oc,voxBus,NOTE[n],t,len*beat*0.96,0.34);
      if(third[n]) voiceNote(oc,harmBus,NOTE[third[n]],t,len*beat*0.96,0.20);
    });
    return oc.startRendering();
  }
  const [instBuf,voxBuf,harmBuf]=await Promise.all([pass("inst"),pass("vox"),pass("harm")]);
  pause(); S.tracks=[]; S.selClip=null;
  const tI=newTrack("Backing (Demo)","inst"); tI.vol=-6; tI.sendRev=0.05;
  tI.clips.push({id:nid(),name:"Backing",buffer:instBuf,start:0,offset:0,dur:instBuf.duration,gain:0,fadeIn:0,fadeOut:0});
  const tV=newTrack("Main Vocal (Demo)","vocal"); tV.vol=-2; tV.bus=S.buses[0].id; tV.sendRev=0.3; tV.sendDly=0.08;
  tV.fx=[defaultFx("eq"),defaultFx("comp")];
  tV.fx[0].bands[0].f=90; tV.fx[0].bands[3].g=2.5; tV.fx[0].bands[4].g=1.5;
  tV.clips.push({id:nid(),name:"Vocal",buffer:voxBuf,start:0,offset:0,dur:voxBuf.duration,gain:0,fadeIn:0.02,fadeOut:0.05});
  tV.auto.volume=[{t:0,v:-1.5},{t:16,v:-1.5},{t:17,v:0.5},{t:31,v:0.5}];
  const tH=newTrack("Harmony (Demo)","harmony"); tH.vol=-9; tH.pan=0.25; tH.bus=S.buses[0].id; tH.sendRev=0.35;
  tH.clips.push({id:nid(),name:"Harmony",buffer:harmBuf,start:0,offset:0,dur:harmBuf.duration,gain:0,fadeIn:0.02,fadeOut:0.05});
  S.tracks=[tI,tV,tH]; S.selTrack=tV.id; S.selFx=0; S.pos=0; S.demoLoaded=true;
  if(S.ctx) S.tracks.forEach(buildTrackGraph);
  const _dc=$("#demoConfirm"); if(_dc) _dc.hidden=true;
  renderTimeline(); renderInspector(); updatePlayhead();
  toast("Demo song loaded. Press play to listen.");
}

/* ============================================================
   File import — per-file progress in the import panel.
   Reading is measured in real bytes (chunked stream read, the
   same chunking idea as a chunked upload); decoding has no
   progress events in Web Audio, so that phase is shown as an
   indeterminate "Decoding…" instead of a fake percentage.
   ============================================================ */
function fmtSize(b){ if(b>=1048576) return (b/1048576).toFixed(1)+" MB"; if(b>=1024) return Math.round(b/1024)+" KB"; return b+" B"; }
function impText(kind,pct){
  const ja=window.VM_LANG==="ja";
  if(kind==="queued") return ja?"待機中":"Queued";
  if(kind==="reading") return (ja?"読み込み中… ":"Reading… ")+pct+"%";
  if(kind==="decoding") return ja?"デコード中…":"Decoding…";
  if(kind==="loaded") return ja?"読み込み完了":"Loaded";
  if(kind==="failed") return ja?"読み込めませんでした":"Could not load";
  return kind;
}
/* WAV header parse (spec + simple audit). Returns null for non-WAV. */
function parseWav(ab){
  try{
    const dv=new DataView(ab), u8=new Uint8Array(ab);
    const tag=o=>String.fromCharCode(u8[o],u8[o+1],u8[o+2],u8[o+3]);
    if(ab.byteLength<44||tag(0)!=="RIFF"||tag(8)!=="WAVE") return null;
    let fmt=null, dataBytes=0, truncated=false, off=12;
    while(off+8<=ab.byteLength){
      const id=tag(off), sz=dv.getUint32(off+4,true);
      if(id==="fmt ") fmt={ch:dv.getUint16(off+10,true), sr:dv.getUint32(off+12,true), bits:dv.getUint16(off+22,true)};
      if(id==="data"){ dataBytes=sz; if(off+8+sz>ab.byteLength) truncated=true; }
      if(sz===0&&id!=="data") break;
      off+=8+sz+(sz%2);
    }
    const issues=[];
    if(!fmt) issues.push("no fmt chunk");
    if(!dataBytes) issues.push("no data chunk");
    if(truncated) issues.push("data chunk truncated");
    if(dv.getUint32(4,true)+8>ab.byteLength) issues.push("RIFF size exceeds file");
    return {fmt, issues};
  }catch(e){ return null; }
}
/* Whitelist audit — no recomputation over the audio data.
   Gate 1 (extension/MIME) already ran in the import filter.
   Gate 2: magic-byte signature per format; a mismatch is cut
   before decoding (a text file renamed to .wav dies here).
   Gate 3: spec collation — sample rate / bit depth / channels
   against the standard whitelist; misses are flagged, not cut. */
const WL_SR=new Set([8000,11025,16000,22050,32000,44100,48000,88200,96000,176400,192000]);
const WL_BITS=new Set([8,16,24,32]);
function checkSignature(name,ab){
  const u8=new Uint8Array(ab.slice(0,12));
  const tag=(o,n)=>{ let s=""; for(let i=0;i<n;i++) s+=String.fromCharCode(u8[o+i]); return s; };
  const ext=(name.split(".").pop()||"").toLowerCase();
  if(ext==="wav") return (tag(0,4)==="RIFF"||tag(0,4)==="RF64")&&tag(8,4)==="WAVE";
  if(ext==="flac") return tag(0,4)==="fLaC";
  if(ext==="ogg") return tag(0,4)==="OggS";
  if(ext==="m4a"||ext==="mp4") return tag(4,4)==="ftyp";
  if(ext==="mp3") return tag(0,3)==="ID3"||(u8[0]===0xFF&&(u8[1]&0xE0)===0xE0);
  return true;
}
function specAudit(wav,buf){
  const issues=[];
  if(!WL_SR.has(buf.sampleRate)) issues.push(buf.sampleRate+" Hz not in whitelist");
  if(buf.numberOfChannels>2) issues.push(buf.numberOfChannels+"ch (mono/stereo expected)");
  if(wav){ issues.push(...wav.issues); if(wav.fmt&&!WL_BITS.has(wav.fmt.bits)) issues.push(wav.fmt.bits+"bit not in whitelist"); }
  return issues;
}
function fmtDur(s){ const m=Math.floor(s/60), ss=Math.floor(s%60); return m+":"+String(ss).padStart(2,"0"); }
function auditLine(wav,buf){
  const ja=window.VM_LANG==="ja";
  const issues=specAudit(wav,buf);
  if(!issues.length) return {text: ja?"監査 ✓ 署名と仕様はホワイトリスト内":"Audit ✓ signature + spec in whitelist", warn:false};
  const tr=s=>{ if(!ja) return s; let m;
    if(m=/^(\d+) Hz not in whitelist$/.exec(s)) return m[1]+" Hz はホワイトリスト外";
    if(m=/^(\d+)ch \(mono\/stereo expected\)$/.exec(s)) return m[1]+"ch（モノラル/ステレオ想定）";
    if(m=/^(\d+)bit not in whitelist$/.exec(s)) return m[1]+"bit はホワイトリスト外";
    return {"no fmt chunk":"fmt チャンクなし","no data chunk":"data チャンクなし","data chunk truncated":"data チャンクが途中で切れています","RIFF size exceeds file":"RIFF サイズがファイル実寸を超えています"}[s]||s; };
  return {text:(ja?"監査 ⚠ ":"Audit ⚠ ")+issues.map(tr).join(ja?"、":", "), warn:true};
}
async function readWithProgress(f,onp){
  if(!f.stream) return f.arrayBuffer();
  try{
    const reader=f.stream().getReader(); const chunks=[]; let got=0,last=-1;
    for(;;){ const r=await reader.read(); if(r.done) break; chunks.push(r.value); got+=r.value.length;
      const pct=f.size?Math.floor(got/f.size*100):0; if(pct!==last){ last=pct; onp(pct); } }
    const out=new Uint8Array(got); let off=0; for(const c of chunks){ out.set(c,off); off+=c.length; }
    return out.buffer;
  }catch(e){ return f.arrayBuffer(); }
}
async function importFiles(files){
  ensureCtx();
  const list=[...files].filter(f=>/audio|\.(wav|mp3|m4a|ogg|flac)$/i.test(f.type+" "+f.name));
  if(!list.length){ toast("No audio files found"); return; }
  const panel=$("#importPanel"), rowsEl=$("#importRows");
  rowsEl.innerHTML=""; panel.hidden=false; clearTimeout(panel._h);
  const rows=list.map(f=>{
    const row=document.createElement("div"); row.className="improw";
    row.innerHTML='<div class="impmeta"><span class="impname"></span><span class="impsize"></span><span class="impstat"></span></div><div class="impbar"><i></i></div><div class="impspec"></div><div class="impaudit"></div>';
    row.querySelector(".impname").textContent=f.name;
    row.querySelector(".impsize").textContent=fmtSize(f.size);
    rowsEl.appendChild(row);
    const stat=row.querySelector(".impstat"), bar=row.querySelector(".impbar"), fill=row.querySelector(".impbar i");
    const specEl=row.querySelector(".impspec"), auditEl=row.querySelector(".impaudit");
    stat.textContent=impText("queued");
    return { set(kind,pct){ stat.textContent=impText(kind,pct);
        row.classList.toggle("done",kind==="loaded"); row.classList.toggle("fail",kind==="failed");
        bar.classList.toggle("indet",kind==="decoding");
        if(kind==="reading") fill.style.width=pct+"%";
        if(kind==="decoding"||kind==="loaded"||kind==="failed") fill.style.width="100%"; },
      setSpec(spec,audit,warn){ specEl.textContent=spec; auditEl.textContent=audit; auditEl.classList.toggle("warn",!!warn); } };
  });
  let failed=0;
  for(let i=0;i<list.length;i++){
    const f=list[i], ui=rows[i];
    try{
      const ab=await readWithProgress(f,pct=>ui.set("reading",pct));
      if(!checkSignature(f.name,ab)){
        failed++; ui.set("failed");
        ui.setSpec("",window.VM_LANG==="ja"?"監査: 署名が一致しません — デコードせず却下しました":"Audit: signature mismatch — rejected without decoding",true);
        continue;
      }
      ui.set("decoding");
      const wav=parseWav(ab);
      const buf=await S.ctx.decodeAudioData(ab);
      const ext=(f.name.split(".").pop()||"").toUpperCase();
      const spec=ext+" · "+(buf.sampleRate/1000).toFixed(1)+" kHz · "+buf.numberOfChannels+"ch"
        +(wav&&wav.fmt?" · "+wav.fmt.bits+"bit":"")+" · "+fmtDur(buf.duration);
      const al=auditLine(wav,buf);
      ui.setSpec(spec,al.text,al.warn);
      const nm=f.name.replace(/\.[^.]+$/,"");
      const type=/harmony|chorus|harm/i.test(nm)?"harmony":(/inst|off|karaoke|backing/i.test(nm)?"inst":"vocal");
      const tr=newTrack(nm,type);
      tr.clips.push({id:nid(),name:nm,buffer:buf,start:0,offset:0,dur:buf.duration,gain:0,fadeIn:0,fadeOut:0});
      if(type!=="inst") tr.bus=S.buses[0].id;
      S.tracks.push(tr); buildTrackGraph(tr); S.selTrack=tr.id;
      ui.set("loaded");
    }catch(e){ failed++; ui.set("failed"); }
  }
  renderTimeline(); renderInspector();
  if(!failed) panel._h=setTimeout(()=>{ panel.hidden=true; },3200);
}

/* ============================================================
   Timeline rendering
   ============================================================ */
const headsEl=$("#heads"), lanesEl=$("#lanes"), rulerEl=$("#ruler");
function contentW(){ return Math.ceil(projectEnd()*S.px)+80; }
function beatSec(){ return 60/S.bpm; }
function drawRuler(){
  const w=contentW(); rulerEl.width=w; rulerEl.style.width=w+"px";
  const c=rulerEl.getContext("2d"); c.clearRect(0,0,w,30);
  const cs=getComputedStyle(document.documentElement);
  c.fillStyle=cs.getPropertyValue("--tx3"); c.strokeStyle=cs.getPropertyValue("--grid");
  c.font="10px "+cs.getPropertyValue("--mono"); c.textBaseline="top";
  const bs=beatSec();
  for(let b=0;b*bs<projectEnd()+4;b++){
    const x=Math.round(b*bs*S.px)+0.5, isBar=b%4===0;
    c.beginPath(); c.moveTo(x,isBar?8:20); c.lineTo(x,30); c.stroke();
    if(isBar) c.fillText(String(b/4+1),x+4,3);
  }
  if(S.loop.on){
    c.fillStyle="rgba(176,84,70,.26)";
    c.fillRect(S.loop.start*S.px,0,(S.loop.end-S.loop.start)*S.px,30);
  }
}
function drawWave(canvas,cl){
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=canvas.clientWidth||Math.round(cl.dur*S.px), h=canvas.clientHeight||80;
  canvas.width=w*dpr; canvas.height=h*dpr;
  const c=canvas.getContext("2d"); c.scale(dpr,dpr);
  c.fillStyle="rgba(255,255,255,.16)"; c.fillRect(0,0,w,h);
  const buf=cl.buffer; if(!buf){return;}
  const ch0=buf.getChannelData(0), ch1=buf.numberOfChannels>1?buf.getChannelData(1):ch0;
  const startS=Math.floor(cl.offset*buf.sampleRate), lenS=Math.floor(cl.dur*buf.sampleRate);
  c.fillStyle="rgba(255,255,255,.85)";
  const mid=h/2;
  for(let x=0;x<w;x++){
    const s0=startS+Math.floor(x/w*lenS), s1=startS+Math.floor((x+1)/w*lenS);
    let mx=0; const step=Math.max(1,((s1-s0)/40)|0);
    for(let i=s0;i<s1&&i<ch0.length;i+=step){ const v=Math.abs(ch0[i])+Math.abs(ch1[i]); if(v>mx)mx=v; }
    const y=clamp(mx*0.5,0.02,1)*(mid-3);
    c.fillRect(x,mid-y,1,Math.max(1,y*2));
  }
  /* fades */
  c.fillStyle="rgba(0,0,0,.35)";
  if(cl.fadeIn>0){ const fw=cl.fadeIn*S.px; c.beginPath(); c.moveTo(0,0); c.lineTo(fw,0); c.lineTo(0,h); c.closePath(); c.fill(); }
  if(cl.fadeOut>0){ const fw=cl.fadeOut*S.px; c.beginPath(); c.moveTo(w,0); c.lineTo(w-fw,0); c.lineTo(w,h); c.closePath(); c.fill(); }
}
function renderTimeline(){
  /* heads */
  headsEl.querySelectorAll(".thead").forEach(e=>e.remove());
  lanesEl.querySelectorAll(".lane").forEach(e=>e.remove());
  lanesEl.style.width=contentW()+"px";
  S.tracks.forEach(tr=>{
    const hd=document.createElement("div"); hd.className="thead"+(tr.id===S.selTrack?" sel":"");
    hd.innerHTML=`<div class="nm"><span class="dot" style="background:${tr.color}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(tr.name)}</span>
      <span class="badge" style="background:${TYPES[tr.type].badge}">${TYPES[tr.type].label}</span></div>
      <div class="row"><button class="msbtn m ${tr.mute?"on":""}" title="Mute">M</button>
      <button class="msbtn s ${tr.solo?"on":""}" title="Solo">S</button>
      <input type="range" min="-60" max="6" step="0.5" value="${tr.vol}" title="Volume">
      <span class="small volVal" style="font-family:var(--mono);min-width:52px">${fmtDb(tr.vol)}</span>
      <button class="del" title="Delete track">✕</button></div>
      <div class="row"><span class="small">PAN</span><input type="range" min="-100" max="100" step="1" value="${Math.round(tr.pan*100)}" title="Pan">
      <span class="small panVal" style="font-family:var(--mono);min-width:34px">${panLabel(tr.pan)}</span></div>`;
    hd.addEventListener("click",e=>{ if(e.target.closest("button,input"))return; selectTrack(tr.id); });
    const [mBtn,sBtn,delBtn]=[hd.querySelector(".m"),hd.querySelector(".s"),hd.querySelector(".del")];
    const volR=hd.querySelectorAll("input[type=range]")[0], panR=hd.querySelectorAll("input[type=range]")[1];
    mBtn.onclick=()=>{tr.mute=!tr.mute; if(S.playing)startSources(currentPos()); renderTimeline();};
    sBtn.onclick=()=>{tr.solo=!tr.solo; if(S.playing)startSources(currentPos()); renderTimeline();};
    delBtn.onclick=()=>{ const wasSel=S.selTrack===tr.id;
      S.tracks=S.tracks.filter(t=>t.id!==tr.id);
      if(wasSel){ const nt=S.tracks[0]; S.selTrack=nt?nt.id:null; S.selClip=null; S.selFx=nt&&nt.fx.length?0:-1; }
      if(S.playing)startSources(currentPos()); renderTimeline(); renderInspector(); };
    volR.oninput=()=>{ tr.vol=parseFloat(volR.value); hd.querySelector(".volVal").textContent=fmtDb(tr.vol);
      if(tr.nodes)tr.nodes.fader.gain.setTargetAtTime(db2lin(tr.vol),S.ctx.currentTime,0.03); syncMixer(); };
    panR.oninput=()=>{ tr.pan=parseFloat(panR.value)/100; hd.querySelector(".panVal").textContent=panLabel(tr.pan);
      if(tr.nodes)tr.nodes.pan.pan.setTargetAtTime(tr.pan,S.ctx.currentTime,0.03); syncMixer(); };
    headsEl.appendChild(hd);

    const ln=document.createElement("div"); ln.className="lane"+(tr.id===S.selTrack?" sel":""); ln.dataset.tid=tr.id;
    ln.style.backgroundImage=`repeating-linear-gradient(to right, var(--grid) 0, var(--grid) 1px, transparent 1px, transparent ${beatSec()*S.px}px),
      repeating-linear-gradient(to right, var(--gridbar) 0, var(--gridbar) 1px, transparent 1px, transparent ${beatSec()*4*S.px}px)`;
    tr.clips.forEach(cl=>{
      const el=document.createElement("div"); el.className="clip"+(cl.id===S.selClip?" sel":"")+(cl.muted?" muted":"");
      el.style.left=(cl.start*S.px)+"px"; el.style.width=Math.max(8,cl.dur*S.px)+"px";
      el.style.background=`linear-gradient(180deg, ${tr.color}cc, ${tr.color}88)`;
      el.title=clipSummary(cl);
      const _pl=pitchLayer(cl); const _active=_pl&&_pl.enabled&&_pl.notes.some(n=>Math.abs(effectiveShift(n,_pl))>1e-4);
      const _badges=[cl.muted?`<span class="clipbadge" style="right:auto;left:6px;background:rgba(120,20,10,.8)">Muted</span>`:"",
        (cl.gain||0)!==0?`<span class="clipbadge" style="bottom:22px">${fmtDb(cl.gain||0)}</span>`:"",
        _active?`<span class="clipbadge">Pitch ${Math.round((_pl.strength==null?1:_pl.strength)*100)}%</span>`:_pl?`<span class="clipbadge" style="opacity:.75">Pitch ${_pl.enabled?"Analyzed":"OFF"}</span>`:""].join("");
      el.innerHTML=`<canvas></canvas><div class="cap">${esc(cl.name)}</div>${_badges}<div class="edge l"></div><div class="edge r"></div>`;
      el.addEventListener("pointerdown",e=>clipPointer(e,tr,cl,el));
      ln.appendChild(el);
      requestAnimationFrame(()=>drawWave(el.querySelector("canvas"),cl));
    });
    if(S.autoMode!=="off"&&tr.id===S.selTrack){
      const ac=document.createElement("canvas"); ac.className="autocanvas"; ac.dataset.tid=tr.id;
      ln.appendChild(ac); requestAnimationFrame(()=>{sizeAutoCanvas(ac,tr); drawAuto(ac,tr);});
      ac.addEventListener("pointerdown",e=>autoPointer(e,tr,ac));
    }
    ln.addEventListener("pointerdown",e=>{ if(e.target===ln){ selectTrack(tr.id); S.selClip=null; renderTimeline(); renderInspector(); }});
    lanesEl.appendChild(ln);
  });
  drawRuler(); updatePlayhead();
  $("#headInfo").textContent=S.tracks.length+" trk";
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function panLabel(p){ return p===0?"C":(p<0?"L"+Math.round(-p*100):"R"+Math.round(p*100)); }
function selectTrack(id){ S.selTrack=id; S.selFx=S.tracks.find(t=>t.id===id)?.fx.length?0:-1; renderTimeline(); renderInspector(); }
function selTrackObj(){ return S.tracks.find(t=>t.id===S.selTrack)||S.tracks[0]; }
function findClip(id){ for(const tr of S.tracks){ const cl=tr.clips.find(c=>c.id===id); if(cl) return {tr,cl}; } return null; }

/* ---------- clip drag / trim ---------- */
function clipPointer(e,tr,cl,el){
  if(e.button!==0) return;
  e.preventDefault(); selectTrackSilent(tr.id); S.selClip=cl.id; renderTimeline(); renderInspector();
  /* re-render replaced the DOM: find this clip's fresh element */
  const lane2=lanesEl.querySelector(`.lane[data-tid="${tr.id}"]`); if(!lane2) return;
  const idx=tr.clips.indexOf(cl); const el2=lane2.querySelectorAll(".clip")[idx]; if(!el2) return;
  const x0=e.clientX;
  const mode=e.target.classList.contains("l")?"trimL":(e.target.classList.contains("r")?"trimR":"move");
  const orig={start:cl.start,offset:cl.offset,dur:cl.dur};
  const snapT=t=>{ if(!S.snap||e.altKey) return t; const g=beatSec()/2; return Math.round(t/g)*g; };
  function mv(ev){
    const dt=(ev.clientX-x0)/S.px;
    if(mode==="move"){ cl.start=Math.max(0,snapT(orig.start+dt)); }
    else if(mode==="trimL"){ const ns=clamp(snapT(orig.start+dt),Math.max(0,orig.start-orig.offset),orig.start+orig.dur-0.05);
      cl.offset=orig.offset+(ns-orig.start); cl.dur=orig.dur-(ns-orig.start); cl.start=ns; }
    else { cl.dur=clamp(orig.dur+dt,0.05,cl.buffer.duration-cl.offset); if(S.snap&&!ev.altKey){ const g=beatSec()/2; cl.dur=Math.max(0.05,Math.round(cl.dur/g)*g); } }
    el2.style.left=(cl.start*S.px)+"px"; el2.style.width=Math.max(8,cl.dur*S.px)+"px";
  }
  function up(){ window.removeEventListener("pointermove",mv); window.removeEventListener("pointerup",up);
    drawWave(el2.querySelector("canvas"),cl); renderInspector(); if(S.playing) startSources(currentPos()); }
  window.addEventListener("pointermove",mv); window.addEventListener("pointerup",up);
}
function selectTrackSilent(id){ S.selTrack=id; }

/* ---------- ruler: seek & loop ---------- */
(function(){
  let drag=null;
  rulerEl.addEventListener("pointerdown",e=>{
    const r=rulerEl.getBoundingClientRect(); const t=(e.clientX-r.left)/S.px;
    drag={t0:t,moved:false}; rulerEl.setPointerCapture(e.pointerId);
  });
  rulerEl.addEventListener("pointermove",e=>{
    if(!drag) return; const r=rulerEl.getBoundingClientRect(); const t=(e.clientX-r.left)/S.px;
    if(Math.abs(t-drag.t0)>4/S.px){ drag.moved=true; S.loop.start=Math.min(drag.t0,t); S.loop.end=Math.max(drag.t0,t); S.loop.on=true; $("#btnLoop").classList.add("on"); drawRuler(); }
  });
  rulerEl.addEventListener("pointerup",e=>{
    if(!drag) return;
    if(!drag.moved) seek(drag.t0); else if(S.playing){ S.pos=S.loop.start; startSources(S.pos); }
    drag=null;
  });
})();

/* ---------- automation editing ---------- */
function sizeAutoCanvas(ac,tr){ const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=ac.clientWidth||contentW(), h=ac.clientHeight||96;
  ac.width=w*dpr; ac.height=h*dpr; ac.getContext("2d").scale(dpr,dpr); ac._w=w; ac._h=h; }
function autoY2V(y,h){ return S.autoMode==="volume"? clamp(6-(y/h)*72,-60,6) : clamp(1-(y/h)*2,-1,1); }
function autoV2Y(v,h){ return S.autoMode==="volume"? (6-v)/72*h : (1-v)/2*h; }
function drawAuto(ac,tr){
  const c=ac.getContext("2d"), w=ac._w, h=ac._h; if(!w) return;
  c.clearRect(0,0,w,h);
  c.fillStyle=S.autoMode==="volume"?"rgba(176,84,70,.10)":"rgba(96,128,168,.10)"; c.fillRect(0,0,w,h);
  const pts=[...tr.auto[S.autoMode]].sort((a,b)=>a.t-b.t);
  const defV=S.autoMode==="volume"?tr.vol:tr.pan;
  const drawPts=pts.length?pts:[{t:0,v:defV}];
  const trace=()=>{ c.beginPath(); c.moveTo(0,autoV2Y(drawPts[0].v,h));
    drawPts.forEach(p=>c.lineTo(p.t*S.px,autoV2Y(p.v,h)));
    c.lineTo(w,autoV2Y(drawPts[drawPts.length-1].v,h)); };
  c.strokeStyle="rgba(0,0,0,.45)"; c.lineWidth=5; trace(); c.stroke();
  c.strokeStyle=S.autoMode==="volume"?"#d97a6a":"#87a6cc"; c.lineWidth=2.5; trace(); c.stroke();
  c.fillStyle="#fff";
  pts.forEach(p=>{ c.beginPath(); c.arc(p.t*S.px,autoV2Y(p.v,h),5,0,7); c.fill();
    c.strokeStyle=S.autoMode==="volume"?"#b85448":"#5d7fa8"; c.stroke(); });
  c.fillStyle="rgba(255,255,255,.75)"; c.font="11px sans-serif";
  c.fillText(S.autoMode==="volume"?"Volume automation (click to add a point, right-click to delete)":"Pan automation (click to add a point, right-click to delete)",10,16);
}
function autoPointer(e,tr,ac){
  e.preventDefault();
  const r=ac.getBoundingClientRect(); const h=ac._h||ac.clientHeight;
  const t=(e.clientX-r.left)/S.px, v=autoY2V(e.clientY-r.top,h);
  const pts=tr.auto[S.autoMode];
  let hit=pts.findIndex(p=>Math.abs(p.t-t)<8/S.px&&Math.abs(autoV2Y(p.v,h)-(e.clientY-r.top))<10);
  if(e.button===2){ if(hit>=0){ pts.splice(hit,1); drawAuto(ac,tr); if(S.playing)startSources(currentPos()); } return; }
  if(hit<0){ pts.push({t:Math.max(0,t),v}); pts.sort((a,b)=>a.t-b.t); hit=pts.findIndex(p=>p.t===Math.max(0,t)); }
  const p=pts[hit]; if(!p) return;
  function mv(ev){ const nt=clamp((ev.clientX-r.left)/S.px,0,projectEnd());
    p.t=S.snap?Math.round(nt/(beatSec()/4))*(beatSec()/4):nt; p.v=autoY2V(ev.clientY-r.top,h);
    pts.sort((a,b)=>a.t-b.t); drawAuto(ac,tr); }
  function up(){ window.removeEventListener("pointermove",mv); window.removeEventListener("pointerup",up);
    if(S.playing) startSources(currentPos()); }
  window.addEventListener("pointermove",mv); window.addEventListener("pointerup",up);
  drawAuto(ac,tr);
}
lanesEl.addEventListener("contextmenu",e=>{ if(S.autoMode!=="off") e.preventDefault(); });

/* ============================================================
   Inspector
   ============================================================ */
let curTab="ch";
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.style.display="block";
  clearTimeout(t._h); t._h=setTimeout(()=>t.style.display="none",2600); }
function renderInspector(){
  $$("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.t===curTab));
  const body=$("#tabBody");
  if(curTab==="ch") body.innerHTML=chHTML(), wireCh();
  else if(curTab==="fx") body.innerHTML=fxHTML(), wireFx();
  else if(curTab==="mix") body.innerHTML=mixHTML(), wireMix();
  else if(curTab==="pitch") body.innerHTML=pitchHTML(), wirePitch();
  else body.innerHTML=expHTML(), wireExp();
}
$("#tabs").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return;
  curTab=b.dataset.t; renderInspector(); });

/* ----- Channel / clips ----- */
function chHTML(){
  const tr=selTrackObj(); if(!tr) return "<p class='small'>No tracks</p>";
  const fc=findClip(S.selClip); const cl=fc&&fc.tr.id===tr.id?fc.cl:null;
  const busOpts=`<option value="">Direct to Master</option>`+S.buses.map(b=>`<option value="${b.id}" ${tr.bus===b.id?"selected":""}>${esc(b.name)}</option>`).join("");
  let h=`<div class="cols">
  <div class="sect"><h3>Track Settings — ${esc(tr.name)}</h3>
    <div class="fld"><label>Name</label><input type="text" id="chName" value="${esc(tr.name)}" style="width:170px"></div>
    <div class="fld"><label>Type</label><select id="chType">${Object.entries(TYPES).map(([k,v])=>`<option value="${k}" ${tr.type===k?"selected":""}>${v.label}</option>`).join("")}</select></div>
    <div class="fld"><label>Output Bus</label><select id="chBus">${busOpts}</select></div>
    <div class="fld"><label>Volume</label><input type="range" id="chVol" min="-60" max="6" step="0.5" value="${tr.vol}"><output>${fmtDb(tr.vol)}</output></div>
    <div class="fld"><label>Pan</label><input type="range" id="chPan" min="-100" max="100" step="1" value="${Math.round(tr.pan*100)}"><output>${panLabel(tr.pan)}</output></div>
    <div class="fld"><label>Reverb Send</label><input type="range" id="chSendR" min="0" max="100" step="1" value="${Math.round(tr.sendRev*100)}"><output>${Math.round(tr.sendRev*100)}%</output></div>
    <div class="fld"><label>Delay Send</label><input type="range" id="chSendD" min="0" max="100" step="1" value="${Math.round(tr.sendDly*100)}"><output>${Math.round(tr.sendDly*100)}%</output></div>
    <p class="small">Sends feed the return reverb / delay. Route several tracks to a bus to process them together.</p>
  </div>
  <div class="sect"><h3>Buses</h3>
    ${S.buses.map(b=>`<div class="fld"><label style="width:110px">${esc(b.name)}</label><input type="range" data-bus="${b.id}" class="busVol" min="-60" max="6" step="0.5" value="${b.vol}"><output>${fmtDb(b.vol)}</output><button data-busmute="${b.id}" class="msbtn m ${b.muted?"on":""}" title="Mute bus">M</button><span class="small">${S.tracks.filter(t=>t.bus===b.id).length} trk</span></div>`).join("")}
    <div class="fld"><input type="text" id="newBusName" placeholder="New bus name" style="width:130px"><button id="btnAddBus">Add Bus</button></div>
    <h3 style="margin-top:16px">Returns (Send Destinations)</h3>
    <div class="fld"><label>Reverb Decay</label><input type="range" id="retDecay" min="0.4" max="6" step="0.1" value="${S.returns?S.returns.decay:2.6}"><output>${(S.returns?S.returns.decay:2.6).toFixed(1)} s</output></div>
    <div class="fld"><label>Delay Time</label><input type="range" id="retDlyT" min="0.03" max="1" step="0.005" value="${S.returns?S.returns.dlyTime:0.375}"><output>${Math.round((S.returns?S.returns.dlyTime:0.375)*1000)} ms</output></div>
    <div class="fld"><label>Delay Feedback</label><input type="range" id="retDlyF" min="0" max="0.85" step="0.01" value="${S.returns?S.returns.dlyFb:0.34}"><output>${Math.round((S.returns?S.returns.dlyFb:0.34)*100)}%</output></div>
  </div>`;
  /* --- Clip list: each clip is an independent unit (select, mute, duplicate, delete, summary) --- */
  h+=`<div class="sect clipchain"><h3>Clips — ${esc(tr.name)} (Independent Units)</h3>
  <p class="small" style="margin:0">Edits change parameters only; the source audio is never rewritten. Summaries keep the state visible while collapsed.</p>
  ${tr.clips.length?tr.clips.map((c,i)=>`<div class="clipitem ${c.id===S.selClip?"sel":""} ${c.muted?"off":""}" data-clip="${c.id}">
    <span class="fxnum">${i+1}</span>
    <div class="fxmeta"><span class="t">${esc(c.name)}</span><span class="fxsum">${esc(clipSummary(c))}</span>
    <div class="fxacts"><button data-cact="dup" title="Duplicate this clip">Duplicate</button><button data-cact="del" title="Delete this clip">✕</button></div></div>
    <button data-cact="mute" class="fxpower ${c.muted?"":"on"}" title="Toggle this clip only (mute)">${c.muted?"OFF":"ON"}</button></div>`).join(""):"<p class='small'>No clips on this track</p>"}
  </div>`;
  if(cl){
    h+=`<div class="sect" style="min-width:min(300px,100%);flex:1"><h3>Selected Clip — ${esc(cl.name)}</h3>
    <div class="layerstack" style="margin-bottom:10px">
      <div class="layercard src"><div class="layer-ico">♪</div><div class="layer-main"><b>Source Audio</b><span class="badge" style="background:#5b7a2a;margin-left:6px">Always Kept</span><p>Source offset ${cl.offset.toFixed(2)} s — never rewritten by trim / gain / fades.</p></div></div>
      <div class="layer-arrow">↓ &nbsp;Parameters layered on top</div>
      <div class="layercard ${cl.muted?"off":"active"}"><div class="layer-ico">✂</div><div class="layer-main"><b>Clip Edit Layer</b> ${cl.muted?`<span class="badge" style="background:#6e7488;margin-left:6px">Muted</span>`:""}
      <p>${esc(clipSummary(cl))}</p></div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:none"><button id="clMuteBtn">${cl.muted?"Unmute":"Mute"}</button><button id="clDupBtn" class="ghost">Duplicate</button></div></div>
    </div>
    <div class="fxpresetbar"><span class="cap">PRESET</span>
      <div class="fxchips">${CLIP_PRESETS.map(p=>`<button data-clippreset="${p.id}" class="${clipPresetMatch(cl,p)?"on":""}">${p.label}</button>`).join("")}</div></div>
    ${cl.collapsed?`<p class="small">This clip's editor is collapsed. Audio plays with the current settings.<button id="clExpandBtn" style="margin-left:6px">Open</button></p>`:`<div class="fld"><label>Start</label><input type="number" id="clStart" step="0.01" min="0" value="${cl.start.toFixed(2)}"><span class="small">s</span><button id="clCollapseBtn" class="ghost" style="margin-left:auto">Collapse</button></div>
    <div class="fld"><label>Gain</label><input type="range" id="clGain" min="-24" max="12" step="0.5" value="${cl.gain||0}"><output>${fmtDb(cl.gain||0)}</output></div>
    <div class="fld"><label>Fade In</label><input type="number" id="clFI" step="0.01" min="0" max="${cl.dur}" value="${(cl.fadeIn||0).toFixed(2)}"><span class="small">s</span></div>
    <div class="fld"><label>Fade Out</label><input type="number" id="clFO" step="0.01" min="0" max="${cl.dur}" value="${(cl.fadeOut||0).toFixed(2)}"><span class="small">s</span></div>
    <div class="fld"><button id="clSplit2">Split at Playhead</button><button id="clDel2">Delete Clip</button></div>
    <p class="small">Length ${(cl.dur).toFixed(2)} s / Source offset ${cl.offset.toFixed(2)} s</p>`}</div>`;
  } else {
    h+=`<div class="sect"><h3>Clips</h3><p class="small">Click a clip in the list or on the timeline to edit its gain and fades. Splitting happens at the playhead (<span class="kbd">S</span>).</p></div>`;
  }
  return h+"</div>";
}
function wireCh(){
  const tr=selTrackObj(); if(!tr) return;
  const R=(id,fn)=>{ const el=$(id); if(el) el.addEventListener("input",fn); };
  R("#chName",e=>{ tr.name=e.target.value; renderTimeline(); });
  $("#chType").addEventListener("change",e=>{ tr.type=e.target.value; tr.color=TYPES[tr.type].color; renderTimeline(); });
  $("#chBus").addEventListener("change",e=>{ tr.bus=e.target.value||null; refreshTrackOut(tr); });
  R("#chVol",e=>{ tr.vol=parseFloat(e.target.value); e.target.nextElementSibling.textContent=fmtDb(tr.vol);
    if(tr.nodes)tr.nodes.fader.gain.setTargetAtTime(db2lin(tr.vol),S.ctx.currentTime,0.03); renderTimelineSoft(); });
  R("#chPan",e=>{ tr.pan=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=panLabel(tr.pan);
    if(tr.nodes)tr.nodes.pan.pan.setTargetAtTime(tr.pan,S.ctx.currentTime,0.03); renderTimelineSoft(); });
  R("#chSendR",e=>{ tr.sendRev=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=e.target.value+"%";
    if(tr.nodes)tr.nodes.sRev.gain.setTargetAtTime(tr.sendRev,S.ctx.currentTime,0.03); });
  R("#chSendD",e=>{ tr.sendDly=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=e.target.value+"%";
    if(tr.nodes)tr.nodes.sDly.gain.setTargetAtTime(tr.sendDly,S.ctx.currentTime,0.03); });
  $$(".busVol").forEach(el=>el.addEventListener("input",()=>{ const b=S.buses.find(x=>x.id===el.dataset.bus);
    b.vol=parseFloat(el.value); el.nextElementSibling.textContent=fmtDb(b.vol);
    if(b.nodes)b.nodes.g.gain.setTargetAtTime(b.muted?0:db2lin(b.vol),S.ctx.currentTime,0.03); }));
  $$("[data-busmute]").forEach(btn=>btn.addEventListener("click",()=>{ const b=S.buses.find(x=>x.id===btn.dataset.busmute); if(!b) return;
    b.muted=!b.muted; if(b.nodes&&S.ctx) b.nodes.g.gain.setTargetAtTime(b.muted?0:db2lin(b.vol),S.ctx.currentTime,0.03); renderInspector(); }));
  /* Clip list (independent units): select, mute, duplicate, delete */
  $$(".clipitem").forEach(item=>{ const cid=item.dataset.clip;
    item.addEventListener("click",e=>{ const act=e.target.dataset&&e.target.dataset.cact; const c=tr.clips.find(x=>x.id===cid); if(!c) return;
      if(act==="mute"){ c.muted=!c.muted; renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos()); return; }
      if(act==="dup"){ duplicateClip(tr,c); return; }
      if(act==="del"){ S.selClip=cid; deleteSelected(); return; }
      if(!act){ S.selClip=cid; renderTimeline(); renderInspector(); } }); });
  const ab=$("#btnAddBus"); if(ab) ab.onclick=()=>{ const nm=($("#newBusName").value||"Bus").trim();
    const b=newBus(nm); S.buses.push(b); if(S.ctx)buildBusGraph(b); renderInspector(); toast("Added bus \""+nm+"\""); };
  R("#retDecay",e=>{ const v=parseFloat(e.target.value); e.target.nextElementSibling.textContent=v.toFixed(1)+" s";
    if(S.returns){ S.returns.decay=v; S.returns.conv.buffer=makeIR(S.ctx,v); } });
  R("#retDlyT",e=>{ const v=parseFloat(e.target.value); e.target.nextElementSibling.textContent=Math.round(v*1000)+" ms";
    if(S.returns){ S.returns.dlyTime=v; S.returns.dly.delayTime.setTargetAtTime(v,S.ctx.currentTime,0.03); } });
  R("#retDlyF",e=>{ const v=parseFloat(e.target.value); e.target.nextElementSibling.textContent=Math.round(v*100)+"%";
    if(S.returns){ S.returns.dlyFb=v; S.returns.fb.gain.setTargetAtTime(v,S.ctx.currentTime,0.03); } });
  const fc=findClip(S.selClip); if(fc&&fc.tr.id===tr.id){ const cl=fc.cl;
    R("#clStart",e=>{ cl.start=Math.max(0,parseFloat(e.target.value)||0); renderTimeline(); });
    R("#clGain",e=>{ cl.gain=parseFloat(e.target.value); e.target.nextElementSibling.textContent=fmtDb(cl.gain); if(S.playing)startSources(currentPos()); });
    R("#clFI",e=>{ cl.fadeIn=clamp(parseFloat(e.target.value)||0,0,cl.dur); renderTimeline(); if(S.playing)startSources(currentPos()); });
    R("#clFO",e=>{ cl.fadeOut=clamp(parseFloat(e.target.value)||0,0,cl.dur); renderTimeline(); if(S.playing)startSources(currentPos()); });
    $$("[data-clippreset]").forEach(b=>b.addEventListener("click",()=>{ const p=CLIP_PRESETS.find(x=>x.id===b.dataset.clippreset); if(p) applyClipPreset(cl,p); }));
    const mb=$("#clMuteBtn"); if(mb) mb.onclick=()=>{ cl.muted=!cl.muted; renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos()); };
    const dp=$("#clDupBtn"); if(dp) dp.onclick=()=>duplicateClip(fc.tr,cl);
    const cb=$("#clCollapseBtn"); if(cb) cb.onclick=()=>{ cl.collapsed=true; renderInspector(); };
    const eb=$("#clExpandBtn"); if(eb) eb.onclick=()=>{ cl.collapsed=false; renderInspector(); };
    const sp=$("#clSplit2"); if(sp) sp.onclick=splitSelected;
    const dl=$("#clDel2"); if(dl) dl.onclick=deleteSelected;
  }
}
function renderTimelineSoft(){ /* Sync header fader readouts only (a full re-render would break focus while typing) */ syncMixer(); }

/* ----- Effects ----- */
const FXNAMES={eq:"Parametric EQ",comp:"Compressor",reverb:"Reverb",delay:"Delay"};
function fxHTML(){
  const tr=selTrackObj(); if(!tr) return "<p class='small'>No tracks</p>";
  if(S.selFx>=tr.fx.length) S.selFx=tr.fx.length-1;
  if(S.selFx<0&&tr.fx.length) S.selFx=0;
  const chain=tr.fx.map((fx,i)=>`<div class="fxitem ${i===S.selFx?"sel":""} ${fx.on?"":"off"}" data-i="${i}" draggable="true">
    <span class="fxnum">${i+1}</span>
    <div class="fxmeta"><span class="t">${FXNAMES[fx.type]}</span><span class="fxsum">${esc(FXDEF[fx.type].summary(fx))}</span>
    <div class="fxacts"><button data-act="up" title="Move up">↑</button><button data-act="down" title="Move down">↓</button><button data-act="del" title="Delete this stage">✕</button></div></div>
    <button data-act="on" class="fxpower ${fx.on?"on":""}" title="Toggle this stage only">${fx.on?"ON":"OFF"}</button></div>`).join("");
  let ed="";
  const fx=tr.fx[S.selFx];
  if(!fx){
    ed="<p class='small'>Select a stage from the list to edit its parameters here. Each stage is independent: ON/OFF, reorder, per-stage presets, duplicate and collapse.</p>";
  } else {
    ed=fxStageHeadHTML(tr,fx,S.selFx);
    if(fx.collapsed){
      ed+=`<p class="small">This stage is collapsed. Audio plays with the current settings (${esc(FXDEF[fx.type].summary(fx))}). Press "Open" to edit it.</p>`;
    }
    else if(fx.type==="eq") ed+=eqEditorHTML(fx);
    else if(fx.type==="comp") ed+=compEditorHTML(fx);
    else if(fx.type==="reverb") ed+=knobEditorHTML("Reverb (Insert)",[
      {k:"decay",label:"Decay",min:0.3,max:7,step:0.1,val:fx.decay,unit:" s",fmt:v=>v.toFixed(1)},
      {k:"predelay",label:"Pre-delay",min:0,max:0.15,step:0.005,val:fx.predelay,unit:" ms",fmt:v=>Math.round(v*1000)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="delay") ed+=knobEditorHTML("Delay (Insert)",[
      {k:"time",label:"Time",min:0.02,max:1.2,step:0.005,val:fx.time,unit:" ms",fmt:v=>Math.round(v*1000)},
      {k:"feedback",label:"Feedback",min:0,max:0.85,step:0.01,val:fx.feedback,unit:"%",fmt:v=>Math.round(v*100)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}])+
      `<div class="fld" style="margin-top:10px"><label style="width:auto">Tempo Sync</label><select id="dlySync">
        ${[["off","No Sync"],["4","Quarter Note"],["d8","Dotted 8th"],["8","8th Note"],["16","16th Note"],["t8","8th Triplet"]].map(([v,l])=>`<option value="${v}" ${fx.sync===v?"selected":""}>${l}</option>`).join("")}</select>
        <span class="small">Syncs the delay time to BPM ${S.bpm}</span></div>`;
  }
  return `<div class="fxwrap"><div class="chain"><h3 style="margin:0 0 4px;font-size:12px;color:var(--tx2)">Inserts — ${esc(tr.name)} (Serial Chain)</h3>
    <p class="small" style="margin:0 0 2px">Audio flows from the top stage down. Each stage is an independent unit; summaries always show here.</p>
    ${chain||"<p class='small'>No effects</p>"}
    <div class="fld" style="margin-top:6px"><select id="addFxType"><option value="eq">EQ</option><option value="comp">Compressor</option><option value="reverb">Reverb</option><option value="delay">Delay</option></select>
    <button id="btnAddFx">+ Add Stage</button></div></div>
    <div class="fxeditor">${ed}</div></div>`;
}
function fxStageHeadHTML(tr,fx,i){
  const def=FXDEF[fx.type];
  const curKey=JSON.stringify(fxSnapshot(fx));
  const chips=def.presets.map(p=>`<button data-fxpreset="${p.id}" class="${fxPresetKey(fx.type,p)===curKey?"on":""}">${p.label}</button>`).join("");
  const uchips=(S.userFxPresets[fx.type]||[]).map((p,ui)=>`<span class="uchip"><button data-ufxpreset="${ui}" class="${JSON.stringify(fxSnapshot(p.data))===curKey?"on":""}">${esc(p.label)}</button><button data-udel="${ui}" title="Delete this preset" aria-label="Delete preset">✕</button></span>`).join("");
  return `<div class="fxhead"><span class="ttl"><span class="fxnum">${i+1}</span>${def.name}<span class="badge" style="background:${fx.on?"#2f8f6e":"#6e7488"}">${fx.on?"ON":"OFF"}</span></span>
    <span class="small">Stage ${i+1} / ${tr.fx.length}</span>
    <div class="acts">
      <button data-sact="collapse">${fx.collapsed?"Open":"Collapse"}</button>
      <button data-sact="dup">Duplicate</button>
      <button data-sact="reset">Reset</button>
      <button data-sact="del">Delete</button>
    </div></div>
  <div class="fxpresetbar"><span class="cap">PRESET</span>
    <div class="fxchips">${chips}${uchips}</div>
    <div class="fxusersave"><input type="text" id="fxPresetName" placeholder="My preset name" maxlength="24"><button id="btnSaveFxPreset">Save Current Settings</button><span class="small">Saved for this session only</span></div>
  </div>`;
}
function eqEditorHTML(fx){
  const rows=fx.bands.map((b,i)=>`<tr>
    <td><button data-bon="${i}" style="min-height:28px;height:28px;padding:0 8px">${b.on?"ON":"OFF"}</button></td>
    <td><select data-bt="${i}">${["highpass","lowpass","lowshelf","peaking","highshelf","notch"].map(t=>`<option ${b.t===t?"selected":""}>${t}</option>`).join("")}</select></td>
    <td><input type="number" data-bf="${i}" min="20" max="20000" step="1" value="${Math.round(b.f)}"></td>
    <td><input type="number" data-bg="${i}" min="-24" max="24" step="0.5" value="${b.g}" ${b.t==="highpass"||b.t==="lowpass"||b.t==="notch"?"disabled":""}></td>
    <td><input type="number" data-bq="${i}" min="0.1" max="18" step="0.05" value="${b.q}"></td></tr>`).join("");
  return `<h3>Parametric EQ — drag handles (horizontal = frequency / vertical = gain), wheel for Q</h3>
    <canvas id="eqCanvas"></canvas>
    <table class="params"><tr><th></th><th>Type</th><th>Frequency Hz</th><th>Gain dB</th><th>Q</th></tr>${rows}</table>`;
}
function compEditorHTML(fx){
  return `<h3>Compressor — Full Control</h3><div class="knobgrid">
    ${knobHTML("threshold","Threshold",-60,0,0.5,fx.threshold,v=>v.toFixed(1)+" dB")}
    ${knobHTML("ratio","Ratio",1,20,0.1,fx.ratio,v=>v.toFixed(1)+" : 1")}
    ${knobHTML("attack","Attack",0,0.25,0.001,fx.attack,v=>Math.round(v*1000)+" ms")}
    ${knobHTML("release","Release",0.01,1,0.005,fx.release,v=>Math.round(v*1000)+" ms")}
    ${knobHTML("knee","Knee",0,40,1,fx.knee,v=>v.toFixed(0)+" dB")}
    ${knobHTML("makeup","Makeup",0,24,0.5,fx.makeup,v=>"+"+v.toFixed(1)+" dB")}
    </div>
    <div style="max-width:420px;margin-top:12px"><label class="small">Gain Reduction (while playing)</label>
    <div class="grmeter"><i id="grBar"></i></div></div>`;
}
function knobHTML(k,label,min,max,step,val,fmt){ return `<div class="knob"><label>${label}</label>
  <div class="row"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></div></div>`; }
function knobEditorHTML(title,defs){
  return `<h3>${title}</h3><div class="knobgrid">${defs.map(d=>knobHTML(d.k,d.label,d.min,d.max,d.step,d.val,v=>d.fmt(v)+ (d.unit==="% "?"":d.unit==="%"?"%":d.unit))).join("")}</div>`;
}
function wireFx(){
  const tr=selTrackObj(); if(!tr) return;
  $$(".fxitem").forEach(item=>{
    const i=parseInt(item.dataset.i);
    item.addEventListener("click",e=>{
      const act=e.target.dataset&&e.target.dataset.act;
      if(act==="on"){ tr.fx[i].on=!tr.fx[i].on; applyFxLive(tr,i); renderInspector(); return; }
      if(act==="del"){ tr.fx.splice(i,1); S.selFx=-1; applyFxLive(tr,i,true); renderInspector(); return; }
      if(act==="up"&&i>0){ [tr.fx[i-1],tr.fx[i]]=[tr.fx[i],tr.fx[i-1]]; S.selFx=i-1; applyFxLive(tr,i,true); renderInspector(); return; }
      if(act==="down"&&i<tr.fx.length-1){ [tr.fx[i+1],tr.fx[i]]=[tr.fx[i],tr.fx[i+1]]; S.selFx=i+1; applyFxLive(tr,i,true); renderInspector(); return; }
      if(!act){ S.selFx=i; renderInspector(); }
    });
    item.addEventListener("dragstart",e=>{ e.dataTransfer.setData("text/plain",String(i)); });
    item.addEventListener("dragover",e=>e.preventDefault());
    item.addEventListener("drop",e=>{ e.preventDefault(); const from=parseInt(e.dataTransfer.getData("text/plain"));
      if(isNaN(from)||from===i) return; const [m]=tr.fx.splice(from,1); tr.fx.splice(i,0,m); S.selFx=i; applyFxLive(tr,i,true); renderInspector(); });
  });
  const add=$("#btnAddFx"); if(add) add.onclick=()=>{ tr.fx.push(defaultFx($("#addFxType").value)); S.selFx=tr.fx.length-1; applyFxLive(tr,S.selFx,true); renderInspector(); };
  /* Stage header: collapse, duplicate, reset, delete (independent actions on the selected stage) */
  $$("[data-sact]").forEach(b=>b.addEventListener("click",()=>{
    const act=b.dataset.sact, i=S.selFx, fx=tr.fx[i]; if(!fx) return;
    if(act==="collapse"){ fx.collapsed=!fx.collapsed; renderInspector(); }
    else if(act==="dup"){ const c=JSON.parse(JSON.stringify(fx)); c.collapsed=false; tr.fx.splice(i+1,0,c); S.selFx=i+1; applyFxLive(tr,i+1,true); renderInspector(); toast(FXNAMES[fx.type]+" duplicated"); }
    else if(act==="reset"){ setFxParams(fx,defaultFx(fx.type)); applyFxLive(tr,i,true); renderInspector(); toast("Stage reset to defaults"); }
    else if(act==="del"){ tr.fx.splice(i,1); S.selFx=-1; applyFxLive(tr,i,true); renderInspector(); }
  }));
  /* Stage presets: built-in + user-saved (this session) */
  $$("[data-fxpreset]").forEach(b=>b.addEventListener("click",()=>{ const fx=tr.fx[S.selFx]; if(!fx) return;
    const p=FXDEF[fx.type].presets.find(x=>x.id===b.dataset.fxpreset); if(p) applyFxPreset(tr,S.selFx,p); }));
  $$("[data-ufxpreset]").forEach(b=>b.addEventListener("click",()=>{ const fx=tr.fx[S.selFx]; if(!fx) return;
    const p=(S.userFxPresets[fx.type]||[])[+b.dataset.ufxpreset]; if(p) applyFxPreset(tr,S.selFx,{label:p.label,data:p.data}); }));
  $$("[data-udel]").forEach(b=>b.addEventListener("click",()=>{ const fx=tr.fx[S.selFx]; if(!fx) return;
    const arr=S.userFxPresets[fx.type]||[]; const rm=arr.splice(+b.dataset.udel,1)[0]; renderInspector();
    if(rm) toast("Deleted preset \""+rm.label+"\""); }));
  const sv=$("#btnSaveFxPreset");
  if(sv) sv.onclick=()=>{ const fx=tr.fx[S.selFx]; if(!fx) return;
    const nm=($("#fxPresetName").value||"").trim()||(FXNAMES[fx.type]+" "+((S.userFxPresets[fx.type]||[]).length+1));
    (S.userFxPresets[fx.type]=S.userFxPresets[fx.type]||[]).push({label:nm,data:fxSnapshot(fx)});
    renderInspector(); toast("Saved preset \""+nm+"\" (this session only)"); };
  const fx=tr.fx[S.selFx]; if(!fx||fx.collapsed) return;
  if(fx.type==="eq") wireEq(tr,fx);
  else if(fx.type==="comp"){ $$(".knob input").forEach(inp=>inp.addEventListener("input",()=>{
    fx[inp.dataset.k]=parseFloat(inp.value); inp.nextElementSibling.textContent=compFmt(inp.dataset.k,fx[inp.dataset.k]);
    applyFxLive(tr,S.selFx); })); }
  else { $$(".knob input").forEach(inp=>inp.addEventListener("input",()=>{
    fx[inp.dataset.k]=parseFloat(inp.value);
    inp.nextElementSibling.textContent=fxFmt(fx.type,inp.dataset.k,fx[inp.dataset.k]);
    applyFxLive(tr,S.selFx); }));
    const ds=$("#dlySync"); if(ds) ds.addEventListener("change",()=>{ fx.sync=ds.value;
      const b=60/S.bpm; const map={"4":b,"d8":b*0.75,"8":b/2,"16":b/4,"t8":b/3};
      if(map[fx.sync]){ fx.time=map[fx.sync]; applyFxLive(tr,S.selFx); renderInspector(); } });
  }
}
function compFmt(k,v){ return {threshold:v.toFixed(1)+" dB",ratio:v.toFixed(1)+" : 1",attack:Math.round(v*1000)+" ms",release:Math.round(v*1000)+" ms",knee:v.toFixed(0)+" dB",makeup:"+"+v.toFixed(1)+" dB"}[k]; }
function fxFmt(type,k,v){ if(k==="mix"||k==="feedback") return Math.round(v*100)+"%";
  if(k==="decay") return v.toFixed(1)+" s"; if(k==="predelay") return Math.round(v*1000)+" ms";
  if(k==="time") return Math.round(v*1000)+" ms"; return String(v); }
/* EQ graph */
function wireEq(tr,fx){
  const cv=$("#eqCanvas"); if(!cv) return;
  $$("[data-bf]").forEach(inp=>inp.addEventListener("input",()=>{ fx.bands[+inp.dataset.bf].f=clamp(parseFloat(inp.value)||100,20,20000); applyFxLive(tr,S.selFx); drawEq(cv,fx); }));
  $$("[data-bg]").forEach(inp=>inp.addEventListener("input",()=>{ fx.bands[+inp.dataset.bg].g=clamp(parseFloat(inp.value)||0,-24,24); applyFxLive(tr,S.selFx); drawEq(cv,fx); }));
  $$("[data-bq]").forEach(inp=>inp.addEventListener("input",()=>{ fx.bands[+inp.dataset.bq].q=clamp(parseFloat(inp.value)||1,0.1,18); applyFxLive(tr,S.selFx); drawEq(cv,fx); }));
  $$("[data-bt]").forEach(sel=>sel.addEventListener("change",()=>{ fx.bands[+sel.dataset.bt].t=sel.value; applyFxLive(tr,S.selFx); renderInspector(); }));
  $$("[data-bon]").forEach(b=>b.addEventListener("click",()=>{ const bd=fx.bands[+b.dataset.bon]; bd.on=!bd.on; applyFxLive(tr,S.selFx); renderInspector(); }));
  drawEq(cv,fx);
  let dragB=-1;
  const pos2fb=(x,y,w,h)=>{ const f=20*Math.pow(1000,x/w); const g=clamp(18-(y/h)*36,-24,24); return {f,g}; };
  cv.addEventListener("pointerdown",e=>{ const r=cv.getBoundingClientRect();
    const x=e.clientX-r.left,y=e.clientY-r.top;
    let best=1e9; fx.bands.forEach((b,i)=>{ const bx=Math.log10(b.f/20)/3*r.width, by=(18-b.g)/36*r.height;
      const d=(bx-x)**2+(by-y)**2; if(d<best){best=d;dragB=i;} });
    if(best>30*30) dragB=-1;
    if(dragB>=0){ cv.setPointerCapture(e.pointerId); moveEq(e); } });
  function moveEq(e){ if(dragB<0) return; const r=cv.getBoundingClientRect();
    const {f,g}=pos2fb(e.clientX-r.left,e.clientY-r.top,r.width,r.height);
    const b=fx.bands[dragB]; b.f=clamp(f,20,20000); if(!["highpass","lowpass","notch"].includes(b.t)) b.g=g;
    applyFxLive(tr,S.selFx); drawEq(cv,fx); syncEqNums(fx); }
  cv.addEventListener("pointermove",moveEq);
  cv.addEventListener("pointerup",()=>dragB=-1);
  cv.addEventListener("wheel",e=>{ const r=cv.getBoundingClientRect(); const x=e.clientX-r.left;
    let best=1e9,bi=-1; fx.bands.forEach((b,i)=>{ const bx=Math.log10(b.f/20)/3*r.width; const d=Math.abs(bx-x); if(d<best){best=d;bi=i;} });
    if(bi>=0){ e.preventDefault(); const b=fx.bands[bi]; b.q=clamp(b.q*(e.deltaY<0?1.15:0.87),0.1,18);
      applyFxLive(tr,S.selFx); drawEq(cv,fx); syncEqNums(fx); } },{passive:false});
}
function syncEqNums(fx){ $$("[data-bf]").forEach(inp=>inp.value=Math.round(fx.bands[+inp.dataset.bf].f));
  $$("[data-bg]").forEach(inp=>inp.value=fx.bands[+inp.dataset.bg].g.toFixed(1));
  $$("[data-bq]").forEach(inp=>inp.value=fx.bands[+inp.dataset.bq].q.toFixed(2)); }
function drawEq(cv,fx){
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=cv.clientWidth, h=cv.clientHeight; if(!w) return;
  cv.width=w*dpr; cv.height=h*dpr; const c=cv.getContext("2d"); c.scale(dpr,dpr);
  const cs=getComputedStyle(document.documentElement);
  c.fillStyle=cs.getPropertyValue("--bg"); c.fillRect(0,0,w,h);
  c.strokeStyle=cs.getPropertyValue("--grid"); c.fillStyle=cs.getPropertyValue("--tx3"); c.font="10px sans-serif";
  [50,100,200,500,1000,2000,5000,10000].forEach(f=>{ const x=Math.log10(f/20)/3*w;
    c.beginPath();c.moveTo(x,0);c.lineTo(x,h);c.stroke(); c.fillText(f>=1000?(f/1000)+"k":f,x+3,h-4); });
  const y0=(18)/36*h; c.strokeStyle=cs.getPropertyValue("--gridbar");
  c.beginPath();c.moveTo(0,y0);c.lineTo(w,y0);c.stroke();
  /* response */
  const N=140, fr=new Float32Array(N), mg=new Float32Array(N), ph=new Float32Array(N);
  for(let i=0;i<N;i++) fr[i]=20*Math.pow(1000,i/(N-1));
  const tot=new Float32Array(N);
  const tmpCtx=S.ctx||null;
  fx.bands.forEach(b=>{
    if(!tmpCtx||!b.on){ if(b.on){ /* analytic fallback skipped */ } return; }
    const node=tmpCtx.createBiquadFilter(); node.type=b.t; node.frequency.value=b.f; node.gain.value=b.g; node.Q.value=b.q;
    node.getFrequencyResponse(fr,mg,ph);
    for(let i=0;i<N;i++) tot[i]+=20*Math.log10(mg[i]||1e-6);
  });
  c.beginPath();
  for(let i=0;i<N;i++){ const x=i/(N-1)*w, y=(18-clamp(tot[i],-30,30))/36*h; i?c.lineTo(x,y):c.moveTo(x,y); }
  c.strokeStyle="#cf8a4e"; c.lineWidth=2; c.stroke();
  c.lineTo(w,h); c.lineTo(0,h); c.closePath(); c.fillStyle="rgba(207,138,78,.14)"; c.fill();
  const cols=["#c05a4e","#c99a4a","#5d84ad","#4f8a6b","#8a74a8"];
  fx.bands.forEach((b,i)=>{ const x=Math.log10(b.f/20)/3*w, y=(18-b.g)/36*h;
    c.beginPath(); c.arc(x,y,9,0,7); c.fillStyle=b.on?cols[i]:"#666"; c.fill();
    c.fillStyle="#fff"; c.font="bold 10px sans-serif"; c.textAlign="center"; c.fillText(String(i+1),x,y+3.5); c.textAlign="left"; });
}

/* ----- Mixer ----- */
function mixHTML(){
  const curSnap=JSON.stringify(mixSnapshot());
  const mixChips=MIX_PRESETS.map(p=>`<button data-mixpreset="${p.id}">${p.label}</button>`).join("");
  const uChips=(S.userMixPresets||[]).map((p,ui)=>`<span class="uchip"><button data-umixpreset="${ui}" class="${JSON.stringify(p.data)===curSnap?"on":""}">${esc(p.label)}</button><button data-umixdel="${ui}" title="Delete this preset" aria-label="Delete preset">✕</button></span>`).join("");
  const bar=`<div class="mixbar"><span class="cap">MIX PRESET</span>
    <div class="fxchips">${mixChips}${uChips}</div>
    <div class="fxusersave"><input type="text" id="mixPresetName" placeholder="My preset name" maxlength="24"><button id="btnSaveMixPreset">Save Current Mix</button><span class="small">Saved for this session only</span></div></div>`;
  const strip=(tr)=>{ const fxOn=tr.fx.filter(f=>f.on).length;
    return `<div class="strip ${tr.id===S.selTrack?"sel":""}" data-tid="${tr.id}">
    <span class="dot" style="background:${tr.color}"></span><div class="nm">${esc(tr.name)}</div>
    <div class="route">${tr.clips.length} clips · FX ${fxOn}/${tr.fx.length} on<br>${tr.auto.volume.length+tr.auto.pan.length} automation pts</div>
    <div class="mini"><label>REV Send <span>${Math.round(tr.sendRev*100)}%</span></label><input type="range" data-k="sendRev" min="0" max="100" value="${Math.round(tr.sendRev*100)}"></div>
    <div class="mini"><label>DLY Send <span>${Math.round(tr.sendDly*100)}%</span></label><input type="range" data-k="sendDly" min="0" max="100" value="${Math.round(tr.sendDly*100)}"></div>
    <div class="mini"><label>PAN <span>${panLabel(tr.pan)}</span></label><input type="range" data-k="pan" min="-100" max="100" value="${Math.round(tr.pan*100)}"></div>
    <input type="range" class="vfader" data-k="vol" min="-60" max="6" step="0.5" value="${tr.vol}">
    <div class="small" data-volval style="font-family:var(--mono)">${fmtDb(tr.vol)}</div>
    <div style="display:flex;gap:5px"><button class="msbtn m ${tr.mute?"on":""}" data-k="mute">M</button><button class="msbtn s ${tr.solo?"on":""}" data-k="solo">S</button></div>
    <label class="small" style="align-self:flex-start">Output</label>
    <select data-k="route" title="Output bus"><option value="">Direct to Master</option>${S.buses.map(b=>`<option value="${b.id}" ${tr.bus===b.id?"selected":""}>${esc(b.name)}</option>`).join("")}</select>
    <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:center"><button class="sumbtn" data-jump="ch">Channel</button><button class="sumbtn" data-jump="fx">FX</button></div></div>`; };
  const busStrip=b=>`<div class="strip ret ${b.muted?"off":""}"><div class="nm">BUS<br>${esc(b.name)}</div>
    <div class="route">${esc(busSummary(b))}</div>
    <div class="mini"><label>PAN <span>${panLabel(b.pan||0)}</span></label><input type="range" data-buspan="${b.id}" min="-100" max="100" value="${Math.round((b.pan||0)*100)}"></div>
    <input type="range" class="vfader" data-bus="${b.id}" min="-60" max="6" step="0.5" value="${b.vol}">
    <div class="small" style="font-family:var(--mono)">${fmtDb(b.vol)}</div>
    <div style="display:flex;gap:5px"><button class="msbtn m ${b.muted?"on":""}" data-busmute2="${b.id}" title="Mute bus">M</button><button class="sumbtn" data-busdel="${b.id}" title="Delete bus (assigned tracks return to Master)">Delete</button></div>
    <div class="small">→ Master</div></div>`;
  const retRev=`<div class="strip ret ${S.revMuted?"off":""}"><div class="nm">RETURN<br>Reverb</div>
    <div class="route">${S.revMuted?"Muted · ":""}Decay ${(S.returns?S.returns.decay:2.6).toFixed(1)}s</div>
    <div class="mini"><label>Decay <span>${(S.returns?S.returns.decay:2.6).toFixed(1)}s</span></label><input type="range" data-ret="decay" min="0.4" max="6" step="0.1" value="${S.returns?S.returns.decay:2.6}"></div>
    <div class="fxchips" style="justify-content:center">${RET_PRESETS.rev.map(p=>`<button data-retpreset="rev:${p.id}" class="${Math.abs((S.returns?S.returns.decay:2.6)-p.decay)<0.05?"on":""}">${p.label}</button>`).join("")}</div>
    <button class="fxpower ${S.revMuted?"":"on"}" data-rettoggle="rev" style="min-height:38px">${S.revMuted?"OFF":"ON"}</button></div>`;
  const retDly=`<div class="strip ret ${S.dlyMuted?"off":""}"><div class="nm">RETURN<br>Delay</div>
    <div class="route">${S.dlyMuted?"Muted · ":""}${Math.round((S.returns?S.returns.dlyTime:0.375)*1000)}ms · Feedback ${Math.round((S.returns?S.returns.dlyFb:0.34)*100)}%</div>
    <div class="mini"><label>Time <span>${Math.round((S.returns?S.returns.dlyTime:0.375)*1000)}ms</span></label><input type="range" data-ret="dlyTime" min="0.03" max="1" step="0.005" value="${S.returns?S.returns.dlyTime:0.375}"></div>
    <div class="mini"><label>Feedback <span>${Math.round((S.returns?S.returns.dlyFb:0.34)*100)}%</span></label><input type="range" data-ret="dlyFb" min="0" max="0.85" step="0.01" value="${S.returns?S.returns.dlyFb:0.34}"></div>
    <div class="fxchips" style="justify-content:center">${RET_PRESETS.dly.map(p=>`<button data-retpreset="dly:${p.id}">${p.label}</button>`).join("")}</div>
    <button class="fxpower ${S.dlyMuted?"":"on"}" data-rettoggle="dly" style="min-height:38px">${S.dlyMuted?"OFF":"ON"}</button></div>`;
  return `${bar}<div class="mixer">${S.tracks.map(strip).join("")}${S.buses.map(busStrip).join("")}${retRev}${retDly}</div>
  <p class="small">Routing: each track → (clip edits → insert FX → automation → fader / pan) → bus or Master. Reverb / delay receive only the send amounts. Buses and returns are independent units too, each with ON/OFF, summaries and presets.</p>`;
}
function wireMix(){
  /* Mixer presets: built-in + user-saved (this session) */
  $$("[data-mixpreset]").forEach(b=>b.addEventListener("click",()=>{ const p=MIX_PRESETS.find(x=>x.id===b.dataset.mixpreset); if(!p) return;
    p.apply(); if(S.returns&&S.ctx) S.returns.conv.buffer=makeIR(S.ctx,S.returns.decay);
    applyMixLiveAll(); renderTimeline(); renderInspector(); toast("Applied mixer preset \""+p.label+"\""); }));
  $$("[data-umixpreset]").forEach(b=>b.addEventListener("click",()=>{ const p=(S.userMixPresets||[])[+b.dataset.umixpreset]; if(p){ applyMixSnapshot(JSON.parse(JSON.stringify(p.data))); toast("Applied mixer preset \""+p.label+"\""); } }));
  $$("[data-umixdel]").forEach(b=>b.addEventListener("click",()=>{ const arr=S.userMixPresets||[]; const rm=arr.splice(+b.dataset.umixdel,1)[0]; renderInspector(); if(rm) toast("Deleted preset \""+rm.label+"\""); }));
  const svm=$("#btnSaveMixPreset");
  if(svm) svm.onclick=()=>{ const nm=($("#mixPresetName").value||"").trim()||("Mix "+((S.userMixPresets||[]).length+1));
    (S.userMixPresets=S.userMixPresets||[]).push({label:nm,data:mixSnapshot()}); renderInspector(); toast("Saved mixer preset \""+nm+"\" (this session only)"); };
  $$(".strip[data-tid]").forEach(st=>{
    const tr=S.tracks.find(t=>t.id===st.dataset.tid); if(!tr) return;
    st.addEventListener("click",e=>{ if(!e.target.closest("input,button,select")) selectTrack(tr.id); });
    st.querySelectorAll("input").forEach(inp=>inp.addEventListener("input",()=>{
      const k=inp.dataset.k, v=parseFloat(inp.value);
      if(k==="vol"){ tr.vol=v; const vv=st.querySelector("[data-volval]"); if(vv)vv.textContent=fmtDb(v); if(tr.nodes)tr.nodes.fader.gain.setTargetAtTime(db2lin(v),S.ctx.currentTime,0.03); }
      if(k==="pan"){ tr.pan=v/100; inp.previousElementSibling.querySelector("span").textContent=panLabel(tr.pan); if(tr.nodes)tr.nodes.pan.pan.setTargetAtTime(tr.pan,S.ctx.currentTime,0.03); }
      if(k==="sendRev"){ tr.sendRev=v/100; inp.previousElementSibling.querySelector("span").textContent=v+"%"; if(tr.nodes)tr.nodes.sRev.gain.setTargetAtTime(tr.sendRev,S.ctx.currentTime,0.03); }
      if(k==="sendDly"){ tr.sendDly=v/100; inp.previousElementSibling.querySelector("span").textContent=v+"%"; if(tr.nodes)tr.nodes.sDly.gain.setTargetAtTime(tr.sendDly,S.ctx.currentTime,0.03); }
      renderTimelineSoft();
    }));
    const routeSel=st.querySelector("[data-k='route']");
    if(routeSel) routeSel.addEventListener("change",()=>{ tr.bus=routeSel.value||null; refreshTrackOut(tr); renderTimeline(); renderInspector(); toast("Output of \""+tr.name+"\" set to "+(tr.bus?esc((S.buses.find(b=>b.id===tr.bus)||{}).name||"Bus"):"Master")); });
    st.querySelectorAll("[data-jump]").forEach(b=>b.addEventListener("click",()=>{ selectTrack(tr.id); curTab=b.dataset.jump; renderInspector(); }));
    st.querySelectorAll("button[data-k]").forEach(b=>b.addEventListener("click",()=>{
      if(b.dataset.k==="mute") tr.mute=!tr.mute; if(b.dataset.k==="solo") tr.solo=!tr.solo;
      if(S.playing)startSources(currentPos()); renderTimeline(); renderInspector();
    }));
  });
  $$("[data-bus]").forEach(inp=>inp.addEventListener("input",()=>{ const b=S.buses.find(x=>x.id===inp.dataset.bus); if(!b) return;
    b.vol=parseFloat(inp.value); inp.nextElementSibling.textContent=fmtDb(b.vol); if(b.nodes)b.nodes.g.gain.setTargetAtTime(b.muted?0:db2lin(b.vol),S.ctx.currentTime,0.03); }));
  $$("[data-buspan]").forEach(inp=>inp.addEventListener("input",()=>{ const b=S.buses.find(x=>x.id===inp.dataset.buspan); if(!b) return;
    b.pan=parseFloat(inp.value)/100; inp.previousElementSibling.querySelector("span").textContent=panLabel(b.pan); if(b.nodes)b.nodes.p.pan.setTargetAtTime(b.pan,S.ctx.currentTime,0.03); }));
  $$("[data-busmute2]").forEach(btn=>btn.addEventListener("click",()=>{ const b=S.buses.find(x=>x.id===btn.dataset.busmute2); if(!b) return;
    b.muted=!b.muted; if(b.nodes&&S.ctx)b.nodes.g.gain.setTargetAtTime(b.muted?0:db2lin(b.vol),S.ctx.currentTime,0.03); renderInspector(); }));
  $$("[data-busdel]").forEach(btn=>btn.addEventListener("click",()=>{ const b=S.buses.find(x=>x.id===btn.dataset.busdel); if(!b) return;
    S.tracks.forEach(t=>{ if(t.bus===b.id){ t.bus=null; refreshTrackOut(t); } });
    S.buses=S.buses.filter(x=>x.id!==b.id); renderTimeline(); renderInspector(); toast("Deleted bus \""+b.name+"\" (assigned tracks returned to Master)"); }));
  $$("[data-ret]").forEach(inp=>inp.addEventListener("input",()=>{ if(!S.returns)return; const v=parseFloat(inp.value);
    if(inp.dataset.ret==="decay"){ S.returns.decay=v; S.returns.conv.buffer=makeIR(S.ctx,v); inp.previousElementSibling.querySelector("span").textContent=v.toFixed(1)+"s"; }
    if(inp.dataset.ret==="dlyTime"){ S.returns.dlyTime=v; S.returns.dly.delayTime.setTargetAtTime(v,S.ctx.currentTime,0.03); inp.previousElementSibling.querySelector("span").textContent=Math.round(v*1000)+"ms"; }
    if(inp.dataset.ret==="dlyFb"){ S.returns.dlyFb=v; S.returns.fb.gain.setTargetAtTime(v,S.ctx.currentTime,0.03); inp.previousElementSibling.querySelector("span").textContent=Math.round(v*100)+"%"; } }));
  $$("[data-rettoggle]").forEach(btn=>btn.addEventListener("click",()=>{ ensureCtx();
    if(btn.dataset.rettoggle==="rev"){ S.revMuted=!S.revMuted; if(S.returns)S.returns.revOut.gain.setTargetAtTime(S.revMuted?0:0.9,S.ctx.currentTime,0.03); }
    else { S.dlyMuted=!S.dlyMuted; if(S.returns)S.returns.dlyOut.gain.setTargetAtTime(S.dlyMuted?0:0.8,S.ctx.currentTime,0.03); }
    renderInspector(); }));
  $$("[data-retpreset]").forEach(btn=>btn.addEventListener("click",()=>{ ensureCtx(); if(!S.returns) return;
    const [kind,id]=btn.dataset.retpreset.split(":");
    if(kind==="rev"){ const p=RET_PRESETS.rev.find(x=>x.id===id); if(p){ S.returns.decay=p.decay; S.returns.conv.buffer=makeIR(S.ctx,p.decay); S.revMuted=false; S.returns.revOut.gain.setTargetAtTime(0.9,S.ctx.currentTime,0.03); } }
    else { const p=RET_PRESETS.dly.find(x=>x.id===id); if(p){ S.returns.dlyTime=p.time; S.returns.dlyFb=p.fb; S.returns.dly.delayTime.setTargetAtTime(p.time,S.ctx.currentTime,0.03); S.returns.fb.gain.setTargetAtTime(p.fb,S.ctx.currentTime,0.03); S.dlyMuted=false; S.returns.dlyOut.gain.setTargetAtTime(0.8,S.ctx.currentTime,0.03); } }
    renderInspector(); toast("Applied return preset"); }));
}
function syncMixer(){ if(curTab==="mix") renderInspector(); }

/* ----- Export ----- */
function expHTML(){
  return `<div class="cols"><div class="sect" style="min-width:320px"><h3>WAV / MP3 Export (Offline Render)</h3>
  <div class="fld"><label>Format</label><select id="expFmt"><option value="wav">WAV (Uncompressed)</option><option value="mp3">MP3 (320 kbps)</option></select></div>
  <div class="fld"><label>Sample Rate</label><select id="expSr"><option value="44100">44.1 kHz</option><option value="48000" selected>48 kHz</option></select></div>
  <div class="fld"><label>Bit Depth</label><select id="expBits"><option value="16">16 bit</option><option value="24" selected>24 bit</option></select><span class="small">WAV only</span></div>
  <div class="fld"><label>File Name</label><input type="text" id="expName" value="utattemita_mix" style="width:180px"></div>
  <div class="fld"><button id="btnDoExport" style="background:var(--teal);border-color:var(--teal);color:#06231d;font-weight:700;padding:6px 18px">Export</button>
  <span class="small" id="expStat">Length ${fmtT(projectEnd())} / ${S.tracks.length} tracks (mute / solo states apply)</span></div>
  <p class="small">Renders the whole project offline. Insert FX, sends / returns, buses, automation and fades are all included.</p>
  </div></div>`;
}
function wireExp(){ const b=$("#btnDoExport"); if(b) b.onclick=doExport;
  const go=$("#btnExportGo"); }

/* ----- User manual ----- */
function manualHTML(){
  return `<div class="manual">
  <h2>User Manual</h2>
  <h3>Start by Importing Audio</h3>
  <p>Drag &amp; drop your karaoke backing track and vocal WAV / MP3 files onto this screen, or add them with "Import Audio". Pitch correction can be done in the built-in Pitch Correction tab, or by importing a WAV already corrected in an external tool (Melodyne, VariAudio, etc.).</p>
  <div class="row"><button id="btnManualImport">Choose Audio Files</button></div>
  <h3>Loading the Demo Song Manually</h3>
  <p>The demo song is not loaded automatically. Load it only when you want to try it, as follows.</p>
  <ol>
    <li>Press "Load Demo Song" at the top of the screen (the button below this manual works too).</li>
    <li>Wait a moment for generation to finish; three tracks (backing + vocal + harmony, synth-generated) appear on the timeline.</li>
    <li>Press play to listen, and try the EQ, compressor, send reverb and automation.</li>
  </ol>
  <p>Loading while tracks exist replaces them with the demo song. A confirmation appears first, so if you are working with your own audio, export it with the Export button at the top beforehand.</p>
  <div class="row"><button id="btnManualDemo">Load Demo Song</button></div>
  <h3>Pitch Correction — Non-Destructive Layer (VariAudio-style, for monophonic vocals)</h3>
  <ol>
    <li>Select a vocal clip on the timeline and open the Pitch Correction tab. At the top you will see the structure: Source Audio (always kept) → Pitch Correction Layer. On a phone, "Open Full-Screen Editor" in that tab moves the piano roll to a page of its own; "Save & Back" there returns the edits to this project.</li>
    <li>Press "Analyze Pitch" to detect pitch and display it as notes (blocks). The source is never rewritten; detection results live only in the layer.</li>
    <li>Drag blocks up or down to correct in semitone steps. "Snap to Nearest Note" pulls enabled notes to the nearest pitch. To revert a single note, select it and disable it with "Note ON/OFF" (or double-click).</li>
    <li>Use "Correction Strength" to adjust how far notes are pulled. Presets: Natural 60% / Standard 85% / Full 100%. Turning the layer OFF plays the original immediately, and deleting the layer still keeps the source.</li>
    <li>Correction applies to playback and export. It targets monophonic singing only (no chords, overlapping sources, or time stretching).</li>
  </ol>
  <h3>Effects — Each Stage in the Serial Chain Is Independent</h3>
  <ul>
    <li>The chain in the Effects tab is a serial connection: audio flows from the top stage down. Each stage is an independent unit with its own ON/OFF, reorder (↑↓ buttons / drag), duplicate and reset to defaults. Order changes the sound, so compare as you listen.</li>
    <li>Each stage has presets (EQ "Vocal Basic" and "De-Mud", Compressor "Cover Standard", and more). You can also save the current settings under a name (saved for this session only).</li>
    <li>Collapse unused stages with "Collapse" in the stage header to hide their parameters. The chain always shows each stage's summary, so the state stays visible while collapsed.</li>
  </ul>
  <h3>Clips / Mixer — Independent Units (Stage 3)</h3>
  <ul>
    <li>The Channel / Clips tab lists the clips of the selected track. Each clip is an independent unit with its own ON/OFF (mute), duplicate and delete, and a summary (position, gain, fades, pitch layer state) is always shown. Muted clips appear dimmed on the timeline and are excluded from playback and export.</li>
    <li>Clip edits are non-destructive too. The source audio is always kept; trim / gain / fades / mute layer on top as Clip Edit Layer parameters. Gain / fade presets are available (Click Removal, Long Fade, etc.). Collapse the editor when not in use.</li>
    <li>In the Mixer tab, each strip can change its output bus directly. Buses and returns (reverb / delay) are independent units too, each with ON/OFF, pan (buses), summaries and presets. Deleting a bus returns its assigned tracks to Master.</li>
    <li>There are whole-mixer presets too (Cover Standard / Vocal Up Front / Dry, etc.). You can also save the current mix under a name (saved for this session only).</li>
  </ul>
  <h3>Basic Operations</h3>
  <ul>
    <li>Drag clips to move them; drag either edge to trim. Select a clip and press <span class="kbd">S</span> to split, <span class="kbd">Del</span> to delete.</li>
    <li>The Effects tab adjusts EQ, compressor, reverb and delay per track, and the chain order can be rearranged.</li>
    <li>Switching the toolbar's Automation mode lets you draw volume / pan for the selected track on the timeline (click to add a point, right-click to delete).</li>
    <li>When finished, export as WAV / MP3 from the Export button at the top (48 kHz / 24 bit available).</li>
    <li>Fine adjustment: click the numeric readout next to a slider to type the value directly (in the displayed units — dB, %, ms). Enter applies, Esc cancels.</li>
  </ul>
  </div>`;
}

function requestDemoLoad(){
  if(!S.tracks.length){ buildDemoProject(); return; }
  const dc=$("#demoConfirm"); if(dc) dc.hidden=false;
}
async function doExport(){
  ensureCtx();
  const fmt=$("#expFmt").value, sr=parseInt($("#expSr").value), bits=parseInt($("#expBits").value);
  const name=($("#expName").value||"mix").replace(/[^\w\-]/g,"_");
  const dur=projectEnd();
  if(!S.tracks.length){ $("#expStat").textContent="No tracks to export."; return; }
  $("#expStat").textContent="Rendering…";
  try{
    const oc=new OfflineAudioContext(2,Math.ceil(sr*dur),sr);
    const master=oc.createGain(); master.gain.value=db2lin(parseFloat($("#masterVol").value));
    const mcomp=oc.createDynamicsCompressor(); mcomp.threshold.value=-3;mcomp.ratio.value=12;mcomp.attack.value=0.002;mcomp.release.value=0.18;
    master.connect(mcomp); mcomp.connect(oc.destination);
    const R=buildReturns(oc,master,false);
    if(S.returns){ R.conv.buffer=makeIR(oc,S.returns.decay); R.dly.delayTime.value=S.returns.dlyTime; R.fb.gain.value=S.returns.dlyFb; }
    if(S.revMuted) R.revOut.gain.value=0; if(S.dlyMuted) R.dlyOut.gain.value=0;
    const busNodes={};
    S.buses.forEach(b=>{ const input=oc.createGain(),g=oc.createGain(),p=oc.createStereoPanner();
      input.connect(g);g.connect(p);p.connect(master); g.gain.value=b.muted?0:db2lin(b.vol); p.pan.value=b.pan||0; busNodes[b.id]=input; });
    const anySolo=S.tracks.some(t=>t.solo);
    S.tracks.forEach(tr=>{
      const input=oc.createGain(); let prev=input;
      tr.fx.forEach(fx=>{ const n=fxNodes(oc,fx); prev.connect(n.input); prev=n.output; });
      const autoG=oc.createGain(), autoP=oc.createStereoPanner(), fader=oc.createGain(), pan=oc.createStereoPanner();
      prev.connect(autoG); autoG.connect(autoP); autoP.connect(fader); fader.connect(pan);
      pan.connect(tr.bus&&busNodes[tr.bus]?busNodes[tr.bus]:master);
      const sR=oc.createGain(), sD=oc.createGain(); fader.connect(sR); sR.connect(R.revIn); fader.connect(sD); sD.connect(R.dlyIn);
      fader.gain.value=db2lin(tr.vol); pan.pan.value=tr.pan; sR.gain.value=tr.sendRev; sD.gain.value=tr.sendDly;
      if(tr.auto.volume.length){ autoG.gain.setValueAtTime(db2lin(autoVal(tr.auto.volume,0,tr.vol)),0);
        tr.auto.volume.forEach(p=>autoG.gain.linearRampToValueAtTime(db2lin(p.v),p.t)); }
      if(tr.auto.pan.length){ autoP.pan.setValueAtTime(autoVal(tr.auto.pan,0,0),0);
        tr.auto.pan.forEach(p=>autoP.pan.linearRampToValueAtTime(p.v,p.t)); }
      if(tr.mute||(anySolo&&!tr.solo)) return;
      tr.clips.forEach(cl=>{ if(cl.muted) return; const src=oc.createBufferSource(); src.buffer=clipBuffer(cl);
        const g=oc.createGain(); src.connect(g); g.connect(input);
        const cg=db2lin(cl.gain||0), t0=cl.start;
        g.gain.setValueAtTime(cl.fadeIn>0?0.0001:cg,t0);
        if(cl.fadeIn>0) g.gain.linearRampToValueAtTime(cg,t0+cl.fadeIn);
        if(cl.fadeOut>0){ g.gain.setValueAtTime(cg,t0+cl.dur-cl.fadeOut); g.gain.linearRampToValueAtTime(0.0001,t0+cl.dur); }
        src.start(t0,cl.offset,cl.dur); });
    });
    const buf=await oc.startRendering();
    let blob, ext;
    if(fmt==="wav"){ blob=encodeWav(buf,bits); ext="wav"; }
    else { blob=encodeMp3(buf); ext="mp3"; if(!blob){ $("#expStat").textContent="Could not load the MP3 encoder. Please export as WAV."; return; } }
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name+"."+ext; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    $("#expStat").textContent="Export complete: "+name+"."+ext+" ("+(blob.size/1024).toFixed(0)+" KB)";
  }catch(err){ $("#expStat").textContent="Export failed: "+err.message; }
}
function encodeWav(buf,bits){
  const nCh=2, sr=buf.sampleRate, len=buf.length, bytesPer=bits/8;
  const block=nCh*bytesPer, dataLen=len*block;
  const ab=new ArrayBuffer(44+dataLen), v=new DataView(ab);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,"RIFF"); v.setUint32(4,36+dataLen,true); ws(8,"WAVEfmt "); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,nCh,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*block,true); v.setUint16(32,block,true); v.setUint16(34,bits,true);
  ws(36,"data"); v.setUint32(40,dataLen,true);
  const L=buf.getChannelData(0), R=buf.numberOfChannels>1?buf.getChannelData(1):L;
  let o=44;
  for(let i=0;i<len;i++){ for(const ch of [L,R]){ const s=clamp(ch[i],-1,1);
    if(bits===16){ v.setInt16(o,Math.round(s*32767),true); o+=2; }
    else { const val=Math.round(s*8388607); v.setUint8(o,val&255); v.setUint8(o+1,(val>>8)&255); v.setUint8(o+2,(val>>16)&255); o+=3; } } }
  return new Blob([ab],{type:"audio/wav"});
}
function encodeMp3(buf){
  if(typeof lamejs==="undefined"||!lamejs.Mp3Encoder) return null;
  try{
    const enc=new lamejs.Mp3Encoder(2,buf.sampleRate,320);
    const L=buf.getChannelData(0), R=buf.numberOfChannels>1?buf.getChannelData(1):L;
    const to16=d=>{ const o=new Int16Array(d.length); for(let i=0;i<d.length;i++)o[i]=Math.round(clamp(d[i],-1,1)*32767); return o; };
    const l16=to16(L), r16=to16(R), parts=[]; const CH=1152;
    for(let i=0;i<l16.length;i+=CH){ const d=enc.encodeBuffer(l16.subarray(i,i+CH),r16.subarray(i,i+CH)); if(d.length)parts.push(d); }
    const end=enc.flush(); if(end.length)parts.push(end);
    return new Blob(parts,{type:"audio/mpeg"});
  }catch(e){ return null; }
}

/* ============================================================
   Pitch correction — non-destructive layer (DaVinci Resolve style / stage-1 refactor)
   ------------------------------------------------------------
   Structure: detection (PitchDetect) / note segmentation (NoteSegment) / application (PitchShift)
   are separate module boundaries, each replaceable.

   Non-destructive principles:
   - The source audio is fixed in clip.buffer (= clip.sourceBuffer) and never rewritten.
     Analysis, correction, reset and layer deletion all leave the source intact.
   - Correction is stored only in clip.pitchLayer, a layer of parameters.
     Playback and export derive audio via clipBuffer() from source + layer each time.
     The derivation cache (clip._corrCache) is disposable, never the master.
     Change the layer and audio is re-derived; turn it OFF and the source plays instantly.

   clip.pitchLayer = { version:2, enabled, strength, notes:[Note,...] }
     enabled  : whole-layer ON/OFF (use this for A/B comparison)
     strength : correction strength 0..1. Effective shift = shift x strength.
                1.0 = pull fully to the target pitch / around 0.6 = keep the nuance
     notes    : Note[]
   Note = { id, start, end, f0, midi, shift, enabled }
     start/end : time within the source buffer (seconds). Coordinates survive trim / split
     f0 / midi : detected values (midi is fractional. e.g. 60.25 = C4 +25 cents)
     shift     : correction amount (semitones, fractional allowed). Dragging moves in
                 semitone steps; snapping pulls to the nearest integer midi, so values can be fractional
     enabled   : per-note ON/OFF (notes set to false play as the original)
   The legacy clip.pitch / clip.pitchOn / clip.corrBuffer are migrated to
   pitchLayer on load (after migration, pitchLayer is the master).
   ============================================================ */
function ensureSource(cl){ if(cl&&!cl.sourceBuffer) cl.sourceBuffer=cl.buffer; return cl?cl.sourceBuffer:null; }
function pitchLayer(cl){
  if(!cl) return null;
  ensureSource(cl);
  if(cl.pitchLayer){ const ns=cl.pitchLayer.notes||[]; if(ns.some(n=>n.enabled==null)) cl.pitchLayer.notes=ns.map(n=>({enabled:true,...n})); else cl.pitchLayer.notes=ns; if(cl.pitchLayer.strength==null) cl.pitchLayer.strength=1; if(cl.pitchLayer.enabled==null) cl.pitchLayer.enabled=true; return cl.pitchLayer; }
  if(cl.pitch&&cl.pitch.notes){ /* migration from the legacy format */
    cl.pitchLayer={version:2,enabled:cl.pitchOn!==false,strength:1,notes:cl.pitch.notes.map(n=>({enabled:true,...n}))};
    if(cl.corrBuffer) cl._corrCache=cl.corrBuffer;
    return cl.pitchLayer;
  }
  return null;
}
function hasPitchLayer(cl){ return !!pitchLayer(cl); }
function effectiveShift(note,layer){ if(!note||note.enabled===false) return 0; const s=layer?layer.strength:1; return (note.shift||0)*(s==null?1:s); }
function layerActiveNotes(cl){ const L=pitchLayer(cl); if(!L||!L.enabled) return []; return L.notes.filter(n=>Math.abs(effectiveShift(n,L))>1e-4); }
function invalidatePitchCache(cl){ if(cl) cl._corrCache=null; }
function clipBuffer(cl){
  const L=pitchLayer(cl);
  if(!L||!L.enabled) return cl.buffer;
  if(!L.notes.some(n=>Math.abs(effectiveShift(n,L))>1e-4)) return cl.buffer;
  if(!cl._corrCache){ ensureCtx(); cl._corrCache=PitchShift.render(S.ctx,cl.buffer,L); }
  return cl._corrCache;
}
const NOTE_NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function midiName(m){ const r=Math.round(m); return NOTE_NAMES[((r%12)+12)%12]+(Math.floor(r/12)-1); }
function fmtCents(m){ const c=Math.round((m-Math.round(m))*100); return (c>0?"+":"")+c+"¢"; }
function fmtShift(s){ if(Math.abs(s)<1e-4) return "±0"; const r=Math.round(s*100)/100; return (r>0?"+":"")+r+" st"; }

/* ---------- (1) Pitch detection: YIN (autocorrelation family) ---------- */
const PitchDetect={
  /* Returns: [{t, f0, voiced}] (t is source-buffer time in seconds). No heavy ML. */
  async analyze(buffer,onProgress){
    const sr0=buffer.sampleRate;
    const ch0=buffer.getChannelData(0), ch1=buffer.numberOfChannels>1?buffer.getChannelData(1):null;
    const targetSr=16000, dec=Math.max(1,Math.round(sr0/targetSr)), sr=sr0/dec;
    const n=Math.floor(ch0.length/dec), data=new Float32Array(n);
    for(let i=0;i<n;i++){ const j=i*dec; data[i]=ch1?(ch0[j]+ch1[j])*0.5:ch0[j]; }
    const W=1024, hop=256, minF=60, maxF=1000;
    const tauMin=Math.max(2,Math.floor(sr/maxF)), tauMax=Math.min(Math.ceil(sr/minF),W-2);
    const frames=[], total=Math.max(1,Math.floor((n-W)/hop));
    for(let fi=0,start=0; start+W<=n; fi++,start+=hop){
      frames.push(this._frame(data.subarray(start,start+W),sr,tauMin,tauMax,start/sr));
      if(onProgress&&fi%40===0){ onProgress(Math.min(1,fi/total)); await new Promise(r=>setTimeout(r,0)); }
    }
    if(onProgress) onProgress(1);
    return frames;
  },
  _frame(d,sr,tauMin,tauMax,t){
    let rms=0; for(let i=0;i<d.length;i++) rms+=d[i]*d[i];
    if(Math.sqrt(rms/d.length)<0.008) return {t,f0:0,voiced:false};
    const W=d.length, df=new Float32Array(tauMax+2), cmnd=new Float32Array(tauMax+2);
    for(let tau=tauMin;tau<=tauMax;tau++){ let s=0; const lim=W-tau;
      for(let i=0;i<lim;i++){ const dd=d[i]-d[i+tau]; s+=dd*dd; } df[tau]=s; }
    cmnd[0]=1; let run=0;
    for(let tau=1;tau<=tauMax;tau++){ run+=df[tau]; cmnd[tau]=run>0?df[tau]*tau/run:1; }
    let tau=-1; const TH=0.15;
    for(let x=Math.max(2,tauMin);x<=tauMax;x++){
      if(cmnd[x]<TH){ while(x+1<=tauMax&&cmnd[x+1]<cmnd[x]) x++; tau=x; break; } }
    if(tau<0){ let m=Infinity; for(let x=tauMin;x<=tauMax;x++){ if(cmnd[x]<m){m=cmnd[x];tau=x;} }
      if(m>0.4) return {t,f0:0,voiced:false}; }
    let sh=0;
    if(tau>tauMin&&tau<tauMax){ const a=cmnd[tau-1],b=cmnd[tau],c=cmnd[tau+1],den=a-2*b+c;
      if(Math.abs(den)>1e-9) sh=0.5*(a-c)/den; }
    const f0=sr/(tau+sh);
    if(f0<50||f0>1100) return {t,f0:0,voiced:false};
    return {t,f0,voiced:true};
  }
};

/* ---------- (2) Note segmentation: frame sequence -> note blocks ---------- */
const NoteSegment={
  segment(frames){
    const hopDur=frames.length>1?frames[1].t-frames[0].t:0.016;
    const med=a=>{ const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
    const notes=[]; let cur=null, dev=null, gap=0;
    const flush=()=>{ if(cur&&cur.midis.length){ const m=med(cur.midis);
        notes.push({id:nid(),start:cur.start,end:cur.end,f0:440*Math.pow(2,(m-69)/12),midi:m,shift:0,enabled:true}); }
      cur=null; dev=null; };
    frames.forEach(fr=>{
      if(!fr.voiced){ gap++; if(gap>3){ flush(); gap=0; } return; }
      gap=0;
      const m=69+12*Math.log2(fr.f0/440);
      if(!cur){ cur={start:fr.t,end:fr.t+hopDur,midis:[m]}; return; }
      if(Math.abs(m-med(cur.midis))<=0.9){ cur.midis.push(m); cur.end=fr.t+hopDur; dev=null; }
      else{
        if(!dev) dev={start:fr.t,midis:[m]};
        else if(Math.abs(m-med(dev.midis))<=0.9) dev.midis.push(m);
        else dev={start:fr.t,midis:[m]};
        if(dev.midis.length>=3){ const dn=dev; flush(); cur={start:dn.start,end:fr.t+hopDur,midis:dn.midis}; }
      }
    });
    flush();
    /* Fragments under 60ms are absorbed into the previous note */
    const out=[];
    notes.forEach(nt=>{ if(nt.end-nt.start<0.06&&out.length) out[out.length-1].end=nt.end; else out.push(nt); });
    return out;
  }
};

/* ---------- (3) Pitch shift application: build the corrected buffer offline ---------- */
const PitchShift={
  /* Derives a new AudioBuffer from the layer (or the legacy notes array).
     The source buffer is read-only and never rewritten (non-destructive). */
  render(ctx,buffer,layerOrNotes){
    const layer=Array.isArray(layerOrNotes)?{enabled:true,strength:1,notes:layerOrNotes}:layerOrNotes;
    const notes=(layer&&layer.notes)||[];
    const sr=buffer.sampleRate, out=ctx.createBuffer(buffer.numberOfChannels,buffer.length,sr);
    const active=notes.map(n=>({...n,shift:effectiveShift(n,layer)})).filter(n=>Math.abs(n.shift)>1e-4);
    for(let ch=0;ch<buffer.numberOfChannels;ch++){
      const src=buffer.getChannelData(ch), dst=out.getChannelData(ch);
      dst.set(src);
      active.forEach(nt=>{
        const ratio=Math.pow(2,nt.shift/12), pad=0.03;
        const s0=Math.max(0,Math.floor((nt.start-pad)*sr)), s1=Math.min(src.length,Math.ceil((nt.end+pad)*sr));
        if(s1-s0<256) return;
        const shifted=this._shift(src.subarray(s0,s1),ratio,sr/nt.f0);
        const fade=Math.min(Math.floor(pad*sr),Math.floor(shifted.length/2));
        for(let i=0;i<shifted.length;i++){
          let g=1;
          if(i<fade) g=i/fade; else if(i>shifted.length-1-fade) g=(shifted.length-1-i)/fade;
          dst[s0+i]=src[s0+i]*(1-g)+shifted[i]*g;
        }
      });
    }
    return out;
  },
  _shift(x,ratio,period){
    /* PSOLA (below) is the main path. Only fragments with no usable period / too short
       are handled by the resample + OLA fallback */
    if(period&&period>=8&&x.length>=4*period){
      /* When ratio is close to 1/integer (especially 0.5), grain placement degenerates
         into an identity map and the pitch does not change, so large downward
         shifts are split into two sqrt steps */
      if(ratio<0.62){ const s=Math.sqrt(ratio);
        return this._psola(this._psola(x,s,period),s,period/s); }
      return this._psola(x,ratio,period);
    }
    const n=Math.max(16,Math.floor(x.length/ratio)), rs=new Float32Array(n);
    for(let i=0;i<n;i++){ const p=i*ratio, i0=Math.floor(p), f=p-i0;
      rs[i]=x[i0]*(1-f)+x[Math.min(i0+1,x.length-1)]*f; }
    return this._stretch(rs,x.length);
  },
  _psola(x,ratio,P){
    /* PSOLA: period-synchronous grains (about 2.5 periods long) are cut from the input
       at period intervals and placed in the output at P/ratio intervals. With ratio>1
       grains repeat; with ratio<1 they are thinned, so only the pitch changes while
       length is preserved. All grain centers align to the same phase (multiples of
       the period), so even steady singing shows no phase drift pulling pitch back. */
    const half=Math.max(8,Math.round(1.25*P)), W=half*2;
    const win=new Float32Array(W);
    for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
    const out=new Float32Array(x.length+W), wsum=new Float32Array(x.length+W);
    const synHop=P/ratio, nIn=Math.max(1,Math.floor(x.length/P));
    let j=0;
    for(let sp=0; sp<x.length; sp+=synHop, j++){
      const c=Math.round(Math.min(nIn,Math.round(j/ratio))*P); /* input grain center */
      const oC=Math.round(sp);                                  /* output grain center */
      for(let i=0;i<W;i++){
        const si=c-half+i, oi=oC-half+i;
        if(si<0||si>=x.length||oi<0||oi>=out.length) continue;
        out[oi]+=x[si]*win[i]; wsum[oi]+=win[i];
      }
    }
    const y=new Float32Array(x.length);
    for(let i=0;i<x.length;i++) y[i]=wsum[i]>0.25?out[i]/wsum[i]:out[i];
    return y;
  },
  _stretch(x,target){
    /* Fallback OLA time-stretch (for fragments with unknown period) */
    if(x.length===target) return Float32Array.from(x);
    const factor=target/x.length, W=1024, Hs=256, Ha=Hs/factor;
    const out=new Float32Array(target+W), wsum=new Float32Array(target+W);
    const win=new Float32Array(W);
    for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
    let ap=0, sp=0;
    while(sp<target){
      const a0=Math.min(Math.round(ap),Math.max(0,x.length-W));
      for(let i=0;i<W&&a0+i<x.length;i++){ out[sp+i]+=x[a0+i]*win[i]; wsum[sp+i]+=win[i]; }
      ap+=Ha; sp+=Hs;
    }
    const y=new Float32Array(target);
    for(let i=0;i<target;i++) y[i]=wsum[i]>0.25?out[i]/wsum[i]:out[i];
    return y;
  }
};

/* ---------- Correction re-derivation (bridge between UI and processing) ---------- */
function refreshPitchRender(cl){
  invalidatePitchCache(cl);
  /* clipBuffer() re-derives from source + layer when needed. Here we only follow along during playback */
  if(S.playing) startSources(currentPos());
  const st=$("#pitchStatus"); if(st) st.textContent=pitchStatusText(cl);
}
function pitchStatusText(cl){
  const L=pitchLayer(cl);
  if(!L) return "Not analyzed — source only";
  const c=L.notes.filter(n=>Math.abs(effectiveShift(n,L))>1e-4).length;
  const off=L.notes.filter(n=>n.enabled===false).length;
  return L.notes.length+" notes detected / "+c+" corrected"+(off?" / "+off+" disabled":"")+(L.enabled?"":" (layer OFF = source)")+" · Strength "+Math.round((L.strength==null?1:L.strength)*100)+"%";
}
const PITCH_PRESETS=[
  {id:"natural",label:"Natural 60%",strength:0.6,desc:"Pulls notes 60% of the way. Keeps vibrato and nuance."},
  {id:"standard",label:"Standard 85%",strength:0.85,desc:"The cover-song standard. Tunes pitch without sounding mechanical."},
  {id:"full",label:"Full 100%",strength:1,desc:"Pulls fully to the target pitch. Meant to be combined with snap."},
];

/* ----- Pitch correction tab (the UI reads pitchLayer only) ----- */
let pitchSelNote=null;
function pitchHTML(){
  const fc=findClip(S.selClip);
  if(!fc) return `<div class="pitchwrap"><h3>Pitch Correction — Non-Destructive Layer</h3>
    <p class="small">Select a clip on the timeline first. For monophonic vocal / harmony tracks (not for chords or overlapping sources).</p></div>`;
  const {tr,cl}=fc;
  const L=pitchLayer(cl);
  const strength=L?(L.strength==null?1:L.strength):1;
  let h=`<div class="pitchwrap"><h3>Pitch Correction — ${esc(tr.name)} / ${esc(cl.name)}</h3>`;
  h+=`<div class="pitchbar"><button id="btnOpenPitchPage">Open Full-Screen Editor</button><span class="small">Full-screen page — easier on a phone.</span></div>`;
  if(tr.type==="inst") h+=`<p class="small">This clip is on a backing / instrument track. Pitch correction is designed for monophonic vocals.</p>`;
  /* --- Layer structure (non-destructive) --- */
  h+=`<div class="layerstack" aria-label="Layer structure">
    <div class="layercard src"><div class="layer-ico">♪</div><div class="layer-main"><b>Source Audio</b><span class="badge" style="background:#5b7a2a;margin-left:6px">Always Kept</span>
      <p>${esc(cl.name)} · ${(cl.buffer?cl.buffer.duration:0).toFixed(2)} s — never rewritten by analysis or correction. You can always return here.</p></div></div>
    <div class="layer-arrow">↓ &nbsp;Parameters layered on top</div>
    <div class="layercard ${L?(L.enabled?"active":"off"):"off"}"><div class="layer-ico">🎚</div><div class="layer-main">
      <b>Pitch Correction Layer</b> ${L?`<span class="badge" style="background:${L.enabled?"#c23e34":"#6e7488"};margin-left:6px">${L.enabled?"ON":"OFF — plays source"}</span>`:`<span class="badge" style="background:#6e7488;margin-left:6px">Not Created</span>`}
      ${L?`<p id="pitchStatus">${pitchStatusText(cl)}</p>
      <div class="strengthrow"><label for="pitchStrength">Correction Strength</label><input type="range" id="pitchStrength" min="0" max="100" step="1" value="${Math.round(strength*100)}"><output id="pitchStrengthVal">${Math.round(strength*100)}%</output><span class="small">Effective shift = note shift x strength</span></div>
      <div class="presetchips" role="group" aria-label="Pitch correction presets">${PITCH_PRESETS.map(p=>`<button data-preset="${p.id}" class="${Math.abs(strength-p.strength)<0.01?"on":""}" title="${p.desc}">${p.label}</button>`).join("")}</div>`
      :`<p>Not analyzed yet. Run "Analyze Pitch" to detect notes and create this layer (the source stays untouched).</p>`}
    </div>
    ${L?`<div style="display:flex;flex-direction:column;gap:6px;flex:none"><button id="btnPitchOn">${L.enabled?"Layer OFF":"Layer ON"}</button><button id="btnDeleteLayer" class="ghost" title="Deletes all analysis and correction. The source audio remains.">Delete Layer</button></div>`:""}
    </div></div>`;
  h+=`<div class="pitchbar">
    <button id="btnAnalyze">${L?"Re-analyze (rebuild layer)":"Analyze Pitch"}</button>
    ${L?"":`<span class="pitchinfo" id="pitchStatus">${pitchStatusText(cl)}</span>`}</div>`;
  if(L&&L.notes.length){
    h+=`<div class="pitchbar">
      <button id="btnSnapNotes">Snap to Nearest Note</button>
      <button id="btnPitchReset">Reset Correction (shifts to 0)</button>
      <span class="pitchinfo" id="pitchInfo">${pitchNoteInfo(cl)}</span>
      <button id="btnNoteDown" title="Lower the selected note by a semitone">− Semitone</button>
      <button id="btnNoteUp" title="Raise the selected note by a semitone">+ Semitone</button>
      <button id="btnNoteToggle" title="Toggles the selected note only. Disabled notes play as the original.">Note ON/OFF</button>
    </div>
    <canvas id="pitchCanvas"></canvas>
    <details class="pitch-details"><summary>How It Works — the Non-Destructive Design (collapse / expand)</summary>
      <ul>
        <li>Dashed = detected position; solid blocks = corrected position (strength applied). Gray = disabled notes; when the layer is OFF, everything is gray.</li>
        <li>Click a block to select it; drag up / down to correct in semitones. "Note ON/OFF" returns a single note to the original.</li>
        <li>Correction is never baked into the source. Playback and export derive it from source + layer each time. Turn the layer OFF for the original instantly; deleting it still keeps the source.</li>
        <li>Even if you split / trim the clip after analysis, the layer carries over in buffer-time coordinates.</li>
      </ul></details>`;
  } else if(L){
    h+=`<p class="small">No voiced notes were detected. The audio may be too quiet or not monophonic. The source audio remains untouched.</p>`;
  } else {
    h+=`<details class="pitch-details" open><summary>How to Use (collapse / expand)</summary><p>Press "Analyze Pitch" to detect pitch with the YIN method and show it as notes (blocks). Drag blocks up or down to correct in semitones, or use "Snap to Nearest Note" to pull all notes to the nearest pitch. Correction only layers on top; the source is never rewritten.</p></details>`;
  }
  return h+"</div>";
}
function pitchNoteInfo(cl){
  const L=pitchLayer(cl);
  const nt=L&&L.notes.find(n=>n.id===pitchSelNote);
  if(!nt) return "Click a block to select it; drag up / down to correct in semitones";
  const eff=effectiveShift(nt,L), tgt=nt.midi+eff;
  return "Selected: detected "+midiName(nt.midi)+" ("+nt.f0.toFixed(1)+" Hz / "+fmtCents(nt.midi)+") → corrected "+midiName(tgt)+" ("+fmtShift(eff)+(nt.enabled===false?" / disabled = source":"")+")";
}
function updatePitchInfo(cl){ const el=$("#pitchInfo"); if(el) el.textContent=pitchNoteInfo(cl); }
function drawPitch(cv,cl){
  const _L=pitchLayer(cl);
  if(!_L||!_L.notes.length) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=cv.clientWidth, hgt=cv.clientHeight; if(!w) return;
  cv.width=w*dpr; cv.height=hgt*dpr;
  const c=cv.getContext("2d"); c.scale(dpr,dpr);
  const cs=getComputedStyle(document.documentElement);
  const notes=_L.notes;
  let mn=Infinity, mx=-Infinity;
  notes.forEach(n=>{ const e=effectiveShift(n,_L); mn=Math.min(mn,n.midi+Math.min(0,e)); mx=Math.max(mx,n.midi+Math.max(0,e)); });
  mn=Math.floor(mn)-1; mx=Math.ceil(mx)+1;
  const gut=40, rows=mx-mn+1, rh=(hgt-10)/rows;
  const t0=cl.offset, t1=cl.offset+cl.dur;
  const X=t=>gut+(t-t0)/Math.max(1e-6,t1-t0)*(w-gut-8);
  const Y=m=>5+(mx-m+0.5)*rh;
  cv._geom={rh,t0,t1,X,Y};
  c.font="9px sans-serif"; c.textBaseline="middle";
  for(let m=mn;m<=mx;m++){
    const y=Y(m), black=[1,3,6,8,10].includes(((m%12)+12)%12);
    c.fillStyle=black?"rgba(127,140,180,.13)":"rgba(127,140,180,.04)";
    c.fillRect(gut,y-rh/2,w-gut,y+rh/2);
    c.strokeStyle=cs.getPropertyValue("--grid"); c.beginPath(); c.moveTo(gut,y+rh/2); c.lineTo(w,y+rh/2); c.stroke();
    c.fillStyle=cs.getPropertyValue("--tx3"); c.fillText(midiName(m),6,y);
  }
  const rr=(x,y,ww,hh,r)=>{ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+ww,y,x+ww,y+hh,r); c.arcTo(x+ww,y+hh,x,y+hh,r); c.arcTo(x,y+hh,x,y,r); c.arcTo(x,y,x+ww,y,r); c.closePath(); };
  notes.forEach(n=>{
    const bx=X(n.start), bw=Math.max(6,X(n.end)-bx), bh=Math.max(6,rh*0.72);
    c.setLineDash([4,3]); c.strokeStyle="rgba(255,255,255,.55)"; c.lineWidth=1;
    c.strokeRect(bx,Y(n.midi)-bh/2,bw,bh); c.setLineDash([]);
    const eff=effectiveShift(n,_L);
    const by=Y(n.midi+eff)-bh/2, shifted=Math.abs(eff)>1e-4, sel=n.id===pitchSelNote, disabled=n.enabled===false||!_L.enabled;
    c.fillStyle=disabled?"rgba(140,148,168,.5)":(shifted?"rgba(207,138,78,.88)":"rgba(96,128,168,.78)");
    rr(bx,by,bw,bh,4); c.fill();
    if(sel){ c.strokeStyle="#fff"; c.lineWidth=2; rr(bx,by,bw,bh,4); c.stroke(); }
    if(bw>44){ c.fillStyle="#fff"; c.font="bold 10px sans-serif";
      c.fillText(midiName(n.midi+eff)+(shifted?" "+fmtShift(eff):"")+(n.enabled===false?" OFF":""),bx+5,Y(n.midi+eff)); c.font="9px sans-serif"; }
  });
}
function wirePitch(){
  const fc=findClip(S.selClip); if(!fc) return;
  const {tr,cl}=fc;
  const L=pitchLayer(cl);
  const op=$("#btnOpenPitchPage");
  if(op) op.onclick=()=>{ if(window.VM_openPitchPage) window.VM_openPitchPage(tr.id,cl.id); else toast("The full-screen editor is not available on this page"); };
  const cv=$("#pitchCanvas");
  if(cv) requestAnimationFrame(()=>drawPitch(cv,cl));
  const an=$("#btnAnalyze");
  if(an) an.onclick=async()=>{
    ensureCtx(); an.disabled=true;
    const prevStrength=L?(L.strength==null?1:L.strength):1;
    try{
      const frames=await PitchDetect.analyze(cl.buffer,p=>{ const st=$("#pitchStatus"); if(st) st.textContent="Analyzing… "+Math.round(p*100)+"%"; });
      cl.pitchLayer={version:2,enabled:true,strength:prevStrength,notes:NoteSegment.segment(frames)};
      delete cl.pitch; delete cl.pitchOn; delete cl.corrBuffer; invalidatePitchCache(cl); pitchSelNote=null;
      toast("Pitch analysis complete ("+cl.pitchLayer.notes.length+" note"+(cl.pitchLayer.notes.length===1?"":"s")+") — source untouched; correction lives in the layer");
    }catch(err){ toast("Pitch analysis failed: "+err.message); }
    renderTimeline();
    if(curTab==="pitch") renderInspector();
  };
  /* Strength slider */
  const str=$("#pitchStrength");
  if(str&&L) str.addEventListener("change",()=>renderTimeline());
  if(str&&L) str.addEventListener("input",()=>{ L.strength=parseInt(str.value)/100; const o=$("#pitchStrengthVal"); if(o)o.textContent=str.value+"%";
    $$(".presetchips button").forEach(b=>{ const p=PITCH_PRESETS.find(x=>x.id===b.dataset.preset); b.classList.toggle("on",!!p&&Math.abs(L.strength-p.strength)<0.01); });
    refreshPitchRender(cl); if(cv)drawPitch(cv,cl); updatePitchInfo(cl); const st=$("#pitchStatus"); if(st)st.textContent=pitchStatusText(cl); });
  /* Presets */
  $$("[data-preset]").forEach(b=>b.addEventListener("click",()=>{ if(!L)return; const p=PITCH_PRESETS.find(x=>x.id===b.dataset.preset); if(!p)return;
    L.strength=p.strength; refreshPitchRender(cl); renderInspector(); toast("Applied preset \""+p.label+"\" — "+p.desc); }));
  const snap=$("#btnSnapNotes");
  if(snap&&L) snap.onclick=()=>{ L.notes.forEach(n=>{ if(n.enabled!==false) n.shift=Math.round((Math.round(n.midi)-n.midi)*1000)/1000; });
    refreshPitchRender(cl); renderTimeline(); if(cv)drawPitch(cv,cl); updatePitchInfo(cl); toast("Snapped enabled notes to the nearest pitch (layer only; source unchanged)"); };
  const rst=$("#btnPitchReset");
  if(rst&&L) rst.onclick=()=>{ L.notes.forEach(n=>n.shift=0);
    refreshPitchRender(cl); renderTimeline(); if(cv)drawPitch(cv,cl); updatePitchInfo(cl); toast("Correction reset (source unchanged)"); };
  const onb=$("#btnPitchOn");
  if(onb&&L) onb.onclick=()=>{ L.enabled=!L.enabled; refreshPitchRender(cl); renderTimeline(); renderInspector(); toast(L.enabled?"Pitch correction layer ON":"Layer OFF — playing the source audio"); };
  const delL=$("#btnDeleteLayer");
  if(delL&&L) delL.onclick=()=>{ cl.pitchLayer=null; delete cl.pitch; delete cl.pitchOn; invalidatePitchCache(cl); pitchSelNote=null; refreshPitchRender(cl); renderTimeline(); renderInspector(); toast("Pitch correction layer deleted (source audio remains)"); };
  const stepBtn=(id,d)=>{ const b=$(id); if(b) b.onclick=()=>{ const nt=L&&L.notes.find(n=>n.id===pitchSelNote);
    if(!nt){ toast("Select a note first"); return; }
    nt.enabled=true; nt.shift=clamp(Math.round((nt.shift+d)*100)/100,-12,12);
    refreshPitchRender(cl); renderTimeline(); if(cv)drawPitch(cv,cl); updatePitchInfo(cl); }; };
  stepBtn("#btnNoteDown",-1); stepBtn("#btnNoteUp",1);
  const tog=$("#btnNoteToggle");
  if(tog&&L) tog.onclick=()=>{ const nt=L.notes.find(n=>n.id===pitchSelNote); if(!nt){ toast("Select a note first"); return; }
    nt.enabled=nt.enabled===false?true:false; refreshPitchRender(cl); renderTimeline(); if(cv)drawPitch(cv,cl); updatePitchInfo(cl); toast(nt.enabled?"Note enabled":"Note disabled — that note plays as the original"); };
  if(!cv||!L) return;
  let drag=null;
  cv.addEventListener("pointerdown",e=>{
    const g=cv._geom; if(!g) return;
    const r=cv.getBoundingClientRect(), x=e.clientX-r.left, y=e.clientY-r.top;
    const hit=[...L.notes].reverse().find(n=>{
      const bx=g.X(n.start), bw=Math.max(6,g.X(n.end)-bx);
      return x>=bx&&x<=bx+bw&&Math.abs(y-g.Y(n.midi+effectiveShift(n,L)))<=Math.max(11,g.rh*0.5);
    });
    pitchSelNote=hit?hit.id:null;
    if(hit){ drag={id:hit.id,y0:y,shift0:hit.shift,moved:false}; cv.setPointerCapture(e.pointerId); }
    drawPitch(cv,cl); updatePitchInfo(cl);
  });
  cv.addEventListener("pointermove",e=>{
    if(!drag||!cv._geom) return;
    const r=cv.getBoundingClientRect(), y=e.clientY-r.top;
    const nt=L.notes.find(n=>n.id===drag.id); if(!nt) return;
    const ns=clamp(drag.shift0+Math.round((drag.y0-y)/cv._geom.rh),-12,12);
    if(ns!==nt.shift){ nt.shift=ns; nt.enabled=true; drag.moved=true; drawPitch(cv,cl); updatePitchInfo(cl); }
  });
  cv.addEventListener("pointerup",()=>{ if(drag&&drag.moved){ refreshPitchRender(cl); renderTimeline(); updatePitchInfo(cl); } drag=null; });
  cv.addEventListener("dblclick",e=>{
    const g=cv._geom; if(!g) return; const r=cv.getBoundingClientRect(), x=e.clientX-r.left, y=e.clientY-r.top;
    const hit=[...L.notes].reverse().find(n=>{ const bx=g.X(n.start), bw=Math.max(6,g.X(n.end)-bx); return x>=bx&&x<=bx+bw&&Math.abs(y-g.Y(n.midi+effectiveShift(n,L)))<=Math.max(11,g.rh*0.5); });
    if(hit){ hit.enabled=hit.enabled===false?true:false; refreshPitchRender(cl); renderTimeline(); drawPitch(cv,cl); updatePitchInfo(cl); }
  });
}

/* ----- split / delete ----- */
function splitSelected(){
  const fc=findClip(S.selClip); if(!fc){ toast("Select a clip to split"); return; }
  const {tr,cl}=fc, t=S.playing?currentPos():S.pos;
  if(t<=cl.start+0.02||t>=cl.start+cl.dur-0.02){ toast("Place the playhead inside the clip to split"); return; }
  const right={id:nid(),name:cl.name,buffer:cl.buffer,sourceBuffer:cl.sourceBuffer||cl.buffer,start:t,offset:cl.offset+(t-cl.start),dur:cl.start+cl.dur-t,
    gain:cl.gain,fadeIn:0,fadeOut:cl.fadeOut,muted:!!cl.muted};
  /* The pitch layer uses buffer-time coordinates, so it carries over on split.
     The source buffer is shared (not copied = non-destructive); the layer is value-copied to stay independent.
     Derivation caches are not shared; each clip re-derives its own range. */
  const _L=pitchLayer(cl);
  if(_L){ right.pitchLayer=JSON.parse(JSON.stringify(_L)); right._corrCache=null; cl._corrCache=null; }
  cl.dur=t-cl.start; cl.fadeOut=0;
  tr.clips.splice(tr.clips.indexOf(cl)+1,0,right); S.selClip=right.id;
  renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos());
  toast("Clip split");
}
function deleteSelected(){
  const fc=findClip(S.selClip); if(!fc){ toast("Select a clip to delete"); return; }
  fc.tr.clips=fc.tr.clips.filter(c=>c.id!==fc.cl.id); S.selClip=null;
  renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos());
}

/* ============================================================
   Wiring / init
   ============================================================ */
$("#btnPlay").onclick=()=>play();
$("#btnStop").onclick=()=>stopAll();
$("#btnBarPlay").onclick=()=>play();
$("#btnBarStop").onclick=()=>stopAll();
$("#btnBarReturn").onclick=()=>seek(0);
$("#btnLoop").onclick=e=>{ S.loop.on=!S.loop.on; e.currentTarget.classList.toggle("on",S.loop.on);
  if(S.loop.on&&(S.loop.end<=S.loop.start)){ S.loop.start=0; S.loop.end=Math.min(8,projectEnd()); }
  drawRuler(); };
$("#masterVol").addEventListener("input",e=>{ if(S.master)S.master.gain.setTargetAtTime(db2lin(parseFloat(e.target.value)),S.ctx.currentTime,0.03); });
$("#bpmIn").addEventListener("change",e=>{ S.bpm=clamp(parseFloat(e.target.value)||120,40,240); e.target.value=S.bpm;
  renderTimeline(); });
$("#btnImport").onclick=()=>$("#fileIn").click();
$("#btnDemo").onclick=()=>requestDemoLoad();
$("#btnDemoOk").onclick=()=>{ $("#demoConfirm").hidden=true; buildDemoProject(); };
$("#btnDemoCancel").onclick=()=>{ $("#demoConfirm").hidden=true; };
$("#demoConfirm").addEventListener("click",e=>{ if(e.target.id==="demoConfirm") e.currentTarget.hidden=true; });
$("#btnExportGo").onclick=()=>{ curTab="exp"; renderInspector(); document.querySelector(".insp").scrollIntoView({behavior:"smooth",block:"start"}); };
$("#fileIn").addEventListener("change",e=>{ importFiles(e.target.files); e.target.value=""; });
$("#btnImportClose").onclick=()=>{ const p=$("#importPanel"); clearTimeout(p._h); p.hidden=true; };
$("#btnAddTrack").onclick=()=>{ const type=$("#newTrackType").value;
  const tr=newTrack(TYPES[type].label+" "+(S.tracks.filter(t=>t.type===type).length+1),type);
  if(type!=="inst") tr.bus=S.buses[0].id;
  S.tracks.push(tr); if(S.ctx)buildTrackGraph(tr); S.selTrack=tr.id; renderTimeline(); renderInspector(); };
$("#btnSplit").onclick=splitSelected;
$("#btnDelClip").onclick=deleteSelected;
$("#btnSnap").onclick=e=>{ S.snap=!S.snap; e.currentTarget.classList.toggle("on",S.snap); };
$("#autoSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return;
  S.autoMode=b.dataset.m; $$("#autoSeg button").forEach(x=>x.classList.toggle("on",x===b)); renderTimeline(); });
$("#zoomR").addEventListener("input",e=>{ const wrap=$("#tlWrap"); const anchor=S.pos;
  S.px=parseFloat(e.target.value); renderTimeline(); });
["dragover","dragenter"].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault(); $("#dropVeil").classList.add("show"); }));
["dragleave","drop"].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault();
  if(ev==="dragleave"&&e.relatedTarget) return; $("#dropVeil").classList.remove("show"); }));
document.addEventListener("drop",e=>{ if(e.dataTransfer.files&&e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
document.addEventListener("pointerdown",()=>ensureCtx(),{once:true});
document.addEventListener("keydown",e=>{
  if(e.target.matches("input,select,textarea")) return;
  if(e.code==="Space"){ e.preventDefault(); play(); }
  else if(e.key==="s"||e.key==="S") splitSelected();
  else if(e.key==="Delete"||e.key==="Backspace") deleteSelected();
  else if(e.key==="Home") seek(0);
});
window.addEventListener("resize",()=>{ renderTimeline(); if(curTab==="pitch") renderInspector(); });

/* Init: start quietly with an empty timeline (the demo song loads manually; usage is collected in the Manual page) */
renderTimeline(); renderInspector();
requestAnimationFrame(raf);

/* ---------- playhead / meters loop ---------- */
function updatePlayhead(){
  const ph=$("#playhead"); const pos=S.playing?currentPos():S.pos;
  ph.style.left=(pos*S.px)+"px"; ph.style.top="0"; ph.style.height="100%";
  ph.parentElement.style.position="relative";
  $("#timeBig").textContent=fmtT(pos);
  const bt=pos/beatSec(); const bar=Math.floor(bt/4)+1, beat=Math.floor(bt%4)+1;
  $("#timeBar").textContent="Bar "+bar+" · Beat "+beat;
  $("#timeLen").textContent=fmtT(projectEnd());
  const bb=$("#barTimeBig"); if(bb) bb.textContent=fmtT(pos);
  const bbar=$("#barTimeBar"); if(bbar) bbar.textContent="Bar "+bar+" · Beat "+beat;
  const blen=$("#barTimeLen"); if(blen) blen.textContent=fmtT(projectEnd());
}
function raf(){
  requestAnimationFrame(raf);
  if(S.playing){
    let pos=currentPos();
    if(S.loop.on&&pos>=S.loop.end){ seek(S.loop.start); pos=S.loop.start; }
    if(pos>=projectEnd()){ pause(); S.pos=0; }
    updatePlayhead();
    /* auto-scroll follow */
    const wrap=$("#tlWrap"), x=pos*S.px;
    if(x>wrap.scrollLeft+wrap.clientWidth-260||x<wrap.scrollLeft-208) wrap.scrollLeft=Math.max(0,x-120);
  }
  if(S.analyser){
    const a=new Uint8Array(S.analyser.frequencyBinCount); S.analyser.getByteTimeDomainData(a);
    let mx=0; for(let i=0;i<a.length;i++){ const v=Math.abs(a[i]-128)/128; if(v>mx)mx=v; }
    const pct=clamp(mx*130,0,100);
    $("#mL").style.height=pct+"%"; $("#mR").style.height=clamp(pct*0.92,0,100)+"%";
    /* GR meter */
    const tr=selTrackObj();
    if(tr&&tr.nodes&&S.selFx>=0&&tr.fx[S.selFx]&&tr.fx[S.selFx].type==="comp"){
      const node=tr.nodes.liveFx[S.selFx]&&tr.nodes.liveFx[S.selFx].parts.comp;
      const grEl=$("#grBar"); if(node&&grEl) grEl.style.width=clamp(-node.reduction*4,0,100)+"%";
    }
  }
}

/* ---------- undo / redo (snapshot history, main page only) ----------
   After any render settles, the project state is snapshotted (audio
   buffers are shared by reference, never copied; node graphs are
   skipped). If the snapshot key changed, the previous snapshot goes
   onto the undo stack. Selection and zoom are restored with a state
   but do not by themselves create history entries. */
(function(){
  if(/pitch\.html|export\.html|manual\.html/.test(location.pathname)) return;
  function cloneVal(v){
    if(v instanceof AudioBuffer) return v;
    if(ArrayBuffer.isView(v)) return v.slice();
    if(Array.isArray(v)) return v.map(cloneVal);
    if(v && typeof v==="object"){
      var proto=Object.getPrototypeOf(v);
      if(proto!==Object.prototype && proto!==null) return undefined;
      var o={};
      for(var k of Object.keys(v)){
        if(k==="nodes") continue;
        var cv=cloneVal(v[k]);
        if(cv!==undefined) o[k]=cv;
      }
      return o;
    }
    if(typeof v==="function") return undefined;
    return v;
  }
  var bufIds=new WeakMap(), bufSeq=0;
  function snapKey(state){
    var kobj={};
    for(var k of Object.keys(state)){ if(k!=="selTrack" && k!=="selClip" && k!=="px") kobj[k]=state[k]; }
    return JSON.stringify(kobj, function(key, v){
      if(v instanceof AudioBuffer){ if(!bufIds.has(v)) bufIds.set(v, ++bufSeq); return {$b: bufIds.get(v)}; }
      return v;
    });
  }
  function takeSnap(){
    var mv=document.querySelector("#masterVol");
    var state={
      bpm:S.bpm, loop:S.loop, autoMode:S.autoMode, snap:S.snap, px:S.px,
      revMuted:S.revMuted, dlyMuted:S.dlyMuted, demoLoaded:S.demoLoaded,
      userFxPresets:cloneVal(S.userFxPresets||{}), userMixPresets:cloneVal(S.userMixPresets||[]),
      masterVol: mv ? mv.value : null,
      returns: S.returns ? {decay:S.returns.decay, dlyTime:S.returns.dlyTime, dlyFb:S.returns.dlyFb} : null,
      selTrack:S.selTrack, selClip:S.selClip,
      buses:cloneVal(S.buses), tracks:cloneVal(S.tracks)
    };
    return {state: state, key: snapKey(state)};
  }
  function applySnap(snap){
    applying=true;
    var s=cloneVal(snap.state);
    S.buses=s.buses; S.tracks=s.tracks;
    S.bpm=s.bpm; S.loop=s.loop; S.autoMode=s.autoMode; S.snap=s.snap; S.px=s.px;
    S.revMuted=s.revMuted; S.dlyMuted=s.dlyMuted; S.demoLoaded=s.demoLoaded;
    S.userFxPresets=s.userFxPresets||{}; S.userMixPresets=s.userMixPresets||[];
    S.selTrack=s.selTrack; S.selClip=s.selClip;
    var mv=document.querySelector("#masterVol"); if(mv && s.masterVol!=null) mv.value=s.masterVol;
    var bi=document.querySelector("#bpmIn"); if(bi) bi.value=s.bpm;
    var zr=document.querySelector("#zoomR"); if(zr) zr.value=s.px;
    var bs=document.querySelector("#btnSnap"); if(bs) bs.classList.toggle("on", !!s.snap);
    var maxId=0;
    (function walk(v){
      if(typeof v==="string"){ var m=/^id(\d+)$/.exec(v); if(m) maxId=Math.max(maxId, parseInt(m[1],10)); }
      else if(Array.isArray(v)) v.forEach(walk);
      else if(v && typeof v==="object" && !ArrayBuffer.isView(v) && !(v instanceof AudioBuffer)) Object.keys(v).forEach(function(k){ walk(v[k]); });
    })(s);
    if(maxId>=uid) uid=maxId+1;
    ensureCtx();
    if(s.returns && S.returns){
      var R=S.returns;
      R.decay=s.returns.decay; R.dlyTime=s.returns.dlyTime; R.dlyFb=s.returns.dlyFb;
      R.conv.buffer=makeIR(S.ctx, R.decay);
      R.dly.delayTime.value=R.dlyTime; R.fb.gain.value=R.dlyFb;
    }
    baseline=snap;
    renderTimeline();
    renderInspector();
    updateBtns();
    setTimeout(function(){ applying=false; }, 50);
  }
  var undoStack=[], redoStack=[], baseline=null, applying=false, hTimer=null;
  function updateBtns(){
    var bu=document.querySelector("#btnUndo"), br=document.querySelector("#btnRedo");
    if(bu) bu.disabled=!undoStack.length;
    if(br) br.disabled=!redoStack.length;
  }
  function checkHistory(){
    if(applying) return;
    var snap;
    try{ snap=takeSnap(); }catch(e){ return; }
    if(!baseline){ baseline=snap; return; }
    if(snap.key===baseline.key) return;
    undoStack.push(baseline);
    if(undoStack.length>50) undoStack.shift();
    redoStack=[];
    baseline=snap;
    updateBtns();
  }
  function scheduleHistory(){
    if(hTimer) clearTimeout(hTimer);
    hTimer=setTimeout(checkHistory, 300);
  }
  ["renderTimeline", "renderInspector"].forEach(function(name){
    var orig=window[name];
    if(typeof orig!=="function") return;
    window[name]=function(){ var r=orig.apply(this, arguments); scheduleHistory(); return r; };
  });
  /* Many controls (channel / FX sliders, typed entry) mutate state on
     'input' WITHOUT re-rendering, so renders alone miss them. Watch
     control events too, plus a slow poll as a backstop for pointer
     gestures that neither render nor fire input events. */
  document.addEventListener("input", function(e){
    if(e.target && (e.target.type==="range" || e.target.type==="number" || e.target.type==="text")) scheduleHistory();
  });
  document.addEventListener("change", function(e){
    if(e.target && e.target.closest && e.target.closest(".app")) scheduleHistory();
  });
  setInterval(function(){ checkHistory(); }, 3000);
  function doUndo(){
    if(!undoStack.length) return;
    redoStack.push(baseline);
    applySnap(undoStack.pop());
  }
  function doRedo(){
    if(!redoStack.length) return;
    undoStack.push(baseline);
    applySnap(redoStack.pop());
  }
  var bu=document.querySelector("#btnUndo"), br=document.querySelector("#btnRedo");
  if(bu) bu.addEventListener("click", doUndo);
  if(br) br.addEventListener("click", doRedo);
  document.addEventListener("keydown", function(e){
    if(!(e.ctrlKey || e.metaKey)) return;
    if(e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    var k=(e.key||"").toLowerCase();
    if(k==="z" && !e.shiftKey){ e.preventDefault(); doUndo(); }
    else if((k==="z" && e.shiftKey) || k==="y"){ e.preventDefault(); doRedo(); }
  });
  updateBtns();
})();

/* ---------- typed value entry (click a slider readout) ----------
   Fine-grained control: clicking the numeric readout next to a slider
   (or the value inside a mixer mini-row label) turns it into a text
   field. Enter applies, Esc cancels. Values are typed in the displayed
   units (dB, %, ms, s) and converted back through the ratio between
   the readout and the slider's own value, so transformed readouts
   (delay time in ms, return feedback in %) stay correct. Readouts
   that do not parse as a number (e.g. "-∞") are left alone. */
(function(){
  function readoutFor(el){
    if(el.tagName==="OUTPUT"){
      var p=el.previousElementSibling;
      if(p && p.type==="range") return {disp:el, slider:p};
    }
    if(el.tagName==="SPAN"){
      var mini=el.closest ? el.closest(".mini") : null;
      if(mini){
        var r=mini.querySelector("input[type=range]");
        if(r) return {disp:el, slider:r};
      }
    }
    return null;
  }
  function parseDisp(text){
    text=(text||"").trim();
    var m=/^([+-]?\d+(?:\.\d+)?)/.exec(text);
    if(m) return parseFloat(m[1]);
    if(/^L(\d+(?:\.\d+)?)$/.test(text)) return -parseFloat(RegExp.$1);
    if(/^R(\d+(?:\.\d+)?)$/.test(text)) return parseFloat(RegExp.$1);
    if(text==="C") return 0;
    return null;
  }
  document.addEventListener("click", function(e){
    var hit=readoutFor(e.target);
    if(!hit) return;
    var disp=hit.disp, slider=hit.slider;
    var sv=parseFloat(slider.value);
    var cur=parseDisp(disp.textContent);
    var ratio=1;
    if(cur===null){
      if((disp.textContent||"").trim()==="-∞" && isFinite(sv)){ cur=sv; }
      else return;
    } else if(cur!==0 && isFinite(sv)){
      ratio=sv/cur;
    }
    e.preventDefault(); e.stopPropagation();
    var input=document.createElement("input");
    input.type="text"; input.className="numedit"; input.value=String(cur);
    input.setAttribute("inputmode","decimal");
    input.setAttribute("aria-label","Type a value");
    disp.replaceWith(input);
    input.focus(); input.select();
    var done=false;
    function finish(commit){
      if(done) return; done=true;
      var v=input.value;
      if(input.parentNode) input.replaceWith(disp);
      if(!commit) return;
      var num=parseFloat(v);
      if(!isFinite(num)) return;
      var min=parseFloat(slider.min||"0"), max=parseFloat(slider.max||"100"), step=parseFloat(slider.step||"1");
      var raw=num*ratio;
      raw=min+Math.round((raw-min)/step)*step;
      raw=Math.max(min, Math.min(max, raw));
      var dec=(String(step).split(".")[1]||"").length;
      slider.value=raw.toFixed(dec);
      slider.dispatchEvent(new Event("input", {bubbles:true}));
      slider.dispatchEvent(new Event("change", {bubbles:true}));
      /* Channel/FX handlers update only their own readout; sync the
         track headers (which show vol/pan/sends) with one render. */
      if(typeof renderTimeline==="function") renderTimeline();
    }
    input.addEventListener("keydown", function(ev){
      if(ev.key==="Enter"){ finish(true); }
      else if(ev.key==="Escape"){ finish(false); }
      ev.stopPropagation();
    });
    input.addEventListener("click", function(ev){ ev.stopPropagation(); });
    input.addEventListener("blur", function(){ finish(true); });
  });
})();

/* VocalMIX language layer: EN (source) / JA (dictionary). Default EN.
   In EN mode nothing changes; in JA mode rendered UI text is translated
   by exact-match dictionary over text nodes, plus pattern rules for
   toasts and the bar/beat readout. */
(function(){
  var JA = {"+ Add Track": "＋ トラック追加", "+ Import Audio": "＋ 音声を読み込む", "Import Audio": "音声を読み込む", "Load Demo Song": "デモ曲を読み込む", "Load the demo song?": "デモ曲を読み込みますか？", "All current tracks will be replaced by the demo song (backing + vocal + harmony). If you are working with your own audio, export it first before loading.": "今あるトラックはすべてデモ曲（オケ＋ボーカル＋ハモリ）に入れ替わります。自分の音源で作業中の場合は、先に書き出してから読み込んでください。", "Cancel": "キャンセル", "Replace & Load": "入れ替えて読み込む", "Channel": "チャンネル", "Effects": "エフェクト", "Pitch Correction": "ピッチ補正", "Mixer": "ミキサー", "Export": "書き出し", "Manual": "マニュアル", "Open Full-Screen Editor": "全画面エディターで開く", "Full-screen page — easier on a phone.": "全画面ページ — スマホで編集しやすい。", "Master": "マスター", "Tracks": "トラック", "Automation": "オートメーション", "Volume": "ボリューム", "Pan": "パン", "Off": "オフ", "Snap": "スナップ", "Zoom": "ズーム", "Delete Clip": "クリップ削除", "✂ Split": "✂ 分割", "Drag to move, drag the edges to trim": "ドラッグで移動、両端でトリム", "Drop audio files here": "ここに音声ファイルをドロップ", "Vocal": "ボーカル", "Harmony": "ハモリ", "Backing / Instrument": "オケ / 楽器", "Backing": "オケ", "Vocal Bus": "ボーカル バス", "Backing (Demo)": "オケ（デモ）", "Main Vocal (Demo)": "メインボーカル（デモ）", "Harmony (Demo)": "ハモリ（デモ）", "Track Settings": "トラック設定", "Selected Clip": "選択中のクリップ", "Name": "名前", "Type": "種類", "Output Bus": "出力バス", "Output": "出力", "Start": "開始", "Time": "時間", "Gain": "ゲイン", "Fade In": "フェードイン", "Fade Out": "フェードアウト", "Reverb Send": "リバーブ センド", "Delay Send": "ディレイ センド", "REV Send": "REV センド", "DLY Send": "DLY センド", "Add Bus": "バスを追加", "Bus": "バス", "Buses": "バス", "BUS": "バス", "Direct to Master": "マスターへ直接", "→ Master": "→ マスター", "Delete": "削除", "Duplicate": "複製", "Collapse": "折りたたむ", "Open": "開く", "Reset": "リセット", "Mute": "ミュート", "Muted": "ミュート中", "No tracks": "トラックがありません", "No tracks to export.": "書き出すトラックがありません。", "No effects": "エフェクトがありません", "No clips on this track": "このトラックにクリップはありません", "Clips": "クリップ", "Clip Edit Layer": "クリップ編集レイヤー", "Source Audio": "元の音源", "Always Kept": "常に保持", "Parameters layered on top": "パラメータを上に重ねる", "↓ Parameters layered on top": "↓ パラメータを上に重ねる", "+ Add Stage": "＋ ステージ追加", "Compressor": "コンプレッサー", "Parametric EQ": "パラメトリックEQ", "Reverb": "リバーブ", "Delay": "ディレイ", "Reverb (Insert)": "リバーブ（インサート）", "EQ": "EQ", "FX": "FX", "Threshold": "スレッショルド", "Ratio": "レシオ", "Knee": "ニー", "Attack": "アタック", "Release": "リリース", "Makeup": "メイクアップ", "Decay": "減衰", "Pre-delay": "プリディレイ", "Feedback": "フィードバック", "Delay Time": "ディレイタイム", "Delay Feedback": "ディレイ フィードバック", "Tempo Sync": "テンポ同期", "No Sync": "同期なし", "Frequency Hz": "周波数 Hz", "Gain dB": "ゲイン dB", "Gain Reduction (while playing)": "ゲインリダクション（再生中）", "PRESET": "プリセット", "Save Current Settings": "現在の設定を保存", "Saved for this session only": "このセッション内のみ保存", "My preset name": "プリセット名", "MIX PRESET": "MIX プリセット", "Save Current Mix": "現在のミックスを保存", "Returns (Send Destinations)": "リターン（センド先）", "RETURN": "リターン", "Reverb Decay": "リバーブ減衰", "Applied return preset": "リターンのプリセットを適用しました", "WAV / MP3 Export (Offline Render)": "WAV / MP3 書き出し（オフラインレンダー）", "Format": "形式", "Sample Rate": "サンプルレート", "Bit Depth": "ビット深度", "File Name": "ファイル名", "WAV (Uncompressed)": "WAV（無圧縮）", "WAV only": "WAVのみ", "Renders the whole project offline. Insert FX, sends / returns, buses, automation and fades are all included.": "プロジェクト全体をオフラインで書き出します。インサートFX、センド/リターン、バス、オートメーション、フェードがすべて含まれます。", "Pitch Correction Layer": "ピッチ補正レイヤー", "Delete Layer": "レイヤーを削除", "Deletes all analysis and correction. The source audio remains.": "解析と補正をすべて削除します。元の音源は残ります。", "Analyze Pitch": "ピッチ解析", "Analyzing…": "解析中…", "Correction Strength": "補正の強さ", "Effective shift = note shift x strength": "実効シフト ＝ ノートシフト × 強さ", "Snap to Nearest Note": "最寄りの音にスナップ", "Reset Correction (shifts to 0)": "補正をリセット（シフトを0に）", "Note ON/OFF": "ノート ON/OFF", "+ Semitone": "＋ 半音", "− Semitone": "− 半音", "Layer ON": "レイヤー ON", "Layer OFF": "レイヤー OFF", "Layer structure": "レイヤー構造", "Not Created": "未作成", "Click a block to select it; drag up / down to correct in semitones": "ブロックをクリックで選択、上下ドラッグで半音単位に補正", "Not analyzed yet. Run": "まだ解析していません。次を実行：", "This clip's editor is collapsed. Audio plays with the current settings.": "このクリップのエディタは折りたたまれています。現在の設定で再生されます。", "Split at Playhead": "再生ヘッドで分割", "Volume automation (click to add a point, right-click to delete)": "ボリューム オートメーション（クリックで点を追加、右クリックで削除）", "Pan automation (click to add a point, right-click to delete)": "パン オートメーション（クリックで点を追加、右クリックで削除）", "How to Use (collapse / expand)": "使い方（折りたたみ／展開）", "Choose Audio Files": "音声ファイルを選ぶ", "Vocal Basic": "ボーカル基本", "De-Mud": "こもり解消", "Presence & Air": "抜けと空気感", "Low Cut Only": "ローカットのみ", "Cover Standard": "歌ってみた標準", "Heavy": "しっかり潰す", "Ballad (Slow)": "バラード（遅め）", "Space": "空間", "Vocal Up Front": "ボーカル前面", "Wide Harmony": "ハモリ広め", "Dry (Minimal Sends)": "ドライ（センド最小）", "Wet (Spacious)": "ウェット（広め）", "Standard (No Fade)": "標準（フェードなし）", "Smooth In & Out": "なめらかイン＆アウト", "Long Fade": "ロングフェード", "Gain +3dB": "ゲイン +3dB", "Gain −3dB": "ゲイン −3dB", "Click Removal (10ms)": "クリック除去（10ms）", "Dotted 8th (BPM Sync)": "付点8分（BPM同期）", "8th Delay": "8分ディレイ", "Slapback": "スラップバック", "Dotted 8th": "付点8分", "Quarter Note": "4分音符", "8th Note": "8分音符", "16th Note": "16分音符", "Dotted 8th Sync": "付点8分 同期", "Quarter Sync": "4分 同期", "8th Sync": "8分 同期", "16th Sync": "16分 同期", "8th Triplet": "8分三連", "No audio files found": "音声ファイルが見つかりません", "Cannot delete the last track": "最後のトラックは削除できません", "Clip duplicated (source buffer is shared = non-destructive)": "クリップを複製しました（元のバッファを共有＝非破壊）", "Clip split": "クリップを分割しました", "Correction reset (source unchanged)": "補正をリセットしました（原音は不変）", "Demo song loaded. Press play to listen.": "デモ曲を読み込みました。再生してお聴きください。", "Generating demo song…": "デモ曲を生成中…", "Layer OFF — playing the source audio": "レイヤー OFF — 原音を再生します", "Not analyzed — source only": "未解析 — 原音のみ", "Note disabled — that note plays as the original": "ノートを無効化 — そのノートは原音で再生されます", "Note enabled": "ノートを有効化", "Pitch correction layer ON": "ピッチ補正レイヤー ON", "Pitch correction layer deleted (source audio remains)": "ピッチ補正レイヤーを削除しました（原音は残ります）", "Place the playhead inside the clip to split": "分割したいクリップ内に再生ヘッドを置いてください", "Select a clip to delete": "削除するクリップを選択してください", "Select a clip to split": "分割するクリップを選択してください", "Select a note first": "先にノートを選択してください", "Snapped enabled notes to the nearest pitch (layer only; source unchanged)": "有効なノートを最寄りの音程にスナップしました（レイヤーのみ、原音は不変）", "Stage reset to defaults": "ステージを初期値にリセットしました", "Could not load the MP3 encoder. Please export as WAV.": "MP3エンコーダを読み込めませんでした。WAVで書き出してください。", "Importing Audio": "音声を読み込み中", "Queued": "待機中", "Loaded": "読み込み完了", "Could not load": "読み込めませんでした", "Close": "閉じる", "The full-screen editor is not available on this page": "このページでは全画面エディターは使えません", "Back from the pitch editor — edits applied to the layer": "ピッチエディターから戻りました — 編集をレイヤーに反映しました", "Back from the pitch editor — project restored": "ピッチエディターから戻りました — プロジェクトを復元しました", "Back from the export page — project restored": "書き出しページから戻りました — プロジェクトを復元しました", "↩ Undo": "↩ 元に戻す", "↪ Redo": "↪ やり直し", "Project restored from autosave": "自動保存からプロジェクトを復元しました", "Back from the manual — project restored": "マニュアルから戻りました — プロジェクトを復元しました", "Rendering…": "書き出し中…", "Audio flows from the top stage down. Each stage is an independent unit; summaries always show here.": "音は上のステージから下へ流れます。各ステージは独立したユニットで、要約は常にここに表示されます。", "Click a block to select it; drag up / down to correct in semitones. \"Note ON/OFF\" returns a single note to the original.": "ブロックをクリックで選択し、上下ドラッグで半音単位に補正します。「ノート ON/OFF」は1つのノートだけを原音に戻します。", "Clips / Mixer — Independent Units (Stage 3)": "クリップ／ミキサー — 独立ユニット", "Collapse unused stages with \"Collapse\" in the stage header to hide their parameters. The chain always shows each stage's summary, so the state stays visible while collapsed.": "使わないステージはヘッダーの「折りたたむ」でパラメータを隠せます。チェーンには各ステージの要約が常に出るので、たたんでも状態は見えます。", "Compressor — Full Control": "コンプレッサー — フルコントロール", "Correction applies to playback and export. It targets monophonic singing only (no chords, overlapping sources, or time stretching).": "補正は再生と書き出しに反映されます。対象は単音の歌声のみです（和音・重なった音源・タイムストレッチは対象外）。", "Correction is never baked into the source. Playback and export derive it from source + layer each time. Turn the layer OFF for the original instantly; deleting it still keeps the source.": "補正が原音に焼き込まれることはありません。再生と書き出しは毎回、原音＋レイヤーから導出します。レイヤーを OFF にすれば即座に原音に戻り、削除しても原音は残ります。", "Dashed = detected position; solid blocks = corrected position (strength applied). Gray = disabled notes; when the layer is OFF, everything is gray.": "破線＝検出位置、実ブロック＝補正後（強さ適用済み）。グレー＝無効化したノート。レイヤー OFF のときは全部グレーになります。", "Each stage has presets (EQ \"Vocal Basic\" and \"De-Mud\", Compressor \"Cover Standard\", and more). You can also save the current settings under a name (saved for this session only).": "各ステージにはプリセットがあります（EQ の「ボーカル基本」「こもり解消」、コンプレッサーの「歌ってみた標準」など）。現在の設定に名前を付けて保存もできます（このセッション内のみ）。", "Edits change parameters only; the source audio is never rewritten. Summaries keep the state visible while collapsed.": "編集はパラメータのみで、原音は書き換わりません。折りたたんでも要約で状態が見えます。", "Effects — Each Stage in the Serial Chain Is Independent": "エフェクト — 直列チェーンの各ステージは独立しています", "Even if you split / trim the clip after analysis, the layer carries over in buffer-time coordinates.": "解析後にクリップを分割／トリムしても、レイヤーはバッファ時間の座標で引き継がれます。", "How It Works — the Non-Destructive Design (collapse / expand)": "仕組み — 非破壊の設計（折りたたみ／展開）", "No voiced notes were detected. The audio may be too quiet or not monophonic. The source audio remains untouched.": "有声ノートが検出されませんでした。音が小さすぎるか、単音でない可能性があります。原音はそのまま残っています。", "Not analyzed yet. Run \"Analyze Pitch\" to detect notes and create this layer (the source stays untouched).": "まだ解析していません。「ピッチ解析」を実行するとノートを検出してこのレイヤーを作ります（原音には触れません）。", "Parametric EQ — drag handles (horizontal = frequency / vertical = gain), wheel for Q": "パラメトリックEQ — ハンドルをドラッグ（横＝周波数／縦＝ゲイン）、ホイールで Q", "Pitch Correction — Non-Destructive Layer": "ピッチ補正 — 非破壊レイヤー", "Press \"Analyze Pitch\" to detect pitch with the YIN method and show it as notes (blocks). Drag blocks up or down to correct in semitones, or use \"Snap to Nearest Note\" to pull all notes to the nearest pitch. Correction only layers on top; the source is never rewritten.": "「ピッチ解析」を押すと YIN 法で音程を検出し、ノート（ブロック）として表示します。ブロックを上下にドラッグして半音単位で補正するか、「最寄りの音にスナップ」で全ノートを最寄りの音程へ寄せます。補正は上に重ねるだけで、原音は書き換わりません。", "Select a clip on the timeline first. For monophonic vocal / harmony tracks (not for chords or overlapping sources).": "先にタイムラインでクリップを選んでください。単音のボーカル／ハモリ向けです（和音や重なった音源には使えません）。", "Select a stage from the list to edit its parameters here. Each stage is independent: ON/OFF, reorder, per-stage presets, duplicate and collapse.": "リストからステージを選ぶと、ここでパラメータを編集できます。各ステージは独立していて、ON/OFF・並び替え・段別プリセット・複製・折りたたみができます。", "Sends feed the return reverb / delay. Route several tracks to a bus to process them together.": "センドはリターンのリバーブ／ディレイへ送ります。複数トラックをバスへまとめると一括で処理できます。", "There are whole-mixer presets too (Cover Standard / Vocal Up Front / Dry, etc.). You can also save the current mix under a name (saved for this session only).": "ミキサー全体のプリセットもあります（歌ってみた標準／ボーカル前面／ドライ等）。現在のミックスに名前を付けて保存もできます（このセッション内のみ）。", "This clip is on a backing / instrument track. Pitch correction is designed for monophonic vocals.": "このクリップはオケ／楽器トラックのものです。ピッチ補正は単音ボーカル向けの設計です。", "Re-analyze (rebuild layer)": "再解析（レイヤーを再構築）", "OFF — plays source": "OFF — 原音を再生", "Natural 60%": "ナチュラル 60%", "Standard 85%": "スタンダード 85%", "Full 100%": "フル 100%", "Pulls notes 60% of the way. Keeps vibrato and nuance.": "ノートを目標の60%まで寄せます。ビブラートとニュアンスを残します。", "The cover-song standard. Tunes pitch without sounding mechanical.": "歌ってみたの標準。機械的に聞こえない範囲で音程を整えます。", "Pulls fully to the target pitch. Meant to be combined with snap.": "目標の音程まで完全に寄せます。スナップとの併用が前提です。", "New bus name": "バス名を入力"};
  var ENR = {}; Object.keys(JA).forEach(function(k){ ENR[JA[k]] = k; });
  var PAT = [
    [/^Loaded: (.+)$/, "読み込みました: $1"],
    [/^Could not load: (.+)$/, "読み込めませんでした: $1"],
    [/^Could not hand the project over: (.+)$/, "プロジェクトを引き継げませんでした: $1"],
    [/^Could not save the pitch edits: (.+)$/, "ピッチ編集を保存できませんでした: $1"],
    [/^Pitch analysis failed: (.+)$/, "ピッチ解析に失敗しました: $1"],
    [/^Pitch analysis complete \((\d+) notes?\) — source untouched; correction lives in the layer$/, "ピッチ解析が完了しました（$1 ノート）— 原音は不変、補正はレイヤーに保存されます"],
    [/^Pitch Correction — (.+) \/ (.+)$/, "ピッチ補正 — $1 / $2"],
    [/^Track Settings — (.+)$/, "トラック設定 — $1"],
    [/^Selected: detected (.+) → corrected (.+)$/, "選択中: 検出 $1 → 補正後 $2"],
    [/^Clips — (.+) \(Independent Units\)$/, "クリップ — $1（独立ユニット）"],
    [/^Selected Clip — (.+)$/, "選択中のクリップ — $1"],
    [/^Length ([\d.]+) s \/ Source offset ([\d.]+) s$/, "長さ $1 秒 / ソースオフセット $2 秒"],
    [/^Source offset ([\d.]+) s — never rewritten by trim \/ gain \/ fades\.$/, "ソースオフセット $1 秒 — トリム／ゲイン／フェードで書き換えられません"],
    [/^(.+) · ([\d.]+) s — never rewritten by analysis or correction\. You can always return here\.$/, "$1 · $2 秒 — 解析や補正で書き換えられることはありません。いつでもここに戻れます"],
    [/^([\d.]+)s → ([\d.]+)s \(([\d.]+)s\) · Gain (.+) · Pitch layer (ON|OFF) · (\d+) notes$/, "$1秒 → $2秒（$3秒）· ゲイン $4 · ピッチレイヤー $5 · $6 ノート"],
    [/^([\d.]+)s → ([\d.]+)s \(([\d.]+)s\) · Gain (.+)$/, "$1秒 → $2秒（$3秒）· ゲイン $4"],
    [/^Analyzing… (\d+)%$/, "解析中… $1%"],
    [/^(\d+) notes detected \/ (\d+) corrected · Strength (\d+)%$/, "$1 ノートを検出 / $2 件を補正 · 強さ $3%"],
    [/^(\d+) notes detected \/ (\d+) corrected \/ (\d+) disabled · Strength (\d+)%$/, "$1 ノートを検出 / $2 件を補正 / $3 件を無効化 · 強さ $4%"],
    [/^(\d+) notes detected \/ (\d+) corrected \(layer OFF = source\) · Strength (\d+)%$/, "$1 ノートを検出 / $2 件を補正（レイヤー OFF = 原音）· 強さ $3%"],
    [/^(\d+) notes detected \/ (\d+) corrected \/ (\d+) disabled \(layer OFF = source\) · Strength (\d+)%$/, "$1 ノートを検出 / $2 件を補正 / $3 件を無効化（レイヤー OFF = 原音）· 強さ $4%"],
    [/^Applied preset "(.+)" to (.+)$/, "プリセット「$1」を $2 に適用しました"],
    [/^Applied preset "(.+)" — (.+)$/, "プリセット「$1」を適用しました — $2"],
    [/^Applied clip preset "(.+)" \(source audio unchanged\)$/, "クリッププリセット「$1」を適用しました（原音は不変）"],
    [/^Applied mixer preset "(.+)"$/, "ミキサープリセット「$1」を適用しました"],
    [/^Saved preset "(.+)" \(this session only\)$/, "プリセット「$1」を保存しました（このセッション内のみ）"],
    [/^Saved mixer preset "(.+)" \(this session only\)$/, "ミキサープリセット「$1」を保存しました（このセッション内のみ）"],
    [/^Deleted preset "(.+)"$/, "プリセット「$1」を削除しました"],
    [/^Added bus "(.+)"$/, "バス「$1」を追加しました"],
    [/^Deleted bus "(.+)" \(assigned tracks returned to Master\)$/, "バス「$1」を削除しました（割り当て中のトラックはマスターへ戻しました）"],
    [/^Output of "(.+)" set to (.+)$/, "「$1」の出力を $2 に設定しました"],
    [/^Export complete: (.+)$/, "書き出しが完了しました: $1"],
    [/^Export failed: (.+)$/, "書き出しに失敗しました: $1"],
    [/^Length (.+) \/ (\d+) tracks \(mute \/ solo states apply\)$/, "長さ $1 / $2 トラック（ミュート/ソロ状態が適用されます）"]
  ];
  window.VM_LANG = localStorage.getItem("vocalmix-lang") || "en";
  function isJa(){ return window.VM_LANG === "ja"; }
  function norm(s){ return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
  function walkTree(root, map){
    if(!root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [], n;
    while(n = w.nextNode()) nodes.push(n);
    nodes.forEach(function(node){
      var t = node.nodeValue, core = norm(t);
      if(!core) return;
      var rep = map[core];
      if(!rep && map === JA){
        for(var i = 0; i < PAT.length; i++){
          if(PAT[i][0].test(core)){ rep = core.replace(PAT[i][0], PAT[i][1]); break; }
        }
      }
      if(!rep) return;
      if(t.indexOf(core) >= 0) node.nodeValue = t.replace(core, rep);
      else node.nodeValue = t.match(/^\s*/)[0] + rep + t.match(/\s*$/)[0];
    });
    root.querySelectorAll("[title],[placeholder]").forEach(function(el){
      ["title", "placeholder"].forEach(function(a){
        var v = el.getAttribute(a);
        if(v && map[norm(v)]) el.setAttribute(a, map[norm(v)]);
      });
    });
  }
  function trToast(m){
    if(JA[m]) return JA[m];
    for(var i = 0; i < PAT.length; i++) if(PAT[i][0].test(m)) return m.replace(PAT[i][0], PAT[i][1]);
    return m;
  }
  var _ri = renderInspector;
  renderInspector = function(){ _ri(); if(isJa()) walkTree(document.querySelector("#tabBody"), JA); };
  var _rt = renderTimeline;
  renderTimeline = function(){ _rt(); if(isJa()) walkTree(document.querySelector("#heads"), JA); };
  var _toast = toast;
  toast = function(m){ _toast(isJa() ? trToast(m) : m); };
  /* bar / beat readout: the transport updater rewrites it directly */
  function barPat(el){
    if(!el || !isJa()) return;
    var m = /^Bar (\d+) · Beat (\d+)$/.exec(el.textContent);
    if(m) el.textContent = m[1] + "小節 " + m[2] + "拍";
  }
  ["#barTimeBar", "#timeBar"].forEach(function(sel){
    var el = document.querySelector(sel);
    if(el) new MutationObserver(function(){ barPat(el); }).observe(el, {childList: true, characterData: true, subtree: true});
  });
  /* dynamic panels: status lines written after render (export status,
     pitch status / info, import panel rows) get translated on mutation.
     Safe against loops: translated text no longer matches EN keys. */
  ["#tabBody", "#importPanel"].forEach(function(sel){
    var el = document.querySelector(sel);
    if(el) new MutationObserver(function(){ if(isJa()) walkTree(el, JA); }).observe(el, {childList: true, characterData: true, subtree: true});
  });
  /* language toggle */
  var seg = document.createElement("div");
  seg.className = "seg langseg"; seg.id = "langSeg";
  seg.innerHTML = '<button data-lang="en">EN</button><button data-lang="ja">日本語</button>';
  var go = document.querySelector("#btnExportGo");
  if(go && go.parentElement) go.parentElement.insertBefore(seg, go);
  function syncSeg(){
    seg.querySelectorAll("button").forEach(function(b){ b.classList.toggle("on", b.dataset.lang === window.VM_LANG); });
  }
  window.VM_setLang = function(l){
    if(l !== "ja") l = "en";
    if(l === window.VM_LANG){ syncSeg(); return; }
    window.VM_LANG = l;
    localStorage.setItem("vocalmix-lang", l);
    document.documentElement.lang = (l === "ja") ? "ja" : "en";
    walkTree(document.body, (l === "ja") ? JA : ENR);
    renderInspector(); renderTimeline();
    syncSeg();
  };
  seg.addEventListener("click", function(e){
    var b = e.target.closest("button"); if(!b) return;
    window.VM_setLang(b.dataset.lang);
  });
  syncSeg();
  if(isJa()){
    document.documentElement.lang = "ja";
    walkTree(document.body, JA);
    renderInspector(); renderTimeline();
  }
})();

