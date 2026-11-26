window.VM_BUILD="815f9eb";

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

const TYPES={folder:{label:"Folder",color:"#5a627a",badge:"#454c61"},inst:{label:"Backing",color:"#a8433a",badge:"#86322b"},
             vocal:{label:"Vocal",color:"#4d6f99",badge:"#3c587c"},
             harmony:{label:"Harmony",color:"#5f8a3e",badge:"#4a6d31"}};

/* ---------- state ---------- */
const S={
  ctx:null, master:null, masterComp:null, analyser:null,
  limiter:{on:true, ceiling:-1}, limiterNodes:null, masterCompOn:true, masterChain:null,
  masterVolSaved:"0",
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
  deesser:{ name:"De-Esser",
    make(){ return {type:"deesser",on:true,freq:P("deesser.freq"),threshold:-24,ratio:6}; },
    summary(fx){ return (Math.round(fx.freq/100)/10)+"kHz · "+fx.threshold.toFixed(0)+"dB · "+fx.ratio.toFixed(0)+":1"; },
    presets:[
      {id:"std",label:"Standard",apply(){}},
      {id:"gentle",label:"Gentle",apply(f){ f.threshold=-18; f.ratio=3; }},
      {id:"strong",label:"Strong Sibilance",apply(f){ f.threshold=-30; f.ratio=10; f.freq=5500; }},
      {id:"bright",label:"High & Bright",apply(f){ f.freq=8000; f.threshold=-22; f.ratio=5; }},
    ]},
  ducker:{ name:"Ducker (Sidechain)",
    make(){ return {type:"ducker",on:true,key:null,threshold:-24,ratio:4,depth:12,attack:0.005,release:0.25}; },
    summary(fx){ if(!fx.key) return "No key selected";
      const kt=S.tracks.find(t=>t.id===fx.key);
      return "Key: "+(kt?kt.name:"?")+" · "+fx.threshold.toFixed(0)+"dB · "+fx.ratio.toFixed(0)+":1 · max −"+fx.depth.toFixed(0)+"dB"; },
    presets:[
      {id:"vocal",label:"Vocal over Backing",apply(f){ f.threshold=-28; f.ratio=6; f.depth=5; f.attack=0.003; f.release=0.3; }},
      {id:"glue",label:"Gentle Glue",apply(f){ f.threshold=-20; f.ratio=2; f.depth=4; f.attack=0.01; f.release=0.35; }},
      {id:"pump",label:"Pump",apply(f){ f.threshold=-30; f.ratio=8; f.depth=16; f.attack=0.002; f.release=0.12; }},
    ]},
  mbcomp:{ name:"Multiband Comp",
    make(){ return {type:"mbcomp",on:true,thrLo:-24,thrMid:-24,thrHi:-24,ratio:3,makeup:0}; },
    summary(fx){ return "Lo "+fx.thrLo+" / Mid "+fx.thrMid+" / Hi "+fx.thrHi+" dB · "+fx.ratio+":1"; },
    presets:[
      {id:"std",label:"Standard",apply(){}},
      {id:"gentle",label:"Gentle",apply(f){ f.thrLo=-18; f.thrMid=-18; f.thrHi=-18; f.ratio=2; }},
      {id:"squash",label:"Squash Lows",apply(f){ f.thrLo=-38; f.ratio=5; }},
    ]},
  dyneq:{ name:"Dynamic EQ",
    make(){ return {type:"dyneq",on:true,freq:3000,q:1.2,thr:-24,range:8}; },
    summary(fx){ return (fx.freq>=1000?(fx.freq/1000).toFixed(1)+" kHz":fx.freq+" Hz")+" · thr "+fx.thr+" dB · cut up to "+fx.range+" dB"; },
    presets:[
      {id:"std",label:"De-Harsh",apply(){}},
      {id:"tame",label:"Tame 800 Hz",apply(f){ f.freq=800; f.q=2; f.range=6; }},
      {id:"sib",label:"Sibilance+",apply(f){ f.freq=6500; f.q=1; f.range=10; }},
    ]},
  custom:{ name:"Custom (Build Your Own)",
    make(){ return {type:"custom",on:true,slots:[{kind:"gain",db:6},{kind:"none"},{kind:"none"}]}; },
    summary(fx){ return (fx.slots||[]).filter(sl=>sl&&sl.kind&&sl.kind!=="none").map(sl=>sl.kind).join(" → ")||"empty"; },
    presets:[
      {id:"std",label:"Starter (+6 dB)",apply(){}},
      {id:"blank",label:"Blank",apply(f){ f.slots=[{kind:"none"},{kind:"none"},{kind:"none"}]; }},
      {id:"air",label:"Air + Warmth",apply(f){ f.slots=[{kind:"filter",ft:"highshelf",freq:8000,g:4,q:0.7},{kind:"drive",drive:6},{kind:"none"}]; }},
    ]},
  doubler:{ name:"Doubler / ADT",
    make(){ return {type:"doubler",on:true,mix:0.5,spread:14}; },
    summary(fx){ return fx.spread.toFixed(0)+" / "+(fx.spread*1.6).toFixed(0)+" ms · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"std",label:"ADT",apply(){}},
      {id:"wide",label:"Wide",apply(f){ f.spread=22; f.mix=0.65; }},
      {id:"subtle",label:"Subtle",apply(f){ f.spread=9; f.mix=0.35; }},
    ]},
  rider:{ name:"Vocal Rider",
    make(){ return {type:"rider",on:true,target:-20,range:6,speed:0.3}; },
    summary(fx){ return "Target "+fx.target.toFixed(0)+" dB · ±"+fx.range.toFixed(0)+" dB"; },
    presets:[
      {id:"std",label:"Gentle",apply(){}},
      {id:"bc",label:"Broadcast",apply(f){ f.range=9; f.speed=0.15; }},
      {id:"subtle",label:"Subtle",apply(f){ f.range=3; f.speed=0.5; }},
    ]},
  gate:{ name:"Noise Gate",
    make(){ return {type:"gate",on:true,threshold:-45,range:36,attack:0.002,release:0.12}; },
    summary(fx){ return fx.threshold.toFixed(0)+"dB · Range "+fx.range.toFixed(0)+"dB"; },
    presets:[
      {id:"std",label:"Vocal Gate",apply(){}},
      {id:"tight",label:"Tight (Noisy Room)",apply(f){ f.threshold=-35; f.range=60; f.release=0.08; }},
      {id:"gentle",label:"Gentle Expander",apply(f){ f.threshold=-40; f.range=12; f.release=0.2; }},
    ]},
  chorus:{ name:"Chorus",
    make(){ return {type:"chorus",on:true,rate:0.8,depth:35,mix:0.3}; },
    summary(fx){ return fx.rate.toFixed(2)+" Hz · Depth "+fx.depth.toFixed(0)+"% · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"std",label:"Gentle Chorus",apply(){}},
      {id:"lush",label:"Lush",apply(f){ f.rate=0.35; f.depth=65; f.mix=0.45; }},
      {id:"double",label:"Doubling",apply(f){ f.rate=0.15; f.depth=20; f.mix=0.5; }},
    ]},
  flanger:{ name:"Flanger",
    make(){ return {type:"flanger",on:true,rate:0.25,depth:60,feedback:0.5,mix:0.5}; },
    summary(fx){ return fx.rate.toFixed(2)+" Hz · FB "+Math.round(fx.feedback*100)+"%"; },
    presets:[
      {id:"std",label:"Classic Flanger",apply(){}},
      {id:"jet",label:"Jet",apply(f){ f.rate=0.6; f.depth=90; f.feedback=0.75; }},
      {id:"subtle",label:"Subtle Sweep",apply(f){ f.rate=0.1; f.depth=40; f.feedback=0.3; f.mix=0.35; }},
    ]},
  phaser:{ name:"Phaser",
    make(){ return {type:"phaser",on:true,rate:0.4,depth:60,freq:600,mix:0.5}; },
    summary(fx){ return fx.rate.toFixed(2)+" Hz · "+Math.round(fx.freq)+" Hz"; },
    presets:[
      {id:"std",label:"Classic Phaser",apply(){}},
      {id:"slow",label:"Slow Sweep",apply(f){ f.rate=0.12; f.depth=80; }},
      {id:"swirl",label:"Vocal Swirl",apply(f){ f.rate=0.8; f.freq=900; f.mix=0.35; }},
    ]},
  widener:{ name:"Stereo Widener",
    make(){ return {type:"widener",on:true,width:1.3}; },
    summary(fx){ return "Width "+fx.width.toFixed(2)+" x"; },
    presets:[
      {id:"std",label:"Mild Width",apply(){}},
      {id:"wide",label:"Extra Wide",apply(f){ f.width=1.8; }},
      {id:"mono",label:"Mono",apply(f){ f.width=0; }},
    ]},
  exciter:{ name:"Exciter",
    make(){ return {type:"exciter",on:true,freq:3500,amount:0.4}; },
    summary(fx){ return (Math.round(fx.freq/100)/10)+" kHz · "+Math.round(fx.amount*100)+"%"; },
    presets:[
      {id:"std",label:"Gentle Air",apply(){}},
      {id:"presence",label:"Presence",apply(f){ f.freq=4500; f.amount=0.65; }},
      {id:"strong",label:"Strong",apply(f){ f.freq=3000; f.amount=0.9; }},
    ]},
  hum:{ name:"Hum Removal",
    make(){ return {type:"hum",on:true,freq:50}; },
    summary(fx){ return Math.round(fx.freq)+" Hz + harmonics"; },
    presets:[
      {id:"hz50",label:"50 Hz (JP / EU)",apply(){}},
      {id:"hz60",label:"60 Hz (US)",apply(f){ f.freq=60; }},
    ]},
  clarity:{ name:"Clarity Boost",
    make(){ return {type:"clarity",on:true,freq:4000,amount:3}; },
    summary(fx){ return "+"+fx.amount.toFixed(1)+" dB @ "+(Math.round(fx.freq/100)/10)+" kHz"; },
    presets:[
      {id:"std",label:"Clarity",apply(){}},
      {id:"soft",label:"Soft",apply(f){ f.amount=1.5; }},
      {id:"strong",label:"Strong",apply(f){ f.amount=6; f.freq=4500; }},
    ]},
  conv:{ name:"Convolution Reverb",
    make(){ return {type:"conv",on:true,decay:1.8,mix:0.3}; },
    summary(fx){ return fx.decay.toFixed(1)+" s IR · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"std",label:"Room",apply(){}},
      {id:"hall",label:"Hall",apply(f){ f.decay=2.8; f.mix=0.35; }},
      {id:"cath",label:"Cathedral",apply(f){ f.decay=5; f.mix=0.4; }},
      {id:"small",label:"Small Room",apply(f){ f.decay=0.6; f.mix=0.25; }},
    ]},
  sat:{ name:"Saturation",
    make(){ return {type:"sat",on:true,drive:30,mix:0.6}; },
    summary(fx){ return "Drive "+fx.drive.toFixed(0)+" · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"subtle",label:"Subtle Warmth",apply(){}},
      {id:"tape",label:"Tape",apply(f){ f.drive=55; f.mix=0.75; }},
      {id:"tube",label:"Tube Grit",apply(f){ f.drive=80; f.mix=0.85; }},
    ]},
  pingpong:{ name:"Ping-Pong Delay",
    make(){ return {type:"pingpong",on:true,time:delaySyncSec("d8",S.bpm),feedback:0.35,mix:0.25,sync:"d8"}; },
    summary(fx){ return Math.round(fx.time*1000)+"ms · FB "+Math.round(fx.feedback*100)+"% · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"dotted",label:"Dotted 8th (BPM Sync)",apply(f,bpm){ f.sync="d8"; f.time=delaySyncSec("d8",bpm); f.feedback=0.35; f.mix=0.25; }},
      {id:"eighth",label:"8th Ping-Pong",apply(f,bpm){ f.sync="8"; f.time=delaySyncSec("8",bpm); f.feedback=0.3; f.mix=0.2; }},
      {id:"wide",label:"Wide & Long",apply(f,bpm){ f.sync="4"; f.time=delaySyncSec("4",bpm); f.feedback=0.5; f.mix=0.3; }},
    ]},
  reverb:{ name:"Reverb",
    make(){ return {type:"reverb",on:true,decay:2.4,mix:0.3,predelay:0.02}; },
    summary(fx){ return fx.decay.toFixed(1)+"s · Mix "+Math.round(fx.mix*100)+"%"; },
    presets:[
      {id:"plate",label:"Plate (Standard)",apply(){}},
      {id:"room",label:"Small Room",apply(f){ f.decay=0.6; f.predelay=0.005; f.mix=0.22; }},
      {id:"hall",label:"Hall",apply(f){ f.decay=2.2; f.predelay=0.04; f.mix=0.35; }},
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
function dupTrack(tr){
  const c={ id:nid(), name:tr.name+" copy", type:tr.type, color:tr.color,
    clips: tr.clips.map(function(cl){ const rest={}; Object.keys(cl).forEach(function(k){ if(k!=="buffer") rest[k]=cl[k]; });
      const nc=JSON.parse(JSON.stringify(rest)); nc.id=nid(); nc.buffer=cl.buffer; return nc; }),
    vol:tr.vol, pan:tr.pan, mute:tr.mute, solo:tr.solo, bus:tr.bus,
    sendRev:tr.sendRev, sendDly:tr.sendDly, sendMode:tr.sendMode?JSON.parse(JSON.stringify(tr.sendMode)):undefined, phaseInv:!!tr.phaseInv,
    mono:!!tr.mono, vca:tr.vca||null, note:tr.note||"",
    fx: JSON.parse(JSON.stringify(tr.fx)),
    auto: JSON.parse(JSON.stringify(tr.auto)), nodes:null };
  const at=S.tracks.indexOf(tr);
  S.tracks.splice(at+1,0,c);
  if(S.ctx) buildTrackGraph(c);
  S.selTrack=c.id; S.selClip=null;
  renderTimeline(); renderInspector();
  toast("Track duplicated: "+c.name);
  return c;
}

/* --- Mixer presets (built-ins that act per track type + whole-mix snapshot save) --- */
function applyMixLiveAll(){
  if(!S.ctx) return; const t=S.ctx.currentTime;
  S.tracks.forEach(tr=>{ if(!tr.nodes) return;
    tr.nodes.fader.gain.setTargetAtTime(db2lin(effVol(tr)),t,0.03);
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

/* ---------- master limiter ----------
   Brickwall stage after the master comp: a 20:1, zero-attack
   compressor at the ceiling plus a hard-clip WaveShaper at the same
   ceiling, so no sample can pass it. Ceiling/release are parameters
   (limiter.ceiling / limiter.release); on/off and the ceiling are
   kept per project (S.limiter). */
function limiterCurve(ceilingDb){
  const c=db2lin(ceilingDb), N=1024, curve=new Float32Array(N);
  for(let i=0;i<N;i++){ const x=i/(N-1)*2-1; curve[i]=Math.max(-c,Math.min(c,x)); }
  return curve;
}
function identityCurve(){
  const N=1024, curve=new Float32Array(N);
  for(let i=0;i<N;i++) curve[i]=i/(N-1)*2-1;
  return curve;
}
function makeLimiterNodes(ctx){
  const comp=ctx.createDynamicsCompressor(), clip=ctx.createWaveShaper();
  clip.oversample="none";
  comp.connect(clip);
  return {input:comp, output:clip, comp:comp, clip:clip};
}
function configureLimiter(nodes,L){
  if(!nodes) return;
  if(L&&L.on){
    nodes.comp.threshold.value=L.ceiling; nodes.comp.ratio.value=20;
    nodes.comp.attack.value=0; nodes.comp.release.value=P("limiter.release")/1000; nodes.comp.knee.value=0;
    nodes.clip.curve=limiterCurve(L.ceiling);
  }else{
    nodes.comp.threshold.value=0; nodes.comp.ratio.value=1; nodes.comp.knee.value=0;
    nodes.clip.curve=identityCurve();
  }
}
function applyLimiterLive(){
  configureLimiter(S.limiterNodes, S.limiter);
  /* OFF must be a true bypass: a WaveShaper clamps out-of-range
     input to its curve edges, so even an "identity" curve would
     hard-clip at 0 dB. Rewire the master comp straight to the
     analyser instead. */
  wireMasterChain();
  const chip=document.querySelector("#btnLimiter");
  if(chip) chip.classList.toggle("on", !!(S.limiter&&S.limiter.on));
}

/* The master volume lives in the top-bar slider on the main page,
   but the export page strips that element; fall back to the value
   the handoff saved into the project (S.masterVolSaved). */
function masterChain(){
  if(!S.masterChain) S.masterChain=[{id:"comp",on:true},{id:"limiter",on:true}];
  S.masterChain.forEach(st=>{
    if(st.id==="comp") st.on=S.masterCompOn!==false;
    if(st.id==="limiter") st.on=!!(S.limiter&&S.limiter.on);
  });
  return S.masterChain;
}
function wireMasterChain(){
  if(!S.ctx||!S.master||!S.analyser||!S.masterComp||!S.limiterNodes) return;
  try{ S.master.disconnect(); }catch(e){}
  try{ S.masterComp.disconnect(); }catch(e){}
  try{ S.limiterNodes.input.disconnect(); }catch(e){}
  try{ S.limiterNodes.output.disconnect(); }catch(e){}
  let prev=S.master;
  masterChain().forEach(st=>{
    if(!st.on) return;
    if(st.id==="comp"){ prev.connect(S.masterComp); prev=S.masterComp; }
    else if(st.id==="limiter"){ prev.connect(S.limiterNodes.input); prev=S.limiterNodes.output; }
  });
  prev.connect(S.analyser);
}
function masterVolValue(){
  const el=document.querySelector("#masterVol");
  if(el) return parseFloat(el.value);
  const v=parseFloat(S.masterVolSaved);
  return isFinite(v)?v:0;
}

/* ---------- audio engine ---------- */
function ensureCtx(){
  if(S.ctx) { if(S.ctx.state==="suspended") S.ctx.resume(); return S.ctx; }
  const ctx=new (window.AudioContext||window.webkitAudioContext)({latencyHint:"interactive"});
  S.ctx=ctx;
  S.master=ctx.createGain(); S.master.gain.value=db2lin(masterVolValue());
  S.masterComp=ctx.createDynamicsCompressor();
  S.masterComp.threshold.value=-3; S.masterComp.ratio.value=12; S.masterComp.attack.value=0.002; S.masterComp.release.value=0.18; S.masterComp.knee.value=4;
  S.analyser=ctx.createAnalyser(); S.analyser.fftSize=256;
  S.limiterNodes=makeLimiterNodes(ctx);
  S.analyser.connect(ctx.destination);
  wireMasterChain();
  /* Per-channel analysers for the correlation meter (#59) and the
     clipping history (#61): tapped off the limiter output. */
  S.splitLR=ctx.createChannelSplitter(2);
  S.anL=ctx.createAnalyser(); S.anL.fftSize=1024;
  S.anR=ctx.createAnalyser(); S.anR.fftSize=1024;
  /* Tap the analyser, not the limiter output: with the limiter OFF
     the master comp feeds the analyser directly, and the meters
     must keep working exactly then. */
  S.analyser.connect(S.splitLR);
  S.splitLR.connect(S.anL,0); S.splitLR.connect(S.anR,1);
  const lt=$("#latStat"); if(lt){ const ms=((ctx.baseLatency||0)+(ctx.outputLatency||0))*1000;
    lt.textContent="Latency "+ms.toFixed(0)+" ms · "+(ctx.sampleRate/1000)+" kHz"; }
  applyLimiterLive();
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
function absCurve(){
  const N=256, c=new Float32Array(N);
  for(let i=0;i<N;i++){ const x=i/(N-1)*2-1; c[i]=Math.abs(x); }
  return c;
}
function smoothHz(sec,lo,hi){ return Math.max(lo,Math.min(hi,1/(2*Math.PI*Math.max(0.0005,sec)))); }
/* The release smoother is a 2nd-order lowpass, whose step response
   settles over ~2.5 time constants; scale its cutoff so the heard
   recovery matches the release knob. */
function releaseHz(sec){ return smoothHz(sec,0.6,180)*3; }
/* Static compressor law as a WaveShaper curve: input is the key
   envelope (0..1), output is the gain multiplier to apply. */
function duckCurve(fx){
  const N=1024, c=new Float32Array(N);
  const T=fx.threshold, R=Math.max(1,fx.ratio), knee=6, floor=Math.pow(10,-(fx.depth||0)/20);
  for(let i=0;i<N;i++){
    const x=i/(N-1)*2-1;
    if(x<=0){ c[i]=1; continue; }
    const eDb=20*Math.log10(x);
    let red=0;
    if(eDb>T+knee/2) red=(1-1/R)*(eDb-T);
    else if(eDb>T-knee/2) red=(1-1/R)*Math.pow(eDb-(T-knee/2),2)/(2*knee);
    c[i]=Math.max(floor,Math.pow(10,-red/20));
  }
  return c;
}
/* Gate law: below the threshold the multiplier falls to the range
   floor across a 6 dB soft window; above it, unity. Same envelope
   domain as duckCurve (x = smoothed amplitude, 0..1). */
function dynEqCurve(fx){
  const N=1024, c=new Float32Array(N), thrLin=db2lin(fx.thr);
  for(let i=0;i<N;i++){ const x=i/(N-1)*2-1;
    if(x<=0){ c[i]=0; continue; }
    const over=Math.max(0, 20*Math.log10(Math.max(x,1e-6)/thrLin));
    c[i]=-Math.min(fx.range, over*0.7);
  }
  return c;
}
function riderK(speed){ return 1-0.005/Math.max(0.02, speed||0.3); }
function riderCurve(fx){
  const N=1024, c=new Float32Array(N);
  const T=db2lin(fx.target), mx=Math.pow(10,(fx.range||6)/20), mn=1/mx;
  for(let i=0;i<N;i++){
    const x=i/(N-1)*2-1;
    if(x<=0){ c[i]=mx; continue; }
    c[i]=Math.max(mn, Math.min(mx, Math.pow(T/x, 0.7)));
  }
  return c;
}
function gateCurve(fx){
  const N=1024, c=new Float32Array(N);
  const T=fx.threshold, knee=6, floor=Math.pow(10,-(fx.range||0)/20);
  for(let i=0;i<N;i++){
    const x=i/(N-1)*2-1;
    if(x<=0){ c[i]=floor; continue; }
    const eDb=20*Math.log10(x);
    if(eDb>=T) c[i]=1;
    else if(eDb<=T-knee) c[i]=floor;
    else { const p=(eDb-(T-knee))/knee, sm=p*p*(3-2*p); c[i]=floor+(1-floor)*sm; }
  }
  return c;
}
/* Saturation law: tanh soft clip. drive 0..100 maps to k = 1..10;
   the curve is normalized by tanh(k) so full-scale stays full-scale. */
function satCurve(drive){
  const N=1024, c=new Float32Array(N), k=1+(Math.max(0,Math.min(100,drive))/100)*9, norm=Math.tanh(k);
  for(let i=0;i<N;i++){ const x=i/(N-1)*2-1; c[i]=Math.tanh(k*x)/norm; }
  return c;
}
/* (Re)connect every ducker's key input to its key track's tap.
   Key taps carry the track's raw input (post clip gain, pre FX). */
function wireSidechains(){
  S.tracks.forEach(tr=>{ if(tr.nodes&&tr.nodes.keyTap){ try{ tr.nodes.keyTap.disconnect(); }catch(e){} } });
  S.tracks.forEach(tr=>{
    if(!tr.nodes) return;
    tr.nodes.liveFx.forEach((live,i)=>{
      const fx=tr.fx[i];
      if(fx&&fx.type==="ducker"&&live.parts&&live.parts.keyIn&&fx.key){
        const kt=S.tracks.find(t=>t.id===fx.key);
        if(kt&&kt.nodes&&kt.nodes.keyTap) kt.nodes.keyTap.connect(live.parts.keyIn);
      }
    });
  });
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
  }else if(fx.type==="deesser"){
    /* Split-band by subtraction: out = in + comp(band) - band, with
       the band taken from one highpass. When the compressor idles the
       two band terms cancel exactly, so the stage is transparent;
       when it engages, only the band above freq is ducked. Two
       compressors in series deepen the ducking (measured: a single
       native compressor gives only ~5 dB on steady sibilance). */
    const hp=ctx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=fx.freq; hp.Q.value=0.707;
    function mkComp(){ const c=ctx.createDynamicsCompressor();
      c.threshold.value=fx.threshold; c.ratio.value=fx.ratio; c.attack.value=0.001; c.release.value=0.05; c.knee.value=6; return c; }
    const c1=mkComp(), c2=mkComp();
    const neg=ctx.createGain(); neg.gain.value=-1;
    inp.connect(out);
    inp.connect(hp); hp.connect(c1); c1.connect(c2); c2.connect(out);
    hp.connect(neg); neg.connect(out);
    parts.hp=hp; parts.comp=c1; parts.comp2=c2;
  }else if(fx.type==="ducker"){
    /* Sidechain ducker: the key signal (another track, wired by the
       host into parts.keyIn) is rectified and smoothed into an
       envelope; a WaveShaper maps envelope -> gain multiplier using
       the static compressor law (threshold / ratio / knee / depth)
       and drives the duck gain at audio rate. All nodes, so live
       playback and offline export behave identically. */
    const duck=ctx.createGain(); duck.gain.value=0;
    const keyIn=ctx.createGain();
    const rect=ctx.createWaveShaper(); rect.curve=absCurve();
    const lpA=ctx.createBiquadFilter(); lpA.type="lowpass"; lpA.frequency.value=smoothHz(fx.attack,5,500);
    const lpR=ctx.createBiquadFilter(); lpR.type="lowpass"; lpR.frequency.value=releaseHz(fx.release);
    const shaper=ctx.createWaveShaper(); shaper.curve=duckCurve(fx);
    keyIn.connect(rect); rect.connect(lpA); lpA.connect(lpR); lpR.connect(shaper); shaper.connect(duck.gain);
    inp.connect(duck); duck.connect(out);
    parts.duck=duck; parts.keyIn=keyIn; parts.lpA=lpA; parts.lpR=lpR; parts.shaper=shaper;
  }else if(fx.type==="mbcomp"){
    /* Cascaded two-way LR splits (200 Hz, then the HP remainder
       split at 2000 Hz); filter pairs are cascaded biquads with
       Q = 0.707. Topology history, all measured by the core test
       suite (2026-11-26): the original parallel bank and this
       cascade both sum about +3 dB hot near the band edges at
       unity, because the Web Audio biquad lowpass itself humps
       +1.1 dB at half its cutoff per section (the node's own
       getFrequencyResponse says so - it is the spec response,
       not a plain Butterworth), so no biquad LR bank sums flat.
       A complement cascade (mid = x - low - high) DID sum flat
       at unity, but its residue carries the low band's
       phase-rotated energy, so compressing a band barely moved
       the sum. This cascade is kept because band isolation is
       exact: compressing the low band moved 100 Hz by -8 dB and
       1 kHz not at all (relative to the stage's own unity run);
       the unity coloration is pinned as a known baseline in
       test_dsp.py. */
    const mkC=thr=>{ const c=ctx.createDynamicsCompressor(); c.threshold.value=thr; c.ratio.value=fx.ratio;
      c.attack.value=0.01; c.release.value=0.18; c.knee.value=6; return c; };
    const pair=(type,f)=>{ const a=ctx.createBiquadFilter(); a.type=type; a.frequency.value=f; a.Q.value=0.707;
      const b=ctx.createBiquadFilter(); b.type=type; b.frequency.value=f; b.Q.value=0.707;
      a.connect(b); return {inp:a, out:b}; };
    const cLo=mkC(fx.thrLo), cMid=mkC(fx.thrMid), cHi=mkC(fx.thrHi);
    const mk=ctx.createGain(); mk.gain.value=db2lin(fx.makeup);
    const lpLo=pair("lowpass",200), hpLo=pair("highpass",200);
    inp.connect(lpLo.inp); lpLo.out.connect(cLo); cLo.connect(mk);
    inp.connect(hpLo.inp);
    const lpMid=pair("lowpass",2000), hpHi=pair("highpass",2000);
    hpLo.out.connect(lpMid.inp); lpMid.out.connect(cMid); cMid.connect(mk);
    hpLo.out.connect(hpHi.inp); hpHi.out.connect(cHi); cHi.connect(mk);
    mk.connect(out);
    parts.cLo=cLo; parts.cMid=cMid; parts.cHi=cHi; parts.mk=mk;
  }else if(fx.type==="dyneq"){
    const pk=ctx.createBiquadFilter(); pk.type="peaking"; pk.frequency.value=fx.freq; pk.Q.value=fx.q; pk.gain.value=0;
    const bp=ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=fx.freq; bp.Q.value=fx.q;
    const ab=ctx.createWaveShaper(); ab.curve=absCurve();
    const k=riderK(0.08);
    const pre=ctx.createGain(); pre.gain.value=1-k;
    const sum=ctx.createGain(); sum.gain.value=1;
    const dly=ctx.createDelay(0.05); dly.delayTime.value=0.005;
    const fb=ctx.createGain(); fb.gain.value=k;
    const law=ctx.createWaveShaper(); law.curve=dynEqCurve(fx);
    inp.connect(pk); pk.connect(out);
    inp.connect(bp); bp.connect(ab); ab.connect(pre); pre.connect(sum);
    sum.connect(dly); dly.connect(fb); fb.connect(sum);
    sum.connect(law); law.connect(pk.gain);
    parts.pk=pk; parts.bp=bp; parts.law=law;
  }else if(fx.type==="custom"){
    let tail=inp;
    (fx.slots||[]).forEach(sl=>{
      if(!sl||!sl.kind||sl.kind==="none") return;
      if(sl.kind==="gain"){ const g=ctx.createGain(); g.gain.value=db2lin(sl.db||0); tail.connect(g); tail=g; }
      else if(sl.kind==="filter"){ const f=ctx.createBiquadFilter(); f.type=sl.ft||"lowpass";
        f.frequency.value=sl.freq||1000; f.Q.value=sl.q||0.7; f.gain.value=sl.g||0; tail.connect(f); tail=f; }
      else if(sl.kind==="drive"){ const w=ctx.createWaveShaper(); w.curve=satCurve(sl.drive||12); w.oversample="2x";
        const g=ctx.createGain(); g.gain.value=0.8; tail.connect(w); w.connect(g); tail=g; }
      else if(sl.kind==="delay"){ const d=ctx.createDelay(1); d.delayTime.value=clamp((sl.ms||120)/1000,0.01,1);
        const fb=ctx.createGain(); fb.gain.value=clamp(sl.fb||0.3,0,0.9);
        const wet=ctx.createGain(); wet.gain.value=0.5;
        tail.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(out); }
    });
    tail.connect(out);
  }else if(fx.type==="doubler"){
    const dA=ctx.createDelay(0.1), dB=ctx.createDelay(0.1);
    dA.delayTime.value=fx.spread/1000; dB.delayTime.value=fx.spread*1.6/1000;
    const gA=ctx.createGain(), gB=ctx.createGain();
    gA.gain.value=fx.mix*0.6; gB.gain.value=fx.mix*0.45;
    const oA=ctx.createOscillator(), ogA=ctx.createGain();
    oA.frequency.value=0.27; ogA.gain.value=fx.spread*0.25/1000;
    oA.connect(ogA); ogA.connect(dA.delayTime); oA.start();
    const oB=ctx.createOscillator(), ogB=ctx.createGain();
    oB.frequency.value=0.19; ogB.gain.value=fx.spread*0.25/1000;
    oB.connect(ogB); ogB.connect(dB.delayTime); oB.start();
    inp.connect(out);
    inp.connect(dA); dA.connect(gA); gA.connect(out);
    inp.connect(dB); dB.connect(gB); gB.connect(out);
    parts.dA=dA; parts.dB=dB; parts.gA=gA; parts.gB=gB; parts.ogA=ogA; parts.ogB=ogB;
  }else if(fx.type==="rider"){
    /* The envelope smoother is a feedback one-pole (delay + gain
       loop), NOT a biquad lowpass: below ~5 Hz this engine's
       biquad lowpass has a wrong DC gain (measured 8.7x at 0.8 Hz),
       which would pin the rider at its minimum gain. The loop's
       time constant is tau = D/(1-k), exact in double precision. */
    const g=ctx.createGain(); g.gain.value=0;
    const ab=ctx.createWaveShaper(); ab.curve=absCurve();
    const k=riderK(fx.speed);
    const pre=ctx.createGain(); pre.gain.value=1-k;
    const sum=ctx.createGain(); sum.gain.value=1;
    const dly=ctx.createDelay(0.05); dly.delayTime.value=0.005;
    const fb=ctx.createGain(); fb.gain.value=k;
    const law=ctx.createWaveShaper(); law.curve=riderCurve(fx);
    inp.connect(g); g.connect(out);
    inp.connect(ab); ab.connect(pre); pre.connect(sum);
    sum.connect(dly); dly.connect(fb); fb.connect(sum);
    sum.connect(law); law.connect(g.gain);
    parts.main=g; parts.envPre=pre; parts.envFb=fb; parts.law=law;
  }else if(fx.type==="gate"){
    /* Noise gate / downward expander: the track's own signal is
       rectified and smoothed into an envelope; gateCurve maps it to
       a gain multiplier (unity above threshold, range floor below).
       All nodes, so live and export behave identically. */
    const g=ctx.createGain(); g.gain.value=0;
    const rect=ctx.createWaveShaper(); rect.curve=absCurve();
    const lpA=ctx.createBiquadFilter(); lpA.type="lowpass"; lpA.frequency.value=smoothHz(fx.attack,5,500);
    const lpR=ctx.createBiquadFilter(); lpR.type="lowpass"; lpR.frequency.value=releaseHz(fx.release);
    const shaper=ctx.createWaveShaper(); shaper.curve=gateCurve(fx);
    inp.connect(rect); rect.connect(lpA); lpA.connect(lpR); lpR.connect(shaper); shaper.connect(g.gain);
    inp.connect(g); g.connect(out);
    parts.gateG=g; parts.lpA=lpA; parts.lpR=lpR; parts.shaper=shaper;
  }else if(fx.type==="chorus"){
    /* Two delay voices (16 ms base) with opposite-phase LFOs,
       split L/R: the classic stereo chorus. */
    const dry=ctx.createGain(), wet=ctx.createGain();
    const sp=ctx.createChannelSplitter(2), mg=ctx.createChannelMerger(2);
    const dL=ctx.createDelay(0.1), dR=ctx.createDelay(0.1);
    const osc=ctx.createOscillator(); osc.frequency.value=fx.rate;
    const gL=ctx.createGain(), gR=ctx.createGain();
    const dep=fx.depth/100*0.008;
    gL.gain.value=dep; gR.gain.value=-dep;
    dL.delayTime.value=0.016; dR.delayTime.value=0.016;
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    inp.connect(dry); dry.connect(out);
    inp.connect(sp); sp.connect(dL,0); sp.connect(dR,1);
    osc.connect(gL); gL.connect(dL.delayTime); osc.connect(gR); gR.connect(dR.delayTime);
    dL.connect(mg,0,0); dR.connect(mg,0,1); mg.connect(wet); wet.connect(out);
    osc.start();
    parts.dL=dL; parts.dR=dR; parts.osc=osc; parts.gL=gL; parts.gR=gR; parts.dry=dry; parts.wet=wet;
  }else if(fx.type==="flanger"){
    const dry=ctx.createGain(), wet=ctx.createGain(), fb=ctx.createGain();
    const d=ctx.createDelay(0.05); d.delayTime.value=0.002;
    const osc=ctx.createOscillator(); osc.frequency.value=fx.rate;
    const og=ctx.createGain(); og.gain.value=fx.depth/100*0.0015;
    fb.gain.value=fx.feedback;
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    inp.connect(dry); dry.connect(out);
    inp.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(out);
    osc.connect(og); og.connect(d.delayTime); osc.start();
    parts.dly=d; parts.osc=osc; parts.og=og; parts.fb=fb; parts.dry=dry; parts.wet=wet;
  }else if(fx.type==="phaser"){
    const dry=ctx.createGain(), wet=ctx.createGain();
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    inp.connect(dry); dry.connect(out);
    let node=inp; const stages=[];
    for(let i=0;i<4;i++){ const f=ctx.createBiquadFilter(); f.type="allpass"; f.frequency.value=fx.freq; f.Q.value=1.2; node.connect(f); node=f; stages.push(f); }
    node.connect(wet); wet.connect(out);
    const osc=ctx.createOscillator(); osc.frequency.value=fx.rate;
    const og=ctx.createGain(); og.gain.value=fx.freq*(fx.depth/100)*0.9;
    osc.connect(og); stages.forEach(function(f){ og.connect(f.frequency); });
    osc.start();
    parts.stages=stages; parts.osc=osc; parts.og=og; parts.dry=dry; parts.wet=wet;
  }else if(fx.type==="widener"){
    /* Mid/side in gain form: outL = a*L + b*R, outR = b*L + a*R
       with a=(1+w)/2, b=(1-w)/2 — w=0 mono, w=1 identity, w=2 side only. */
    const sp=ctx.createChannelSplitter(2), mg=ctx.createChannelMerger(2);
    const a=(1+fx.width)/2, b=(1-fx.width)/2;
    const gLL=ctx.createGain(), gLR=ctx.createGain(), gRL=ctx.createGain(), gRR=ctx.createGain();
    gLL.gain.value=a; gRR.gain.value=a; gLR.gain.value=b; gRL.gain.value=b;
    inp.connect(sp);
    sp.connect(gLL,0); gLL.connect(mg,0,0);
    sp.connect(gLR,1); gLR.connect(mg,0,0);
    sp.connect(gRL,0); gRL.connect(mg,0,1);
    sp.connect(gRR,1); gRR.connect(mg,0,1);
    mg.connect(out);
    parts.gLL=gLL; parts.gLR=gLR; parts.gRL=gRL; parts.gRR=gRR;
  }else if(fx.type==="exciter"){
    const dry=ctx.createGain(), wet=ctx.createGain(), hp=ctx.createBiquadFilter(), sh=ctx.createWaveShaper();
    hp.type="highpass"; hp.frequency.value=fx.freq;
    sh.curve=satCurve(60); sh.oversample="2x";
    wet.gain.value=fx.amount;
    inp.connect(dry); dry.connect(out);
    inp.connect(hp); hp.connect(sh); sh.connect(wet); wet.connect(out);
    parts.hp=hp; parts.wet=wet; parts.dry=dry;
  }else if(fx.type==="hum"){
    let node=inp; const notches=[];
    for(let h=1;h<=4;h++){ const f=ctx.createBiquadFilter(); f.type="peaking"; f.frequency.value=fx.freq*h; f.Q.value=30; f.gain.value=-30; node.connect(f); node=f; notches.push(f); }
    node.connect(out);
    parts.notches=notches;
  }else if(fx.type==="clarity"){
    const pk=ctx.createBiquadFilter(); pk.type="peaking"; pk.frequency.value=fx.freq; pk.Q.value=0.9; pk.gain.value=fx.amount;
    const mud=ctx.createBiquadFilter(); mud.type="peaking"; mud.frequency.value=300; mud.Q.value=1; mud.gain.value=-1.5;
    inp.connect(mud); mud.connect(pk); pk.connect(out);
    parts.pk=pk; parts.mud=mud;
  }else if(fx.type==="conv"){
    const dry=ctx.createGain(), wet=ctx.createGain(), cv=ctx.createConvolver();
    cv.buffer=makeIR(ctx, fx.decay);
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    inp.connect(dry); dry.connect(out);
    inp.connect(cv); cv.connect(wet); wet.connect(out);
    parts.conv=cv; parts.dry=dry; parts.wet=wet; parts._dec=fx.decay;
  }else if(fx.type==="sat"){
    const sh=ctx.createWaveShaper(); sh.curve=satCurve(fx.drive); sh.oversample="2x";
    const dry=ctx.createGain(), wet=ctx.createGain();
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    inp.connect(dry); dry.connect(out); inp.connect(sh); sh.connect(wet); wet.connect(out);
    parts.shaper=sh; parts.dry=dry; parts.wet=wet;
  }else if(fx.type==="pingpong"){
    /* Cross-coupled delays: L feeds R, R feeds L, each repeat lands
       on the opposite side (panned +-0.7). */
    const dry=ctx.createGain(), wet=ctx.createGain();
    const dL=ctx.createDelay(2), dR=ctx.createDelay(2);
    const gLR=ctx.createGain(), gRL=ctx.createGain();
    const pL=ctx.createStereoPanner(), pR=ctx.createStereoPanner();
    dry.gain.value=1-fx.mix; wet.gain.value=fx.mix;
    dL.delayTime.value=fx.time; dR.delayTime.value=fx.time;
    gLR.gain.value=fx.feedback; gRL.gain.value=fx.feedback;
    pL.pan.value=-0.7; pR.pan.value=0.7;
    inp.connect(dry); dry.connect(out);
    inp.connect(dL);
    dL.connect(gLR); gLR.connect(dR);
    dR.connect(gRL); gRL.connect(dL);
    dL.connect(pL); pL.connect(wet); dR.connect(pR); pR.connect(wet);
    wet.connect(out);
    parts.dL=dL; parts.dR=dR; parts.gLR=gLR; parts.gRL=gRL; parts.dry=dry; parts.wet=wet;
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
  if(tr.isFolder) return;
  if(tr.nodes){ try{tr.nodes.input.disconnect();}catch(e){} }
  const input=ctx.createGain(), keyTap=ctx.createGain(), autoG=ctx.createGain(), autoP=ctx.createStereoPanner(),
        fader=ctx.createGain(), pan=ctx.createStereoPanner(),
        sRev=ctx.createGain(), sDly=ctx.createGain();
  input.gain.value=tr.phaseInv?-1:1;
  let head=input;
  if(tr.mono){ const mg=ctx.createGain(); mg.channelCount=1; mg.channelCountMode="explicit"; input.connect(mg); head=mg; }
  head.connect(keyTap);
  let prev=head; const liveFx=[];
  if(!tr.frozen) tr.fx.forEach(fx=>{ const n=fxNodes(ctx,fx); prev.connect(n.input); prev=n.output; liveFx.push(n); });
  prev.connect(autoG); autoG.connect(autoP); autoP.connect(fader); fader.connect(pan);
  const dest=busDest(ctx,tr.bus,true);
  pan.connect(dest);
  ((tr.sendMode&&tr.sendMode.rev==="pre")?autoP:fader).connect(sRev); sRev.connect(S.returns.revIn);
  ((tr.sendMode&&tr.sendMode.dly==="pre")?autoP:fader).connect(sDly); sDly.connect(S.returns.dlyIn);
  fader.gain.value=db2lin(effVol(tr)); pan.pan.value=tr.pan;
  sRev.gain.value=tr.sendRev; sDly.gain.value=tr.sendDly;
  tr.nodes={input,keyTap,autoG,autoP,fader,pan,sRev,sDly,liveFx,out:dest};
  wireSidechains();
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
  else if(fx.type==="deesser"&&p.comp){ p.hp.frequency.setTargetAtTime(fx.freq,t,0.02);
    [p.comp,p.comp2].forEach(function(c){ if(c){ c.threshold.setTargetAtTime(fx.threshold,t,0.02); c.ratio.setTargetAtTime(fx.ratio,t,0.02); } }); }
  else if(fx.type==="ducker"&&p.shaper){ p.lpA.frequency.setTargetAtTime(smoothHz(fx.attack,5,500),t,0.02);
    p.lpR.frequency.setTargetAtTime(releaseHz(fx.release),t,0.02);
    p.shaper.curve=duckCurve(fx); }
  else if(fx.type==="mbcomp"&&p.cLo){ p.cLo.threshold.setTargetAtTime(fx.thrLo,t,0.03);
    p.cMid.threshold.setTargetAtTime(fx.thrMid,t,0.03); p.cHi.threshold.setTargetAtTime(fx.thrHi,t,0.03);
    [p.cLo,p.cMid,p.cHi].forEach(c=>c.ratio.setTargetAtTime(fx.ratio,t,0.03));
    if(p.mk) p.mk.gain.setTargetAtTime(db2lin(fx.makeup),t,0.03); }
  else if(fx.type==="dyneq"&&p.pk){ p.pk.frequency.setTargetAtTime(fx.freq,t,0.03); p.pk.Q.setTargetAtTime(fx.q,t,0.03);
    if(p.bp){ p.bp.frequency.setTargetAtTime(fx.freq,t,0.03); p.bp.Q.setTargetAtTime(fx.q,t,0.03); }
    if(p.law) p.law.curve=dynEqCurve(fx); }
  else if(fx.type==="doubler"&&p.dA){ p.dA.delayTime.setTargetAtTime(fx.spread/1000,t,0.03);
    p.dB.delayTime.setTargetAtTime(fx.spread*1.6/1000,t,0.03);
    p.gA.gain.setTargetAtTime(fx.mix*0.6,t,0.03); p.gB.gain.setTargetAtTime(fx.mix*0.45,t,0.03);
    if(p.ogA) p.ogA.gain.setTargetAtTime(fx.spread*0.25/1000,t,0.03);
    if(p.ogB) p.ogB.gain.setTargetAtTime(fx.spread*0.25/1000,t,0.03); }
  else if(fx.type==="rider"&&p.law){ p.law.curve=riderCurve(fx);
    if(p.envPre&&p.envFb){ const k=riderK(fx.speed);
      p.envPre.gain.setTargetAtTime(1-k,t,0.03); p.envFb.gain.setTargetAtTime(k,t,0.03); } }
  else if(fx.type==="gate"&&p.shaper){ p.lpA.frequency.setTargetAtTime(smoothHz(fx.attack,5,500),t,0.02);
    p.lpR.frequency.setTargetAtTime(releaseHz(fx.release),t,0.02);
    p.shaper.curve=gateCurve(fx); }
  else if(fx.type==="chorus"&&p.osc){ p.osc.frequency.setTargetAtTime(fx.rate,t,0.02);
    const dep=fx.depth/100*0.008; p.gL.gain.setTargetAtTime(dep,t,0.02); p.gR.gain.setTargetAtTime(-dep,t,0.02);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
  else if(fx.type==="flanger"&&p.osc){ p.osc.frequency.setTargetAtTime(fx.rate,t,0.02);
    p.og.gain.setTargetAtTime(fx.depth/100*0.0015,t,0.02); p.fb.gain.setTargetAtTime(fx.feedback,t,0.02);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
  else if(fx.type==="phaser"&&p.osc){ p.osc.frequency.setTargetAtTime(fx.rate,t,0.02);
    p.og.gain.setTargetAtTime(fx.freq*(fx.depth/100)*0.9,t,0.02);
    p.stages.forEach(function(f){ f.frequency.setTargetAtTime(fx.freq,t,0.02); });
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
  else if(fx.type==="widener"&&p.gLL){ const a=(1+fx.width)/2, b=(1-fx.width)/2;
    p.gLL.gain.setTargetAtTime(a,t,0.02); p.gRR.gain.setTargetAtTime(a,t,0.02);
    p.gLR.gain.setTargetAtTime(b,t,0.02); p.gRL.gain.setTargetAtTime(b,t,0.02); }
  else if(fx.type==="exciter"&&p.hp){ p.hp.frequency.setTargetAtTime(fx.freq,t,0.02);
    p.wet.gain.setTargetAtTime(fx.amount,t,0.02); }
  else if(fx.type==="hum"&&p.notches){ p.notches.forEach(function(f,i){ f.frequency.setTargetAtTime(fx.freq*(i+1),t,0.02); }); }
  else if(fx.type==="clarity"&&p.pk){ p.pk.frequency.setTargetAtTime(fx.freq,t,0.02);
    p.pk.gain.setTargetAtTime(fx.amount,t,0.02); }
  else if(fx.type==="conv"&&p.conv){ p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02);
    if(Math.abs((p._dec||0)-fx.decay)>0.01){ p._dec=fx.decay; p.conv.buffer=makeIR(S.ctx, fx.decay); } }
  else if(fx.type==="sat"&&p.shaper){ p.shaper.curve=satCurve(fx.drive);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
  else if(fx.type==="pingpong"&&p.dL){ p.dL.delayTime.setTargetAtTime(fx.time,t,0.02);
    p.dR.delayTime.setTargetAtTime(fx.time,t,0.02);
    p.gLR.gain.setTargetAtTime(fx.feedback,t,0.02); p.gRL.gain.setTargetAtTime(fx.feedback,t,0.02);
    p.dry.gain.setTargetAtTime(1-fx.mix,t,0.02); p.wet.gain.setTargetAtTime(fx.mix,t,0.02); }
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
/* Equal-power fade curves for crossfades: fade-in follows sin,
   fade-out cos, so the summed power across a join stays constant.
   skipInto slices the curve so playback can start mid-fade. */
function fadeCurve(kind, curve){
  const N=32, a=new Float32Array(N+1);
  for(let i=0;i<=N;i++){ const p=i/N;
    if(curve==="scurve"){ const sm=p*p*(3-2*p); a[i]=kind==="in"?sm:1-sm; }
    else a[i]=kind==="in"?Math.sin(p*Math.PI/2):Math.cos(p*Math.PI/2); }
  return a;
}
function applyFade(param, kind, cg, t0, dur, skipInto, curve){
  const rem=dur-(skipInto||0);
  if(!(rem>0)) return;
  const N=32, full=fadeCurve(kind, curve||"eqp");
  const from=Math.max(0,Math.min(N,Math.round((skipInto||0)/dur*N)));
  const sub=full.slice(from);
  for(let i=0;i<sub.length;i++) sub[i]=Math.max(0.0001,sub[i]*cg);
  param.setValueCurveAtTime(sub,t0,rem);
}
/* Silence analysis over the clip's source segment: 10 ms RMS
   windows against the silence.db parameter; silent runs of at
   least silence.min seconds separate the sounding segments. */
function analyzeSilence(cl){
  const buf=cl.buffer; if(!buf) return null;
  const sr=buf.sampleRate, win=0.01;
  const thr=Math.pow(10,P("silence.db")/20), minW=Math.max(1,Math.round(P("silence.min")/win));
  const from=Math.floor(cl.offset*sr), to=Math.min(buf.length,Math.ceil((cl.offset+cl.dur)*sr));
  const nW=Math.max(1,Math.floor((to-from)/(sr*win))), loud=new Array(nW);
  const chans=[]; for(let ch=0; ch<buf.numberOfChannels; ch++) chans.push(buf.getChannelData(ch));
  for(let wI=0; wI<nW; wI++){ let sum=0, cnt=0;
    const a=from+Math.floor(wI*sr*win), b=Math.min(to,from+Math.floor((wI+1)*sr*win));
    for(let cI=0;cI<chans.length;cI++){ const d=chans[cI]; for(let i=a;i<b;i+=4){ sum+=d[i]*d[i]; cnt++; } }
    loud[wI]=Math.sqrt(sum/Math.max(1,cnt))>=thr; }
  const runs=[]; let s0=-1;
  for(let i=0;i<=nW;i++){ const isSil=i<nW&&!loud[i];
    if(isSil&&s0<0) s0=i;
    if(!isSil&&s0>=0){ if(i-s0>=minW) runs.push([s0,i]); s0=-1; } }
  const segs=[]; let prev=0;
  runs.forEach(function(r){ segs.push([prev,r[0]]); prev=r[1]; });
  segs.push([prev,nW]);
  return { segs: segs.filter(function(sg){ return sg[1]-sg[0]>=2; }).map(function(sg){ return [+(sg[0]*win).toFixed(3), +(sg[1]*win).toFixed(3)]; }),
           mids: runs.map(function(r){ return +(((r[0]+r[1])/2)*win).toFixed(3); }) };
}
function subClip(cl, relA, relB, keepIn, keepOut){
  const nc={id:nid(), name:cl.name, buffer:cl.buffer, sourceBuffer:cl.sourceBuffer||cl.buffer,
    start:cl.start+relA, offset:cl.offset+relA, dur:relB-relA,
    gain:cl.gain, fadeIn:keepIn?cl.fadeIn:0, fadeOut:keepOut?cl.fadeOut:0,
    curveIn:keepIn?cl.curveIn:undefined, curveOut:keepOut?cl.curveOut:undefined,
    muted:!!cl.muted, reversed:!!cl.reversed};
  const L=pitchLayer(cl); if(L) nc.pitchLayer=JSON.parse(JSON.stringify(L));
  return nc;
}
function replaceClip(tr, cl, news){
  const i=tr.clips.indexOf(cl); if(i<0) return;
  tr.clips.splice(i,1,...news); S.selClip=news.length?news[0].id:null;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
}
function splitAtSilence(tr, cl){
  const an=analyzeSilence(cl); if(!an){ toast("No audio"); return; }
  const mids=an.mids.filter(function(t){ return t>0.05&&t<cl.dur-0.05; });
  if(!mids.length){ toast("No silence found"); return; }
  const bounds=[0].concat(mids,[cl.dur]);
  const news=bounds.slice(0,-1).map(function(b0,i){ return subClip(cl,b0,bounds[i+1],i===0,i===bounds.length-2); });
  replaceClip(tr,cl,news); toast("Split into "+news.length+" clips");
}
function stripSilence(tr, cl){
  const an=analyzeSilence(cl); if(!an){ toast("No audio"); return; }
  if(!an.segs.length||(an.segs.length===1&&an.segs[0][0]===0&&an.segs[0][1]>=cl.dur-0.02)){ toast("No silence found"); return; }
  const news=an.segs.map(function(sg,i){ return subClip(cl,sg[0],Math.min(sg[1],cl.dur),i===0,i===an.segs.length-1); });
  replaceClip(tr,cl,news); toast("Stripped silence: "+news.length+" clips");
}
function slipClip(cl, delta){
  if(!cl.buffer) return;
  cl.offset=Math.max(0,Math.min(cl.buffer.duration-cl.dur, cl.offset+delta));
  renderTimeline(); if(S.playing) startSources(currentPos());
}
function nudgeSelected(step){
  const fc=findClip(S.selClip); if(!fc){ toast("Select a clip first"); return; }
  fc.cl.start=Math.max(0,fc.cl.start+step);
  renderTimeline(); if(S.playing) startSources(currentPos());
}
async function glueWithNext(tr, cl){
  const clips=tr.clips.slice().sort(function(a,b){ return a.start-b.start; });
  const i=clips.indexOf(cl);
  if(i<0||i>=clips.length-1){ toast("No next clip to glue"); return; }
  const nx=clips[i+1];
  const start=Math.min(cl.start,nx.start), end=Math.max(cl.start+cl.dur,nx.start+nx.dur), dur=end-start;
  ensureCtx(); const sr=S.ctx.sampleRate;
  const oc=new OfflineAudioContext(2,Math.ceil(sr*dur),sr);
  const out=oc.createGain(); out.connect(oc.destination);
  [cl,nx].forEach(function(c){ if(c.muted) return;
    const src=oc.createBufferSource(); src.buffer=clipBuffer(c);
    const g=oc.createGain(); src.connect(g); g.connect(out);
    const cg=db2lin(c.gain||0), t0=c.start-start;
    if(c.fadeIn>0&&(c.curveIn==="eqp"||c.curveIn==="scurve")) applyFade(g.gain,"in",cg,t0,c.fadeIn,0,c.curveIn);
    else { g.gain.setValueAtTime(c.fadeIn>0?0.0001:cg,t0); if(c.fadeIn>0) g.gain.linearRampToValueAtTime(cg,t0+c.fadeIn); }
    if(c.fadeOut>0){
      if(c.curveOut==="eqp"||c.curveOut==="scurve") applyFade(g.gain,"out",cg,t0+c.dur-c.fadeOut,c.fadeOut,0,c.curveOut);
      else { g.gain.setValueAtTime(cg,t0+c.dur-c.fadeOut); g.gain.linearRampToValueAtTime(0.0001,t0+c.dur); } }
    src.start(t0,c.offset,c.dur); });
  const buf=await oc.startRendering();
  const nc={id:nid(), name:cl.name+" +", buffer:buf, sourceBuffer:buf, start:start, offset:0, dur:dur, gain:0, fadeIn:0, fadeOut:0, muted:false};
  tr.clips=tr.clips.filter(function(c){ return c!==cl&&c!==nx; });
  tr.clips.push(nc); tr.clips.sort(function(a,b){ return a.start-b.start; });
  S.selClip=nc.id; renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Glued into one clip");
}
/* Key / BPM detection (#62): onset-flux autocorrelation for tempo;
   Goertzel chroma + Krumhansl profiles for key. Analysis is capped
   at the first 60 s of the clip segment. */
function detectBpm(buf, from, to){
  const sr=buf.sampleRate, hop=0.01;
  const d=buf.getChannelData(0);
  const a=Math.floor(from*sr), b=Math.min(d.length, Math.floor(to*sr));
  const n=Math.floor((b-a)/(sr*hop)); if(n<100) return null;
  const env=new Float32Array(n);
  for(let i=0;i<n;i++){ let sm=0; const st=a+Math.floor(i*sr*hop), en=Math.min(b, st+Math.floor(sr*0.02));
    for(let j=st;j<en;j+=2) sm+=d[j]*d[j]; env[i]=Math.sqrt(sm/Math.max(1,(en-st)/2)); }
  const flux=new Float32Array(n);
  for(let i=1;i<n;i++) flux[i]=Math.max(0, env[i]-env[i-1]);
  let mean=0; for(let i=0;i<n;i++) mean+=flux[i]; mean/=n;
  for(let i=0;i<n;i++) flux[i]=Math.max(0, flux[i]-mean);
  const minLag=Math.floor(0.25/hop), maxLag=Math.floor(1.5/hop);
  let best=0, bestV=0;
  for(let lag=minLag;lag<=maxLag;lag++){ let sm=0; for(let i=0;i+lag<n;i++) sm+=flux[i]*flux[i+lag];
    if(sm>bestV){ bestV=sm; best=lag; } }
  if(!best) return null;
  let bpm=60/(best*hop);
  while(bpm<70) bpm*=2; while(bpm>180) bpm/=2;
  return Math.round(bpm);
}
function detectKey(buf, from, to){
  const sr=buf.sampleRate, d=buf.getChannelData(0);
  const a=Math.floor(from*sr), b=Math.min(d.length, Math.floor(to*sr));
  if(b-a<sr*0.3) return null;
  const chroma=new Float32Array(12);
  const segLen=Math.min(b-a, Math.floor(sr*2));
  const nWin=Math.max(1, Math.floor((b-a)/segLen));
  for(let wI=0; wI<nWin; wI++){
    const ws=a+wI*segLen;
    for(let midi=36; midi<84; midi++){
      const f=440*Math.pow(2,(midi-69)/12);
      const w=2*Math.PI*f/sr, cw=Math.cos(w), cf=2*cw;
      let s0=0,s1=0,s2=0;
      for(let i=0;i<segLen;i+=2){ s0=d[ws+i]+cf*s1-s2; s2=s1; s1=s0; }
      chroma[midi%12]+=Math.sqrt(Math.max(0,s1*s1+s2*s2-cf*s1*s2));
    }
  }
  let sum=0; for(let i=0;i<12;i++) sum+=chroma[i];
  if(sum<=0) return null;
  for(let i=0;i<12;i++) chroma[i]/=sum;
  const MAJ=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const MIN=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  let best=null, bestV=-1;
  for(let r=0;r<12;r++){ for(let mode=0;mode<2;mode++){ const prof=mode?MIN:MAJ;
      let sm=0; for(let i=0;i<12;i++) sm+=chroma[(i+r)%12]*prof[i];
      if(sm>bestV){ bestV=sm; best=NAMES[r]+(mode?" minor":" major"); } } }
  return best;
}
function detectClip(cl){
  if(!cl||!cl.buffer) return null;
  const to=Math.min(cl.offset+cl.dur, cl.offset+60);
  return { bpm: detectBpm(cl.buffer, cl.offset, to), key: detectKey(cl.buffer, cl.offset, to) };
}
function runDetect(cl){
  const r=detectClip(cl); if(!r) return null;
  if(r.bpm){ S.bpm=r.bpm; const bi=$("#bpmIn"); if(bi) bi.value=r.bpm; }
  return r;
}
/* ---------- FFT + spectrogram (#58) ---------- */
function fftInPlace(re, im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit;
    if(i<j){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
  for(let len=2;len<=n;len<<=1){ const ang=-2*Math.PI/len;
    for(let i=0;i<n;i+=len){ for(let k=0;k<len/2;k++){
      const wr=Math.cos(ang*k), wi=Math.sin(ang*k);
      const xr=re[i+k+len/2], xi=im[i+k+len/2];
      const tr2=xr*wr-xi*wi, ti2=xr*wi+xi*wr;
      re[i+k+len/2]=re[i+k]-tr2; im[i+k+len/2]=im[i+k]-ti2;
      re[i+k]+=tr2; im[i+k]+=ti2; } } }
}
function spectrogramData(buf, from, to){
  const sr=buf.sampleRate, d=buf.getChannelData(0);
  const W=1024, hop=256;
  const a=Math.floor(from*sr), b=Math.min(d.length, Math.floor(to*sr));
  const frames=Math.max(1, Math.floor(Math.max(0, b-a-W)/hop));
  const mags=new Float32Array(frames*(W/2));
  const win=new Float32Array(W);
  for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
  const re=new Float32Array(W), im=new Float32Array(W);
  let maxMag=1e-9;
  for(let f=0;f<frames;f++){
    re.fill(0); im.fill(0);
    const st=a+f*hop;
    for(let i=0;i<W&&st+i<d.length;i++) re[i]=d[st+i]*win[i];
    fftInPlace(re, im);
    for(let k=0;k<W/2;k++){ const m=Math.sqrt(re[k]*re[k]+im[k]*im[k]); mags[f*(W/2)+k]=m; if(m>maxMag) maxMag=m; }
  }
  return {mags, frames, bins:W/2, sr, maxMag};
}
function drawSpectrogram(cv, cl){
  if(!cv||!cl||!cl.buffer) return;
  const dpr=Math.min(2, window.devicePixelRatio||1);
  const w=cv.clientWidth, h=cv.clientHeight; if(!w||!h) return;
  cv.width=w*dpr; cv.height=h*dpr;
  const c=cv.getContext("2d"); c.scale(dpr, dpr);
  const sg=spectrogramData(clipBuffer(cl), cl.offset, cl.offset+cl.dur);
  c.fillStyle="#0b0e1a"; c.fillRect(0, 0, w, h);
  const colW=w/sg.frames;
  for(let f=0;f<sg.frames;f++){
    for(let k=1;k<sg.bins;k++){
      const m=sg.mags[f*sg.bins+k]/sg.maxMag;
      const db=20*Math.log10(Math.max(m, 1e-6));
      const t=Math.max(0, Math.min(1, (db+70)/70));
      if(t<0.04) continue;
      const y=h-(k/sg.bins)*h;
      const hue=250-t*250;
      c.fillStyle="hsl("+hue+",90%,"+(8+t*52)+"%)";
      c.fillRect(f*colW, y-Math.ceil(h/sg.bins)-1, Math.ceil(colW), Math.ceil(h/sg.bins)+1);
    }
  }
  c.fillStyle="rgba(255,255,255,.75)"; c.font="9px sans-serif";
  [500, 1000, 2000, 4000, 8000].forEach(fr=>{
    const y=h-(fr/(sg.sr/2))*h;
    if(y>8&&y<h-2) c.fillText(fr>=1000?(fr/1000)+"k":fr+"", 3, y-2);
  });
}

/* ---------- clip gain line (#3) ---------- */
function gainLineValueAt(line, t){
  if(!line||!line.length) return 0;
  if(t<=line[0].t) return line[0].db;
  for(let i=1;i<line.length;i++){ if(t<=line[i].t){ const a=line[i-1], b=line[i];
    return a.db+(b.db-a.db)*((t-a.t)/Math.max(1e-6, b.t-a.t)); } }
  return line[line.length-1].db;
}
function scheduleGainLineLive(param, line, when, skip, dur){
  if(!line||!line.length) return;
  param.setValueAtTime(db2lin(gainLineValueAt(line, skip)), when);
  line.forEach(pt=>{ if(pt.t>skip&&pt.t<skip+dur) param.linearRampToValueAtTime(db2lin(pt.db), when+(pt.t-skip)); });
}
function scheduleGainLineAbs(param, line, startAbs){
  if(!line||!line.length) return;
  param.setValueAtTime(db2lin(gainLineValueAt(line, 0)), startAbs);
  line.forEach(pt=>{ if(pt.t>0) param.linearRampToValueAtTime(db2lin(pt.db), startAbs+pt.t); });
}

/* ---------- take lanes & comping (#65/#66) ----------
   cl.takes holds every recorded alternative INCLUDING the active
   one (cl.takeIdx); cl.buffer always mirrors takes[takeIdx].
   Splitting a clip copies the list, so each half can pick its own
   take afterwards - that is the comping workflow. */
function ensureTakes(cl){
  if(!cl.takes){ cl.takes=[cl.sourceBuffer||cl.buffer]; cl.takeIdx=0; }
  return cl.takes;
}
function switchTake(cl, i){
  const t=ensureTakes(cl);
  if(i<0||i>=t.length||i===(cl.takeIdx||0)) return;
  cl.takeIdx=i; cl.buffer=t[i]; cl.sourceBuffer=t[i];
  if(cl.offset+cl.dur>cl.buffer.duration) cl.dur=Math.max(0.05, cl.buffer.duration-cl.offset);
  cl._corrCache=null; cl._revCache=null;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Take "+(i+1)+" active");
}
window.VM_switchTake=switchTake; window.VM_ensureTakes=ensureTakes;

/* ---------- room-noise reduction (#41): spectral gating ----------
   The noise profile is the average magnitude spectrum of the
   quietest quarter of frames; each bin of each frame is then
   attenuated by how far it rises above that profile. Per
   Audacity's noise reduction, the raw per-bin gains are then
   smoothed across frequency (3-tap) and across time (fast
   attack, slow release per bin): unsmoothed gains flicker per
   frame and chirp as "musical noise" - measured here as the
   processed noise region's crest factor rising 1.09 -> 1.21
   before this smoothing was added. */
function denoiseClip(cl, strength){
  const srcBuf=cl.buffer; if(!srcBuf){ toast("No audio"); return 0; }
  const sr=srcBuf.sampleRate;
  const a=Math.floor(cl.offset*sr), b=Math.min(srcBuf.length, Math.ceil((cl.offset+cl.dur)*sr));
  const W=1024, hop=256, bins=W/2;
  const out=new AudioBuffer({length:srcBuf.length, sampleRate:sr, numberOfChannels:srcBuf.numberOfChannels});
  let changed=0;
  for(let c=0;c<srcBuf.numberOfChannels;c++){
    const d=srcBuf.getChannelData(c), o=out.getChannelData(c);
    o.set(d);
    const segLen=Math.min(b-a, Math.floor(120*sr));
    if(segLen<W*4) continue;
    const frames=Math.floor((segLen-W)/hop);
    if(frames<8) continue;
    const win=new Float32Array(W);
    for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
    const mags=new Float32Array(frames*bins), energy=new Float32Array(frames);
    const re=new Float32Array(W), im=new Float32Array(W);
    for(let f=0;f<frames;f++){
      const st=f*hop;
      for(let i=0;i<W;i++){ re[i]=d[a+st+i]*win[i]; im[i]=0; }
      fftInPlace(re, im);
      let e=0;
      for(let k=0;k<bins;k++){ const m=Math.sqrt(re[k]*re[k]+im[k]*im[k]); mags[f*bins+k]=m; e+=m; }
      energy[f]=e;
    }
    const order=Array.from({length:frames},(_,i)=>i).sort((x,y)=>energy[x]-energy[y]);
    const qn=Math.max(1, Math.floor(frames*0.25));
    const noise=new Float32Array(bins);
    for(let q=0;q<qn;q++){ const f=order[q]; for(let k=0;k<bins;k++) noise[k]+=mags[f*bins+k]/qn; }
    const acc=new Float32Array(segLen+W), wsum=new Float32Array(segLen+W);
    const gPrev=new Float32Array(bins).fill(1), gRaw=new Float32Array(bins), gSm=new Float32Array(bins);
    for(let f=0;f<frames;f++){
      const st=f*hop;
      for(let i=0;i<W;i++){ re[i]=d[a+st+i]*win[i]; im[i]=0; }
      fftInPlace(re, im);
      for(let k=0;k<bins;k++){
        const m=mags[f*bins+k];
        gRaw[k]=m>1e-9?clamp(1-strength*noise[k]/m, 0.08, 1):0.08;
      }
      for(let k=0;k<bins;k++){
        const kl=k>0?gRaw[k-1]:gRaw[k], kr=k<bins-1?gRaw[k+1]:gRaw[k];
        gSm[k]=0.25*kl+0.5*gRaw[k]+0.25*kr;
      }
      for(let k=0;k<bins;k++){
        const g=gSm[k], coef=g<gPrev[k]?0.5:0.12;
        gPrev[k]+=coef*(g-gPrev[k]);
      }
      re[0]*=gPrev[0]; im[0]=0;
      for(let k=1;k<bins;k++){
        re[k]*=gPrev[k]; im[k]*=gPrev[k];
        re[W-k]=re[k]; im[W-k]=-im[k];
      }
      /* inverse FFT via the conjugate trick */
      for(let i=0;i<W;i++) im[i]=-im[i];
      fftInPlace(re, im);
      for(let i=0;i<W;i++){ const v=re[i]/W; acc[st+i]+=v*win[i]; wsum[st+i]+=win[i]*win[i]; }
      changed++;
    }
    for(let i=0;i<segLen;i++){ if(wsum[i]>0.05) o[a+i]=acc[i]/wsum[i]; }
  }
  cl.buffer=out; cl._corrCache=null; cl._revCache=null;
  if(cl.takes) cl.takes[cl.takeIdx||0]=out;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Room noise reduced (spectral gate, strength "+strength+")");
  return changed;
}

/* ---------- freeze & bounce (#50/#51) ---------- */
async function renderTrackOnly(tr, dur){
  const savedM=S.tracks.map(t=>({m:t.mute, s:t.solo}));
  const sv={vol:tr.vol, pan:tr.pan, sr:tr.sendRev, sd:tr.sendDly};
  S.tracks.forEach(t=>{ t.mute=t!==tr; t.solo=false; });
  tr.vol=0; tr.pan=0; tr.sendRev=0; tr.sendDly=0;
  S._freezeRender=true;
  try{ return await renderMix(48000, Math.max(0.1, dur)); }
  finally{ S._freezeRender=false;
    S.tracks.forEach((t,i)=>{ t.mute=savedM[i].m; t.solo=savedM[i].s; });
    tr.vol=sv.vol; tr.pan=sv.pan; tr.sendRev=sv.sr; tr.sendDly=sv.sd; }
}
async function freezeTrack(tr){
  if(tr.frozen){
    if(tr.frozenData&&tr.frozenData.clips){ tr.clips=tr.frozenData.clips; tr.frozenData=null; tr.frozen=false;
      if(S.ctx) buildTrackGraph(tr); renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
      toast("Track unfrozen — original clips restored"); }
    else toast("This track was frozen in an earlier session; its original clips were not kept");
    return;
  }
  ensureCtx();
  const dur=Math.max(0.1, projectEnd());
  const buf=await renderTrackOnly(tr, dur);
  if(!buf){ toast("Freeze failed"); return; }
  tr.frozenData={clips:tr.clips};
  tr.clips=[{id:nid(), name:tr.name+" (frozen)", buffer:buf, sourceBuffer:buf, start:0, offset:0, dur:dur, gain:0, fadeIn:0, fadeOut:0, muted:false}];
  tr.frozen=true;
  if(S.ctx) buildTrackGraph(tr);
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Track frozen — FX baked into one clip (unfreeze restores)");
}
async function bounceClip(tr, cl){
  ensureCtx();
  const savedClips=tr.clips;
  tr.clips=[cl];
  let buf=null;
  try{ buf=await renderTrackOnly(tr, Math.max(0.1, cl.start+cl.dur)); }
  finally{ tr.clips=savedClips; }
  if(!buf){ toast("Bounce failed"); return; }
  const seg=sliceBuffer(buf, cl.start, cl.start+cl.dur);
  cl.buffer=seg; cl.sourceBuffer=seg; cl.offset=0;
  cl.pitchLayer=null; delete cl.pitch; cl._corrCache=null; cl._revCache=null;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Clip bounced in place — track FX baked in");
}

/* ---------- timing / pitch tools (#11/#12/#15/#17) ---------- */
function estimateF0(buf, from, to){
  const sr=buf.sampleRate, d=buf.getChannelData(0);
  const a=Math.floor(from*sr), maxLen=Math.min(d.length-a, Math.floor((to-from)*sr));
  if(maxLen<sr*0.1) return 0;
  const W=Math.min(maxLen, Math.floor(sr*0.25));
  let bestOff=a, bestE=-1;
  for(let off=a; off+W<=a+maxLen; off+=Math.floor(sr*0.05)){
    let e=0; for(let i=off;i<off+W;i+=4) e+=d[i]*d[i];
    if(e>bestE){ bestE=e; bestOff=off; }
  }
  const minLag=Math.floor(sr/400), maxLag=Math.floor(sr/60);
  let bestLag=0, bestV=0;
  for(let lag=minLag;lag<=maxLag;lag++){
    let sm=0; for(let i=0;i<W-lag;i+=2) sm+=d[bestOff+i]*d[bestOff+i+lag];
    if(sm>bestV){ bestV=sm; bestLag=lag; }
  }
  return bestLag?sr/bestLag:0;
}
function stretchClip(cl, factor){
  if(!cl.buffer){ toast("No audio"); return; }
  const srcBuf=cl.buffer, sr=srcBuf.sampleRate;
  const segA=Math.floor(cl.offset*sr), segLen=Math.max(256, Math.floor(cl.dur*sr));
  const target=Math.max(256, Math.round(segLen*factor));
  const out=new AudioBuffer({length:target, sampleRate:sr, numberOfChannels:srcBuf.numberOfChannels});
  const f0s=estimateF0(srcBuf, cl.offset, cl.offset+cl.dur);
  for(let c=0;c<srcBuf.numberOfChannels;c++){
    const seg=srcBuf.getChannelData(c).subarray(segA, segA+segLen);
    out.getChannelData(c).set(f0s?PitchShift._psolaT(seg, factor, sr/f0s):PitchShift._stretch(seg, target));
  }
  /* Stretch bakes and detaches the clip from its (possibly shared)
     source; the pitch layer's coordinates no longer apply. */
  cl.buffer=out; cl.sourceBuffer=out; cl.offset=0; cl.dur=target/sr;
  cl.pitchLayer=null; delete cl.pitch; cl._corrCache=null; cl._revCache=null;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Stretched x"+factor+" -> "+cl.dur.toFixed(2)+" s (baked; Undo restores)");
}
function onsetTimes(buf, from, to){
  const sr=buf.sampleRate, d=buf.getChannelData(0);
  const hop=0.01, n=Math.floor((to-from)/hop), env=new Float32Array(Math.max(0,n));
  for(let i=0;i<n;i++){ let sm=0; const st=Math.floor((from+i*hop)*sr), en=Math.min(d.length, st+Math.floor(0.02*sr));
    for(let j=st;j<en;j+=3) sm+=d[j]*d[j]; env[i]=Math.sqrt(sm/Math.max(1,(en-st)/3)); }
  const onsets=[]; let lastT=-1;
  for(let i=2;i<n-1;i++){ const flux=env[i]-env[i-2];
    if(flux>0.1&&env[i]>0.12&&(i*hop-lastT)>0.12&&env[i]>=env[i-1]){ onsets.push(i*hop); lastT=i*hop; } }
  /* A phrase that starts right at the clip head has no rise to
     detect; if the opening is already loud, count t=0 as an onset. */
  if(n>3&&env[0]>0.12&&env[2]>0.12&&(!onsets.length||onsets[0]>0.15)) onsets.unshift(0);
  return onsets;
}
function alignClipToRef(cl, refCl){
  const sr=cl.buffer.sampleRate;
  const srcBuf=clipBuffer(cl), refBuf=clipBuffer(refCl);
  const tOn=onsetTimes(srcBuf, cl.offset, cl.offset+cl.dur);
  const rOn=onsetTimes(refBuf, refCl.offset, refCl.offset+refCl.dur);
  if(tOn.length<2||rOn.length<2){ toast("Align: need at least 2 detected onsets in both clips"); return 0; }
  const pairs=Math.min(tOn.length, rOn.length);
  const tb=[0], rb=[0];
  for(let i=0;i<pairs-1;i++){ tb.push((tOn[i]+tOn[i+1])/2); rb.push((rOn[i]+rOn[i+1])/2); }
  const tailLen=cl.dur-tb[tb.length-1];
  tb.push(cl.dur); rb.push(rb[rb.length-1]+tailLen);
  const total=rb[rb.length-1];
  const outLen=Math.max(256, Math.round(total*sr));
  const out=new AudioBuffer({length:outLen, sampleRate:sr, numberOfChannels:srcBuf.numberOfChannels});
  const xf=Math.floor(sr*0.005);
  const segF0=[];
  for(let c=0;c<srcBuf.numberOfChannels;c++){
    const sd=srcBuf.getChannelData(c), od=out.getChannelData(c);
    for(let i=0;i<tb.length-1;i++){
      const sA=Math.floor((cl.offset+tb[i])*sr), sB=Math.floor((cl.offset+tb[i+1])*sr);
      const seg=sd.subarray(sA, Math.min(sd.length, sB));
      if(seg.length<64) continue;
      const tgtLen=Math.max(64, Math.round((rb[i+1]-rb[i])*sr));
      if(segF0[i]===undefined) segF0[i]=estimateF0(srcBuf, cl.offset+tb[i], cl.offset+tb[i+1]);
      const f0g=segF0[i];
      const st=f0g?PitchShift._psolaT(seg, tgtLen/seg.length, sr/f0g):PitchShift._stretch(seg, tgtLen);
      const oA=Math.round(rb[i]*sr);
      for(let j=0;j<st.length&&oA+j<outLen;j++){
        let g=1;
        if(i>0&&j<xf) g=j/xf; else if(j>st.length-1-xf) g=Math.max(0,(st.length-1-j)/xf);
        od[oA+j]+=st[j]*g;
      }
    }
  }
  cl.buffer=out; cl.sourceBuffer=out; cl.offset=0; cl.dur=total;
  cl.pitchLayer=null; delete cl.pitch; cl._corrCache=null; cl._revCache=null;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Aligned "+pairs+" onsets to the reference clip (baked; Undo restores)");
  return pairs;
}
function formantClip(cl, semis){
  if(!cl.buffer){ toast("No audio"); return; }
  const f0=estimateF0(cl.buffer, cl.offset, cl.offset+cl.dur);
  if(!f0){ toast("Formant: could not estimate the pitch"); return; }
  const ratio=Math.pow(2, semis/12), period=cl.buffer.sampleRate/f0;
  processClipBuffer(cl, (buf, from, to)=>{
    const sr=buf.sampleRate;
    for(let c=0;c<buf.numberOfChannels;c++){
      const d=buf.getChannelData(c);
      const a=Math.floor(from*sr), b=Math.min(d.length, Math.ceil(to*sr));
      const seg=Float32Array.from(d.subarray(a, b));
      const out=PitchShift._formant(seg, ratio, period);
      d.set(out.subarray(0, b-a), a);
    }
    return 1;
  }, "Formant shifted "+(semis>0?"+":"")+semis+" st (pitch kept)");
}
async function ensurePitchLayer(cl){
  const L=pitchLayer(cl); if(L&&L.notes.length) return L;
  ensureCtx();
  const frames=await PitchDetect.analyze(cl.buffer, ()=>{});
  cl.pitchLayer={version:2,enabled:true,strength:1,notes:NoteSegment.segment(frames)};
  delete cl.pitch; delete cl.pitchOn; delete cl.corrBuffer; invalidatePitchCache(cl);
  return cl.pitchLayer;
}
async function makeHarmony(cl, semis){
  const L=await ensurePitchLayer(cl);
  if(!L||!L.notes.length){ toast("Harmony: no notes detected in this clip"); return null; }
  const fc=findClip(cl.id);
  const tr=newTrack("Harmony "+(semis>0?"+":"")+semis, fc?fc.tr.type:"vocal");
  if(S.buses.length&&tr.type!=="inst") tr.bus=S.buses[0].id;
  const nc={id:nid(), name:cl.name+" harm", buffer:cl.buffer, sourceBuffer:cl.sourceBuffer||cl.buffer,
    start:cl.start, offset:cl.offset, dur:cl.dur, gain:cl.gain, fadeIn:cl.fadeIn, fadeOut:cl.fadeOut, muted:false,
    pitchLayer: JSON.parse(JSON.stringify(L))};
  nc.pitchLayer.notes.forEach(n=>{ n.id=nid(); n.shift=(n.shift||0)+semis; n.enabled=true; });
  tr.clips.push(nc); S.tracks.push(tr); if(S.ctx) buildTrackGraph(tr);
  S.selTrack=tr.id; S.selClip=nc.id;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Harmony track created ("+(semis>0?"+":"")+semis+" st, "+nc.pitchLayer.notes.length+" notes)");
  return tr;
}

/* ---------- clip repair tools (#34/#35/#37/#38/#43) ----------
   Each tool rewrites only this clip's buffer (a private copy);
   cl.sourceBuffer keeps the original audio, so the pitch layer's
   source stays intact, and Undo covers the change. */
function processClipBuffer(cl, fn, msg){
  if(!cl.buffer){ toast("No audio"); return 0; }
  const src=cl.buffer, sr=src.sampleRate;
  const out=new AudioBuffer({length:src.length, sampleRate:sr, numberOfChannels:src.numberOfChannels});
  for(let c=0;c<src.numberOfChannels;c++) out.getChannelData(c).set(src.getChannelData(c));
  const n=fn(out, cl.offset, cl.offset+cl.dur)||0;
  cl.buffer=out; cl._corrCache=null; cl._revCache=null;
  if(cl.takes) cl.takes[cl.takeIdx||0]=out;
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  if(msg) toast(msg.replace("{n}", n));
  return n;
}
function medianOf(vals){ const a=Array.from(vals).sort((x,y)=>x-y); return a[a.length>>1]||0; }
function localRmsLookup(d, a, b, sr){
  const hop=Math.max(1,Math.floor(sr*0.001)), n=Math.max(1,Math.ceil((b-a)/hop)), arr=new Float32Array(n);
  for(let hI=0;hI<n;hI++){ const st=a+hI*hop, en=Math.min(b, st+hop*5); let sm=0,cnt=0;
    for(let j=st;j<en;j+=2){ sm+=d[j]*d[j]; cnt++; } arr[hI]=Math.sqrt(sm/Math.max(1,cnt)); }
  return {arr:arr, hop:hop};
}
function declickPass(buf, from, to, half, threshMul, minErr, gateRms){
  /* The threshold scale is the local mean |difference| (a high-
     frequency scale), not the signal RMS: against raw RMS a loud
     sine's own level hides a click completely. */
  const sr=buf.sampleRate; let fixed=0;
  for(let c=0;c<buf.numberOfChannels;c++){
    const d=buf.getChannelData(c);
    const segA=Math.floor(from*sr), segB=Math.min(d.length, Math.ceil(to*sr));
    const a=segA+half, b=segB-half;
    if(b-a<10) continue;
    const hop=Math.max(1,Math.floor(sr*0.005)), nH=Math.max(1,Math.ceil((segB-segA)/hop));
    const scale=new Float32Array(nH), lev=new Float32Array(nH);
    for(let hI=0;hI<nH;hI++){ const st=segA+hI*hop, en=Math.min(segB, st+hop);
      let sm=0, sl=0; for(let j=st+1;j<en;j++){ sm+=Math.abs(d[j]-d[j-1]); sl+=d[j]*d[j]; }
      scale[hI]=sm/Math.max(1,en-st-1); lev[hI]=Math.sqrt(sl/Math.max(1,en-st-1)); }
    const tmp=new Float32Array(2*half+1);
    for(let i=a;i<b;i++){
      const hI=Math.max(0, Math.min(nH-1, Math.floor((i-segA)/hop)));
      if(gateRms&&lev[hI]>gateRms) continue;
      for(let k=-half;k<=half;k++) tmp[k+half]=d[i+k];
      const med=medianOf(tmp);
      if(Math.abs(d[i]-med)>Math.max(minErr, threshMul*scale[hI]*2.5)){ d[i]=med; fixed++; }
    }
  }
  return fixed;
}
function deplosivePass(buf, from, to){
  const sr=buf.sampleRate; let fixed=0;
  const alpha=1-Math.exp(-2*Math.PI*120/sr);
  for(let c=0;c<buf.numberOfChannels;c++){
    const d=buf.getChannelData(c);
    const a=Math.floor(from*sr), b=Math.min(d.length, Math.ceil(to*sr));
    const N=b-a; if(N<sr*0.2) continue;
    const lp=new Float32Array(N);
    let y=0; for(let i=0;i<N;i++){ y+=alpha*(d[a+i]-y); lp[i]=y; }
    const hop=Math.floor(sr*0.005), nH=Math.floor(N/hop), env=new Float32Array(nH);
    for(let hI=0;hI<nH;hI++){ let m=0; for(let j=hI*hop;j<Math.min(N,(hI+1)*hop);j++) m=Math.max(m,Math.abs(lp[j])); env[hI]=m; }
    const burst=new Float32Array(N);
    for(let hI=0;hI<nH;hI++){
      const vals=[]; for(let j=Math.max(0,hI-30);j<Math.min(nH,hI+30);j++) vals.push(env[j]);
      if(env[hI]>Math.max(0.04, 3*medianOf(vals))){ for(let j=hI*hop;j<Math.min(N,(hI+1)*hop);j++) burst[j]=1; }
    }
    const bw=Math.floor(sr*0.005)*2+1, mask=new Float32Array(N);
    let acc=0;
    for(let i=0;i<N;i++){ acc+=burst[i]-(i-bw>=0?burst[i-bw]:0); mask[i]=Math.min(1, acc/bw*2); }
    let any=false;
    for(let i=0;i<N;i++){ if(mask[i]>0.01){ d[a+i]-=0.75*lp[i]*mask[i]; any=true; } }
    if(any) fixed++;
  }
  return fixed;
}
function breathPass(buf, from, to){
  const sr=buf.sampleRate, d0=buf.getChannelData(0);
  const a=Math.floor(from*sr), b=Math.min(d0.length, Math.ceil(to*sr));
  const hop=Math.floor(sr*0.01), nH=Math.floor((b-a)/hop);
  if(nH<10) return 0;
  const rms=new Float32Array(nH);
  for(let hI=0;hI<nH;hI++){ let sm=0; const st=a+hI*hop; for(let j=st;j<Math.min(b,st+hop);j+=2) sm+=d0[j]*d0[j];
    rms[hI]=Math.sqrt(sm/Math.max(1,hop/2)); }
  const lo=Math.pow(10,-52/20), hi=Math.pow(10,-30/20);
  const att=db2lin(-P("repair.breathDb"));
  let count=0, runStart=-1;
  const applyRun=function(sH,eH){
    if(eH-sH<7||eH-sH>80) return;
    count++;
    const st=a+sH*hop, en=a+eH*hop, ramp=Math.floor(sr*0.025);
    for(let c=0;c<buf.numberOfChannels;c++){ const dd=buf.getChannelData(c);
      for(let i=st;i<en;i++){ let g=att; const din=i-st, dout=en-1-i;
        if(din<ramp) g=1+(att-1)*(din/ramp); else if(dout<ramp) g=1+(att-1)*(dout/ramp);
        dd[i]*=g; } }
  };
  for(let hI=0;hI<=nH;hI++){
    const inBand=hI<nH&&rms[hI]>=lo&&rms[hI]<hi;
    if(inBand&&runStart<0) runStart=hI;
    if(!inBand&&runStart>=0){ applyRun(runStart,hI); runStart=-1; }
  }
  return count;
}
function levelPass(buf, from, to, cl){
  const an=analyzeSilence(cl); if(!an||an.segs.length<2) return 0;
  const sr=buf.sampleRate, d=buf.getChannelData(0);
  const segs=an.segs.map(function(sg){
    const a=Math.floor((cl.offset+sg[0])*sr), b=Math.min(d.length, Math.floor((cl.offset+sg[1])*sr));
    let sm=0,cnt=0; for(let i=a;i<b;i+=4){ sm+=d[i]*d[i]; cnt++; }
    return {a:a, b:b, rms:Math.sqrt(sm/Math.max(1,cnt))};
  }).filter(function(g){ return g.rms>1e-4; });
  if(segs.length<2) return 0;
  const target=medianOf(segs.map(function(g){ return g.rms; }));
  const capLin=Math.pow(10, P("repair.levelDb")/20);
  const segGain=function(g){ return Math.max(1/capLin, Math.min(capLin, target/g.rms)); };
  const hop=Math.max(1,Math.floor(sr*0.005));
  const segA=Math.floor(from*sr), segB=Math.min(d.length, Math.ceil(to*sr));
  const nH=Math.ceil((segB-segA)/hop), hg=new Float32Array(nH).fill(1);
  const gainAt=function(t){ const sg=segs.find(function(g){ return t>=g.a&&t<g.b; }); return sg?segGain(sg):null; };
  for(let hI=0;hI<nH;hI++){
    const gv=gainAt(segA+hI*hop);
    if(gv!==null){ hg[hI]=gv; continue; }
    let pv=1, nx=1;
    for(let j=hI-1;j>=0;j--){ const g2=gainAt(segA+j*hop); if(g2!==null){ pv=g2; break; } }
    for(let j=hI+1;j<nH;j++){ const g2=gainAt(segA+j*hop); if(g2!==null){ nx=g2; break; } }
    hg[hI]=(pv+nx)/2;
  }
  let changed=0;
  segs.forEach(function(g){ if(Math.abs(segGain(g)-1)>0.02) changed++; });
  for(let c=0;c<buf.numberOfChannels;c++){ const dd=buf.getChannelData(c);
    for(let i=segA;i<segB;i++){ const pos=(i-segA)/hop, hI=Math.floor(pos), fr=pos-hI;
      const g0=hg[Math.min(nH-1,hI)], g1=hg[Math.min(nH-1,hI+1)];
      dd[i]*=g0+(g1-g0)*fr; } }
  return changed;
}
function repairClip(cl, kind){
  if(!cl||!cl.buffer){ toast("Select a clip with audio first"); return; }
  if(kind==="breath") processClipBuffer(cl, (buf,f,t)=>breathPass(buf,f,t), "Breath control: {n} breath(s) softened");
  else if(kind==="level") processClipBuffer(cl, (buf,f,t)=>levelPass(buf,f,t,cl), "Syllables leveled: {n} adjusted");
  else if(kind==="declick") processClipBuffer(cl, (buf,f,t)=>declickPass(buf,f,t,4,4,0.03,0), "De-click: {n} sample(s) repaired");
  else if(kind==="mouth") processClipBuffer(cl, (buf,f,t)=>declickPass(buf,f,t,2,3,0.015,0.2), "Mouth clicks: {n} sample(s) repaired");
  else if(kind==="plosive") processClipBuffer(cl, (buf,f,t)=>deplosivePass(buf,f,t), "De-plosive applied");
}

/* Clip normalize: set the clip gain so the clip's own peak (of the
   pitch-corrected signal, i.e. what actually plays) reaches the
   norm.target parameter. Peak normalization — a rule, not a guess. */
function normalizeClip(cl){
  const buf=clipBuffer(cl); if(!buf){ toast("No audio"); return; }
  const sr=buf.sampleRate, from=Math.max(0,Math.floor((cl.offset||0)*sr)),
        to=Math.min(buf.length, Math.ceil(((cl.offset||0)+cl.dur)*sr));
  let pk=0;
  for(let ch=0; ch<buf.numberOfChannels; ch++){ const d=buf.getChannelData(ch);
    for(let i=from;i<to;i++){ const a=Math.abs(d[i]); if(a>pk) pk=a; } }
  if(!(pk>0)){ toast("Clip is silent — nothing to normalize"); return; }
  const peakDb=20*Math.log10(pk);
  cl.gain=Math.max(-24, Math.min(12, (cl.gain||0)+(P("norm.target")-peakDb)));
  renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
  toast("Normalized: peak "+peakDb.toFixed(1)+" dB, gain now "+fmtDb(cl.gain));
}
/* Crossfade the selected clip into the next clip on its track:
   equal-power fades across the join. Overlapping clips crossfade
   over the overlap; touching clips use xfade.sec (parameter). */
function crossfadeWithNext(tr, cl, secOverride){
  const clips=tr.clips.slice().sort(function(a,b){ return a.start-b.start; });
  const i=clips.indexOf(cl);
  if(i<0||i>=clips.length-1){ toast("No next clip on this track"); return; }
  const nx=clips[i+1];
  const gap=nx.start-(cl.start+cl.dur);
  if(gap>0.02){ toast("Clips do not touch — move the next clip against this one first"); return; }
  let X;
  if(secOverride) X=secOverride;
  else if(gap<-0.001) X=-gap;
  else X=P("xfade.sec");
  X=Math.min(X,cl.dur,nx.dur);
  if(!(X>0.001)){ toast("Crossfade too short"); return; }
  cl.fadeOut=X; cl.curveOut="eqp";
  nx.fadeIn=X; nx.curveIn="eqp";
  renderTimeline(); renderInspector();
  if(S.playing) startSources(currentPos());
  toast("Crossfade: "+X.toFixed(2)+" s (equal power)");
}

/* ---------- playback ---------- */
function startSources(fromPos){
  const ctx=S.ctx, now=ctx.currentTime+0.06;
  stopSources();
  const anySolo=S.tracks.some(t=>t.solo);
  S.tracks.forEach(tr=>{
    if(tr.isFolder) return;
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
      if(S.speed&&S.speed!==1) src.playbackRate.value=S.speed;
      const g=ctx.createGain(); const gl=ctx.createGain(); src.connect(g); g.connect(gl); gl.connect(tr.nodes.input);
      const skip=Math.max(0,fromPos-cl.start);
      const when=now+Math.max(0,cl.start-fromPos);
      const playDur=cl.dur-skip; if(playDur<=0) return;
      /* fades + clip gain */
      const t0=when, cg=db2lin(cl.gain||0);
      const fi=cl.fadeIn||0, fo=cl.fadeOut||0;
      if(fi>0&&skip<fi&&(cl.curveIn==="eqp"||cl.curveIn==="scurve")){ applyFade(g.gain,"in",cg,t0,fi,skip,cl.curveIn); }
      else{
        g.gain.setValueAtTime(fi>0&&skip===0?0.0001:cg,t0);
        if(fi>0&&skip<fi) g.gain.linearRampToValueAtTime(cg,t0+(fi-skip));
      }
      if(fo>0){
        const fStart=t0+playDur-fo, elapsed=skip-(cl.dur-fo);
        if(cl.curveOut==="eqp"||cl.curveOut==="scurve"){
          if(elapsed>0) applyFade(g.gain,"out",cg,t0,fo,elapsed,cl.curveOut);
          else applyFade(g.gain,"out",cg,Math.max(t0,fStart),fo,0,cl.curveOut);
        }else{
          g.gain.setValueAtTime(cg,Math.max(t0,fStart));
          g.gain.linearRampToValueAtTime(0.0001,t0+playDur);
        }
      }
      scheduleGainLineLive(gl.gain, cl.gainLine, when, skip, playDur);
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
  /* Count-in: with the metronome on, clicks play for metro.countin
     bars before the project starts. A token cancels the pending
     start if the user stops meanwhile. */
  const doCount=S.metroOn&&P("metro.countin")>0&&!S._skipCountIn;
  S._skipCountIn=false;
  if(doCount){
    const bars=P("metro.countin"), bs=beatSec(), t0=S.ctx.currentTime+0.08;
    for(let k=0;k<bars*4;k++) scheduleClick(t0+k*bs,k%4===0);
    const tok=(S._countToken=(S._countToken||0)+1);
    toast("Count-in…");
    setTimeout(function(){ if(S._countToken!==tok||S.playing) return; S._skipCountIn=true; play(); }, bars*4*bs*1000);
    return;
  }
  if(S.pos>=projectEnd()-0.05) S.pos=0;
  startSources(S.pos); S.playing=true; $("#btnPlay").textContent="❚❚"; $("#btnPlay").classList.add("playing");
  metroStart();
  const bp=$("#btnBarPlay"); if(bp){ bp.textContent="❚❚"; bp.classList.add("playing"); }
}
function pause(){
  S._countToken=(S._countToken||0)+1; metroStop();
  if(!S.playing) return;
  S.pos=currentPos(); stopSources(); S.playing=false;
  $("#btnPlay").textContent="▶"; $("#btnPlay").classList.remove("playing");
  const bp2=$("#btnBarPlay"); if(bp2){ bp2.textContent="▶"; bp2.classList.remove("playing"); }
}
function stopAll(){ pause(); S.pos=0; updatePlayhead(); }
function currentPos(){
  if(!S.playing) return S.pos;
  return S.playPosStart+(S.ctx.currentTime-S.playCtxStart)*(S.speed||1);
}
function seek(t){
  S.pos=clamp(t,0,projectEnd());
  if(S._metroNext!==undefined) S._metroNext=Math.ceil(S.pos/beatSec()-1e-6);
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
  if(S.markers&&S.markers.length){
    c.fillStyle=cs.getPropertyValue("--acc")||"#c96a2c"; c.font="9px "+cs.getPropertyValue("--mono");
    S.markers.forEach(function(m){ const x=Math.round(m.t*S.px)+0.5;
      c.beginPath(); c.moveTo(x,0); c.lineTo(x+8,0); c.lineTo(x,8); c.closePath(); c.fill();
      if(m.name) c.fillText(m.name,x+3,13); });
  }
}
function drawWave(canvas,cl){
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const w=canvas.clientWidth||Math.round(cl.dur*S.px), h=canvas.clientHeight||80;
  canvas.width=w*dpr; canvas.height=h*dpr;
  const c=canvas.getContext("2d"); c.scale(dpr,dpr);
  c.fillStyle="rgba(255,255,255,.16)"; c.fillRect(0,0,w,h);
  const buf=cl.reversed?clipBuffer(cl):cl.buffer; if(!buf){return;}
  const ch0=buf.getChannelData(0), ch1=buf.numberOfChannels>1?buf.getChannelData(1):ch0;
  const startS=Math.floor(cl.offset*buf.sampleRate), lenS=Math.floor(cl.dur*buf.sampleRate);
  c.fillStyle="rgba(255,255,255,.85)";
  const mid=h/2;
  for(let x=0;x<w;x++){
    const s0=startS+Math.floor(x/w*lenS), s1=startS+Math.floor((x+1)/w*lenS);
    let mx=0, hf=0, tot=0; const step=Math.max(1,((s1-s0)/40)|0);
    for(let i=s0;i<s1&&i<ch0.length;i+=step){ const v=Math.abs(ch0[i])+Math.abs(ch1[i]); if(v>mx)mx=v;
      /* HF estimate from ADJACENT sample pairs: differences between
         the strided samples themselves would alias low frequencies
         into fake high-frequency energy. */
      const d0=ch0[i]; hf+=Math.abs((i+1<ch0.length?ch0[i+1]:d0)-d0); tot+=Math.abs(d0); }
    if(S.showSib&&mx>0.05&&tot>0&&hf/tot>0.55){ c.fillStyle="rgba(255,110,60,.30)"; c.fillRect(x,0,1,h); c.fillStyle="rgba(255,255,255,.85)"; }
    const y=clamp(mx*0.5*(S.waveZoom||1),0.02,1)*(mid-3);
    c.fillRect(x,mid-y,1,Math.max(1,y*2));
  }
  /* Clip gain line (#3): an orange envelope over the waveform. */
  if(cl.gainLine&&cl.gainLine.length){
    c.strokeStyle="rgba(255,170,60,.95)"; c.lineWidth=1.5; c.beginPath();
    const yOf=db=>2+((12-db)/48)*(h-4);
    const xOf=t=>(t/Math.max(1e-6,cl.dur))*w;
    c.moveTo(0, yOf(gainLineValueAt(cl.gainLine, 0)));
    cl.gainLine.forEach(pt=>c.lineTo(xOf(pt.t), yOf(pt.db)));
    c.lineTo(w, yOf(gainLineValueAt(cl.gainLine, cl.dur)));
    c.stroke(); c.lineWidth=1;
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
    const _fold=S.tracks.find(f=>f.id===tr.folderId);
    if(_fold&&_fold.collapsed) return;
    const hd=document.createElement("div"); hd.className="thead"+(tr.id===S.selTrack?" sel":"");
    hd.innerHTML=`<div class="nm"><span class="dot" style="background:${tr.color}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(tr.name)}</span>
      <span class="badge" style="background:${TYPES[tr.type].badge}">${TYPES[tr.type].label}</span>${tr.isFolder?`<button class="msbtn fold" title="Collapse / expand this folder">${tr.collapsed?"▸":"▾"}</button>`:""}</div>
      <div class="row"><button class="msbtn m ${tr.mute?"on":""}" title="Mute">M</button>
      <button class="msbtn s ${tr.solo?"on":""}" title="Solo">S</button>
      <button class="msbtn ph ${tr.phaseInv?"on":""}" title="Invert polarity">Ø</button>
      <button class="msbtn mn ${tr.mono?"on":""}" title="Mono downmix">MN</button>
      <input type="range" min="-60" max="6" step="0.5" value="${tr.vol}" title="Volume">
      <span class="small volVal" style="font-family:var(--mono);min-width:52px">${fmtDb(tr.vol)}</span>
      <button class="del" title="Delete track">✕</button></div>
      <div class="row"><span class="small">PAN</span><input type="range" min="-100" max="100" step="1" value="${Math.round(tr.pan*100)}" title="Pan">
      <span class="small panVal" style="font-family:var(--mono);min-width:34px">${panLabel(tr.pan)}</span></div>`;
    hd.addEventListener("click",e=>{ if(e.target.closest("button,input"))return; selectTrack(tr.id); });
    const foBtn=hd.querySelector(".fold");
    if(foBtn) foBtn.onclick=()=>{ tr.collapsed=!tr.collapsed; renderTimeline(); };
    const [mBtn,sBtn,delBtn]=[hd.querySelector(".m"),hd.querySelector(".s"),hd.querySelector(".del")];
    const phBtn=hd.querySelector(".ph");
    if(phBtn) phBtn.onclick=()=>{ tr.phaseInv=!tr.phaseInv;
      if(tr.nodes) tr.nodes.input.gain.setTargetAtTime(tr.phaseInv?-1:1,S.ctx.currentTime,0.01);
      renderTimeline(); };
    const mnBtn=hd.querySelector(".mn");
    if(mnBtn) mnBtn.onclick=()=>{ tr.mono=!tr.mono; if(S.ctx) buildTrackGraph(tr);
      if(S.playing) startSources(currentPos()); renderTimeline(); };
    const volR=hd.querySelectorAll("input[type=range]")[0], panR=hd.querySelectorAll("input[type=range]")[1];
    mBtn.onclick=()=>{tr.mute=!tr.mute; if(S.playing)startSources(currentPos()); renderTimeline();};
    sBtn.onclick=()=>{tr.solo=!tr.solo; if(S.playing)startSources(currentPos()); renderTimeline();};
    delBtn.onclick=()=>{ const wasSel=S.selTrack===tr.id;
      S.tracks=S.tracks.filter(t=>t.id!==tr.id);
      if(wasSel){ const nt=S.tracks[0]; S.selTrack=nt?nt.id:null; S.selClip=null; S.selFx=nt&&nt.fx.length?0:-1; }
      if(S.playing)startSources(currentPos()); renderTimeline(); renderInspector(); };
    volR.oninput=()=>{ tr.vol=parseFloat(volR.value); hd.querySelector(".volVal").textContent=fmtDb(tr.vol);
      if(tr.nodes)tr.nodes.fader.gain.setTargetAtTime(db2lin(effVol(tr)),S.ctx.currentTime,0.03); syncMixer(); };
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
  drawRuler(); updatePlayhead(); drawMinimap();
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
  const vcaOpts=`<option value="">No VCA</option>`+(S.vcas||[]).map(v=>`<option value="${v.id}" ${tr.vca===v.id?"selected":""}>${esc(v.name)}</option>`).join("");
  let h=`<div class="cols">
  <div class="sect"><h3>Track Settings — ${esc(tr.name)}</h3>
    <div class="fld"><label>Name</label><input type="text" id="chName" value="${esc(tr.name)}" style="width:170px"></div>
    <div class="fld"><label>Type</label><select id="chType">${Object.entries(TYPES).map(([k,v])=>`<option value="${k}" ${tr.type===k?"selected":""}>${v.label}</option>`).join("")}</select></div>
    <div class="fld"><label>Output Bus</label><select id="chBus">${busOpts}</select></div>
    <div class="fld"><label>Folder</label><select id="chFolder"><option value="">No folder</option>${S.tracks.filter(t=>t.isFolder&&t.id!==tr.id).map(f=>`<option value="${f.id}" ${tr.folderId===f.id?"selected":""}>${esc(f.name)}</option>`).join("")}</select></div>
    <div class="fld"><button id="btnFreeze">${tr.frozen?"Unfreeze Track":"Freeze Track"}</button><span class="small">Bakes this track's FX chain into one clip to save CPU. Unfreeze restores the original clips (this session).</span></div>
    <div class="fld"><label>VCA Group</label><select id="chVca">${vcaOpts}</select></div>
    <div class="fld"><label>Track Color</label><input type="color" id="chColor" value="${tr.color}"></div>
    <div class="fld"><label>Track Note</label><input type="text" id="chNote" value="${esc(tr.note||"")}" placeholder="Note for this track" style="width:220px"></div>
    <div class="fld"><label>Volume</label><input type="range" id="chVol" min="-60" max="6" step="0.5" value="${tr.vol}"><output>${fmtDb(tr.vol)}</output></div>
    <div class="fld"><label>Pan</label><input type="range" id="chPan" min="-100" max="100" step="1" value="${Math.round(tr.pan*100)}"><output>${panLabel(tr.pan)}</output></div>
    <div class="fld"><label>Reverb Send</label><input type="range" id="chSendR" min="0" max="100" step="1" value="${Math.round(tr.sendRev*100)}"><output>${Math.round(tr.sendRev*100)}%</output><button id="chSendRMode" class="ghost">${(tr.sendMode&&tr.sendMode.rev)==="pre"?"Pre":"Post"}</button></div>
    <div class="fld"><label>Delay Send</label><input type="range" id="chSendD" min="0" max="100" step="1" value="${Math.round(tr.sendDly*100)}"><output>${Math.round(tr.sendDly*100)}%</output><button id="chSendDMode" class="ghost">${(tr.sendMode&&tr.sendMode.dly)==="pre"?"Pre":"Post"}</button></div>
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
    <div class="fld"><label>Fade In Curve</label><select id="clCI">${["lin","eqp","scurve"].map(function(c){ return '<option value="'+c+'" '+((cl.curveIn||"lin")===c?"selected":"")+'>'+({lin:"Linear",eqp:"Equal Power",scurve:"S-Curve"})[c]+'</option>'; }).join("")}</select></div>
    <div class="fld"><label>Fade Out</label><input type="number" id="clFO" step="0.01" min="0" max="${cl.dur}" value="${(cl.fadeOut||0).toFixed(2)}"><span class="small">s</span></div>
    <div class="fld"><label>Fade Out Curve</label><select id="clCO">${["lin","eqp","scurve"].map(function(c){ return '<option value="'+c+'" '+((cl.curveOut||"lin")===c?"selected":"")+'>'+({lin:"Linear",eqp:"Equal Power",scurve:"S-Curve"})[c]+'</option>'; }).join("")}</select></div>
    <div class="fld"><button id="clSplit2">Split at Playhead</button><button id="clDel2">Delete Clip</button><button id="clXfade" class="ghost">Crossfade with Next</button><button id="clNorm" class="ghost">Normalize</button></div>
    <div class="fld"><button id="clSplitSil" class="ghost">Split at Silence</button><button id="clStrip" class="ghost">Strip Silence</button><button id="clRev" class="ghost">${cl.reversed?"Forward":"Reverse"}</button><button id="clGlue" class="ghost">Glue with Next</button></div>
    <div class="fld"><button id="clSlipL" class="ghost">◀ Slip</button><button id="clSlipR" class="ghost">Slip ▶</button><span class="small">Slip moves the audio inside the clip frame (0.1 s)</span></div>
    <div class="fld"><button id="clDetect" class="ghost">Detect Key/BPM</button><span class="small" id="clDetectOut"></span></div>
    <div class="fld"><span class="small">Takes:</span><span id="clTakes"></span><button id="clTakeAdd" class="ghost">Store Current as New Take</button></div>
    <div class="fld"><span class="small">Gain Line:</span><button id="clGlAdd" class="ghost">Add Point at Playhead</button><button id="clGlClear" class="ghost">Clear Line</button><span id="clGlList"></span></div>
    <div class="fld"><span class="small">Timing:</span><button id="clStretch09" class="ghost">Stretch 0.9x</button><button id="clBounce" class="ghost">Bounce in Place</button><button id="clStretch11" class="ghost">Stretch 1.1x</button><button id="clAlign" class="ghost">Align to Top Track</button><span class="small">Formant:</span><button id="clFormDown" class="ghost">-2 st</button><button id="clFormUp" class="ghost">+2 st</button></div>
    <div class="fld"><span class="small">Repair:</span><button id="clBreath" class="ghost">Breath</button><button id="clLevel" class="ghost">Level Syllables</button><button id="clDeclick" class="ghost">De-Click</button><button id="clMouth" class="ghost">Mouth Clicks</button><button id="clPlosive" class="ghost">De-Plosive</button><button id="clNoise" class="ghost">Room Noise</button><button id="clSib" class="ghost">Sibilance</button></div>
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
  const cf=$("#chFolder"); if(cf) cf.addEventListener("change",e=>{ tr.folderId=e.target.value||null; renderTimeline(); });
  const bf=$("#btnFreeze"); if(bf) bf.onclick=()=>freezeTrack(tr);
  const cv=$("#chVca"); if(cv) cv.addEventListener("change",e=>{ tr.vca=e.target.value||null;
    if(tr.nodes) tr.nodes.fader.gain.setTargetAtTime(db2lin(effVol(tr)),S.ctx.currentTime,0.03); });
  const cc=$("#chColor"); if(cc) cc.addEventListener("input",e=>{ tr.color=e.target.value; renderTimelineSoft(); });
  const cn=$("#chNote"); if(cn) cn.addEventListener("input",e=>{ tr.note=e.target.value; });
  R("#chVol",e=>{ tr.vol=parseFloat(e.target.value); e.target.nextElementSibling.textContent=fmtDb(tr.vol);
    if(tr.nodes)tr.nodes.fader.gain.setTargetAtTime(db2lin(effVol(tr)),S.ctx.currentTime,0.03); renderTimelineSoft(); });
  R("#chPan",e=>{ tr.pan=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=panLabel(tr.pan);
    if(tr.nodes)tr.nodes.pan.pan.setTargetAtTime(tr.pan,S.ctx.currentTime,0.03); renderTimelineSoft(); });
  R("#chSendR",e=>{ tr.sendRev=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=e.target.value+"%";
    if(tr.nodes)tr.nodes.sRev.gain.setTargetAtTime(tr.sendRev,S.ctx.currentTime,0.03); });
  R("#chSendD",e=>{ tr.sendDly=parseFloat(e.target.value)/100; e.target.nextElementSibling.textContent=e.target.value+"%";
    if(tr.nodes)tr.nodes.sDly.gain.setTargetAtTime(tr.sendDly,S.ctx.currentTime,0.03); });
  const smR=$("#chSendRMode"); if(smR) smR.onclick=()=>{ tr.sendMode=tr.sendMode||{rev:"post",dly:"post"};
    tr.sendMode.rev=tr.sendMode.rev==="pre"?"post":"pre"; if(S.ctx) buildTrackGraph(tr); if(S.playing) startSources(currentPos()); renderInspector(); };
  const smD=$("#chSendDMode"); if(smD) smD.onclick=()=>{ tr.sendMode=tr.sendMode||{rev:"post",dly:"post"};
    tr.sendMode.dly=tr.sendMode.dly==="pre"?"post":"pre"; if(S.ctx) buildTrackGraph(tr); if(S.playing) startSources(currentPos()); renderInspector(); };
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
    R("#clCI",e=>{ cl.curveIn=e.target.value; if(S.playing)startSources(currentPos()); });
    R("#clCO",e=>{ cl.curveOut=e.target.value; if(S.playing)startSources(currentPos()); });
    $$("[data-clippreset]").forEach(b=>b.addEventListener("click",()=>{ const p=CLIP_PRESETS.find(x=>x.id===b.dataset.clippreset); if(p) applyClipPreset(cl,p); }));
    const mb=$("#clMuteBtn"); if(mb) mb.onclick=()=>{ cl.muted=!cl.muted; renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos()); };
    const dp=$("#clDupBtn"); if(dp) dp.onclick=()=>duplicateClip(fc.tr,cl);
    const cb=$("#clCollapseBtn"); if(cb) cb.onclick=()=>{ cl.collapsed=true; renderInspector(); };
    const eb=$("#clExpandBtn"); if(eb) eb.onclick=()=>{ cl.collapsed=false; renderInspector(); };
    const sp=$("#clSplit2"); if(sp) sp.onclick=splitSelected;
    const nm=$("#clNorm"); if(nm) nm.onclick=()=>normalizeClip(cl);
    const ss=$("#clSplitSil"); if(ss) ss.onclick=()=>splitAtSilence(fc.tr,cl);
    const st=$("#clStrip"); if(st) st.onclick=()=>stripSilence(fc.tr,cl);
    const rv=$("#clRev"); if(rv) rv.onclick=()=>{ cl.reversed=!cl.reversed; cl._revCache=null; renderTimeline(); renderInspector(); if(S.playing)startSources(currentPos()); toast(cl.reversed?"Clip reversed":"Clip forward"); };
    const gl=$("#clGlue"); if(gl) gl.onclick=()=>glueWithNext(fc.tr,cl);
    const bn=$("#clBounce"); if(bn) bn.onclick=()=>bounceClip(tr, cl);
    const nz=$("#clNoise"); if(nz) nz.onclick=()=>denoiseClip(cl, P("repair.noise"));
    const tkEl=$("#clTakes");
    const renderTakes=()=>{ if(!tkEl) return; const t=ensureTakes(cl);
      tkEl.innerHTML=t.map((tb,i)=>`<button data-take="${i}" class="${i===(cl.takeIdx||0)?"":"ghost"}">Take ${i+1}</button>`).join(" ");
      tkEl.querySelectorAll("[data-take]").forEach(b=>b.onclick=()=>{ switchTake(cl, +b.dataset.take); renderTakes(); }); };
    if(tkEl) renderTakes();
    const ta=$("#clTakeAdd"); if(ta) ta.onclick=()=>{ const t=ensureTakes(cl); t.push(cl.buffer); renderTakes(); toast("Stored as Take "+t.length); };
    const glList=$("#clGlList");
    const renderGlList=()=>{ if(!glList) return; const line=cl.gainLine||[];
      glList.innerHTML=line.map((pt,i)=>`<span style="white-space:nowrap">${pt.t.toFixed(2)}s <input type="number" data-gli="${i}" value="${pt.db}" step="0.5" style="width:58px"> dB <button data-glx="${i}" class="ghost">✕</button></span>`).join(" ");
      glList.querySelectorAll("[data-gli]").forEach(inp=>inp.onchange=()=>{ const i=+inp.dataset.gli;
        cl.gainLine[i].db=clamp(parseFloat(inp.value)||0,-36,12); renderTimeline(); if(S.playing) startSources(currentPos()); });
      glList.querySelectorAll("[data-glx]").forEach(b=>b.onclick=()=>{ cl.gainLine.splice(+b.dataset.glx,1);
        renderGlList(); renderTimeline(); if(S.playing) startSources(currentPos()); }); };
    renderGlList();
    const ga=$("#clGlAdd"); if(ga) ga.onclick=()=>{ const t=clamp((S.playing?currentPos():S.pos)-cl.start, 0, cl.dur);
      if(!cl.gainLine) cl.gainLine=[];
      cl.gainLine.push({t:+t.toFixed(3), db:gainLineValueAt(cl.gainLine, t)});
      cl.gainLine.sort((a,b)=>a.t-b.t); renderGlList(); renderTimeline(); if(S.playing) startSources(currentPos()); };
    const gc=$("#clGlClear"); if(gc) gc.onclick=()=>{ cl.gainLine=[]; renderGlList(); renderTimeline(); if(S.playing) startSources(currentPos()); };
    const st9=$("#clStretch09"); if(st9) st9.onclick=()=>stretchClip(cl,0.9);
    const st11=$("#clStretch11"); if(st11) st11.onclick=()=>stretchClip(cl,1.1);
    const alg=$("#clAlign"); if(alg) alg.onclick=()=>{ const ref=S.tracks.find(t=>t.id!==tr.id&&t.clips.length);
      if(ref) alignClipToRef(cl, ref.clips[0]); else toast("Align: no other track with a clip to use as reference"); };
    const fdn=$("#clFormDown"); if(fdn) fdn.onclick=()=>formantClip(cl,-2);
    const fup=$("#clFormUp"); if(fup) fup.onclick=()=>formantClip(cl,2);
    const rb=$("#clBreath"); if(rb) rb.onclick=()=>repairClip(cl,"breath");
    const rl=$("#clLevel"); if(rl) rl.onclick=()=>repairClip(cl,"level");
    const rd=$("#clDeclick"); if(rd) rd.onclick=()=>repairClip(cl,"declick");
    const rm=$("#clMouth"); if(rm) rm.onclick=()=>repairClip(cl,"mouth");
    const rp2=$("#clPlosive"); if(rp2) rp2.onclick=()=>repairClip(cl,"plosive");
    const rsb=$("#clSib"); if(rsb) rsb.onclick=()=>{ S.showSib=!S.showSib; rsb.classList.toggle("on",!!S.showSib); renderTimeline(); };
    const dt=$("#clDetect"); if(dt) dt.onclick=()=>{ const r=runDetect(cl); const o=$("#clDetectOut");
      if(o) o.textContent=r?((r.key||"Key ?")+" · "+(r.bpm?r.bpm+" BPM (project tempo set)":"BPM ?")):"No audio"; };
    const sl=$("#clSlipL"); if(sl) sl.onclick=()=>slipClip(cl,-0.1);
    const sr2=$("#clSlipR"); if(sr2) sr2.onclick=()=>slipClip(cl,0.1);
    const dl=$("#clDel2"); if(dl) dl.onclick=deleteSelected;
    const xf=$("#clXfade"); if(xf) xf.onclick=()=>{ const f=findClip(S.selClip); if(f) crossfadeWithNext(f.tr,f.cl); };
  }
}
function renderTimelineSoft(){ /* Sync header fader readouts only (a full re-render would break focus while typing) */ syncMixer(); }

/* ----- Effects ----- */
const FXNAMES={eq:"Parametric EQ",comp:"Compressor",deesser:"De-Esser",ducker:"Ducker (Sidechain)",gate:"Noise Gate",rider:"Vocal Rider",doubler:"Doubler / ADT",mbcomp:"Multiband Comp",dyneq:"Dynamic EQ",custom:"Custom (Build Your Own)",conv:"Convolution Reverb",chorus:"Chorus",flanger:"Flanger",phaser:"Phaser",widener:"Stereo Widener",exciter:"Exciter",hum:"Hum Removal",clarity:"Clarity Boost",sat:"Saturation",pingpong:"Ping-Pong Delay",reverb:"Reverb",delay:"Delay"};
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
    else if(fx.type==="deesser") ed+=knobEditorHTML("De-Esser",[
      {k:"freq",label:"Frequency",min:2000,max:12000,step:50,val:fx.freq,unit:" Hz",fmt:v=>Math.round(v)},
      {k:"threshold",label:"Threshold",min:-60,max:0,step:0.5,val:fx.threshold,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"ratio",label:"Ratio",min:1,max:20,step:0.5,val:fx.ratio,unit:" : 1",fmt:v=>v.toFixed(1)}]);
    else if(fx.type==="ducker") ed+=knobEditorHTML("Ducker (Sidechain)",[
      {k:"threshold",label:"Threshold",min:-60,max:0,step:0.5,val:fx.threshold,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"ratio",label:"Ratio",min:1,max:20,step:0.5,val:fx.ratio,unit:" : 1",fmt:v=>v.toFixed(1)},
      {k:"depth",label:"Depth",min:0,max:24,step:0.5,val:fx.depth,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"attack",label:"Attack",min:0.001,max:0.1,step:0.001,val:fx.attack,unit:" ms",fmt:v=>Math.round(v*1000)},
      {k:"release",label:"Release",min:0.05,max:1,step:0.005,val:fx.release,unit:" ms",fmt:v=>Math.round(v*1000)}])+
      `<div class="fld" style="margin-top:10px"><label style="width:auto">Key Source</label><select id="duckKey">
        <option value="">— None —</option>
        ${S.tracks.filter(t=>t.id!==tr.id).map(t=>`<option value="${t.id}" ${fx.key===t.id?"selected":""}>${esc(t.name)}</option>`).join("")}
        </select><span class="small">This track ducks when the key track plays</span></div>`;
    else if(fx.type==="mbcomp") ed+=knobEditorHTML("Multiband Comp",[
      {k:"thrLo",label:"Low Thr",min:-48,max:0,step:0.5,val:fx.thrLo,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"thrMid",label:"Mid Thr",min:-48,max:0,step:0.5,val:fx.thrMid,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"thrHi",label:"High Thr",min:-48,max:0,step:0.5,val:fx.thrHi,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"ratio",label:"Ratio",min:1,max:10,step:0.1,val:fx.ratio,unit:":1",fmt:v=>v.toFixed(1)},
      {k:"makeup",label:"Makeup",min:0,max:12,step:0.1,val:fx.makeup,unit:" dB",fmt:v=>v.toFixed(1)}]);
    else if(fx.type==="dyneq") ed+=knobEditorHTML("Dynamic EQ",[
      {k:"freq",label:"Frequency",min:200,max:12000,step:10,val:fx.freq,unit:" Hz",fmt:v=>v>=1000?(v/1000).toFixed(2)+"k":v.toFixed(0)},
      {k:"q",label:"Q",min:0.4,max:6,step:0.05,val:fx.q,unit:"",fmt:v=>v.toFixed(2)},
      {k:"thr",label:"Threshold",min:-48,max:0,step:0.5,val:fx.thr,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"range",label:"Max Cut",min:0,max:15,step:0.5,val:fx.range,unit:" dB",fmt:v=>v.toFixed(1)}]);
    else if(fx.type==="custom"){ ed+=`<div class="small" style="margin:6px 0">Build a stage from up to 3 primitive slots in series (a delay slot mixes in parallel):</div>`+
      (fx.slots||[]).map((sl,i)=>{ const kind=sl.kind||"none"; let fields="";
        if(kind==="gain") fields=`<span class="small">dB</span> <input type="number" data-cs="${i}:db" value="${sl.db||0}" step="0.5" style="width:64px">`;
        else if(kind==="filter") fields=`<select data-cs-ft="${i}">${["lowpass","highpass","peaking","lowshelf","highshelf"].map(t=>`<option ${sl.ft===t?"selected":""}>${t}</option>`).join("")}</select> <input type="number" data-cs="${i}:freq" value="${sl.freq||1000}" step="10" style="width:78px"> <span class="small">Hz · Q</span> <input type="number" data-cs="${i}:q" value="${sl.q||0.7}" step="0.1" style="width:54px"> <span class="small">gain dB</span> <input type="number" data-cs="${i}:g" value="${sl.g||0}" step="0.5" style="width:56px">`;
        else if(kind==="drive") fields=`<span class="small">Drive</span> <input type="number" data-cs="${i}:drive" value="${sl.drive||12}" step="1" style="width:64px">`;
        else if(kind==="delay") fields=`<span class="small">ms</span> <input type="number" data-cs="${i}:ms" value="${sl.ms||120}" step="5" style="width:64px"> <span class="small">feedback</span> <input type="number" data-cs="${i}:fb" value="${sl.fb||0.3}" step="0.05" style="width:56px">`;
        return `<div class="fld"><label>Slot ${i+1}</label><select data-cs-kind="${i}">${["none","gain","filter","drive","delay"].map(t=>`<option ${kind===t?"selected":""}>${t}</option>`).join("")}</select> ${fields}</div>`; }).join(""); }
    else if(fx.type==="doubler") ed+=knobEditorHTML("Doubler / ADT",[
      {k:"spread",label:"Spread",min:5,max:30,step:0.5,val:fx.spread,unit:" ms",fmt:v=>v.toFixed(1)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="rider") ed+=knobEditorHTML("Vocal Rider",[
      {k:"target",label:"Target",min:-30,max:-6,step:0.5,val:fx.target,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"range",label:"Range",min:0,max:12,step:0.5,val:fx.range,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"speed",label:"Speed",min:0.05,max:1,step:0.05,val:fx.speed,unit:" s",fmt:v=>v.toFixed(2)}]);
    else if(fx.type==="gate") ed+=knobEditorHTML("Noise Gate",[
      {k:"threshold",label:"Threshold",min:-70,max:0,step:0.5,val:fx.threshold,unit:" dB",fmt:v=>v.toFixed(1)},
      {k:"range",label:"Range",min:0,max:80,step:1,val:fx.range,unit:" dB",fmt:v=>v.toFixed(0)},
      {k:"attack",label:"Attack",min:0.0005,max:0.05,step:0.0005,val:fx.attack,unit:" ms",fmt:v=>Math.round(v*1000)},
      {k:"release",label:"Release",min:0.03,max:0.6,step:0.005,val:fx.release,unit:" ms",fmt:v=>Math.round(v*1000)}]);
    else if(fx.type==="chorus") ed+=knobEditorHTML("Chorus",[
      {k:"rate",label:"Rate",min:0.05,max:5,step:0.05,val:fx.rate,unit:" Hz",fmt:v=>v.toFixed(2)},
      {k:"depth",label:"Depth",min:0,max:100,step:1,val:fx.depth,unit:"%",fmt:v=>v.toFixed(0)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="flanger") ed+=knobEditorHTML("Flanger",[
      {k:"rate",label:"Rate",min:0.02,max:3,step:0.01,val:fx.rate,unit:" Hz",fmt:v=>v.toFixed(2)},
      {k:"depth",label:"Depth",min:0,max:100,step:1,val:fx.depth,unit:"%",fmt:v=>v.toFixed(0)},
      {k:"feedback",label:"Feedback",min:0,max:0.9,step:0.01,val:fx.feedback,unit:"%",fmt:v=>Math.round(v*100)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="phaser") ed+=knobEditorHTML("Phaser",[
      {k:"rate",label:"Rate",min:0.02,max:3,step:0.01,val:fx.rate,unit:" Hz",fmt:v=>v.toFixed(2)},
      {k:"depth",label:"Depth",min:0,max:100,step:1,val:fx.depth,unit:"%",fmt:v=>v.toFixed(0)},
      {k:"freq",label:"Frequency",min:150,max:2500,step:10,val:fx.freq,unit:" Hz",fmt:v=>Math.round(v)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="widener") ed+=knobEditorHTML("Stereo Widener",[
      {k:"width",label:"Width",min:0,max:2,step:0.05,val:fx.width,unit:" x",fmt:v=>v.toFixed(2)}])+
      `<p class="small" style="margin-top:6px">0 = mono, 1 = unchanged, 2 = side only. Check the Corr meter in the bottom bar for mono compatibility (stay above 0).</p>`;
    else if(fx.type==="exciter") ed+=knobEditorHTML("Exciter",[
      {k:"freq",label:"Frequency",min:2000,max:8000,step:100,val:fx.freq,unit:" Hz",fmt:v=>Math.round(v)},
      {k:"amount",label:"Amount",min:0,max:1,step:0.01,val:fx.amount,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="hum") ed+=knobEditorHTML("Hum Removal",[
      {k:"freq",label:"Fundamental",min:50,max:60,step:10,val:fx.freq,unit:" Hz",fmt:v=>Math.round(v)}])+
      `<p class="small" style="margin-top:6px">Notches at the fundamental and its 2nd, 3rd and 4th harmonics (-30 dB, Q 30).</p>`;
    else if(fx.type==="clarity") ed+=knobEditorHTML("Clarity Boost",[
      {k:"freq",label:"Frequency",min:2500,max:6000,step:100,val:fx.freq,unit:" Hz",fmt:v=>Math.round(v)},
      {k:"amount",label:"Amount",min:0,max:8,step:0.5,val:fx.amount,unit:" dB",fmt:v=>"+"+v.toFixed(1)}]);
    else if(fx.type==="conv") ed+=knobEditorHTML("Convolution Reverb",[
      {k:"decay",label:"Decay",min:0.2,max:6,step:0.1,val:fx.decay,unit:" s",fmt:v=>v.toFixed(1)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="sat") ed+=knobEditorHTML("Saturation",[
      {k:"drive",label:"Drive",min:0,max:100,step:1,val:fx.drive,unit:"",fmt:v=>v.toFixed(0)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}]);
    else if(fx.type==="pingpong") ed+=knobEditorHTML("Ping-Pong Delay",[
      {k:"time",label:"Time",min:0.02,max:1.2,step:0.005,val:fx.time,unit:" ms",fmt:v=>Math.round(v*1000)},
      {k:"feedback",label:"Feedback",min:0,max:0.85,step:0.01,val:fx.feedback,unit:"%",fmt:v=>Math.round(v*100)},
      {k:"mix",label:"Mix",min:0,max:1,step:0.01,val:fx.mix,unit:"%",fmt:v=>Math.round(v*100)}])+
      `<div class="fld" style="margin-top:10px"><label style="width:auto">Tempo Sync</label><select id="ppSync">
        ${[["off","No Sync"],["4","Quarter Note"],["d8","Dotted 8th"],["8","8th Note"],["16","16th Note"],["t8","8th Triplet"]].map(([v,l])=>`<option value="${v}" ${fx.sync===v?"selected":""}>${l}</option>`).join("")}</select>
        <span class="small">Syncs the delay time to BPM ${S.bpm}</span></div>`;
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
    <div class="fld"><button id="btnStage" class="ghost">Check Gain Staging</button><span class="small">Per-stage output peaks for this track (first 3 s)</span></div><div id="gsOut"></div>
    <div class="fld" style="margin-top:6px"><select id="addFxType"><option value="eq">EQ</option><option value="comp">Compressor</option><option value="deesser">De-Esser</option><option value="ducker">Ducker (Sidechain)</option><option value="mbcomp">Multiband Comp</option><option value="dyneq">Dynamic EQ</option><option value="custom">Custom (Build Your Own)</option><option value="doubler">Doubler / ADT</option><option value="rider">Vocal Rider</option><option value="gate">Noise Gate</option><option value="chorus">Chorus</option><option value="flanger">Flanger</option><option value="phaser">Phaser</option><option value="widener">Stereo Widener</option><option value="exciter">Exciter</option><option value="hum">Hum Removal</option><option value="clarity">Clarity Boost</option><option value="conv">Convolution Reverb</option><option value="sat">Saturation</option><option value="pingpong">Ping-Pong Delay</option><option value="reverb">Reverb</option><option value="delay">Delay</option></select>
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
  const bst=$("#btnStage"); if(bst) bst.onclick=()=>{ const tt=selTrackObj()||S.tracks[0];
    if(tt) checkGainStaging(tt, $("#gsOut")); };
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
    const dk=$("#duckKey"); if(dk) dk.addEventListener("change",()=>{ fx.key=dk.value||null; applyFxLive(tr,S.selFx,true); renderInspector(); });
    document.querySelectorAll("[data-cs]").forEach(inp=>inp.addEventListener("change",()=>{ const pr=inp.dataset.cs.split(":");
      fx.slots[+pr[0]][pr[1]]=parseFloat(inp.value)||0; applyFxLive(tr,S.selFx,true); }));
    document.querySelectorAll("[data-cs-kind]").forEach(sel=>sel.addEventListener("change",()=>{ fx.slots[+sel.dataset.csKind].kind=sel.value;
      applyFxLive(tr,S.selFx,true); renderInspector(); }));
    document.querySelectorAll("[data-cs-ft]").forEach(sel=>sel.addEventListener("change",()=>{ fx.slots[+sel.dataset.csFt].ft=sel.value;
      applyFxLive(tr,S.selFx,true); }));
    const ds=$("#dlySync"); if(ds) ds.addEventListener("change",()=>{ fx.sync=ds.value;
      const b=60/S.bpm; const map={"4":b,"d8":b*0.75,"8":b/2,"16":b/4,"t8":b/3};
      if(map[fx.sync]){ fx.time=map[fx.sync]; applyFxLive(tr,S.selFx); renderInspector(); } });
    const ps=$("#ppSync"); if(ps) ps.addEventListener("change",()=>{ fx.sync=ps.value;
      const b=60/S.bpm; const map={"4":b,"d8":b*0.75,"8":b/2,"16":b/4,"t8":b/3};
      if(map[fx.sync]){ fx.time=map[fx.sync]; applyFxLive(tr,S.selFx); renderInspector(); } });
  }
}
function compFmt(k,v){ return {threshold:v.toFixed(1)+" dB",ratio:v.toFixed(1)+" : 1",attack:Math.round(v*1000)+" ms",release:Math.round(v*1000)+" ms",knee:v.toFixed(0)+" dB",makeup:"+"+v.toFixed(1)+" dB"}[k]; }
function fxFmt(type,k,v){ if(k==="freq") return Math.round(v)+" Hz";
  if(k==="threshold") return v.toFixed(1)+" dB"; if(k==="ratio") return v.toFixed(1)+" : 1";
  if(k==="depth") return type==="ducker"?v.toFixed(1)+" dB":v.toFixed(0)+"%";
  if(k==="rate") return v.toFixed(2)+" Hz";
  if(k==="decay") return v.toFixed(1)+" s";
  if(k==="width") return v.toFixed(2)+" x";
  if(k==="amount") return type==="clarity"?("+"+v.toFixed(1)+" dB"):Math.round(v*100)+"%"; if(k==="attack"||k==="release") return Math.round(v*1000)+" ms";
  if(k==="mix"||k==="feedback") return Math.round(v*100)+"%";
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
  <div class="cols"><div class="sect"><h3>Master Chain</h3><div id="mchainRows"></div><p class="small">Order and on/off for the master stages. Exports use the same chain. The limiter row follows the limiter switch and its ceiling (Params).</p></div>
  <div class="sect"><h3>Spectrum</h3><canvas id="specCanvas" width="520" height="120" style="width:100%;height:120px;background:var(--panel2);border-radius:8px"></canvas><p class="small">Master spectrum (live, while playing).</p></div>
  <div class="sect"><h3>Reference Track</h3>
  <div class="fld"><input type="file" id="refFile" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"><span class="small" id="refStat">${refTrk.buf?esc(refTrk.name)+" · "+refTrk.buf.duration.toFixed(1)+" s":"No reference loaded"}</span></div>
  <div class="fld"><button id="btnRefPlay" class="ghost">Play Reference</button><button id="btnRefStop" class="ghost">Stop</button><label class="small">Gain</label><input type="range" id="refGain" min="-24" max="12" step="0.5" value="${refTrk.gain}" style="width:110px"><span class="small" id="refGainVal">${fmtDb(refTrk.gain)}</span></div>
  <p class="small">A/B: the reference plays through the same master chain as your mix. It is not saved with the project.</p></div></div>
  <p class="small">Routing: each track → (clip edits → insert FX → automation → fader / pan) → bus or Master. Reverb / delay receive only the send amounts. Buses and returns are independent units too, each with ON/OFF, summaries and presets.</p>`;
}
function wireMix(){
  const mc=$("#mchainRows");
  if(mc){ const names={comp:"Master Comp", limiter:"Limiter"};
    mc.innerHTML=masterChain().map((st,i)=>`<div class="fld" style="align-items:center"><button data-mc-on="${i}" class="${st.on?"":"ghost"}">${st.on?"ON":"OFF"}</button><span style="flex:1">${i+1}. ${names[st.id]||st.id}</span><button data-mc-up="${i}" class="ghost" ${i===0?"disabled":""}>↑</button><button data-mc-dn="${i}" class="ghost" ${i===masterChain().length-1?"disabled":""}>↓</button></div>`).join("");
    mc.querySelectorAll("[data-mc-on]").forEach(b=>b.onclick=()=>{ const st=masterChain()[+b.dataset.mcOn];
      if(st.id==="comp"){ S.masterCompOn=S.masterCompOn===false?true:false; }
      else if(st.id==="limiter"){ S.limiter.on=!S.limiter.on; applyLimiterLive(); }
      wireMasterChain(); renderInspector(); });
    const swap=(i,j)=>{ const ch=masterChain(); const t=ch[i]; ch[i]=ch[j]; ch[j]=t; S.masterChain=ch; wireMasterChain(); renderInspector(); };
    mc.querySelectorAll("[data-mc-up]").forEach(b=>b.onclick=()=>swap(+b.dataset.mcUp, +b.dataset.mcUp-1));
    mc.querySelectorAll("[data-mc-dn]").forEach(b=>b.onclick=()=>swap(+b.dataset.mcDn, +b.dataset.mcDn+1));
  }
  const rf=$("#refFile"); if(rf) rf.addEventListener("change",()=>{ if(rf.files[0]) refLoad(rf.files[0]); rf.value=""; });
  const rp=$("#btnRefPlay"); if(rp) rp.onclick=()=>{ if(S.playing) pause(); refPlay(); };
  const rs=$("#btnRefStop"); if(rs) rs.onclick=()=>refStop();
  const rg=$("#refGain"); if(rg) rg.addEventListener("input",()=>{ refTrk.gain=parseFloat(rg.value);
    const gv=$("#refGainVal"); if(gv) gv.textContent=fmtDb(refTrk.gain);
    if(refTrk.gainNode&&S.ctx) refTrk.gainNode.gain.setTargetAtTime(db2lin(refTrk.gain),S.ctx.currentTime,0.03); });
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
  <div class="fld"><label>Platform Preset</label><select id="expPreset"><option value="">Custom</option><option value="youtube">YouTube</option><option value="spotify">Spotify</option><option value="apple">Apple Music</option><option value="niconico">niconico</option><option value="podcast">Podcast</option><option value="cd">CD</option></select><span class="small">Sets format, sample rate, bit depth and the loudness target at once</span></div>
  <div class="fld"><label>MP3 Artist</label><input type="text" id="expArtist" style="width:160px"><label>MP3 Title</label><input type="text" id="expTitle" style="width:160px"><span class="small">Written as ID3 tags on MP3 exports (title defaults to the file name)</span></div>
  <div class="fld"><label>SRC Quality</label><select id="expSrcQ"><option value="std">Standard (browser)</option><option value="sinc">High — sinc resample (slower)</option></select><span class="small">High renders at 96 kHz and downsamples with a windowed-sinc filter</span></div>
  <div class="fld"><label>Normalize</label><select id="expNorm"><option value="off">Off</option><option value="-14">YouTube / Spotify (-14 LUFS)</option><option value="-15">niconico (-15 LUFS)</option><option value="-16">Apple Music / Podcast (-16 LUFS)</option><option value="param">Custom (loudness.target parameter)</option></select></div>
  <div class="fld"><label>Tail Fade</label><select id="expTail"><option value="off">Off</option><option value="1">1 s</option><option value="2">2 s</option><option value="4">4 s</option><option value="param">Custom (export.tailfade parameter)</option></select></div>
  <div class="fld"><label>Range (s)</label><input type="number" id="expStart" placeholder="start" step="0.1" style="width:80px"><input type="number" id="expEnd" placeholder="end" step="0.1" style="width:80px"><button id="btnUseLoop" class="ghost">Use Loop</button></div>
  <div class="fld"><label>Finishing</label><label class="small"><input type="checkbox" id="expDc"> Remove DC offset</label><label class="small"><input type="checkbox" id="expTrim"> Trim silence</label><label class="small"><input type="checkbox" id="expDither" checked> Dither (WAV)</label></div>
  <div class="fld"><button id="btnConcat" class="ghost">Concatenate Track Clips</button><span class="small">Joins the selected track's clips end-to-end (no gaps) into one WAV through the full chain.</span></div>
  <div class="fld"><button id="btnStems" class="ghost">Export Stems (per track)</button><button id="btnExportAll" class="ghost">Export All Formats</button><span class="small">Stems render each track alone through the master chain.</span></div>
  <div class="fld"><button id="btnMeasure" class="ghost">Measure Loudness</button><span class="small" id="loudStat"></span></div>
  <div class="fld"><button id="btnDoExport" style="background:var(--teal);border-color:var(--teal);color:#06231d;font-weight:700;padding:6px 18px">Export</button>
  <button id="btnReport" class="ghost" disabled>Loudness Report (.txt)</button>
  <span class="small" id="expStat">Length ${fmtT(projectEnd())} / ${S.tracks.length} tracks (mute / solo states apply)</span></div>
  <p class="small">Renders the whole project offline. Insert FX, sends / returns, buses, automation and fades are all included.</p>
  </div></div>`;
}
function wireExp(){ const b=$("#btnDoExport"); if(b) b.onclick=doExport;
  const ep=$("#expPreset"); if(ep) ep.addEventListener("change",()=>{
    const P={youtube:{f:"wav",sr:"48000",b:"24",n:"-14"},spotify:{f:"wav",sr:"44100",b:"24",n:"-14"},
      apple:{f:"wav",sr:"48000",b:"24",n:"-16"},niconico:{f:"wav",sr:"48000",b:"24",n:"-15"},
      podcast:{f:"mp3",sr:"44100",b:"16",n:"-16"},cd:{f:"wav",sr:"44100",b:"16",n:"off"}}[ep.value];
    if(!P) return;
    $("#expFmt").value=P.f; $("#expSr").value=P.sr; $("#expBits").value=P.b; $("#expNorm").value=P.n;
    toast("Platform preset applied: "+ep.options[ep.selectedIndex].text);
  });
  const ul=$("#btnUseLoop"); if(ul) ul.onclick=()=>{ if(S.loop&&S.loop.on){ $("#expStart").value=S.loop.start; $("#expEnd").value=S.loop.end; } else toast("Loop is not set"); };
  const sb=$("#btnStems"); if(sb) sb.onclick=doStems;
  const cb=$("#btnConcat"); if(cb) cb.onclick=doConcat;
  const ea=$("#btnExportAll"); if(ea) ea.onclick=()=>{ window._expAll=true; doExport(); };
  const rb=$("#btnReport"); if(rb) rb.onclick=()=>{ if(!window._lastLoudReport) return;
    const blob=new Blob([window._lastLoudReport.text],{type:"text/plain"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=window._lastLoudReport.name; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000); };
  const mb=$("#btnMeasure"); if(mb) mb.onclick=async()=>{
    if(!S.tracks.length){ $("#expStat").textContent="No tracks to measure."; return; }
    mb.disabled=true; $("#expStat").textContent="Rendering for measurement…";
    try{
      const buf=await renderMix(parseInt($("#expSr").value), projectEnd());
      reportLoudness(buf);
      $("#expStat").textContent="Measured (no file written).";
    }catch(err){ $("#expStat").textContent="Measure failed: "+err.message; }
    mb.disabled=false;
  };
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
        <li>Crossfade: select the left of two touching clips and use "Crossfade with Next" in the clip editor (equal-power curves). Its default length is the xfade.sec parameter.</li>
        <li>Fade curves: each clip fade can be Linear, Equal Power, or S-Curve (clip editor, or "fadecurve in|out lin|eqp|scurve"). Equal power suits joins between different sounds; S-curve is the gentle default for a single clip's edges.</li>
        <li>Noise Gate: an insert stage that drops the level by its Range when the signal falls below the Threshold — for room noise between phrases. Gentle Expander (12 dB range) is the subtle option; release around 100–200 ms avoids chattering.</li>
        <li>Metronome: the ♩ button (or "metro") clicks along with playback in 4/4 with an accented beat 1, and play/record starts after metro.countin bars of count-in clicks. The click is live only — it never appears in exports.</li>
        <li>True peak: the loudness readout also shows the true peak (dBTP, 4× oversampled per BS.1770), which catches inter-sample peaks that a plain sample-peak reading misses — keep it under your limiter ceiling.</li>
        <li>Polarity invert: the Ø button on a track head (or "phase") flips the track's polarity — for doubled or layered takes that thin out when combined. Applies live and in exports.</li>
        <li>Clip normalize: the Normalize button in the clip editor (or "norm") sets the clip gain so its peak reaches the norm.target parameter (−1 dB by default).</li>
        <li>Tail fade: the export page can fade the song's tail out over the last 1 / 2 / 4 seconds (or the export.tailfade parameter) — a cosine fade applied to the final file after normalization.</li>
        <li>Loudness report: after an export, "Loudness Report (.txt)" downloads the numbers behind the file — integrated loudness, true peak of the final file, normalization applied, limiter state.</li>
        <li>Saturation: a tanh soft-clip stage (Drive / Mix) for tape- or tube-style density. Ping-Pong Delay: cross-coupled tempo-synced delays that bounce between left and right.</li>
        <li>Pre/Post sends: each track's reverb and delay sends can tap before the fader (Pre) or after it (Post) — the button next to each send slider, or "sendmode rev|dly pre|post". Pre keeps the send alive when the fader drops.</li>
        <li>Markers: the flag button (or "mark [name]") drops a named marker at the playhead; markers show on the ruler and are saved with the project. "mark list", "mark go n", "mark del n" manage them; clicking the ruler near a marker seeks to it.</li>
        <li>Silence tools: "Split at Silence" cuts a clip at the middle of each silent gap, "Strip Silence" deletes the silent parts outright (threshold silence.db, minimum length silence.min). "Reverse" flips a clip's segment in place; "Glue with Next" bounces two clips into one (clip gain, fades and pitch are baked in).</li>
        <li>Slip & nudge: Slip (buttons or "slip &lt;sec&gt;") slides the audio inside the clip frame; "," and "." nudge the selected clip by one beat ("nudge &lt;sec&gt;" for exact amounts). Audio files can also be dropped onto the window to import. Press "?" for the shortcut list.</li>
        <li>More stages: Chorus, Flanger, Phaser (modulation), Stereo Widener (mid/side width — watch the Corr meter), Exciter (harmonic sparkle above a chosen frequency), Hum Removal (notches at 50/60 Hz and harmonics), Clarity Boost (presence lift with a gentle de-mud cut).</li>
        <li>Correlation & clipping: the bottom bar shows the phase correlation of the master (+1 mono-safe, negative = phasey). Peaks that hit full scale while playing are logged; "clips" lists them, "clips go n" jumps to one, "clips clear" resets.</li>
        <li>VCA groups: "vca new &lt;name&gt;" creates a group fader; assign tracks in the Channel tab and trim the whole group with "vca gain &lt;name&gt; &lt;dB&gt;" (the track faders keep their own values). The MN button on a track header downmixes that track to mono. The bottom bar shows output latency and sample rate once audio starts.</li>
        <li>Templates & recent: "template save &lt;name&gt;" stores the track/FX structure without audio; "template load &lt;name&gt;" rebuilds it empty, ready for new recordings. The Snapshots panel also lists recent activity. Tracks take a color and a text note in the Channel tab; the Wave slider (or "wzoom") scales waveform height.</li>
        <li>Export finishing: set a Range in seconds (or Use Loop) to export part of the project; Remove DC offset subtracts each channel's mean; Trim silence cuts head/tail silence at the silence.db threshold; Dither adds TPDF dither when writing WAV. Export Stems renders one file per track (through the master chain); Export All Formats writes 16-bit WAV, 24-bit WAV and MP3 from one render. A browser notification and a check in the title announce completion.</li>
        <li>Settings: the Parameters panel can export/import all settings (parameters, user presets, templates) as one JSON file.</li>
        <li>Performance &amp; takes: the Pitch tab's Vibrato (depth/rate, fades in after each note starts) and Portamento (glide time into each note) shape the correction; Room Noise (clip Repair row) spectrally gates steady background noise. With Take mode (transport), recordings land on the selected track - over an existing clip they become new takes of it; switch takes in the clip editor, split the clip, and pick a different take per half to comp. Concatenate Track Clips (Export tab) joins a track's clips end-to-end into one WAV.</li>
        <li>Workflow &amp; export extras: single-key shortcuts can be remapped in the ? panel (stored on this device). The overview minimap above the timeline shows every clip and the visible window; click or drag it to scroll. On touch screens, pinch the lanes to zoom and long-press a clip to select it. Export extras: Platform Presets set format/rate/loudness together, MP3 exports carry ID3 title/artist tags, SRC Quality "High" renders at 96 kHz and downsamples with a windowed-sinc filter, and the Params panel exports/imports the whole project as a .zip (project.json + WAV audio). The Custom stage type builds an effect from up to three primitive slots (gain / filter / drive / delay).</li>
        <li>Master chain: the Mix tab's Master Chain section reorders the master compressor and limiter (or switches either off); live playback and exports share the same chain. Freeze (Channel tab) bakes a track's FX into a single clip (unfreeze restores; the fader, pan and sends are not baked). Bounce in Place (clip editor) bakes the track FX into the selected clip permanently. Folder tracks group other tracks in the Channel tab and collapse from their header. A clip Gain Line (clip editor) draws a per-clip volume envelope: add points at the playhead and edit their dB values.</li>
        <li>Analysis & reference: the Mix tab shows a live master Spectrum and a Reference Track player (plays through the same master chain for A/B comparison; not saved with the project). "Detect Key/BPM" on a clip estimates its key (Krumhansl profiles) and tempo (onset autocorrelation) and sets the project tempo. A Convolution Reverb stage (generated impulse, Decay/Mix) is also available.</li>
        <li>Recording & playback helpers: Punch-in (transport button or "punch") trims takes to the loop range; Tap sets the tempo from clicks; the Speed selector (or "speed") auditions at 0.5-1.5x without affecting exports. The History panel (toolbar button or "history") lists undo states by time and jumps to any of them — the jump itself can be redone.</li>
        <li>Timing & formants (clip editor, Timing row): Stretch changes a clip's length without changing pitch (baked into a detached copy; the pitch layer is cleared, Undo restores). "Align to Top Track" retimes this clip's phrases to the first clip of the topmost other track by matching onsets. Formant -/+ shifts the voice's formants while keeping the pitch. In the Pitch tab: "Preserve formants" keeps the voice character during pitch correction, the Scale selectors make Snapping land on scale tones only, Harmony buttons create a harmony track from the detected notes, and notes can now be dragged sideways as well as vertically (sideways moves the note's time window).</li>
        <li>Clip repair (clip editor, Repair row, or "repair ..."): Breath softens detected breaths, Level Syllables evens syllable levels toward the median, De-Click / Mouth Clicks repair short spikes with a median filter, De-Plosive tames low-frequency thumps. Repairs rewrite only that clip's audio copy — the original source buffer is kept and Undo covers every repair. The Sibilance button tints sibilant regions of the waveform orange. The Vocal Rider effect level-rides a track toward a target level, and "Check Gain Staging" (Effects tab) shows each stage's output peak with a health colour.</li>
        <li>Power tools: ⚙ Params edits the app's tunable values; on a keyboard, press ":" for the command bar (try "help"; targets accept /regex/).</li>
        <li>Home-position keys: Space play/pause, S split, J/K select track, H/L seek (Shift = 5 s), M mute, O solo, U undo (Shift+U redo), D duplicate, 1–4 switch tabs, +/− zoom, Enter play from the top.</li>
        <li>Command bar extras: tab, zoom, seek (seconds, 1:30, or "bar n"), bpm, master, limiter on/off, loop (seconds or "bars a b"), addtrack, dup, rename, export, pitch.</li>
        <li>Snapshots: the Snapshots button (or "snap save &lt;name&gt;") stores the whole project under a name in this browser; load or delete from the same panel. Unlike autosave, snapshots are kept until you delete them.</li>
        <li>Recording: press ● (or the R key, or "rec") to record from the microphone along with playback; stopping drops the take onto a new track at the playhead. Use headphones. rec.offsetMs compensates interface latency; mic processing stays off unless rec.processing is set to 1.</li>
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
/* ----- Loudness (ITU-R BS.1770 integrated, K-weighted, gated) ----- */
function kWeight(fs){
  const f1=1681.974450955533, G=3.999843853973347, Q1=0.7071752369554196;
  const K1=Math.tan(Math.PI*f1/fs), Vh=Math.pow(10,G/20), Vb=Math.pow(Vh,0.4996667741545416);
  const a01=1+K1/Q1+K1*K1;
  const s1={b:[(Vh+Vb*K1/Q1+K1*K1)/a01, 2*(K1*K1-Vh)/a01, (Vh-Vb*K1/Q1+K1*K1)/a01],
            a:[1, 2*(K1*K1-1)/a01, (1-K1/Q1+K1*K1)/a01]};
  const f2=38.13547087602444, Q2=0.5003270373238773;
  const K2=Math.tan(Math.PI*f2/fs), a02=1+K2/Q2+K2*K2;
  const s2={b:[1/a02, -2/a02, 1/a02], a:[1, 2*(K2*K2-1)/a02, (1-K2/Q2+K2*K2)/a02]};
  return [s1,s2];
}
function applyBiquad(d,f){
  const out=new Float32Array(d.length);
  let x1=0,x2=0,y1=0,y2=0;
  const b0=f.b[0],b1=f.b[1],b2=f.b[2],a1=f.a[1],a2=f.a[2];
  for(let i=0;i<d.length;i++){ const x=d[i], y=b0*x+b1*x1+b2*x2-a1*y1-a2*y2; out[i]=y; x2=x1; x1=x; y2=y1; y1=y; }
  return out;
}
function measureLoudness(buf){
  const fs=buf.sampleRate, nCh=Math.min(2,buf.numberOfChannels);
  const [s1,s2]=kWeight(fs);
  const cums=[]; let peak=0;
  for(let c=0;c<nCh;c++){
    let d=Float32Array.from(buf.getChannelData(c));
    for(let i=0;i<d.length;i++){ const a=Math.abs(d[i]); if(a>peak) peak=a; }
    d=applyBiquad(applyBiquad(d,s1),s2);
    const cum=new Float64Array(d.length+1);
    for(let i=0;i<d.length;i++) cum[i+1]=cum[i]+d[i]*d[i];
    cums.push(cum);
  }
  const len=buf.length, blockLen=Math.round(fs*0.4), hop=Math.round(fs*0.1);
  if(len<blockLen) return {integrated:-Infinity, peak};
  const zs=[];
  for(let st=0; st+blockLen<=len; st+=hop){
    let z=0;
    for(let c=0;c<nCh;c++) z+=(cums[c][st+blockLen]-cums[c][st])/blockLen;
    zs.push(z);
  }
  const toLoud=z=>-0.691+10*Math.log10(z);
  const abs=zs.filter(z=>toLoud(z)>-70);
  if(!abs.length) return {integrated:-Infinity, peak};
  const meanAbs=abs.reduce((a,b)=>a+b,0)/abs.length;
  const rel=abs.filter(z=>z>meanAbs*0.1);
  const meanRel=rel.reduce((a,b)=>a+b,0)/rel.length;
  return {integrated:toLoud(meanRel), peak};
}
/* True peak: the maximum of the 4x-oversampled signal (BS.1770's
   idea), which catches inter-sample peaks a sample-peak meter
   misses. The oversampling is our own windowed-sinc interpolation
   (Blackman, L=16, per-phase normalized) — the browser's resampler
   was measured and rejected: it both missed a real +3 dB
   inter-sample peak (12 kHz at 45 degrees) and invented phantom
   overshoot on other phases. Verified exact on canonical signals.
   Intervals whose rigorous kernel bound cannot beat the running
   best are skipped, so typical songs measure fast. */
function truePeakLin(d, globalPeak){
  const L=16;
  const sinc=function(x){ return x===0?1:Math.sin(Math.PI*x)/(Math.PI*x); };
  const W=function(x){ if(Math.abs(x)>=L) return 0; const u=(x+L)/(2*L);
    return sinc(x)*(0.42-0.5*Math.cos(2*Math.PI*u)+0.08*Math.cos(4*Math.PI*u)); };
  const phis=[0.25,0.5,0.75], kernels=[];
  for(const phi of phis){
    const w=new Float64Array(2*L+1); let norm=0, near=0, tail=0;
    for(let k=-L+1;k<=L;k++){ const v=W(phi-k); w[k+L]=v; norm+=v; }
    for(let k=-L+1;k<=L;k++){ w[k+L]/=norm; const a=Math.abs(w[k+L]); if(Math.abs(k)<=4) near+=a; else tail+=a; }
    kernels.push({w:w, near:near, tail:tail});
  }
  let best=globalPeak; const len=d.length;
  for(let n=L;n<len-L;n++){
    let win=0; for(let j=n-4;j<=n+5;j++){ const a=d[j]<0?-d[j]:d[j]; if(a>win) win=a; }
    let skip=true;
    for(let q=0;q<3;q++){ const K=kernels[q]; if(K.near*win+K.tail*globalPeak>best){ skip=false; break; } }
    if(skip) continue;
    for(let q=0;q<3;q++){ const w=kernels[q].w; let y=0;
      for(let k=-L+1;k<=L;k++) y+=d[n+k]*w[k+L];
      const a=y<0?-y:y; if(a>best) best=a; }
  }
  return best;
}
async function truePeakDb(buf){
  await new Promise(function(r){ setTimeout(r,0); });
  try{
    let best=0;
    for(let ch=0; ch<buf.numberOfChannels; ch++){ const d=buf.getChannelData(ch);
      let sp=0; for(let i=0;i<d.length;i++){ const a=Math.abs(d[i]); if(a>sp) sp=a; }
      const tp=truePeakLin(d, sp); if(tp>best) best=tp; }
    return best>0?20*Math.log10(best):-Infinity;
  }catch(e){ return null; }
}
function reportLoudness(buf){
  const loud=measureLoudness(buf);
  const el=$("#loudStat");
  const base="Integrated loudness: "+(isFinite(loud.integrated)?loud.integrated.toFixed(1)+" LUFS":"— (silence)")+
    " · Peak: "+(loud.peak>0?(20*Math.log10(loud.peak)).toFixed(1)+" dB":"—");
  if(el){ el.textContent=base;
    const tok=(el._tpTok=(el._tpTok||0)+1);
    truePeakDb(buf).then(function(tp){
      if(tp!==null&&isFinite(tp)&&el._tpTok===tok) el.textContent=base+" · True Peak: "+tp.toFixed(1)+" dBTP";
    });
  }
  return loud;
}

async function renderMix(sr,dur){
  const oc=new OfflineAudioContext(2,Math.ceil(sr*dur),sr);
  const master=oc.createGain(); master.gain.value=db2lin(masterVolValue());
  const mcomp=oc.createDynamicsCompressor(); mcomp.threshold.value=-3;mcomp.ratio.value=12;mcomp.attack.value=0.002;mcomp.release.value=0.18;
  const mlim=makeLimiterNodes(oc); configureLimiter(mlim,S.limiter);
  if(S._freezeRender){ master.gain.value=1; master.connect(oc.destination); }
  else { let prevM=master;
    masterChain().forEach(st=>{ if(!st.on) return;
      if(st.id==="comp"){ prevM.connect(mcomp); prevM=mcomp; }
      else if(st.id==="limiter"&&S.limiter&&S.limiter.on){ prevM.connect(mlim.input); prevM=mlim.output; } });
    prevM.connect(oc.destination); }
  const R=buildReturns(oc,master,false);
  if(S.returns){ R.conv.buffer=makeIR(oc,S.returns.decay); R.dly.delayTime.value=S.returns.dlyTime; R.fb.gain.value=S.returns.dlyFb; }
  if(S.revMuted) R.revOut.gain.value=0; if(S.dlyMuted) R.dlyOut.gain.value=0;
  const busNodes={};
  S.buses.forEach(b=>{ const input=oc.createGain(),g=oc.createGain(),p=oc.createStereoPanner();
    input.connect(g);g.connect(p);p.connect(master); g.gain.value=b.muted?0:db2lin(b.vol); p.pan.value=b.pan||0; busNodes[b.id]=input; });
  const anySolo=S.tracks.some(t=>t.solo);
  const keyTaps={}, pendingKeys=[];
  S.tracks.forEach(tr=>{ keyTaps[tr.id]=oc.createGain(); });
  S.tracks.forEach(tr=>{
    const input=oc.createGain(); input.gain.value=tr.phaseInv?-1:1;
    let head=input;
    if(tr.mono){ const mg=oc.createGain(); mg.channelCount=1; mg.channelCountMode="explicit"; input.connect(mg); head=mg; }
    head.connect(keyTaps[tr.id]); let prev=head;
    (tr.frozen?[]:tr.fx).forEach(fx=>{ const n=fxNodes(oc,fx); prev.connect(n.input); prev=n.output;
      if(n.parts&&n.parts.keyIn) pendingKeys.push({keyIn:n.parts.keyIn, key:fx.key}); });
    const autoG=oc.createGain(), autoP=oc.createStereoPanner(), fader=oc.createGain(), pan=oc.createStereoPanner();
    prev.connect(autoG); autoG.connect(autoP); autoP.connect(fader); fader.connect(pan);
    pan.connect(tr.bus&&busNodes[tr.bus]?busNodes[tr.bus]:master);
    const sR=oc.createGain(), sD=oc.createGain(); ((tr.sendMode&&tr.sendMode.rev==="pre")?autoP:fader).connect(sR); sR.connect(R.revIn); ((tr.sendMode&&tr.sendMode.dly==="pre")?autoP:fader).connect(sD); sD.connect(R.dlyIn);
    fader.gain.value=db2lin(effVol(tr)); pan.pan.value=tr.pan; sR.gain.value=tr.sendRev; sD.gain.value=tr.sendDly;
    if(tr.auto.volume.length){ autoG.gain.setValueAtTime(db2lin(autoVal(tr.auto.volume,0,tr.vol)),0);
      tr.auto.volume.forEach(p=>autoG.gain.linearRampToValueAtTime(db2lin(p.v),p.t)); }
    if(tr.auto.pan.length){ autoP.pan.setValueAtTime(autoVal(tr.auto.pan,0,0),0);
      tr.auto.pan.forEach(p=>autoP.pan.linearRampToValueAtTime(p.v,p.t)); }
    if(tr.mute||(anySolo&&!tr.solo)) return;
    tr.clips.forEach(cl=>{ if(cl.muted) return; const src=oc.createBufferSource(); src.buffer=clipBuffer(cl);
      const g=oc.createGain(); const gl=oc.createGain(); src.connect(g); g.connect(gl); gl.connect(input);
      scheduleGainLineAbs(gl.gain, cl.gainLine, cl.start);
      const cg=db2lin(cl.gain||0), t0=cl.start;
      if(cl.fadeIn>0&&(cl.curveIn==="eqp"||cl.curveIn==="scurve")) applyFade(g.gain,"in",cg,t0,cl.fadeIn,0,cl.curveIn);
      else { g.gain.setValueAtTime(cl.fadeIn>0?0.0001:cg,t0); if(cl.fadeIn>0) g.gain.linearRampToValueAtTime(cg,t0+cl.fadeIn); }
      if(cl.fadeOut>0){
        if(cl.curveOut==="eqp"||cl.curveOut==="scurve") applyFade(g.gain,"out",cg,t0+cl.dur-cl.fadeOut,cl.fadeOut,0,cl.curveOut);
        else { g.gain.setValueAtTime(cg,t0+cl.dur-cl.fadeOut); g.gain.linearRampToValueAtTime(0.0001,t0+cl.dur); }
      }
      src.start(t0,cl.offset,cl.dur); });
  });
  pendingKeys.forEach(pk=>{ const kt=keyTaps[pk.key]; if(kt&&pk.key) kt.connect(pk.keyIn); });
  const buf=await oc.startRendering();
  return buf;
}
/* ---------- export finishing helpers ---------- */
function sliceBuffer(buf, a, b){
  const sr=buf.sampleRate, from=Math.max(0,Math.floor(a*sr)), to=Math.min(buf.length,Math.ceil(b*sr));
  const out=new AudioBuffer({length:Math.max(1,to-from), sampleRate:sr, numberOfChannels:buf.numberOfChannels});
  for(let c=0;c<buf.numberOfChannels;c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(from,Math.max(from+1,to)));
  return out;
}
function removeDc(buf){
  for(let c=0;c<buf.numberOfChannels;c++){ const d=buf.getChannelData(c);
    let m=0; for(let i=0;i<d.length;i++) m+=d[i]; m/=Math.max(1,d.length);
    for(let i=0;i<d.length;i++) d[i]-=m; }
}
function trimSilenceBuf(buf, thrDb){
  const thr=Math.pow(10,thrDb/20);
  const chans=[]; for(let c=0;c<buf.numberOfChannels;c++) chans.push(buf.getChannelData(c));
  let first=-1, last=-1;
  for(let i=0;i<buf.length;i++){ let hot=false;
    for(let c=0;c<chans.length;c++){ if(Math.abs(chans[c][i])>thr){ hot=true; break; } }
    if(hot){ if(first<0) first=i; last=i; } }
  if(first<0||(first===0&&last===buf.length-1)) return buf;
  return sliceBuffer(buf, first/buf.sampleRate, (last+1)/buf.sampleRate);
}
function notifyExportDone(what){
  try{ if("Notification" in window&&Notification.permission==="granted")
    new Notification("VocalMIX export complete",{body:what}); }catch(e){}
  const old=document.title; document.title="\u2713 "+old;
  setTimeout(function(){ document.title=old; }, 4000);
}
async function doStems(){
  ensureCtx();
  if(!S.tracks.length){ $("#expStat").textContent="No tracks to export."; return; }
  const sr=parseInt($("#expSr").value), bits=parseInt($("#expBits").value);
  const base=($("#expName").value||"mix").replace(/[^\w\-]/g,"_");
  const dur=projectEnd(), stat=$("#expStat");
  const saved=S.tracks.map(t=>({m:t.mute, s:t.solo}));
  try{
    for(let i=0;i<S.tracks.length;i++){
      const tr=S.tracks[i];
      S.tracks.forEach((t,j)=>{ t.mute=j!==i; t.solo=false; });
      stat.textContent="Rendering stem "+(i+1)+"/"+S.tracks.length+": "+tr.name;
      const buf=await renderMix(sr,dur);
      const blob=encodeWav(buf,bits,($("#expDither")||{}).checked);
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download=base+"_stem_"+(i+1)+"_"+tr.name.replace(/[^\w\-]/g,"_")+".wav"; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      await new Promise(r=>setTimeout(r,350));
    }
    stat.textContent="Stems complete: "+S.tracks.length+" files";
    notifyExportDone(S.tracks.length+" stems");
  }catch(err){ stat.textContent="Stems failed: "+err.message; }
  finally{ S.tracks.forEach((t,j)=>{ t.mute=saved[j].m; t.solo=saved[j].s; }); }
}
/* ---------- project zip (#89): STORE-only zip, CRC32 ---------- */
const CRC_TABLE=(()=>{ const t=new Int32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?(0xEDB88320^(c>>>1)):c>>>1; t[n]=c; } return t; })();
function crc32(u8){ let c=-1; for(let i=0;i<u8.length;i++) c=CRC_TABLE[(c^u8[i])&0xff]^(c>>>8); return (c^-1)>>>0; }
function zipStoreBlob(files){
  const enc=new TextEncoder();
  const parts=[]; let offset=0; const cd=[];
  const push=a=>{ parts.push(a); offset+=a.length; };
  files.forEach(f=>{
    const name=enc.encode(f.name), data=f.data, crc=crc32(data);
    const lh=new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(8,0,true);
    lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true);
    lh.setUint16(26,name.length,true);
    const localOff=offset;
    push(new Uint8Array(lh.buffer)); push(name); push(data);
    const ch=new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true);
    ch.setUint32(16,crc,true); ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true);
    ch.setUint16(28,name.length,true); ch.setUint32(42,localOff,true);
    cd.push(new Uint8Array(ch.buffer)); cd.push(name);
  });
  const cdStart=offset; cd.forEach(a=>push(a));
  const end=new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true);
  end.setUint16(8,files.length,true); end.setUint16(10,files.length,true);
  end.setUint32(12,offset-cdStart,true); end.setUint32(16,cdStart,true);
  push(new Uint8Array(end.buffer));
  return new Blob(parts,{type:"application/zip"});
}
async function unzipStore(arrayBuffer){
  const u8=new Uint8Array(arrayBuffer), dv=new DataView(arrayBuffer);
  const dec=new TextDecoder(); const out=new Map();
  let i=0;
  while(i+30<=u8.length&&dv.getUint32(i,true)===0x04034b50){
    const method=dv.getUint16(i+8,true);
    const csize=dv.getUint32(i+18,true);
    const nlen=dv.getUint16(i+26,true), xlen=dv.getUint16(i+28,true);
    const name=dec.decode(u8.subarray(i+30,i+30+nlen));
    const start=i+30+nlen+xlen;
    const raw=u8.subarray(start,start+csize);
    if(method===0) out.set(name, raw.slice());
    else if(method===8&&typeof DecompressionStream!=="undefined"){
      const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    i=start+csize;
  }
  return out;
}
window.VM_zipStore=zipStoreBlob; window.VM_unzipStore=unzipStore;
async function zipProject(){
  if(!window.VM_serializeProject){ toast("Project export unavailable on this page"); return; }
  const proj=VM_serializeProject();
  ensureCtx();
  const files=[]; const refs=[];
  for(let i=0;i<(proj.bufs||[]).length;i++){
    /* serializeProject stores buffers as {sr, ch:[Float32Array]} -
       rebuild an AudioBuffer to encode the WAV. */
    const ent=proj.bufs[i];
    const ab=S.ctx.createBuffer(ent.ch.length, ent.ch[0].length, ent.sr);
    ent.ch.forEach((cd,c)=>ab.copyToChannel(cd, c));
    const data=new Uint8Array(await encodeWav(ab,16,false).arrayBuffer());
    const nm="audio/buf"+i+".wav"; files.push({name:nm, data}); refs.push(nm);
  }
  const json=JSON.stringify(Object.assign({}, proj, {bufs:refs}));
  files.unshift({name:"project.json", data:new TextEncoder().encode(json)});
  const blob=zipStoreBlob(files);
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="vocalmix-project.zip"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast("Project exported (.zip, "+files.length+" files)");
  logRecent("Project zip exported");
}
async function unzipProject(file){
  try{
    const map=await unzipStore(await file.arrayBuffer());
    const pj=map.get("project.json"); if(!pj) throw new Error("project.json missing");
    const proj=JSON.parse(new TextDecoder().decode(pj));
    ensureCtx();
    const bufs=[];
    for(const ref of (proj.bufs||[])){
      const data=map.get(ref); if(!data) throw new Error("missing "+ref);
      const ab=await S.ctx.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset+data.byteLength));
      /* restore expects the serialize format {sr, ch:[Float32Array]} */
      const ch=[]; for(let c=0;c<ab.numberOfChannels;c++) ch.push(ab.getChannelData(c).slice());
      bufs.push({sr:ab.sampleRate, ch});
    }
    proj.bufs=bufs;
    if(window.VM_restoreProject) VM_restoreProject(proj);
    toast("Project imported from zip");
  }catch(e){ toast("Project import failed: "+e.message); }
}
window.VM_zipProject=zipProject; window.VM_unzipProject=unzipProject;

async function doConcat(){
  const tr=selTrackObj()||S.tracks[0];
  if(!tr||!tr.clips.length){ toast("No clips on the selected track"); return; }
  ensureCtx();
  const saved=S.tracks.map(t=>({m:t.mute, clips:t.clips}));
  const sorted=[...tr.clips].filter(c=>!c.muted).sort((a,b)=>a.start-b.start);
  let pos=0;
  const seq=sorted.map(cl=>{ const c=Object.assign({}, cl, {start:pos}); pos+=cl.dur; return c; });
  S.tracks.forEach(t=>{ t.mute=t!==tr; if(t===tr) t.clips=seq; });
  try{
    const buf=await renderMix(48000, Math.max(0.1, pos));
    const blob=encodeWav(buf, 16, ($("#expDither")||{}).checked);
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=tr.name.replace(/[^\w\-]/g,"_")+"_concat.wav"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    toast("Concatenated "+seq.length+" clips ("+pos.toFixed(1)+" s)");
    logRecent("Concat export: "+tr.name);
  }catch(e){ toast("Concat failed: "+e.message); }
  finally{ S.tracks.forEach((t,i)=>{ t.mute=saved[i].m; t.clips=saved[i].clips; }); renderTimeline(); }
}

function exportSettings(){
  const data={app:"VocalMIX", kind:"settings", v:1, params:PARAMS,
    userFxPresets:S.userFxPresets||{}, userMixPresets:S.userMixPresets||[], templates:templatesAll()};
  const blob=new Blob([JSON.stringify(data,null,1)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="vocalmix-settings.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}
function importSettings(file){
  const rd=new FileReader();
  rd.onload=function(){ try{ const d=JSON.parse(rd.result);
      if(!d||d.kind!=="settings") throw new Error("not a VocalMIX settings file");
      if(d.params){ PARAMS=d.params; try{ localStorage.setItem("vocalmix-params",JSON.stringify(PARAMS)); }catch(e){} }
      if(d.userFxPresets) S.userFxPresets=d.userFxPresets;
      if(d.userMixPresets) S.userMixPresets=d.userMixPresets;
      if(d.templates){ try{ localStorage.setItem("vocalmix-templates",JSON.stringify(d.templates)); }catch(e){} }
      if(S.limiter) S.limiter.ceiling=P("limiter.ceiling");
      toast("Settings imported");
    }catch(e){ toast("Settings import failed"); } };
  rd.readAsText(file);
}

/* Windowed-sinc resampler (#94): renders are done at 96 kHz and
   downsampled with a Blackman-windowed sinc (12 output periods
   each side), instead of the browser's internal conversion. */
function resampleSinc(buf, targetSr){
  const sr=buf.sampleRate; if(sr===targetSr) return buf;
  const ratio=sr/targetSr;
  const outLen=Math.max(1, Math.round(buf.length/ratio));
  const out=new AudioBuffer({length:outLen, sampleRate:targetSr, numberOfChannels:buf.numberOfChannels});
  const L=12, W=L*ratio;
  for(let c=0;c<buf.numberOfChannels;c++){
    const inp=buf.getChannelData(c), o=out.getChannelData(c);
    for(let j=0;j<outLen;j++){
      const center=j*ratio, i0=Math.max(0, Math.ceil(center-W)), i1=Math.min(inp.length-1, Math.floor(center+W));
      let sum=0, norm=0;
      for(let i=i0;i<=i1;i++){ const d=(i-center)/ratio;
        const sd=d===0?1:Math.sin(Math.PI*d)/(Math.PI*d);
        const x=(i-center)/W, bw=0.42-0.5*Math.cos(Math.PI*(x+1))+0.08*Math.cos(2*Math.PI*(x+1));
        const k=sd*bw/ratio; sum+=inp[i]*k; norm+=k; }
      o[j]=norm>1e-9?sum/norm:sum;
    }
  }
  return out;
}
window.VM_resampleSinc=resampleSinc;

/* ID3v2.3 tag for MP3 exports (#87): title, artist, encoder. */
function buildId3(title, artist){
  const enc=new TextEncoder();
  const frame=(id,text)=>{ const body=new Uint8Array(1+enc.encode(text).length);
    body[0]=3; body.set(enc.encode(text),1);
    const h=new Uint8Array(10); h.set(enc.encode(id),0);
    new DataView(h.buffer).setUint32(4, body.length);
    return [h, body]; };
  const frames=[];
  if(title) frames.push(frame("TIT2",title));
  if(artist) frames.push(frame("TPE1",artist));
  frames.push(frame("TENC","VocalMIX"));
  let size=0; frames.forEach(f=>{ size+=f[0].length+f[1].length; });
  const head=new Uint8Array(10); head.set(enc.encode("ID3"),0); head[3]=3;
  head[6]=(size>>21)&0x7f; head[7]=(size>>14)&0x7f; head[8]=(size>>7)&0x7f; head[9]=size&0x7f;
  const out=new Uint8Array(10+size); out.set(head,0);
  let o=10; frames.forEach(f=>{ out.set(f[0],o); o+=f[0].length; out.set(f[1],o); o+=f[1].length; });
  return out;
}
window.VM_buildId3=buildId3;
async function prependId3(blob, fallbackTitle){
  const title=(($("#expTitle")||{}).value||"").trim()||fallbackTitle||"VocalMIX";
  const artist=(($("#expArtist")||{}).value||"").trim();
  const tag=buildId3(title, artist);
  const data=await blob.arrayBuffer();
  return new Blob([tag, data], {type:"audio/mpeg"});
}

async function doExport(){
  ensureCtx();
  try{ if("Notification" in window&&Notification.permission==="default") Notification.requestPermission(); }catch(e){}
  const fmt=$("#expFmt").value, sr=parseInt($("#expSr").value), bits=parseInt($("#expBits").value);
  const name=($("#expName").value||"mix").replace(/[^\w\-]/g,"_");
  const dur=projectEnd();
  if(!S.tracks.length){ $("#expStat").textContent="No tracks to export."; return; }
  $("#expStat").textContent="Rendering…";
  try{
    const hq=($("#expSrcQ")||{}).value==="sinc"&&sr<96000;
    let buf=await renderMix(hq?96000:sr,dur);
    if(hq) buf=resampleSinc(buf,sr);
    /* Range (#84), DC removal (#95), auto-trim (#96): applied to the
       rendered buffer before loudness measurement, so every number
       and the report describe the file actually written. */
    let rangeNote="";
    const rA=parseFloat(($("#expStart")||{}).value), rB=parseFloat(($("#expEnd")||{}).value);
    if(isFinite(rA)||isFinite(rB)){ const a=isFinite(rA)?Math.max(0,rA):0, b=isFinite(rB)?rB:dur;
      if(b>a+0.05){ buf=sliceBuffer(buf,a,b); rangeNote=" · Range "+a.toFixed(1)+"\u2013"+b.toFixed(1)+" s"; } }
    if(($("#expDc")||{}).checked){ removeDc(buf); rangeNote+=" · DC removed"; }
    if(($("#expTrim")||{}).checked){ const before=buf.length; buf=trimSilenceBuf(buf,P("silence.db"));
      if(buf.length<before) rangeNote+=" · Trimmed to "+(buf.length/sr).toFixed(1)+" s"; }
    const loud=reportLoudness(buf);
    let normNote="";
    const normSel=$("#expNorm")?$("#expNorm").value:"off";
    if(normSel!=="off"&&isFinite(loud.integrated)){
      const target=normSel==="param"?P("loudness.target"):parseFloat(normSel);
      let gainDb=target-loud.integrated;
      const ceil=P("loudness.ceiling"), peakDb=20*Math.log10(Math.max(loud.peak,1e-6));
      if(peakDb+gainDb>ceil) gainDb=ceil-peakDb;
      const g=db2lin(gainDb);
      for(let c=0;c<buf.numberOfChannels;c++){ const d=buf.getChannelData(c); for(let k=0;k<d.length;k++) d[k]*=g; }
      normNote=" · Normalized "+(gainDb>=0?"+":"")+gainDb.toFixed(1)+" dB to "+target.toFixed(1)+" LUFS";
    }
    /* Tail fade (#97): a cosine fade-out over the last N seconds,
       applied to the final buffer after normalization. */
    let tailNote="", tailSec=0;
    const tailSel=$("#expTail")?$("#expTail").value:"off";
    if(tailSel!=="off"){
      const sec=tailSel==="param"?P("export.tailfade"):parseFloat(tailSel);
      tailSec=sec;
      const n=Math.min(buf.length, Math.floor(sec*buf.sampleRate));
      if(n>0){ for(let c=0;c<buf.numberOfChannels;c++){ const d=buf.getChannelData(c);
          for(let k=0;k<n;k++) d[buf.length-n+k]*=Math.cos((k/n)*Math.PI/2); }
        tailNote=" · Tail fade "+sec+" s"; }
    }
    /* Formats: the chosen one, or all at once (#86). */
    const dither=($("#expDither")||{}).checked, downloads=[];
    if(window._expAll){ window._expAll=false;
      downloads.push([encodeWav(buf,16,dither), name+"_16bit.wav"]);
      downloads.push([encodeWav(buf,24,false), name+"_24bit.wav"]);
      const mpA=encodeMp3(buf); if(mpA) downloads.push([mpA, name+".mp3"]);
    } else if(fmt==="wav"){ downloads.push([encodeWav(buf,bits,dither), name+".wav"]); }
    else { const mpB=encodeMp3(buf); if(!mpB){ $("#expStat").textContent="Could not load the MP3 encoder. Please export as WAV."; return; } downloads.push([mpB, name+".mp3"]); }
    for(const pair of downloads){ if(pair[1].endsWith(".mp3")) pair[0]=await prependId3(pair[0], name); }
    const blob=downloads[0][0], ext=downloads[0][1].split(".").pop();
    for(const pair of downloads){
      const a=document.createElement("a"); a.href=URL.createObjectURL(pair[0]); a.download=pair[1]; a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      if(downloads.length>1) await new Promise(r=>setTimeout(r,350));
    }
    $("#expStat").textContent="Export complete: "+downloads.map(d=>d[1]).join(", ")+" ("+(blob.size/1024).toFixed(0)+" KB)"+normNote+tailNote+rangeNote;
    notifyExportDone(downloads.map(d=>d[1]).join(", "));
    /* Loudness report (#90): the numbers behind this export, as a
       downloadable text file (button next to Export). */
    const tpDb=await truePeakDb(buf);
    const finPeak=measureLoudness(buf).peak;
    const rep=["VocalMIX loudness report",
      "File: "+name+"."+ext,
      "Format: "+(fmt==="wav"?("WAV "+sr+" Hz "+bits+"-bit"):"MP3 320 kbps")+" · Duration: "+dur.toFixed(1)+" s",
      "Integrated loudness: "+(isFinite(loud.integrated)?loud.integrated.toFixed(1)+" LUFS (BS.1770)":"— (silence)"),
      "Sample peak: "+(loud.peak>0?(20*Math.log10(loud.peak)).toFixed(1)+" dBFS":"—")+" (before normalization)",
      "True peak: "+(tpDb!==null&&isFinite(tpDb)?tpDb.toFixed(1)+" dBTP (4x oversampled)":"—")+" (final file)",
      "Final sample peak: "+(finPeak>0?(20*Math.log10(finPeak)).toFixed(1)+" dBFS":"—"),
      "Normalization: "+(normNote?normNote.replace(/^ · /,""):"Off"),
      "Tail fade: "+(tailSec?tailSec+" s":"Off"),
      "Processing: "+(rangeNote?rangeNote.replace(/^ \u00b7 /,""):"None"),
      "Limiter: "+(S.limiter&&S.limiter.on?("On, ceiling "+(S.limiter.ceiling!==undefined?S.limiter.ceiling:P("limiter.ceiling"))+" dB"):"Off"),
      "Date: "+new Date().toLocaleString()].join("\n");
    window._lastLoudReport={text:rep, name:name+"-loudness.txt"};
    const rb2=$("#btnReport"); if(rb2) rb2.disabled=false;
  }catch(err){ $("#expStat").textContent="Export failed: "+err.message; }
}
function encodeWav(buf,bits,dither){
  const nCh=2, sr=buf.sampleRate, len=buf.length, bytesPer=bits/8;
  const block=nCh*bytesPer, dataLen=len*block;
  const ab=new ArrayBuffer(44+dataLen), v=new DataView(ab);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws(0,"RIFF"); v.setUint32(4,36+dataLen,true); ws(8,"WAVEfmt "); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,nCh,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*block,true); v.setUint16(32,block,true); v.setUint16(34,bits,true);
  ws(36,"data"); v.setUint32(40,dataLen,true);
  const L=buf.getChannelData(0), R=buf.numberOfChannels>1?buf.getChannelData(1):L;
  const lsb=bits===16?1/32768:1/8388608;
  let o=44;
  for(let i=0;i<len;i++){ for(const ch of [L,R]){ let x=ch[i];
    if(dither) x+=(Math.random()+Math.random()-1)*lsb; /* TPDF dither (#93) */
    const s=clamp(x,-1,1);
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
  let base=cl.buffer;
  const needFx=L&&(L.vibrato&&L.vibrato.depth>0||L.porta>0||(L.drift||0)>0);
  if(L&&L.enabled&&(needFx||L.notes.some(n=>Math.abs(effectiveShift(n,L))>1e-4))){
    if(!cl._corrCache){ ensureCtx(); cl._corrCache=PitchShift.render(S.ctx,cl.buffer,L); }
    base=cl._corrCache;
  }
  if(!cl.reversed||!base) return base;
  /* Reverse: a copy of the buffer with only this clip's segment
     flipped in place, so offset/skip math elsewhere is unchanged.
     Cached per (buffer, offset, dur). */
  const ck=(base===cl.buffer?"src":"corr")+"|"+cl.offset+"|"+cl.dur;
  if(cl._revCache&&cl._revKey===ck) return cl._revCache;
  const sr=base.sampleRate, from=Math.max(0,Math.floor(cl.offset*sr)), to=Math.min(base.length,Math.ceil((cl.offset+cl.dur)*sr));
  const out=new AudioBuffer({length:base.length, sampleRate:sr, numberOfChannels:base.numberOfChannels});
  for(let ch=0; ch<base.numberOfChannels; ch++){ const d=base.getChannelData(ch), o=out.getChannelData(ch);
    o.set(d); for(let i=from,j=to-1;i<j;i++,j--){ const tmp=o[i]; o[i]=o[j]; o[j]=tmp; } }
  cl._revCache=out; cl._revKey=ck;
  return out;
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
        const nt={id:nid(),start:cur.start,end:cur.end,f0:440*Math.pow(2,(m-69)/12),midi:m,shift:0,enabled:true};
        /* Pitch-drift contour (#42): for longer notes, keep the
           slow wander (cents from the note median, ~50 ms steps)
           so the renderer can flatten it on request. */
        if(cur.end-cur.start>=0.25&&cur.midis.length>=8&&hopDur>0){
          const step=Math.max(1, Math.round(0.05/hopDur)), cc=[];
          for(let i=0;i<cur.midis.length;i+=step) cc.push(Math.round((cur.midis[i]-m)*100));
          if(cc.length>=4) nt.contour={dt:step*hopDur, c:cc};
        }
        notes.push(nt); }
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
    const vibOn=!!(layer.vibrato&&layer.vibrato.depth>0);
    const sorted=[...notes].sort((a,b)=>a.start-b.start);
    const prevShiftOf=nt=>{ let ps=effectiveShift(nt,layer);
      for(const o of sorted){ if(o.start<nt.start-1e-6) ps=effectiveShift(o,layer); else break; }
      return ps; };
    const active=notes.map(n=>({...n,shift:effectiveShift(n,layer)}))
      .filter(n=>Math.abs(n.shift)>1e-4||vibOn||((layer.drift||0)>0&&n.contour));
    for(let ch=0;ch<buffer.numberOfChannels;ch++){
      const src=buffer.getChannelData(ch), dst=out.getChannelData(ch);
      dst.set(src);
      active.forEach(nt=>{
        const ratio=Math.pow(2,nt.shift/12), pad=0.03;
        const s0=Math.max(0,Math.floor((nt.start-pad)*sr)), s1=Math.min(src.length,Math.ceil((nt.end+pad)*sr));
        if(s1-s0<256) return;
        const vib=layer.vibrato, porta=layer.porta||0, driftAmt=layer.drift||0;
        const prevSh=prevShiftOf(nt);
        const useV=(vib&&vib.depth>0)||(porta>0&&Math.abs(prevSh-nt.shift)>0.01)||(driftAmt>0&&!!nt.contour);
        let shifted;
        if(useV&&(sr/nt.f0)>=8){
          const noteStartSamp=nt.start*sr-s0;
          const ratioFn=samp=>{
            const t=(samp-noteStartSamp)/sr;
            let sh=nt.shift;
            if(porta>0&&t>=0&&t<porta){ const u=t/porta, sm=u*u*(3-2*u); sh=prevSh+(nt.shift-prevSh)*sm; }
            else if(porta>0&&t<0) sh=prevSh;
            if(vib&&vib.depth>0){ const td=t-(vib.delay||0);
              if(td>0){ const fade=Math.min(1, td/0.12);
                sh+=(vib.depth/100)*Math.sin(2*Math.PI*(vib.rate||5.5)*td)*fade; } }
            if(driftAmt>0&&nt.contour){ const ct2=Math.max(0, t/nt.contour.dt);
              const i0=clamp(Math.floor(ct2),0,nt.contour.c.length-1);
              const i1=Math.min(nt.contour.c.length-1, i0+1), fr2=clamp(ct2-i0,0,1);
              const cents=nt.contour.c[i0]*(1-fr2)+nt.contour.c[i1]*fr2;
              sh-=driftAmt*cents/100; }
            return Math.pow(2, sh/12);
          };
          shifted=this._psolaV(src.subarray(s0,s1), ratioFn, sr/nt.f0);
        } else shifted=this._shift(src.subarray(s0,s1),ratio,sr/nt.f0);
        /* PSOLA preserves formants by nature (grains keep their
           spectral envelope). "Preserve formants" OFF therefore
           applies the opposite: formants are dragged along with
           the pitch (the chipmunk direction). ON = plain PSOLA. */
        if(!useV&&layer.preserveFormants===false&&Math.abs(nt.shift)>0.5)
          shifted=this._formant(shifted, ratio, (sr/nt.f0)/ratio);
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
  _formant(x,ratio,period){
    /* Formant shift by <ratio> with pitch and length preserved:
       resample (pitch + formants x ratio, shorter), PSOLA the pitch
       back by 1/ratio (formants stay shifted), stretch to the
       original length. period = the input's period in samples. */
    if(!period||period<8||x.length<4*period||Math.abs(ratio-1)<0.03) return x;
    const n=Math.max(16,Math.floor(x.length/ratio)), rs=new Float32Array(n);
    for(let i=0;i<n;i++){ const p=i*ratio, i0=Math.floor(p), f=p-i0;
      rs[i]=x[i0]*(1-f)+x[Math.min(i0+1,x.length-1)]*f; }
    /* Pitch back by 1/ratio. Below 0.62 the grain placement hits
       the integer-ratio degeneracy (see _shift), so split into two
       sqrt steps exactly as _shift does. */
    const pr=1/ratio, P2=Math.max(8, period/ratio);
    let ps;
    if(pr<0.62){ const sq=Math.sqrt(pr); const mid=this._psola(rs, sq, P2); ps=this._psola(mid, sq, P2/sq); }
    else ps=this._psola(rs, pr, P2);
    return this._psolaT(ps, ratio, period);
  },
  _psolaV(x, ratioFn, P){
    /* PSOLA with a time-varying ratio (#13/#14): both the output
       grain spacing and the input consumption advance by 1/ratio(t)
       input periods per grain, so vibrato (an oscillating ratio)
       and portamento (a gliding ratio) come out of the same loop
       as the constant-ratio path. ratioFn takes the output sample
       offset within the segment. */
    if(!P||P<8) return x;
    const half=Math.max(8, Math.round(1.25*P)), W=half*2;
    const win=new Float32Array(W);
    for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
    const out=new Float32Array(x.length+W), wsum=new Float32Array(x.length+W);
    let inPer=0, oC=0, guard=0;
    while(oC<x.length&&guard++<x.length){
      const r=Math.max(0.25, Math.min(4, ratioFn(oC)));
      const step=1/r;
      const c=Math.round(Math.round(inPer)*P), oc=Math.round(oC);
      for(let i=0;i<W;i++){
        const si=c-half+i, oi=oc-half+i;
        if(si<0||si>=x.length||oi<0||oi>=out.length) continue;
        out[oi]+=x[si]*win[i]; wsum[oi]+=win[i];
      }
      inPer+=step; oC+=step*P;
    }
    const y=new Float32Array(x.length);
    for(let i=0;i<x.length;i++) y[i]=wsum[i]>0.25?out[i]/wsum[i]:out[i];
    return y;
  },
  _psolaT(x,F,P){
    /* Period-synchronous time-stretch by F (pitch preserved). The
       plain OLA _stretch places grains at fixed hops, which lands
       them at random phases of a periodic signal and combs the
       harmonics away; here grains sit on period multiples in both
       the input and the output, so the harmonics survive. */
    if(!P||P<8||Math.abs(F-1)<0.02) return this._stretch(x, Math.round(x.length*F));
    const half=Math.max(8,Math.round(1.25*P)), W=half*2;
    const win=new Float32Array(W);
    for(let i=0;i<W;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(W-1));
    const target=Math.round(x.length*F);
    const out=new Float32Array(target+W), wsum=new Float32Array(target+W);
    /* Output grains always sit one period apart (that is what
       preserves the pitch); the INPUT consumption rate carries the
       stretch factor. Placing output grains at P*F instead cancels
       the fundamental whenever P*F lands near a half period. */
    const nG=Math.floor(x.length*F/P);
    for(let j=0;j<=nG;j++){
      /* Analysis marks stay ON period multiples: synthesis mark j
         uses analysis mark round(j/F). A continuous j*P/F lands
         between periods and phase-cancels the fundamental. */
      const c=Math.round(Math.round(j/F)*P), oC=Math.round(j*P);
      for(let i=0;i<W;i++){
        const si=c-half+i, oi=oC-half+i;
        if(si<0||si>=x.length||oi<0||oi>=out.length) continue;
        out[oi]+=x[si]*win[i]; wsum[oi]+=win[i];
      }
    }
    const y=new Float32Array(target);
    for(let i=0;i<target;i++) y[i]=wsum[i]>0.25?out[i]/wsum[i]:out[i];
    return y;
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
      <div class="strengthrow"><label>Vibrato</label><input type="range" id="pvibDepth" min="0" max="100" step="1" value="${(L.vibrato&&L.vibrato.depth)||0}" style="flex:1"><span class="small" id="pvibDepthVal">${(L.vibrato&&L.vibrato.depth)||0} cents</span><label>Rate</label><input type="range" id="pvibRate" min="3" max="8" step="0.1" value="${(L.vibrato&&L.vibrato.rate)||5.5}"><span class="small" id="pvibRateVal">${(L.vibrato&&L.vibrato.rate)||5.5} Hz</span></div>
      <div class="strengthrow"><label>Portamento</label><input type="range" id="pPorta" min="0" max="0.5" step="0.01" value="${L.porta||0}" style="flex:1"><span class="small" id="pPortaVal">${(L.porta||0).toFixed(2)} s glide into each note</span></div>
      <div class="strengthrow"><label>Drift Fix</label><input type="range" id="pDrift" min="0" max="100" step="1" value="${Math.round((L.drift||0)*100)}" style="flex:1"><span class="small" id="pDriftVal">${Math.round((L.drift||0)*100)}% — flattens slow pitch wander inside long notes (needs an analyzed contour)</span></div>
      <div class="strengthrow"><label><input type="checkbox" id="pitchPreserve" ${L.preserveFormants===false?"":"checked"}> Preserve formants</label><span class="small">ON keeps the voice's character (PSOLA leaves formants put); OFF drags formants along with the pitch</span></div>
      <div class="presetchips" role="group" aria-label="Pitch correction presets">${PITCH_PRESETS.map(p=>`<button data-preset="${p.id}" class="${Math.abs(strength-p.strength)<0.01?"on":""}" title="${p.desc}">${p.label}</button>`).join("")}</div>`
      :`<p>Not analyzed yet. Run "Analyze Pitch" to detect notes and create this layer (the source stays untouched).</p>`}
    </div>
    ${L?`<div style="display:flex;flex-direction:column;gap:6px;flex:none"><button id="btnPitchOn">${L.enabled?"Layer OFF":"Layer ON"}</button><button id="btnDeleteLayer" class="ghost" title="Deletes all analysis and correction. The source audio remains.">Delete Layer</button></div>`:""}
    </div></div>`;
  h+=`<p class="small" style="margin:8px 0 2px">Spectrogram of this clip (frequency up, time across; bright = loud):</p>
    <canvas id="sgCanvas" style="width:100%;height:150px;background:#0b0e1a;border-radius:8px"></canvas>`;
  h+=`<div class="pitchbar">
    <button id="btnAnalyze">${L?"Re-analyze (rebuild layer)":"Analyze Pitch"}</button>
    ${L?"":`<span class="pitchinfo" id="pitchStatus">${pitchStatusText(cl)}</span>`}</div>`;
  if(L&&L.notes.length){
    h+=`<div class="pitchbar">
      <button id="btnSnapNotes">Snap to Nearest Note</button>
      <label class="small">Scale <select id="scaleRoot">${NOTE_NAMES.map((nm,i)=>`<option value="${i}" ${((L&&L.scaleRoot)||0)===i?"selected":""}>${nm}</option>`).join("")}</select>
      <select id="scaleMode">${["chromatic","major","minor"].map(m=>`<option value="${m}" ${((L&&L.scaleMode)||"chromatic")===m?"selected":""}>${m}</option>`).join("")}</select></label>
      <button id="btnHarmony" class="ghost">Harmony +4 st</button><button id="btnHarmony7" class="ghost">Harmony +7 st</button>
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
function scaleTones(L){
  if(!L||!L.scaleMode||L.scaleMode==="chromatic") return null;
  const steps=L.scaleMode==="minor"?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11];
  const root=L.scaleRoot||0;
  return steps.map(x=>(root+x)%12);
}
function nearestScaleMidi(m, L){
  const tones=scaleTones(L); if(!tones) return Math.round(m);
  let best=Math.round(m), bd=1e9;
  for(let cand=Math.floor(m)-12;cand<=Math.ceil(m)+12;cand++){
    if(tones.indexOf(((cand%12)+12)%12)>=0){ const d=Math.abs(cand-m); if(d<bd){ bd=d; best=cand; } }
  }
  return best;
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
  const sgc=$("#sgCanvas");
  if(sgc) requestAnimationFrame(()=>drawSpectrogram(sgc,cl));
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
  if(snap&&L) snap.onclick=()=>{ L.notes.forEach(n=>{ if(n.enabled!==false) n.shift=Math.round((nearestScaleMidi(n.midi,L)-n.midi)*1000)/1000; });
    refreshPitchRender(cl); renderTimeline(); if(cv)drawPitch(cv,cl); updatePitchInfo(cl);
    toast(scaleTones(L)?"Snapped enabled notes to the "+NOTE_NAMES[L.scaleRoot||0]+" "+L.scaleMode+" scale (layer only)":"Snapped enabled notes to the nearest pitch (layer only; source unchanged)"); };
  const srEl=$("#scaleRoot"); if(srEl&&L) srEl.onchange=()=>{ L.scaleRoot=parseInt(srEl.value); };
  const smEl=$("#scaleMode"); if(smEl&&L) smEl.onchange=()=>{ L.scaleMode=smEl.value; };
  const pv=$("#pitchPreserve"); if(pv&&L) pv.onchange=()=>{ L.preserveFormants=pv.checked; invalidatePitchCache(cl); refreshPitchRender(cl); toast(pv.checked?"Formant preservation ON":"Formant preservation OFF"); };
  const vd=$("#pvibDepth"), vr=$("#pvibRate"), pp=$("#pPorta");
  const applyVib=()=>{ if(!L) return; if(!L.vibrato) L.vibrato={rate:5.5, depth:0, delay:0.25};
    if(vd){ L.vibrato.depth=parseFloat(vd.value); const e=$("#pvibDepthVal"); if(e) e.textContent=vd.value+" cents"; }
    if(vr){ L.vibrato.rate=parseFloat(vr.value); const e=$("#pvibRateVal"); if(e) e.textContent=(+vr.value).toFixed(1)+" Hz"; }
    invalidatePitchCache(cl); refreshPitchRender(cl); };
  if(vd) vd.addEventListener("input", applyVib);
  if(vr) vr.addEventListener("input", applyVib);
  const pd=$("#pDrift");
  if(pd) pd.addEventListener("input", ()=>{ if(!L) return; L.drift=parseFloat(pd.value)/100;
    const e=$("#pDriftVal"); if(e) e.textContent=pd.value+"% — flattens slow pitch wander inside long notes (needs an analyzed contour)";
    invalidatePitchCache(cl); refreshPitchRender(cl); });
  if(pp) pp.addEventListener("input", ()=>{ if(!L) return; L.porta=parseFloat(pp.value);
    const e=$("#pPortaVal"); if(e) e.textContent=(+pp.value).toFixed(2)+" s glide into each note";
    invalidatePitchCache(cl); refreshPitchRender(cl); });
  const hb=$("#btnHarmony"); if(hb) hb.onclick=()=>makeHarmony(cl,4);
  const hb7=$("#btnHarmony7"); if(hb7) hb7.onclick=()=>makeHarmony(cl,7);
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
    if(hit){ drag={id:hit.id,y0:y,x0:x,shift0:hit.shift,start0:hit.start,end0:hit.end,moved:false}; cv.setPointerCapture(e.pointerId); }
    drawPitch(cv,cl); updatePitchInfo(cl);
  });
  cv.addEventListener("pointermove",e=>{
    if(!drag||!cv._geom) return;
    const r=cv.getBoundingClientRect(), y=e.clientY-r.top;
    const nt=L.notes.find(n=>n.id===drag.id); if(!nt) return;
    const ns=clamp(drag.shift0+Math.round((drag.y0-y)/cv._geom.rh),-12,12);
    if(ns!==nt.shift){ nt.shift=ns; nt.enabled=true; drag.moved=true; drawPitch(cv,cl); updatePitchInfo(cl); }
    /* Horizontal drag (#19): move the note's window in time. */
    const r2=cv.getBoundingClientRect(), x=e.clientX-r2.left;
    const g=cv._geom, pxPerSec=(g.X(g.t1)-g.X(g.t0))/Math.max(1e-6, g.t1-g.t0);
    const dt=(x-drag.x0)/pxPerSec, dur0=drag.end0-drag.start0;
    if(Math.abs(dt)>0.004){
      const ns0=clamp(drag.start0+dt, 0, Math.max(0, cl.buffer.duration-dur0));
      if(Math.abs(ns0-nt.start)>1e-4){ nt.start=ns0; nt.end=ns0+dur0; drag.moved=true; drawPitch(cv,cl); updatePitchInfo(cl); }
    }
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
    gain:cl.gain,fadeIn:0,fadeOut:cl.fadeOut,muted:!!cl.muted,curveOut:cl.curveOut,reversed:!!cl.reversed,
    takes:cl.takes?[...cl.takes]:undefined, takeIdx:cl.takeIdx||0};
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
  if(type==="folder"){ tr.fx=[]; tr.isFolder=true; }
  if(type!=="inst"&&type!=="folder") tr.bus=S.buses[0].id;
  S.tracks.push(tr); if(S.ctx)buildTrackGraph(tr); S.selTrack=tr.id; renderTimeline(); renderInspector(); };
$("#btnSplit").onclick=splitSelected;
$("#btnDelClip").onclick=deleteSelected;
$("#btnSnap").onclick=e=>{ S.snap=!S.snap; e.currentTarget.classList.toggle("on",S.snap); };
$("#autoSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return;
  S.autoMode=b.dataset.m; $$("#autoSeg button").forEach(x=>x.classList.toggle("on",x===b)); renderTimeline(); });
const zvEl=$("#zoomV"); if(zvEl) zvEl.addEventListener("input",e=>{ S.waveZoom=parseFloat(e.target.value)/100; renderTimeline(); });
$("#zoomR").addEventListener("input",e=>{ const wrap=$("#tlWrap"); const anchor=S.pos;
  S.px=parseFloat(e.target.value); renderTimeline(); });
["dragover","dragenter"].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault(); $("#dropVeil").classList.add("show"); }));
["dragleave","drop"].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault();
  if(ev==="dragleave"&&e.relatedTarget) return; $("#dropVeil").classList.remove("show"); }));
document.addEventListener("drop",e=>{ if(e.dataTransfer.files&&e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
document.addEventListener("pointerdown",()=>ensureCtx(),{once:true});
/* ---------- shortcut remap (#72) ---------- */
const KEY_ACTIONS=[["split","Split at playhead"],["trackDown","Select track down"],["trackUp","Select track up"],["seekBack","Seek -1 s (Shift: 5 s)"],["seekFwd","Seek +1 s (Shift: 5 s)"],["mute","Mute track"],["solo","Solo track"],["undo","Undo (Shift: Redo)"],["dup","Duplicate clip / track"],["rec","Record"]];
const KEYMAP_DEFAULTS={split:"s",trackDown:"j",trackUp:"k",seekBack:"h",seekFwd:"l",mute:"m",solo:"o",undo:"u",dup:"d",rec:"r"};
function keymap(){
  if(!S._keymap){ try{ S._keymap=JSON.parse(localStorage.getItem("vocalmix-keymap")||"{}"); }catch(e){ S._keymap={}; } }
  return Object.assign({}, KEYMAP_DEFAULTS, S._keymap);
}
function setKeymap(action, key){
  const km=keymap(); km[action]=key; S._keymap=km;
  try{ localStorage.setItem("vocalmix-keymap", JSON.stringify(km)); }catch(e){}
}
function resetKeymap(){ S._keymap={}; try{ localStorage.removeItem("vocalmix-keymap"); }catch(e){} }
window.VM_keymap=keymap;

document.addEventListener("keydown",e=>{
  if(e.target.matches("input,select,textarea")) return;
  if(e.code==="Space"){ e.preventDefault(); play(); }
  else if(e.key.toLowerCase()===keymap().split) splitSelected();
  else if(e.key==="Delete"||e.key==="Backspace") deleteSelected();
  else if(e.key==="Home") seek(0);
  else if(!/(pitch|export|manual)\.html/.test(location.pathname)&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    /* Home-position keys (main page): the frequent actions live on
       and around the home row, no modifiers, no mouse travel. */
    const k=e.key, KM=keymap();
    if(k===KM.trackDown||k===KM.trackUp){ const ts=S.tracks; if(ts.length){ let i=ts.findIndex(t=>t.id===S.selTrack);
      i=(i+(k===KM.trackDown?1:-1)+ts.length)%ts.length; S.selTrack=ts[i].id; S.selClip=null; renderTimeline(); renderInspector(); } }
    else if(k.toLowerCase()===KM.seekBack||k.toLowerCase()===KM.seekFwd){ const d=(k.toLowerCase()===KM.seekBack?-1:1)*(e.shiftKey?5:1); seek(currentPos()+d); }
    else if(k===KM.mute){ const tr=selTrackObj(); if(tr){ tr.mute=!tr.mute; renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos()); } }
    else if(k===KM.solo){ const tr=selTrackObj(); if(tr){ tr.solo=!tr.solo; renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos()); } }
    else if(k===KM.undo){ const b=document.querySelector("#btnUndo"); if(b) b.click(); }
    else if(k===KM.undo.toUpperCase()){ const b=document.querySelector("#btnRedo"); if(b) b.click(); }
    else if(k===KM.dup){ const fc=findClip(S.selClip); if(fc) duplicateClip(fc.tr,fc.cl);
      else { const tr=selTrackObj(); if(tr) dupTrack(tr); } }
    else if(k==="1"||k==="2"||k==="3"||k==="4"){ curTab=["ch","fx","pitch","mix"][+k-1]; renderInspector(); }
    else if(k==="+"||k==="-"||k==="="){ S.px=clamp(Math.round(S.px*(k==="-"?0.8:1.25)),8,140);
      const z=$("#zoomR"); if(z) z.value=S.px; renderTimeline(); }
    else if(k===KM.rec){ recToggle(); }
    else if(k==="Enter"){ seek(0); if(!S.playing) play(); }
    else if(k===","||k==="."){ nudgeSelected((k===","?-1:1)*beatSec()); }
    else if(k==="?"){ toggleKeysPanel(); }
    else if(k==="Escape"){ const kp=$("#keysPanel"); if(kp) kp.style.display="none"; }
  }
});
window.addEventListener("resize",()=>{ renderTimeline(); if(curTab==="pitch") renderInspector(); });

/* ---------- overview minimap (#78) ---------- */
function drawMinimap(){
  const cv=$("#minimap"); if(!cv) return;
  const w=cv.clientWidth; if(!w) return;
  const dpr=Math.min(2, window.devicePixelRatio||1);
  if(cv.width!==Math.round(w*dpr)){ cv.width=Math.round(w*dpr); cv.height=Math.round(36*dpr); }
  const c=cv.getContext("2d"); c.setTransform(dpr,0,0,dpr,0,0);
  const h=36, end=Math.max(1, projectEnd());
  c.clearRect(0,0,w,h);
  const rows=Math.max(1, S.tracks.length);
  const rh=Math.min(8, (h-6)/rows);
  S.tracks.forEach((tr,i)=>{ const y=3+i*rh;
    tr.clips.forEach(cl=>{ c.fillStyle=tr.color; c.globalAlpha=0.85;
      c.fillRect(cl.start/end*w, y, Math.max(1.5,(cl.dur/end)*w), Math.max(2, rh-1.5)); });
    c.globalAlpha=1; });
  const wrap=$("#tlWrap");
  if(wrap&&contentW()>0){ const cw=contentW();
    const x0=wrap.scrollLeft/cw*w, x1=(wrap.scrollLeft+wrap.clientWidth)/cw*w;
    c.strokeStyle="rgba(255,255,255,.8)"; c.lineWidth=1; c.strokeRect(x0+0.5, 1.5, Math.max(4, x1-x0), h-3); }
  const pos=S.playing?currentPos():S.pos;
  c.fillStyle="#ffcf5c"; c.fillRect(pos/end*w, 0, 1.5, h);
}
{ const mm=$("#minimap");
  if(mm){ const jump=e=>{ const r=mm.getBoundingClientRect(); const f=clamp((e.clientX-r.left)/r.width,0,1);
      const wrap=$("#tlWrap"); if(wrap) wrap.scrollLeft=Math.max(0, f*contentW()-wrap.clientWidth/2); drawMinimap(); };
    mm.addEventListener("pointerdown",e=>{ jump(e);
      const mv=ev=>jump(ev);
      const up=()=>{ window.removeEventListener("pointermove",mv); window.removeEventListener("pointerup",up); };
      window.addEventListener("pointermove",mv); window.addEventListener("pointerup",up); }); }
  const tw=$("#tlWrap");
  if(tw) tw.addEventListener("scroll",()=>{ if(!S._mmPend){ S._mmPend=true;
    requestAnimationFrame(()=>{ S._mmPend=false; drawMinimap(); }); } });
}

/* ---------- touch gestures (#81) ---------- */
{ const pts=new Map(); let pinch0=null, lpTimer=null;
  const clearLp=()=>{ if(lpTimer){ clearTimeout(lpTimer); lpTimer=null; } };
  lanesEl.addEventListener("pointerdown",e=>{
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size===2){ const v=[...pts.values()]; pinch0={d:Math.hypot(v[0].x-v[1].x, v[0].y-v[1].y), px:S.px}; clearLp(); }
    else if(e.pointerType!=="mouse"){ const clipEl=e.target.closest?e.target.closest(".clip"):null;
      if(clipEl){ lpTimer=setTimeout(()=>{ lpTimer=null;
        const lane=clipEl.parentElement, tr=S.tracks.find(t=>t.id===lane.dataset.tid);
        const idx=[...lane.querySelectorAll(".clip")].indexOf(clipEl);
        if(tr&&tr.clips[idx]){ S.selTrack=tr.id; S.selClip=tr.clips[idx].id; curTab="ch";
          renderTimeline(); renderInspector(); toast("Clip selected (long press)"); }
      }, 450); } }
  });
  lanesEl.addEventListener("pointermove",e=>{
    if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    clearLp();
    if(pts.size===2&&pinch0){ const v=[...pts.values()]; const d=Math.hypot(v[0].x-v[1].x, v[0].y-v[1].y);
      if(d>10&&pinch0.d>10){ S.px=clamp(Math.round(pinch0.px*d/pinch0.d),8,140);
        const z=$("#zoomR"); if(z) z.value=S.px; renderTimeline(); } }
  });
  const up=e=>{ pts.delete(e.pointerId); if(pts.size<2) pinch0=null; clearLp(); };
  lanesEl.addEventListener("pointerup",up); lanesEl.addEventListener("pointercancel",up);
}

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
    /* Phase correlation (#59) + clipping history (#61) */
    if(S.anL&&S.anR){
      if(!S._anBufL){ S._anBufL=new Float32Array(1024); S._anBufR=new Float32Array(1024); }
      const la=S._anBufL, ra=S._anBufR;
      S.anL.getFloatTimeDomainData(la); S.anR.getFloatTimeDomainData(ra);
      let slr=0, sl=0, sr2=0, pk=0;
      for(let i=0;i<1024;i++){ slr+=la[i]*ra[i]; sl+=la[i]*la[i]; sr2+=ra[i]*ra[i];
        const av=Math.abs(la[i]), bv=Math.abs(ra[i]); if(av>pk)pk=av; if(bv>pk)pk=bv; }
      const corr=(sl>1e-9&&sr2>1e-9)?slr/Math.sqrt(sl*sr2):0;
      const cs=$("#corrStat"); if(cs) cs.textContent="Corr "+(corr>=0?"+":"")+corr.toFixed(2);
      if(S.playing&&pk>=0.999){
        const nowT=S.ctx.currentTime;
        if(!S._lastClipT||nowT-S._lastClipT>0.25){ S._lastClipT=nowT;
          S.clipLog=S.clipLog||[];
          S.clipLog.push({t:Math.round(currentPos()*10)/10, peak:+pk.toFixed(3)});
          if(S.clipLog.length>50) S.clipLog.shift();
          const ce=$("#clipStat"); if(ce) ce.textContent="Clip \u00d7"+S.clipLog.length;
        }
      }
    }
    /* Spectrum (#57): master frequency display on the Mix tab */
    const sc=$("#specCanvas");
    if(sc){ if(!S._specBuf) S._specBuf=new Uint8Array(S.analyser.frequencyBinCount);
      const fd=S._specBuf; S.analyser.getByteFrequencyData(fd);
      const sctx=sc.getContext("2d"), W=sc.width, H=sc.height;
      sctx.clearRect(0,0,W,H); sctx.fillStyle="#57c7a3";
      const bars=48, step=Math.max(1,Math.floor(fd.length/bars));
      for(let i=0;i<bars;i++){ let mx=0; for(let j=0;j<step;j++){ const v=fd[i*step+j]; if(v>mx)mx=v; }
        const h=(mx/255)*(H-4); sctx.fillRect(i*(W/bars)+1, H-h, Math.max(1,W/bars-2), h); } }
    /* GR meter */
    const tr=selTrackObj();
    if(tr&&tr.nodes&&S.selFx>=0&&tr.fx[S.selFx]&&tr.fx[S.selFx].type==="comp"){
      const node=tr.nodes.liveFx[S.selFx]&&tr.nodes.liveFx[S.selFx].parts.comp;
      const grEl=$("#grBar"); if(node&&grEl) grEl.style.width=clamp(-node.reduction*4,0,100)+"%";
    }
  }
}

/* ---------- parameters (variable values) ----------
   Feature constants live here as named, user-adjustable parameters
   instead of being hard-coded. Edit them in the ⚙ Params panel, with
   `set` in the command bar, or via localStorage "vocalmix-params".
   window.VM_P(key) reads a value; new features must read their
   tunables from here. */
const PARAM_DEFS={
  "xfade.sec":   {def:0.10, min:0.005, max:2,   step:0.005, label:"Crossfade length (s)", ja:"クロスフェード長（秒）"},
  "autosave.sec":{def:1.2,  min:0.3,   max:10,  step:0.1,   label:"Autosave delay (s)",   ja:"自動保存までの遅延（秒）"},
  "undo.depth":  {def:50,   min:5,     max:200, step:1,     label:"Undo depth",           ja:"アンドゥの深さ"},
  "deesser.freq":{def:6000, min:2000,  max:12000, step:50,  label:"De-esser frequency (Hz)", ja:"ディエッサー中心周波数（Hz）"},
  "limiter.ceiling":{def:-1, min:-12, max:0,   step:0.1,   label:"Limiter ceiling (dB)",  ja:"リミッターの天井（dB）"},
  "limiter.release":{def:120, min:10,  max:1000, step:5,   label:"Limiter release (ms)",  ja:"リミッターのリリース（ms）"},
  "loudness.target":{def:-14, min:-24, max:-8,  step:0.5,   label:"Loudness target (LUFS)", ja:"ラウドネス目標（LUFS）"},
  "loudness.ceiling":{def:-1, min:-6,  max:0,   step:0.1,   label:"Normalize peak ceiling (dB)", ja:"ノーマライズ時のピーク天井（dB）"},
  "snap.max":    {def:20,   min:1,     max:100, step:1,     label:"Max named snapshots",   ja:"名前付きスナップショットの上限"},
  "rec.offsetMs":{def:0,    min:-500,  max:500, step:1,     label:"Record latency offset (ms)", ja:"録音レイテンシ補正（ms）"},
  "rec.processing":{def:0,  min:0,     max:1,   step:1,     label:"Mic processing (echo/noise/AGC) 0=off 1=on", ja:"マイク処理（エコー/ノイズ/AGC）0=切 1=入"},
  "metro.countin":{def:1,   min:0,     max:2,   step:1,     label:"Count-in bars before play/record", ja:"再生・録音前のカウントイン小節数"},
  "norm.target": {def:-1,   min:-24,   max:0,   step:0.5,   label:"Clip normalize target peak (dB)", ja:"クリップノーマライズの目標ピーク（dB）"},
  "silence.db":  {def:-45,  min:-70,   max:-20, step:1,     label:"Silence threshold for split/strip (dB)", ja:"分割・除去の無音しきい値（dB）"},
  "silence.min": {def:0.3,  min:0.05,  max:2,   step:0.05,  label:"Minimum silence length for split/strip (s)", ja:"分割・除去の最小無音長（秒）"},
  "repair.breathDb": {def:12, min:0, max:30, step:1, label:"Breath control attenuation (dB)", ja:"ブレス制御の減衰量（dB）"},
  "repair.levelDb": {def:6, min:1, max:12, step:0.5, label:"Syllable leveling max correction (dB)", ja:"音節レベル均しの最大補正（dB）"},
  "repair.noise": {def:1, min:0.2, max:2, step:0.1, label:"Room-noise reduction strength", ja:"部屋ノイズ除去の強さ"},
  "export.tailfade":{def:2, min:0,     max:10,  step:0.5,   label:"Export tail fade length when 'Custom' (s)", ja:"書き出し曲尾フェード（カスタム時、秒）"},
  "metro.vol":   {def:50,   min:0,     max:100, step:1,     label:"Metronome volume (%)", ja:"メトロノーム音量（%）"},
};
let PARAMS={};
try{ PARAMS=JSON.parse(localStorage.getItem("vocalmix-params")||"{}")||{}; }catch(e){ PARAMS={}; }
function P(key){
  const d=PARAM_DEFS[key]; if(!d) return undefined;
  const v=PARAMS[key];
  return (typeof v==="number"&&isFinite(v))?v:d.def;
}
function setParam(key,val){
  const d=PARAM_DEFS[key]; if(!d) return false;
  const v=parseFloat(val); if(!isFinite(v)) return false;
  PARAMS[key]=Math.max(d.min,Math.min(d.max,v));
  try{ localStorage.setItem("vocalmix-params",JSON.stringify(PARAMS)); }catch(e){}
  if(key==="limiter.ceiling"&&typeof S!=="undefined"&&S.limiter){ S.limiter.ceiling=PARAMS[key]; applyLimiterLive(); }
  if(key==="limiter.release") applyLimiterLive();
  return true;
}
window.VM_P=P; window.VM_setParam=setParam; window.VM_PARAM_DEFS=PARAM_DEFS;
function vmLang(){ try{ return localStorage.getItem("vocalmix-lang")||"en"; }catch(e){ return "en"; } }

(function(){
  if(/pitch\.html|export\.html|manual\.html/.test(location.pathname)) return;
  let panel=null;
  function close(){ if(panel){ panel.remove(); panel=null; } }
  function open(){
    if(panel){ close(); return; }
    const j=vmLang()==="ja";
    panel=document.createElement("div"); panel.className="parampanel";
    let h='<div class="pp-head"><b>'+(j?"パラメータ":"Parameters")+'</b><button class="ghost" id="ppClose">'+(j?"閉じる":"Close")+'</button></div>';
    for(const key of Object.keys(PARAM_DEFS)){
      const d=PARAM_DEFS[key];
      h+='<label class="pp-row"><span>'+(j?d.ja:d.label)+'<small>'+key+'</small></span><input type="number" data-pk="'+key+'" min="'+d.min+'" max="'+d.max+'" step="'+d.step+'" value="'+P(key)+'"></label>';
    }
    h+='<div class="pp-foot"><button class="ghost" id="ppReset">'+(j?"すべて既定に戻す":"Reset all")+'</button><button class="ghost" id="ppExpSet">'+(j?"設定を書き出し":"Export settings")+'</button><button class="ghost" id="ppImpSet">'+(j?"設定を読み込み":"Import settings")+'</button><button class="ghost" id="ppZipExp">'+(j?"プロジェクトzip書き出し":"Export project .zip")+'</button><button class="ghost" id="ppZipImp">'+(j?"プロジェクトzip読み込み":"Import project .zip")+'</button><span class="small">'+(j?"コマンドは「:」キー（help で一覧）":"Commands: press : (try help)")+'</span></div>';
    panel.innerHTML=h;
    panel.classList.add("open");
    document.body.appendChild(panel);
    panel.querySelector("#ppClose").onclick=close;
    panel.querySelector("#ppReset").onclick=function(){ PARAMS={}; try{ localStorage.removeItem("vocalmix-params"); }catch(e){} close(); open(); toast(j?"パラメータを既定に戻しました":"Parameters reset"); };
    panel.querySelector("#ppExpSet").onclick=function(){ exportSettings(); };
    const setFile=document.createElement("input"); setFile.type="file"; setFile.accept=".json,application/json"; setFile.style.display="none";
    setFile.addEventListener("change",function(){ if(setFile.files[0]) importSettings(setFile.files[0]); setFile.value=""; });
    panel.appendChild(setFile);
    panel.querySelector("#ppImpSet").onclick=function(){ setFile.click(); };
    const ze=panel.querySelector("#ppZipExp"); if(ze) ze.onclick=function(){ zipProject(); };
    const zi=panel.querySelector("#ppZipImp"); if(zi) zi.onclick=function(){ const inp=document.createElement("input");
      inp.type="file"; inp.accept=".zip"; inp.onchange=function(){ if(inp.files[0]) unzipProject(inp.files[0]); }; inp.click(); };
    panel.querySelectorAll("input[data-pk]").forEach(function(inp){
      inp.addEventListener("change",function(){ if(setParam(inp.dataset.pk,inp.value)) inp.value=P(inp.dataset.pk); });
    });
  }
  if(typeof S!=="undefined"&&S.limiter) S.limiter.ceiling=P("limiter.ceiling");
  const btn=document.querySelector("#btnParams");
  if(btn) btn.addEventListener("click",open);
  window.VM_openParams=open;
})();

/* ---------- command bar (PC) ----------
   Open with ":" or Ctrl+K. Commands:
     set <param> <value> | get <param> | params
     sel /regex/                       select first matching track
     @/regex/ vol|pan|mute|solo ...    apply to all matching tracks
     vol <dB> | pan <-100..100|L30|R45|C> | mute | solo   (selected track)
     gain <dB> | fadein <s> | fadeout <s> | xfade [s]     (selected clip)
     undo | redo | play | stop | help                     */
(function(){
  if(/pitch\.html|export\.html|manual\.html/.test(location.pathname)) return;
  let bar=null, input=null, out=null;
  function ensure(){
    if(bar) return;
    bar=document.createElement("div"); bar.className="cmdbar";
    bar.innerHTML='<span class="cmdprompt">&gt;</span><input type="text" autocomplete="off" spellcheck="false" placeholder="help"><span class="cmdout"></span>';
    document.body.appendChild(bar);
    input=bar.querySelector("input"); out=bar.querySelector(".cmdout");
    input.addEventListener("keydown",function(e){
      e.stopPropagation();
      if(e.key==="Enter"){ run(input.value); closeBar(); }
      else if(e.key==="Escape") closeBar();
    });
    input.addEventListener("blur",function(){ setTimeout(function(){ if(bar&&document.activeElement!==input) bar.classList.remove("open"); },200); });
  }
  function openBar(){ ensure(); bar.classList.add("open"); input.value=""; out.textContent=""; setTimeout(function(){ input.focus(); },0); }
  function closeBar(){ if(bar) bar.classList.remove("open"); if(input) input.blur(); }
  document.addEventListener("keydown",function(e){
    const t=e.target;
    if(t&&t.closest&&t.closest("input,textarea,select,[contenteditable]")) return;
    if(e.key===":"||((e.ctrlKey||e.metaKey)&&(e.key==="k"||e.key==="K"))){ e.preventDefault(); openBar(); }
  });
  function say(msg){ if(out) out.textContent=msg; toast(msg); }
  function parseRegex(tok){
    const m=/^\/(.*)\/([a-z]*)$/.exec(tok||"");
    if(m) return new RegExp(m[1],m[2]||"");
    return new RegExp(tok);
  }
  function parsePan(tok){
    if(!tok) return null;
    if(tok==="C"||tok==="c") return 0;
    const m=/^([LR])([\d.]+)$/.exec(tok);
    if(m) return (m[1]==="L"?-1:1)*Math.min(100,parseFloat(m[2]))/100;
    const n=parseFloat(tok); return isFinite(n)?Math.max(-100,Math.min(100,n))/100:null;
  }
  function run(raw){
    const s=(raw||"").trim(); if(!s) return;
    let rest=s, targets=null;
    const tm=/^@(\/\S+\/[a-z]*|\S+)\s+(.*)$/.exec(s);
    if(tm){
      let re; try{ re=parseRegex(tm[1]); }catch(e){ say("Bad regex: "+e.message); return; }
      targets=S.tracks.filter(function(t){ return re.test(t.name); });
      rest=tm[2];
      if(!targets.length){ say("No tracks match"); return; }
    }
    const parts=rest.split(/\s+/), verb=(parts[0]||"").toLowerCase(), args=parts.slice(1);
    const num=function(v){ const n=parseFloat(v); return isFinite(n)?n:null; };
    try{
      if(verb==="help"){ say("Keys: Space S J/K H/L M O U D R 1-4 +- Enter · Cmds: set/get · sel /re/ · @/re/ vol|pan|mute|solo · tab · zoom · seek · bpm · master · limiter · loop · addtrack · dup · rename · snap · rec · export · pitch · gain · fadein · fadeout · xfade · undo · redo · play · stop · params"); return; }
      if(verb==="set"){ say(setParam(args[0],args[1])? args[0]+" = "+P(args[0]) : "Unknown param: "+args[0]); return; }
      if(verb==="get"){ const v=P(args[0]); say(v===undefined? "Unknown param: "+args[0] : args[0]+" = "+v); return; }
      if(verb==="params"){ if(window.VM_openParams) window.VM_openParams(); closeBar(); return; }
      if(verb==="undo"){ const b=document.querySelector("#btnUndo"); if(b) b.click(); say("Undo"); return; }
      if(verb==="redo"){ const b=document.querySelector("#btnRedo"); if(b) b.click(); say("Redo"); return; }
      if(verb==="play"){ play(); closeBar(); return; }
      if(verb==="stop"){ pause(); S.pos=0; say("Stop"); return; }
      if(verb==="sel"){
        const re=parseRegex(args[0]||"");
        const tr=S.tracks.find(function(t){ return re.test(t.name); });
        if(!tr){ say("No track matches"); return; }
        S.selTrack=tr.id; S.selClip=tr.clips.length?tr.clips[0].id:null;
        renderTimeline(); renderInspector(); say("Selected: "+tr.name); return;
      }
      if(verb==="phase"){
        const tr=S.tracks.find(t=>t.id===S.selTrack); if(!tr){ say("Select a track first"); return; }
        tr.phaseInv=!tr.phaseInv;
        if(tr.nodes&&S.ctx) tr.nodes.input.gain.setTargetAtTime(tr.phaseInv?-1:1,S.ctx.currentTime,0.01);
        renderTimeline(); say("Polarity "+(tr.phaseInv?"inverted":"normal")+" — "+tr.name); return;
      }
      if(verb==="norm"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        normalizeClip(f.cl); say("Normalized to "+P("norm.target")+" dB peak"); return;
      }
      if(verb==="splitauto"||verb==="strip"||verb==="reverse"||verb==="glue"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        if(verb==="splitauto"){ splitAtSilence(f.tr,f.cl); say("Split at silence (threshold "+P("silence.db")+" dB)"); }
        else if(verb==="strip"){ stripSilence(f.tr,f.cl); say("Stripped silence"); }
        else if(verb==="reverse"){ f.cl.reversed=!f.cl.reversed; f.cl._revCache=null; renderTimeline(); renderInspector(); say(f.cl.reversed?"Clip reversed":"Clip forward"); }
        else { glueWithNext(f.tr,f.cl); say("Gluing…"); }
        return;
      }
      if(verb==="slip"||verb==="nudge"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        const v=parseFloat(args[0]); if(isNaN(v)){ say(verb+" <seconds>"); return; }
        if(verb==="slip"){ slipClip(f.cl,v); say("Slip: offset "+f.cl.offset.toFixed(2)+" s"); }
        else { nudgeSelected(v); say("Nudge: start "+f.cl.start.toFixed(2)+" s"); }
        return;
      }
      if(verb==="keys"){ toggleKeysPanel(); say("Shortcut panel toggled"); return; }
      if(verb==="clips"){
        const log=S.clipLog||[];
        if(args[0]==="clear"){ S.clipLog=[]; const ce=$("#clipStat"); if(ce) ce.textContent=""; say("Clip history cleared"); return; }
        if(args[0]==="go"){ const i=parseInt(args[1])-1;
          if(log[i]){ seek(log[i].t); say("Seek: clip at "+log[i].t.toFixed(1)+"s"); } else say("clips go <number from clips>"); return; }
        say(log.length?log.map(function(c,i){ return (i+1)+": "+c.t.toFixed(1)+"s ("+c.peak+")"; }).join(" · "):"No clipping recorded");
        return;
      }
      if(verb==="vca"){
        const sub=args[0]; S.vcas=S.vcas||[];
        if(sub==="new"){ const name=args.slice(1).join(" ")||("VCA "+(S.vcas.length+1));
          S.vcas.push({id:nid(), name:name, gain:0}); say("VCA created: "+name); return; }
        if(sub==="gain"){ const v=S.vcas.find(function(x){ return x.name===args[1]; })||S.vcas[parseInt(args[1])-1];
          const g=parseFloat(args[2]); if(!v||isNaN(g)){ say("vca gain <name|#> <dB>"); return; }
          v.gain=clamp(g,-60,6); applyVcaLive(v); say("VCA "+v.name+": "+fmtDb(v.gain)); return; }
        if(sub==="del"){ const i=S.vcas.findIndex(function(x){ return x.name===args[1]; });
          if(i<0){ say("VCA not found"); return; } const gone=S.vcas[i];
          S.tracks.forEach(function(tr){ if(tr.vca===gone.id) tr.vca=null; }); S.vcas.splice(i,1); say("VCA deleted: "+gone.name); return; }
        say(S.vcas.length?S.vcas.map(function(v,i){ return (i+1)+": "+v.name+" "+fmtDb(v.gain); }).join(" · "):"No VCAs — 'vca new <name>'");
        return;
      }
      if(verb==="template"){
        const sub=args[0], name=args.slice(1).join(" ");
        if(sub==="save"){ if(!name){ say("template save <name>"); return; } say(saveTemplate(name)?"Template saved: "+name:"Template save failed"); return; }
        if(sub==="load"){ say(loadTemplate(name)?"Template loaded: "+name:"Template not found: "+name); return; }
        if(sub==="del"){ const all=templatesAll(); if(!all[name]){ say("Template not found"); return; }
          delete all[name]; try{ localStorage.setItem("vocalmix-templates",JSON.stringify(all)); }catch(e){} say("Template deleted: "+name); return; }
        const names=Object.keys(templatesAll()); say(names.length?names.join(" · "):"No templates — 'template save <name>'");
        return;
      }
      if(verb==="recent"){ const l=recentLog();
        say(l.length?l.map(function(r){ const d=new Date(r.t); return r.label+" ("+d.getMonth()+"/"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+")"; }).join(" · "):"Nothing recent yet");
        return; }
      if(verb==="note"){ const tr=selTrackObj(); if(!tr){ say("No track selected"); return; }
        if(args.length){ tr.note=args.join(" "); say("Note saved"); } else say(tr.note||"No note"); return; }
      if(verb==="color"){ const tr=selTrackObj(); if(!tr){ say("No track selected"); return; }
        if(/^#[0-9a-fA-F]{6}$/.test(args[0]||"")){ tr.color=args[0]; renderTimeline(); renderInspector(); say("Color: "+args[0]); } else say("color <#rrggbb>"); return; }
      if(verb==="mono"){ const tr=selTrackObj(); if(!tr){ say("No track selected"); return; }
        tr.mono=!tr.mono; if(S.ctx) buildTrackGraph(tr); if(S.playing) startSources(currentPos()); renderTimeline(); say(tr.name+": mono "+(tr.mono?"on":"off")); return; }
      if(verb==="wzoom"){ const v=parseFloat(args[0]);
        if(isNaN(v)){ say("Waveform zoom: "+(S.waveZoom||1)+"x — 'wzoom <0.25-4>'"); return; }
        S.waveZoom=clamp(v,0.25,4); const zv2=$("#zoomV"); if(zv2) zv2.value=Math.round(S.waveZoom*100);
        renderTimeline(); say("Waveform zoom "+S.waveZoom+"x"); return; }
      if(verb==="stretch"){ const f=findClip(S.selClip); const v=parseFloat(args[0]);
        if(!f){ say("Select a clip first"); return; }
        if(isNaN(v)||v<0.25||v>4){ say("Usage: stretch <0.25-4>"); return; }
        stretchClip(f.cl, v); say("Stretched x"+v); return; }
      if(verb==="harmony"){ const f=findClip(S.selClip); const v=parseInt(args[0]);
        if(!f){ say("Select a clip first"); return; }
        if(isNaN(v)){ say("Usage: harmony <semitones, e.g. 4>"); return; }
        makeHarmony(f.cl, v); say("Creating harmony track ("+v+" st)..."); return; }
      if(verb==="align"){ const f=findClip(S.selClip);
        if(!f){ say("Select a clip first"); return; }
        const ref=S.tracks.find(t=>t.id!==f.tr.id&&t.clips.length);
        if(!ref){ say("No reference track with a clip"); return; }
        alignClipToRef(f.cl, ref.clips[0]); say("Aligned to "+ref.name); return; }
      if(verb==="formant"){ const f=findClip(S.selClip); const v=parseFloat(args[0]);
        if(!f){ say("Select a clip first"); return; }
        if(isNaN(v)){ say("Usage: formant <semitones, e.g. -3>"); return; }
        formantClip(f.cl, v); say("Formant "+v+" st"); return; }
      if(verb==="freeze"){ const tr=selTrackObj(); if(tr){ freezeTrack(tr); say("Toggling freeze on "+tr.name+"..."); } return; }
      if(verb==="bounce"){ const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        bounceClip(f.tr, f.cl); say("Bouncing clip..."); return; }
      if(verb==="gainline"){ const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        if(args[0]==="clear"){ f.cl.gainLine=[]; renderTimeline(); say("Gain line cleared"); return; }
        const t=parseFloat(args[0]), dbv=parseFloat(args[1]);
        if(isNaN(t)||isNaN(dbv)){ say("Usage: gainline <sec> <dB> | gainline clear"); return; }
        if(!f.cl.gainLine) f.cl.gainLine=[];
        f.cl.gainLine.push({t:+clamp(t,0,f.cl.dur).toFixed(3), db:clamp(dbv,-36,12)});
        f.cl.gainLine.sort((a,b)=>a.t-b.t); renderTimeline(); renderInspector();
        say("Gain line: "+f.cl.gainLine.length+" points"); return; }
      if(verb==="take"){ const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        if(args[0]==="add"){ const t=ensureTakes(f.cl); t.push(f.cl.buffer); say("Stored as Take "+t.length); renderInspector(); return; }
        const n=parseInt(args[0]);
        if(isNaN(n)){ say("Usage: take <n> | take add ("+ensureTakes(f.cl).length+" takes)"); return; }
        switchTake(f.cl, n-1); say("Take "+n+" active"); return; }
      if(verb==="repair"){ const f=findClip(S.selClip);
        if(!f){ say("Select a clip first"); return; }
        if(args[0]==="noise"){ denoiseClip(f.cl, P("repair.noise")); say("Repair: room noise"); return; }
        if(["breath","level","declick","mouth","plosive"].indexOf(args[0])<0){ say("Usage: repair breath|level|declick|mouth|plosive|noise"); return; }
        repairClip(f.cl, args[0]); say("Repair: "+args[0]); return; }
      if(verb==="sib"){ S.showSib=args[0]==="off"?false:true; renderTimeline(); say("Sibilance highlight "+(S.showSib?"on":"off")); return; }
      if(verb==="punch"){ if(args[0]==="on") S.punch=true; else if(args[0]==="off") S.punch=false; else S.punch=!S.punch;
        const pb=$("#btnPunch"); if(pb) pb.classList.toggle("on",!!S.punch);
        say("Punch-in "+(S.punch?"on (takes trim to the loop range; loop must be on)":"off")); return; }
      if(verb==="speed"){ const v=parseFloat(args[0]);
        if(isNaN(v)){ say("Audition speed: "+(S.speed||1)+"x — 'speed <0.25-2>'"); return; }
        setSpeed(clamp(v,0.25,2)); say("Audition speed "+S.speed+"x (playback only, exports unaffected)"); return; }
      if(verb==="detect"){ const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        const r=runDetect(f.cl); say(r?("Detected: "+(r.key||"key ?")+" · "+(r.bpm?r.bpm+" BPM (project tempo set)":"BPM ?")):"No audio"); return; }
      if(verb==="history"){ toggleHistPanel(); say("History panel toggled"); return; }
      if(verb==="mark"){
        S.markers=S.markers||[];
        if(args[0]==="list"){ say(S.markers.length?S.markers.map(function(m,i){ return (i+1)+": "+m.name+" @ "+m.t.toFixed(1)+"s"; }).join(" · "):"No markers"); return; }
        if(args[0]==="del"){ const i=parseInt(args[1])-1;
          if(S.markers[i]){ const nm=S.markers[i].name; S.markers.splice(i,1); drawRuler(); say("Deleted marker "+nm); } else say("mark del <number from mark list>"); return; }
        if(args[0]==="go"){ const i=parseInt(args[1])-1;
          if(S.markers[i]){ seek(S.markers[i].t); say("Seek: "+S.markers[i].name); } else say("mark go <number from mark list>"); return; }
        const m=addMarker(S.pos, args.join(" ")||undefined);
        say("Marker: "+m.name+" @ "+m.t.toFixed(1)+"s"); return;
      }
      if(verb==="sendmode"){
        const tr=S.tracks.find(t=>t.id===S.selTrack); if(!tr){ say("Select a track first"); return; }
        const which=(args[0]||"").toLowerCase(), mode=(args[1]||"").toLowerCase();
        if(["rev","dly"].indexOf(which)<0||["pre","post"].indexOf(mode)<0){ say("sendmode rev|dly pre|post"); return; }
        tr.sendMode=tr.sendMode||{rev:"post",dly:"post"}; tr.sendMode[which]=mode;
        if(S.ctx) buildTrackGraph(tr); if(S.playing) startSources(currentPos()); renderInspector();
        say("Send "+which+": "+mode+"-fader"); return;
      }
      if(verb==="metro"){
        if(args[0]==="off") S.metroOn=false; else if(args[0]==="on") S.metroOn=true; else S.metroOn=!S.metroOn;
        const b=document.querySelector("#btnMetro"); if(b) b.classList.toggle("on",S.metroOn);
        if(S.metroOn&&S.playing) metroStart(); else metroStop();
        say(S.metroOn?"Metronome ON":"Metronome OFF"); return;
      }
      if(verb==="rec"){
        if(args[0]==="stop"){ if(REC.mr) REC.mr.stop(); else say("Not recording"); return; }
        recToggle(); closeBar(); return;
      }
      if(verb==="snap"){
        const sub=(args[0]||"").toLowerCase(), nm=args.slice(1).join(" ");
        if(sub==="save"){ if(window.VM_snapSave) window.VM_snapSave(nm); else say("Snapshots are not available here"); return; }
        if(sub==="load"){ if(window.VM_snapLoad) window.VM_snapLoad(nm); else say("Snapshots are not available here"); return; }
        if(sub==="del"||sub==="delete"){ if(window.VM_snapDelete) window.VM_snapDelete(nm); else say("Snapshots are not available here"); return; }
        if(sub==="list"||!sub){ if(window.VM_snapList) window.VM_snapList().then(function(l){
          say(l.length? l.map(function(x){ return x.name; }).join(" · ") : "No snapshots"); });
          else say("Snapshots are not available here"); return; }
        say("snap: save|load|del|list <name>"); return;
      }
      if(verb==="tab"){
        const map={"1":"ch","2":"fx","3":"pitch","4":"mix",ch:"ch",channel:"ch",fx:"fx",effects:"fx",pitch:"pitch",mix:"mix",mixer:"mix"};
        const t=map[(args[0]||"").toLowerCase()]; if(!t){ say("tab: ch|fx|pitch|mix"); return; }
        curTab=t; renderInspector(); say("Tab: "+t); return;
      }
      if(verb==="zoom"){
        const a=args[0]||"+";
        if(a==="+") S.px=clamp(Math.round(S.px*1.25),8,140);
        else if(a==="-") S.px=clamp(Math.round(S.px*0.8),8,140);
        else if(a==="reset") S.px=42;
        else { const v=num(a); if(v===null){ say("zoom: +|-|reset|px"); return; } S.px=clamp(Math.round(v),8,140); }
        const z=document.querySelector("#zoomR"); if(z) z.value=S.px;
        renderTimeline(); say("Zoom "+S.px+" px/s"); return;
      }
      if(verb==="seek"){
        const a=(args[0]||"").toLowerCase(); let v=null;
        if(a==="start") v=0;
        else if(a==="end") v=projectEnd();
        else if(a==="bar"){ const b=num(args[1]); if(b!==null) v=Math.max(0,(b-1)*4*beatSec()); }
        else { const mm=/^(\d+):([\d.]+)$/.exec(a); if(mm) v=parseInt(mm[1])*60+parseFloat(mm[2]); else v=num(a); }
        if(v===null){ say("seek: <sec> | 1:30 | bar <n> | start | end"); return; }
        seek(v); say("Seek "+fmtT(v)); return;
      }
      if(verb==="bpm"){
        const v=num(args[0]); const bi=document.querySelector("#bpmIn");
        if(v===null||!bi){ say("BPM "+S.bpm); return; }
        bi.value=clamp(v,40,240); bi.dispatchEvent(new Event("change")); say("BPM "+S.bpm); return;
      }
      if(verb==="master"){
        const v=num(args[0]); const mv=document.querySelector("#masterVol");
        if(v===null||!mv){ say("master: "+(mv?mv.value:"?")+" dB"); return; }
        mv.value=clamp(v,-40,6); mv.dispatchEvent(new Event("input")); say("Master "+mv.value+" dB"); return;
      }
      if(verb==="limiter"){
        if(args[0]==="on") S.limiter.on=true;
        else if(args[0]==="off") S.limiter.on=false;
        else S.limiter.on=!S.limiter.on;
        applyLimiterLive();
        say(S.limiter.on?("Limiter ON ("+S.limiter.ceiling.toFixed(1)+" dB)"):"Limiter OFF"); return;
      }
      if(verb==="loop"){
        const lb=document.querySelector("#btnLoop");
        const sync=function(){ if(lb) lb.classList.toggle("on",S.loop.on); if(typeof drawRuler==="function") drawRuler(); };
        if(args[0]==="on"){ S.loop.on=true; sync(); say("Loop ON"); return; }
        if(args[0]==="off"){ S.loop.on=false; sync(); say("Loop OFF"); return; }
        if(args[0]==="bars"){ const a=num(args[1]), b=num(args[2]);
          if(a===null||b===null){ say("loop bars <start> <end>"); return; }
          S.loop.start=Math.max(0,(a-1)*4*beatSec()); S.loop.end=b*4*beatSec(); S.loop.on=true; sync();
          say("Loop bars "+a+"-"+b); return; }
        const a=num(args[0]), b=num(args[1]);
        if(a!==null&&b!==null){ S.loop.start=Math.min(a,b); S.loop.end=Math.max(a,b); S.loop.on=true; sync();
          say("Loop "+S.loop.start.toFixed(1)+"-"+S.loop.end.toFixed(1)+" s"); return; }
        S.loop.on=!S.loop.on; sync(); say(S.loop.on?"Loop ON":"Loop OFF"); return;
      }
      if(verb==="addtrack"){
        const types=["vocal","inst","harmony"];
        let type="vocal", nameArgs=args;
        if(types.indexOf((args[0]||"").toLowerCase())>=0){ type=args[0].toLowerCase(); nameArgs=args.slice(1); }
        const nm=nameArgs.join(" ")||((TYPES[type]?TYPES[type].label:type)+" "+(S.tracks.filter(function(t){ return t.type===type; }).length+1));
        const tr=newTrack(nm,type);
        if(type!=="inst"&&S.buses.length) tr.bus=S.buses[0].id;
        S.tracks.push(tr); if(S.ctx) buildTrackGraph(tr);
        S.selTrack=tr.id; renderTimeline(); renderInspector();
        say("Added track: "+nm); return;
      }
      if(verb==="dup"){
        const fc=findClip(S.selClip);
        if(fc){ duplicateClip(fc.tr,fc.cl); say("Clip duplicated"); return; }
        const tr=selTrackObj();
        if(tr){ dupTrack(tr); say("Track duplicated: "+tr.name); return; }
        say("Nothing to duplicate"); return;
      }
      if(verb==="rename"){
        const tr=selTrackObj(); const nm=args.join(" ");
        if(!tr||!nm){ say("rename <name> (selected track)"); return; }
        tr.name=nm; renderTimeline(); renderInspector(); say("Renamed: "+nm); return;
      }
      if(verb==="export"){ const b=document.querySelector("#btnExportGo"); if(b){ closeBar(); b.click(); } return; }
      if(verb==="manual"){ const b=document.querySelector("#btnManualGo"); if(b){ closeBar(); b.click(); } return; }
      if(verb==="pitch"){
        const fc=findClip(S.selClip);
        if(fc&&window.VM_openPitchPage){ closeBar(); window.VM_openPitchPage(fc.tr.id,fc.cl.id); }
        else say("Select a clip first"); return;
      }
      if(verb==="xfade"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        crossfadeWithNext(f.tr,f.cl,args.length?num(args[0]):null); closeBar(); return;
      }
      if(verb==="fadecurve"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        const which=(args[0]||"").toLowerCase(), cv=(args[1]||"").toLowerCase();
        if(["lin","eqp","scurve"].indexOf(cv)<0){ say("fadecurve in|out lin|eqp|scurve"); return; }
        if(which==="in") f.cl.curveIn=cv; else if(which==="out") f.cl.curveOut=cv;
        else { say("fadecurve in|out lin|eqp|scurve"); return; }
        renderInspector(); if(S.playing) startSources(currentPos());
        say("Fade "+which+" curve: "+cv); return;
      }
      if(verb==="gain"||verb==="fadein"||verb==="fadeout"){
        const f=findClip(S.selClip); if(!f){ say("Select a clip first"); return; }
        const v=num(args[0]); if(v===null){ say("Need a number"); return; }
        if(verb==="gain") f.cl.gain=Math.max(-60,Math.min(24,v));
        if(verb==="fadein") f.cl.fadeIn=Math.max(0,Math.min(f.cl.dur,v));
        if(verb==="fadeout") f.cl.fadeOut=Math.max(0,Math.min(f.cl.dur,v));
        renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
        say(verb+" = "+v); return;
      }
      if(verb==="vol"||verb==="pan"||verb==="mute"||verb==="solo"){
        const sel=S.tracks.find(function(t){ return t.id===S.selTrack; });
        const list=targets||(sel?[sel]:[]);
        if(!list.length){ say("Select a track first"); return; }
        list.forEach(function(tr){
          if(verb==="vol"){ const v=num(args[0]); if(v!==null) tr.vol=Math.max(-60,Math.min(6,v)); }
          else if(verb==="pan"){ const v=parsePan(args[0]); if(v!==null) tr.pan=v; }
          else if(verb==="mute") tr.mute=!tr.mute;
          else if(verb==="solo") tr.solo=!tr.solo;
        });
        renderTimeline(); renderInspector(); if(S.playing) startSources(currentPos());
        say(verb+" -> "+list.length+" track(s)"); return;
      }
      say("Unknown command: "+verb+" (help)");
    }catch(e){ say("Error: "+((e&&e.message)||e)); }
  }
})();

/* ---------- named snapshots ----------
   User-named, persistent project snapshots in the same IndexedDB
   store as the handoffs/autosave. Serialization is the boot's own
   (window.VM_serializeProject), so a snapshot is exactly a project
   file: restoring one is the autosave-restore path. Panel for
   touch, "snap" verbs in the command bar for keyboards. */
(function(){
  if(/(pitch|export|manual)\.html/.test(location.pathname)) return;
  const KEY="snapshots";
  function ja(){ return vmLang()==="ja"; }
  /* Strict read: null means the read FAILED (after one retry),
     which callers must not confuse with an empty list - the old
     code swallowed errors into [], so a transient IndexedDB
     hiccup (seen on iOS Safari, whose open/close churn can fail
     a read) made snapDelete report "not found" and do nothing,
     and could make snapSave overwrite the whole list with just
     the new snapshot. loadSnaps() keeps the forgiving contract
     for display; every write path uses loadSnapsRaw(). */
  let cache=null;
  async function loadSnapsRaw(){
    if(cache) return cache;
    for(let attempt=0;attempt<2;attempt++){
      try{ const db=await window.VM_idb.open(); const v=await window.VM_idb.get(db,KEY); db.close();
        cache=Array.isArray(v)?v:[]; return cache; }catch(e){ if(attempt===1) return null; await new Promise(function(r){ setTimeout(r,150); }); }
    }
    return null;
  }
  async function loadSnaps(){
    const v=await loadSnapsRaw();
    return v||[];
  }
  async function saveSnaps(list){
    for(let attempt=0;attempt<2;attempt++){
      try{ const db=await window.VM_idb.open(); await window.VM_idb.put(db,KEY,list); db.close(); cache=list; return; }
      catch(e){ if(attempt===1) throw e; await new Promise(function(r){ setTimeout(r,150); }); }
    }
  }
  async function snapSave(name){
    if(!window.VM_serializeProject){ toast("Snapshots are not available here"); return false; }
    name=(name||"").trim();
    if(!name){ const d=new Date(); name="Snapshot "+d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); }
    const list=await loadSnapsRaw();
    if(!list){ toast(ja()?"スナップショットを読み込めませんでした。もう一度お試しください":"Could not read snapshots - please try again"); return false; }
    const proj=window.VM_serializeProject();
    const rec={name:name, ts:Date.now(), tracks:(proj.tracks||[]).length, project:proj};
    const ex=list.findIndex(function(x){ return x.name===name; });
    if(ex>=0) list[ex]=rec;
    else{
      if(list.length>=P("snap.max")){ toast("Snapshot storage is full — delete one first"); return false; }
      list.push(rec);
    }
    await saveSnaps(list);
    toast("Snapshot saved: "+name); logRecent("Snapshot saved: "+name);
    return true;
  }
  async function snapLoad(name){
    const list=await loadSnapsRaw();
    if(!list){ toast(ja()?"スナップショットを読み込めませんでした。もう一度お試しください":"Could not read snapshots - please try again"); return false; }
    const rec=list.find(function(x){ return x.name===name; });
    if(!rec){ toast("Snapshot not found: "+name); return false; }
    if(S.playing) pause();
    window.VM_restoreProject(rec.project);
    renderTimeline(); renderInspector();
    toast("Snapshot loaded: "+name); logRecent("Snapshot loaded: "+name);
    return true;
  }
  async function snapDelete(name){
    const list=await loadSnapsRaw();
    if(!list){ toast(ja()?"スナップショットを読み込めませんでした。もう一度お試しください":"Could not read snapshots - please try again"); return false; }
    const next=list.filter(function(x){ return x.name!==name; });
    if(next.length===list.length){ toast("Snapshot not found: "+name); return false; }
    try{ await saveSnaps(next); }
    catch(e){ toast(ja()?"削除を保存できませんでした":"Could not save the deletion - please try again"); return false; }
    toast("Snapshot deleted: "+name);
    return next;
  }
  window.VM_snapSave=snapSave; window.VM_snapLoad=snapLoad;
  window.VM_snapDelete=snapDelete; window.VM_snapList=loadSnaps;

  /* panel */
  const panel=document.createElement("div");
  panel.className="parampanel snappanel";
  const head=document.createElement("div"); head.className="pp-head";
  const title=document.createElement("span"); title.textContent=(ja()?"スナップショット":"Snapshots")+(window.VM_BUILD?" · build "+window.VM_BUILD:""); title.style.fontSize="12px";
  const close=document.createElement("button"); close.className="ghost"; close.textContent="✕";
  close.addEventListener("click",function(){ panel.classList.remove("open"); });
  head.appendChild(title); head.appendChild(close);
  const newRow=document.createElement("div"); newRow.className="snapnew";
  const nameIn=document.createElement("input"); nameIn.type="text";
  nameIn.placeholder=ja()?"スナップショット名":"Snapshot name";
  const saveBtn=document.createElement("button"); saveBtn.textContent=ja()?"保存":"Save";
  newRow.appendChild(nameIn); newRow.appendChild(saveBtn);
  const listEl=document.createElement("div");
  panel.appendChild(head); panel.appendChild(newRow); panel.appendChild(listEl);
  document.body.appendChild(panel);
  async function refresh(known){
    listEl.textContent="";
    const list=Array.isArray(known)?known:await loadSnaps();
    const recs=recentLog();
    if(recs.length){ const h=document.createElement("p"); h.className="small"; h.style.fontWeight="700";
      h.textContent=ja()?"最近":"Recent"; listEl.appendChild(h);
      recs.slice(0,5).forEach(function(r){ const row=document.createElement("div"); row.className="snaprow";
        const info=document.createElement("span"); info.className="snapinfo";
        const d=new Date(r.t); info.textContent=r.label+" · "+d.getMonth()+"/"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
        row.appendChild(info); listEl.appendChild(row); }); }
    if(!list.length){ const p=document.createElement("p"); p.className="small";
      p.textContent=ja()?"まだスナップショットはありません":"No snapshots yet"; listEl.appendChild(p); return; }
    list.slice().sort(function(a,b){ return b.ts-a.ts; }).forEach(function(rec){
      const row=document.createElement("div"); row.className="snaprow";
      const info=document.createElement("span"); info.className="snapinfo";
      const d=new Date(rec.ts);
      info.textContent=rec.name+" · "+d.getMonth()+"/"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+" · "+rec.tracks+(ja()?" トラック":" tracks");
      const lb=document.createElement("button"); lb.textContent=ja()?"読込":"Load";
      lb.addEventListener("click",async function(){ await snapLoad(rec.name); refresh(); });
      const db2=document.createElement("button"); db2.className="delbtn"; db2.textContent=ja()?"削除":"Delete";
      let armed=false, armTimer=null;
      db2.addEventListener("click",async function(){
        if(!armed){
          armed=true; db2.classList.add("confirm"); db2.textContent=ja()?"本当に削除":"Sure?";
          armTimer=setTimeout(function(){ armed=false; db2.classList.remove("confirm"); db2.textContent=ja()?"削除":"Delete"; }, 3000);
          return;
        }
        clearTimeout(armTimer);
        row.style.opacity="0.35"; db2.disabled=true;
        const nl=await snapDelete(rec.name);
        if(Array.isArray(nl)) refresh(nl);
        else{ row.style.opacity=""; db2.disabled=false; db2.classList.remove("confirm"); db2.textContent=ja()?"削除":"Delete"; armed=false; refresh(); }
      });
      row.appendChild(info); row.appendChild(lb); row.appendChild(db2);
      listEl.appendChild(row);
    });
  }
  saveBtn.addEventListener("click",async function(){
    if(await snapSave(nameIn.value)){ nameIn.value=""; refresh(); }
  });
  const btn=document.querySelector("#btnSnaps");
  function openSnaps(){ panel.classList.toggle("open"); if(panel.classList.contains("open")) refresh(); }
  if(btn) btn.addEventListener("click",openSnaps);
  window.VM_openSnaps=openSnaps;
})();

/* ---------- metronome / count-in ----------
   A practice click that follows playback (4/4, accent on beat 1).
   Clicks are scheduled against the same ctx clock as the sources,
   routed into the master fader (live only — never in exports).
   With metro.countin > 0 bars, play/record first plays that many
   bars of clicks before the project starts. */
function makeClickBuf(accent){
  const ctx=S.ctx, sr=ctx.sampleRate, len=Math.floor(sr*0.03);
  const buf=ctx.createBuffer(1,len,sr), d=buf.getChannelData(0);
  const f=accent?2000:1400;
  for(let i=0;i<len;i++){ const t=i/sr; d[i]=Math.sin(2*Math.PI*f*t)*Math.exp(-t/0.008); }
  return buf;
}
function scheduleClick(t, accent){
  if(!S.ctx||!S.master) return;
  if(!S._clickHi){ S._clickHi=makeClickBuf(true); S._clickLo=makeClickBuf(false); }
  const src=S.ctx.createBufferSource(); src.buffer=accent?S._clickHi:S._clickLo;
  const g=S.ctx.createGain(); g.gain.value=(accent?0.6:0.42)*P("metro.vol")/50;
  src.connect(g); g.connect(S.master); src.start(t);
}
const METRO={timer:null};
function metroStart(){
  metroStop();
  if(!S.metroOn||!S.playing) return;
  S._metroNext=Math.ceil(S.playPosStart/beatSec()-1e-6);
  const tick=function(){
    if(!S.playing) return;
    const ahead=S.ctx.currentTime+0.18, bs=beatSec();
    let k=S._metroNext;
    while(true){
      const t=S.playCtxStart+(k*bs-S.playPosStart);
      if(t>ahead) break;
      if(t>=S.ctx.currentTime-0.05) scheduleClick(t,((k%4)+4)%4===0);
      k++;
    }
    S._metroNext=k;
  };
  METRO.timer=setInterval(tick,90); tick();
}
function metroStop(){ if(METRO.timer){ clearInterval(METRO.timer); METRO.timer=null; } }
(function(){
  const btn=document.querySelector("#btnMetro");
  if(btn) btn.addEventListener("click",function(){
    S.metroOn=!S.metroOn;
    btn.classList.toggle("on",S.metroOn);
    toast(S.metroOn?"Metronome ON":"Metronome OFF");
    if(S.metroOn&&S.playing) metroStart(); else metroStop();
  });
  window.VM_metroStart=metroStart; window.VM_metroStop=metroStop;
})();

/* ---------- transport extras: tap tempo (#69), speed (#70), punch (#64) ---------- */
function setSpeed(x){ S.speed=x; const sp=$("#speedSel"); if(sp) sp.value=String(x);
  if(S.playing) startSources(currentPos()); }
(function(){
  let taps=[];
  const tapBtn=$("#btnTap");
  if(tapBtn) tapBtn.addEventListener("click",function(){
    const now=performance.now();
    taps=taps.filter(function(t){ return now-t<2000; }); taps.push(now);
    if(taps.length>=3){ const iv=(taps[taps.length-1]-taps[0])/(taps.length-1);
      const bpm=Math.round(60000/iv);
      if(bpm>=40&&bpm<=240){ S.bpm=bpm; const bi=$("#bpmIn"); if(bi) bi.value=bpm; renderTimeline(); toast("Tempo: "+bpm+" BPM"); } }
  });
  const sp=$("#speedSel");
  if(sp) sp.addEventListener("change",function(){ setSpeed(parseFloat(sp.value)); });
  const hb=$("#btnHist");
  if(hb) hb.addEventListener("click",function(){ toggleHistPanel(); });
  const pb=$("#btnPunch");
  if(pb) pb.addEventListener("click",function(){ S.punch=!S.punch; pb.classList.toggle("on",!!S.punch);
    toast(S.punch?"Punch-in on: takes are trimmed to the loop range":"Punch-in off"); });
})();

/* ---------- keyboard shortcut panel (?) ---------- */
function toggleKeysPanel(){
  let kp=$("#keysPanel");
  if(kp){ kp.style.display=kp.style.display==="none"?"block":"none"; return; }
  kp=document.createElement("div"); kp.id="keysPanel";
  const rows=[["Space","Play / Pause"],["S","Split at playhead"],["Delete","Delete clip"],["Home","Back to start"],
    ["J / K","Select track down / up"],["H / L","Seek -1 s / +1 s (Shift: 5 s)"],["M / O","Mute / Solo track"],
    ["U / Shift+U","Undo / Redo"],["D","Duplicate clip (or track)"],["R","Record"],["1-4","Tabs"],["+ / -","Zoom"],
    [", / .","Nudge clip by one beat"],["Enter","Play from start"],[": or Ctrl+K","Command bar"],["?","This panel"]];
  kp.innerHTML="<h3 style='margin:0 0 8px'>Keyboard Shortcuts</h3>"+
    rows.map(function(r){ return "<div style='display:flex;gap:10px;padding:2px 0'><b style='min-width:110px;font-family:var(--mono)'>"+r[0]+"</b><span>"+r[1]+"</span></div>"; }).join("")+
    "<p class='small'>Click anywhere or press Esc to close.</p>";
  kp.addEventListener("click",function(){ kp.style.display="none"; });
  document.body.appendChild(kp);
  const sec=document.createElement("div"); sec.style.marginTop="12px";
  sec.addEventListener("click",function(e){ e.stopPropagation(); });
  const renderSec=function(){ const KM=keymap();
    sec.innerHTML="<h4 style='margin:4px 0'>Remap Keys</h4>"+
      KEY_ACTIONS.map(function(a){ return "<div style='display:flex;gap:10px;padding:2px 0;align-items:center'><span style='flex:1'>"+a[1]+"</span><b style='font-family:var(--mono)'>"+KM[a[0]].toUpperCase()+"</b><button class='ghost' data-kr='"+a[0]+"'>Set</button></div>"; }).join("")+
      "<button class='ghost' id='krReset'>Reset all keys</button>";
    sec.querySelectorAll("[data-kr]").forEach(function(b){ b.onclick=function(){ b.textContent="press a key...";
      const cap=function(ev){ ev.preventDefault(); ev.stopPropagation();
        if(ev.key.length===1) setKeymap(b.dataset.kr, ev.key.toLowerCase());
        document.removeEventListener("keydown",cap,true); renderSec(); };
      document.addEventListener("keydown",cap,true); }; });
    const rs=sec.querySelector("#krReset"); if(rs) rs.onclick=function(){ resetKeymap(); renderSec(); };
  };
  renderSec();
  kp.appendChild(sec);
}

/* ---------- history panel (#82) ---------- */
function buildHistRows(hp){
  const H=window.VM_historyList?window.VM_historyList():{past:[],now:0,future:0};
  const fmt=function(t){ return t?new Date(t).toTimeString().slice(0,8):"\u2014"; };
  let h="<h3 style='margin:0 0 8px'>History</h3>";
  h+="<div style='padding:2px 0'><b>Now</b> <span>"+fmt(H.now)+"</span></div>";
  for(let i=H.past.length-1;i>=0;i--){ const back=H.past.length-i;
    h+="<div style='padding:2px 0'><button class='ghost' data-hist='"+i+"'>"+fmt(H.past[i])+"</button> <span class='small'>"+back+" step"+(back>1?"s":"")+" back</span></div>"; }
  if(H.future) h+="<p class='small'>"+H.future+" redo step(s) available (Redo / Shift+U)</p>";
  if(!H.past.length) h+="<p class='small'>No earlier states yet. Edits you make will appear here.</p>";
  h+="<p class='small'>Click a time to jump there. Jumping is itself undoable with Redo.</p>";
  hp.innerHTML=h;
  hp.querySelectorAll("[data-hist]").forEach(function(b){ b.addEventListener("click",function(){
    window.VM_historyJump(parseInt(b.dataset.hist)); hp.style.display="none"; }); });
}
function toggleHistPanel(){
  let hp=$("#histPanel");
  if(hp){ const show=hp.style.display==="none"; hp.style.display=show?"block":"none"; if(show) buildHistRows(hp); return; }
  hp=document.createElement("div"); hp.id="histPanel";
  buildHistRows(hp);
  hp.addEventListener("click",function(e){ if(e.target===hp) hp.style.display="none"; });
  document.body.appendChild(hp);
}

/* ---------- drag & drop import ---------- */
["dragenter","dragover"].forEach(function(ev){ document.addEventListener(ev,function(e){ e.preventDefault(); document.body.classList.add("dropping"); }); });
document.addEventListener("dragleave",function(e){ if(!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop",function(e){ e.preventDefault(); document.body.classList.remove("dropping");
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

/* ---------- gain staging check (#40) ---------- */
function peakOfBuf(buf, off, dur){
  const sr=buf.sampleRate; let pk=0;
  for(let c=0;c<buf.numberOfChannels;c++){ const d=buf.getChannelData(c);
    const a=Math.floor(off*sr), b=Math.min(d.length, Math.floor((off+dur)*sr));
    for(let i=a;i<b;i+=2){ const v=Math.abs(d[i]); if(v>pk)pk=v; } }
  return pk;
}
async function checkGainStaging(tr, outEl){
  const cl=tr.clips.find(function(c){ return c.buffer; });
  if(!cl){ if(outEl) outEl.innerHTML="<p class='small'>No audio clip on this track.</p>"; return; }
  ensureCtx();
  const sr=48000, dur=Math.min(3, cl.dur), base=clipBuffer(cl);
  const rows=[{name:"Clip (source)", peak:peakOfBuf(base, cl.offset, dur)}];
  for(let i=0;i<tr.fx.length;i++){
    if(!tr.fx[i].on){ rows.push({name:FXNAMES[tr.fx[i].type]+" (off)", peak:null}); continue; }
    const oc=new OfflineAudioContext(2, Math.ceil(sr*dur), sr);
    const src=oc.createBufferSource(); src.buffer=base;
    let node=src;
    for(let j=0;j<=i;j++){ if(!tr.fx[j].on) continue; const n=fxNodes(oc, tr.fx[j]); node.connect(n.input); node=n.output; }
    node.connect(oc.destination); src.start(0, cl.offset, dur);
    const rendered=await oc.startRendering();
    rows.push({name:FXNAMES[tr.fx[i].type], peak:peakOfBuf(rendered, 0, dur)});
  }
  if(outEl){
    outEl.innerHTML=rows.map(function(r){
      if(r.peak===null) return "<div class='small'>"+esc(r.name)+": \u2014</div>";
      const db=20*Math.log10(Math.max(r.peak,1e-6));
      const col=db>-1?"#e5534b":(db>-6?"#d8a723":(db>=-18?"#57c7a3":"#7aa2f7"));
      return "<div class='small'><span style='color:"+col+"'>\u25CF</span> "+esc(r.name)+": peak "+db.toFixed(1)+" dB</div>";
    }).join("")+"<p class='small'>Green is a healthy -18..-6 dB; red means the stage output is at the ceiling.</p>";
  }
  return rows;
}

/* ---------- reference track A/B (#60) ---------- */
const refTrk={buf:null, name:"", src:null, gainNode:null, gain:0};
function refStop(){ if(refTrk.src){ try{ refTrk.src.stop(); }catch(e){} refTrk.src=null; } }
function refPlay(){
  if(!refTrk.buf){ toast("Load a reference file first"); return; }
  ensureCtx(); refStop();
  const src=S.ctx.createBufferSource(); src.buffer=refTrk.buf;
  const g=S.ctx.createGain(); g.gain.value=db2lin(refTrk.gain||0);
  src.connect(g); g.connect(S.master);
  src.onended=function(){ if(refTrk.src===src) refTrk.src=null; };
  src.start(); refTrk.src=src; refTrk.gainNode=g;
}
async function refLoad(file){
  ensureCtx();
  const ab=await file.arrayBuffer();
  refTrk.buf=await S.ctx.decodeAudioData(ab); refTrk.name=file.name;
  const st=$("#refStat"); if(st) st.textContent=file.name+" · "+refTrk.buf.duration.toFixed(1)+" s";
  toast("Reference loaded: "+file.name);
}

/* ---------- VCA groups / recent log / templates ---------- */
function vcaDb(tr){ if(!tr||!tr.vca) return 0; const v=(S.vcas||[]).find(function(x){ return x.id===tr.vca; }); return v?v.gain:0; }
function effVol(tr){ return tr.vol+vcaDb(tr); }
function applyVcaLive(v){ if(!S.ctx) return; (S.tracks||[]).forEach(function(tr){ if(tr.vca===v.id&&tr.nodes) tr.nodes.fader.gain.setTargetAtTime(db2lin(effVol(tr)),S.ctx.currentTime,0.03); }); }
function recentLog(){ try{ return JSON.parse(localStorage.getItem("vocalmix-recent")||"[]"); }catch(e){ return []; } }
function logRecent(label){ try{ const l=recentLog().filter(function(r){ return r.label!==label; });
  l.unshift({label:label,t:Date.now()}); localStorage.setItem("vocalmix-recent",JSON.stringify(l.slice(0,10))); }catch(e){} }
function templatesAll(){ try{ return JSON.parse(localStorage.getItem("vocalmix-templates")||"{}"); }catch(e){ return {}; } }
function saveTemplate(name){
  if(!window.VM_serializeProject) return false;
  /* serializeProject already returns a detached, sanitized copy;
     a template keeps the structure only: no clips, no audio buffers
     (the field is "bufs"), no markers, no dangling clip selection. */
  const t=window.VM_serializeProject();
  (t.tracks||[]).forEach(function(tr){ tr.clips=[]; });
  t.bufs=[]; t.markers=[]; t.selClip=null;
  const all=templatesAll(); all[name]=t;
  try{ localStorage.setItem("vocalmix-templates",JSON.stringify(all)); }catch(e){ return false; }
  return true;
}
function loadTemplate(name){
  const all=templatesAll(); if(!all[name]||!window.VM_restoreProject) return false;
  if(S.playing) pause();
  window.VM_restoreProject(JSON.parse(JSON.stringify(all[name])));
  renderTimeline(); renderInspector();
  return true;
}

/* ---------- markers ---------- */
function addMarker(t, name){
  S.markers=S.markers||[];
  const m={t:Math.round(t*100)/100, name:name||("M"+(S.markers.length+1))};
  S.markers.push(m); S.markers.sort(function(a,b){ return a.t-b.t; });
  drawRuler(); toast("Marker: "+m.name+" @ "+m.t.toFixed(1)+"s");
  return m;
}
(function(){
  const btn=document.querySelector("#btnMark");
  if(btn) btn.addEventListener("click",function(){ addMarker(currentPos()); });
})();

/* ---------- microphone recording ----------
   Record along with playback: the take starts at the playhead,
   and on stop it lands as a clip on a new track at that position
   (shifted by the rec.offsetMs parameter for interface latency).
   Mic processing (echo cancellation / noise suppression / AGC) is
   off unless rec.processing is 1 — for singing, raw is right. */
const REC={mr:null, stream:null, chunks:[], startPos:0, busy:false};
async function recStart(){
  if(REC.mr||REC.busy) return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||typeof MediaRecorder==="undefined"){
    toast("Microphone recording is not supported in this browser"); return;
  }
  ensureCtx();
  const proc=P("rec.processing")>=1;
  let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:proc, noiseSuppression:proc, autoGainControl:proc}});
  }catch(e){ toast("Microphone unavailable: "+((e&&e.name)||e)); return; }
  REC.stream=stream; REC.chunks=[];
  REC.startPos=S.playing?currentPos():S.pos;
  let mr;
  try{ mr=new MediaRecorder(stream); }
  catch(e){ stream.getTracks().forEach(function(t){ t.stop(); }); toast("Microphone unavailable: "+((e&&e.name)||e)); return; }
  REC.mr=mr;
  mr.ondataavailable=function(ev){ if(ev.data&&ev.data.size) REC.chunks.push(ev.data); };
  mr.onstop=recFinish;
  mr.start(250);
  const btn=document.querySelector("#btnRec"); if(btn) btn.classList.add("recording");
  if(!S.playing) play();
  toast("Recording…");
}
async function recFinish(){
  const mr=REC.mr; REC.mr=null;
  const btn=document.querySelector("#btnRec"); if(btn) btn.classList.remove("recording");
  if(S.playing) pause();
  if(REC.stream){ REC.stream.getTracks().forEach(function(t){ t.stop(); }); REC.stream=null; }
  if(!REC.chunks.length){ toast("Nothing was recorded"); return; }
  REC.busy=true;
  try{
    const blob=new Blob(REC.chunks, {type:(mr&&mr.mimeType)||"audio/webm"});
    const ab=await blob.arrayBuffer();
    const buf=await S.ctx.decodeAudioData(ab);
    const n=S.tracks.filter(function(t){ return t.name.indexOf("Recorded")===0; }).length+1;
    const tr=newTrack("Recorded "+n,"vocal");
    if(S.buses.length) tr.bus=S.buses[0].id;
    const start=Math.max(0, REC.startPos + P("rec.offsetMs")/1000);
    const cl={id:nid(), name:"Take "+new Date().toTimeString().slice(0,8), buffer:buf,
      start:start, offset:0, dur:buf.duration, gain:0, fadeIn:0, fadeOut:0, muted:false};
    if(S.punch&&S.loop&&S.loop.on){
      /* Punch-in (#64): keep only the part of the take that falls
         inside the loop range. */
      const ns=Math.max(cl.start, S.loop.start), ne=Math.min(cl.start+cl.dur, S.loop.end);
      if(ne-ns<0.05){ toast("Punch: nothing recorded inside the loop range"); REC.busy=false; return; }
      cl.offset+=ns-cl.start; cl.start=ns; cl.dur=ne-ns;
    }
    const takeTr=S.takeMode?S.tracks.find(t=>t.id===S.selTrack&&!t.isFolder):null;
    if(takeTr){
      /* Take mode (#65): the recording lands on the selected track.
         Over an existing clip it becomes a new take of that clip. */
      const host=takeTr.clips.find(c=>cl.start<c.start+c.dur&&cl.start+cl.dur>c.start);
      if(host){ const tk=ensureTakes(host); tk.push(buf); host.takeIdx=tk.length-1;
        host.buffer=buf; host.sourceBuffer=buf;
        if(host.offset+host.dur>buf.duration) host.dur=Math.max(0.05, buf.duration-host.offset);
        host._corrCache=null; host._revCache=null;
        S.selTrack=takeTr.id; S.selClip=host.id;
        renderTimeline(); renderInspector();
        toast("Take "+tk.length+" recorded on "+takeTr.name);
        REC.busy=false; return;
      }
      cl.takes=[buf]; cl.takeIdx=0;
      takeTr.clips.push(cl);
      S.selTrack=takeTr.id; S.selClip=cl.id;
      renderTimeline(); renderInspector();
      toast("Take recorded on "+takeTr.name);
      REC.busy=false; return;
    }
    tr.clips.push(cl);
    S.tracks.push(tr);
    if(S.ctx) buildTrackGraph(tr);
    S.selTrack=tr.id; S.selClip=cl.id;
    renderTimeline(); renderInspector();
    toast("Recorded take added: "+tr.name);
  }catch(e){ toast("Could not decode the recording: "+((e&&e.message)||e)); }
  REC.busy=false;
}
function recToggle(){ if(REC.mr){ REC.mr.stop(); } else recStart(); }
(function(){
  const tb=document.querySelector("#btnTake");
  if(tb) tb.addEventListener("click",function(){ S.takeMode=!S.takeMode;
    tb.classList.toggle("on", S.takeMode);
    toast(S.takeMode?"Take mode ON: recordings land on the selected track as takes":"Take mode OFF"); });
})();
(function(){
  const btn=document.querySelector("#btnRec");
  if(btn) btn.addEventListener("click",recToggle);
  window.VM_recToggle=recToggle;
})();

(function(){
  const chip=document.querySelector("#btnLimiter");
  if(chip) chip.addEventListener("click",function(){
    S.limiter.on=!S.limiter.on;
    applyLimiterLive();
    toast(S.limiter.on?("Limiter ON ("+S.limiter.ceiling.toFixed(1)+" dB)"):"Limiter OFF");
  });
})();

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
    if(!baseline.t) baseline.t=Date.now();
    undoStack.push(baseline);
    if(undoStack.length>P("undo.depth")) undoStack.shift();
    redoStack=[];
    baseline=snap; if(!baseline.t) baseline.t=Date.now();
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
  /* History panel API (#82): list the undo states with their times
     and jump straight to one (the states in between move to the
     redo stack, so the jump itself is undoable via Redo). */
  window.VM_historyList=function(){ return { past:undoStack.map(function(sn){ return sn.t||0; }),
    now:baseline?(baseline.t||0):0, future:redoStack.length }; };
  window.VM_historyJump=function(idx){ if(idx<0||idx>=undoStack.length) return;
    var steps=undoStack.length-idx;
    for(var i=0;i<steps;i++){ redoStack.push(baseline); baseline=undoStack.pop(); }
    applySnap(baseline); updateBtns(); };
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
  var JA = {"+ Add Track": "＋ トラック追加", "+ Import Audio": "＋ 音声を読み込む", "Import Audio": "音声を読み込む", "Load Demo Song": "デモ曲を読み込む", "Load the demo song?": "デモ曲を読み込みますか？", "All current tracks will be replaced by the demo song (backing + vocal + harmony). If you are working with your own audio, export it first before loading.": "今あるトラックはすべてデモ曲（オケ＋ボーカル＋ハモリ）に入れ替わります。自分の音源で作業中の場合は、先に書き出してから読み込んでください。", "Cancel": "キャンセル", "Replace & Load": "入れ替えて読み込む", "Channel": "チャンネル", "Effects": "エフェクト", "Pitch Correction": "ピッチ補正", "Mixer": "ミキサー", "Export": "書き出し", "Manual": "マニュアル", "Open Full-Screen Editor": "全画面エディターで開く", "Full-screen page — easier on a phone.": "全画面ページ — スマホで編集しやすい。", "Master": "マスター", "Tracks": "トラック", "Automation": "オートメーション", "Volume": "ボリューム", "Pan": "パン", "Off": "オフ", "Snap": "スナップ", "Zoom": "ズーム", "Delete Clip": "クリップ削除", "✂ Split": "✂ 分割", "Drag to move, drag the edges to trim": "ドラッグで移動、両端でトリム", "Drop audio files here": "ここに音声ファイルをドロップ", "Vocal": "ボーカル", "Harmony": "ハモリ", "Backing / Instrument": "オケ / 楽器", "Backing": "オケ", "Vocal Bus": "ボーカル バス", "Backing (Demo)": "オケ（デモ）", "Main Vocal (Demo)": "メインボーカル（デモ）", "Harmony (Demo)": "ハモリ（デモ）", "Track Settings": "トラック設定", "Selected Clip": "選択中のクリップ", "Name": "名前", "Type": "種類", "Output Bus": "出力バス", "Output": "出力", "Start": "開始", "Time": "時間", "Gain": "ゲイン", "Fade In": "フェードイン", "Fade Out": "フェードアウト", "Reverb Send": "リバーブ センド", "Delay Send": "ディレイ センド", "REV Send": "REV センド", "DLY Send": "DLY センド", "Add Bus": "バスを追加", "Bus": "バス", "Buses": "バス", "BUS": "バス", "Direct to Master": "マスターへ直接", "→ Master": "→ マスター", "Delete": "削除", "Duplicate": "複製", "Collapse": "折りたたむ", "Open": "開く", "Reset": "リセット", "Mute": "ミュート", "Muted": "ミュート中", "No tracks": "トラックがありません", "No tracks to export.": "書き出すトラックがありません。", "No effects": "エフェクトがありません", "No clips on this track": "このトラックにクリップはありません", "Clips": "クリップ", "Clip Edit Layer": "クリップ編集レイヤー", "Source Audio": "元の音源", "Always Kept": "常に保持", "Parameters layered on top": "パラメータを上に重ねる", "↓ Parameters layered on top": "↓ パラメータを上に重ねる", "+ Add Stage": "＋ ステージ追加", "Compressor": "コンプレッサー", "Parametric EQ": "パラメトリックEQ", "Reverb": "リバーブ", "Delay": "ディレイ", "Reverb (Insert)": "リバーブ（インサート）", "EQ": "EQ", "FX": "FX", "Threshold": "スレッショルド", "Ratio": "レシオ", "Knee": "ニー", "Attack": "アタック", "Release": "リリース", "Makeup": "メイクアップ", "Decay": "減衰", "Pre-delay": "プリディレイ", "Feedback": "フィードバック", "Delay Time": "ディレイタイム", "Delay Feedback": "ディレイ フィードバック", "Tempo Sync": "テンポ同期", "No Sync": "同期なし", "Frequency Hz": "周波数 Hz", "Gain dB": "ゲイン dB", "Gain Reduction (while playing)": "ゲインリダクション（再生中）", "PRESET": "プリセット", "Save Current Settings": "現在の設定を保存", "Saved for this session only": "このセッション内のみ保存", "My preset name": "プリセット名", "MIX PRESET": "MIX プリセット", "Save Current Mix": "現在のミックスを保存", "Returns (Send Destinations)": "リターン（センド先）", "RETURN": "リターン", "Reverb Decay": "リバーブ減衰", "Applied return preset": "リターンのプリセットを適用しました", "WAV / MP3 Export (Offline Render)": "WAV / MP3 書き出し（オフラインレンダー）", "Format": "形式", "Sample Rate": "サンプルレート", "Bit Depth": "ビット深度", "File Name": "ファイル名", "WAV (Uncompressed)": "WAV（無圧縮）", "WAV only": "WAVのみ", "Renders the whole project offline. Insert FX, sends / returns, buses, automation and fades are all included.": "プロジェクト全体をオフラインで書き出します。インサートFX、センド/リターン、バス、オートメーション、フェードがすべて含まれます。", "Pitch Correction Layer": "ピッチ補正レイヤー", "Delete Layer": "レイヤーを削除", "Deletes all analysis and correction. The source audio remains.": "解析と補正をすべて削除します。元の音源は残ります。", "Analyze Pitch": "ピッチ解析", "Analyzing…": "解析中…", "Correction Strength": "補正の強さ", "Effective shift = note shift x strength": "実効シフト ＝ ノートシフト × 強さ", "Snap to Nearest Note": "最寄りの音にスナップ", "Reset Correction (shifts to 0)": "補正をリセット（シフトを0に）", "Note ON/OFF": "ノート ON/OFF", "+ Semitone": "＋ 半音", "− Semitone": "− 半音", "Layer ON": "レイヤー ON", "Layer OFF": "レイヤー OFF", "Layer structure": "レイヤー構造", "Not Created": "未作成", "Click a block to select it; drag up / down to correct in semitones": "ブロックをクリックで選択、上下ドラッグで半音単位に補正", "Not analyzed yet. Run": "まだ解析していません。次を実行：", "This clip's editor is collapsed. Audio plays with the current settings.": "このクリップのエディタは折りたたまれています。現在の設定で再生されます。", "Split at Playhead": "再生ヘッドで分割", "Volume automation (click to add a point, right-click to delete)": "ボリューム オートメーション（クリックで点を追加、右クリックで削除）", "Pan automation (click to add a point, right-click to delete)": "パン オートメーション（クリックで点を追加、右クリックで削除）", "How to Use (collapse / expand)": "使い方（折りたたみ／展開）", "Choose Audio Files": "音声ファイルを選ぶ", "Vocal Basic": "ボーカル基本", "De-Mud": "こもり解消", "Presence & Air": "抜けと空気感", "Low Cut Only": "ローカットのみ", "Cover Standard": "歌ってみた標準", "Heavy": "しっかり潰す", "Ballad (Slow)": "バラード（遅め）", "Space": "空間", "Vocal Up Front": "ボーカル前面", "Wide Harmony": "ハモリ広め", "Dry (Minimal Sends)": "ドライ（センド最小）", "Wet (Spacious)": "ウェット（広め）", "Standard (No Fade)": "標準（フェードなし）", "Smooth In & Out": "なめらかイン＆アウト", "Long Fade": "ロングフェード", "Gain +3dB": "ゲイン +3dB", "Gain −3dB": "ゲイン −3dB", "Click Removal (10ms)": "クリック除去（10ms）", "Dotted 8th (BPM Sync)": "付点8分（BPM同期）", "8th Delay": "8分ディレイ", "Slapback": "スラップバック", "Dotted 8th": "付点8分", "Quarter Note": "4分音符", "8th Note": "8分音符", "16th Note": "16分音符", "Dotted 8th Sync": "付点8分 同期", "Quarter Sync": "4分 同期", "8th Sync": "8分 同期", "16th Sync": "16分 同期", "8th Triplet": "8分三連", "No audio files found": "音声ファイルが見つかりません", "Cannot delete the last track": "最後のトラックは削除できません", "Clip duplicated (source buffer is shared = non-destructive)": "クリップを複製しました（元のバッファを共有＝非破壊）", "Clip split": "クリップを分割しました", "Correction reset (source unchanged)": "補正をリセットしました（原音は不変）", "Demo song loaded. Press play to listen.": "デモ曲を読み込みました。再生してお聴きください。", "Generating demo song…": "デモ曲を生成中…", "Layer OFF — playing the source audio": "レイヤー OFF — 原音を再生します", "Not analyzed — source only": "未解析 — 原音のみ", "Note disabled — that note plays as the original": "ノートを無効化 — そのノートは原音で再生されます", "Note enabled": "ノートを有効化", "Pitch correction layer ON": "ピッチ補正レイヤー ON", "Pitch correction layer deleted (source audio remains)": "ピッチ補正レイヤーを削除しました（原音は残ります）", "Place the playhead inside the clip to split": "分割したいクリップ内に再生ヘッドを置いてください", "Select a clip to delete": "削除するクリップを選択してください", "Select a clip to split": "分割するクリップを選択してください", "Select a note first": "先にノートを選択してください", "Snapped enabled notes to the nearest pitch (layer only; source unchanged)": "有効なノートを最寄りの音程にスナップしました（レイヤーのみ、原音は不変）", "Stage reset to defaults": "ステージを初期値にリセットしました", "Could not load the MP3 encoder. Please export as WAV.": "MP3エンコーダを読み込めませんでした。WAVで書き出してください。", "Importing Audio": "音声を読み込み中", "Queued": "待機中", "Loaded": "読み込み完了", "Could not load": "読み込めませんでした", "Close": "閉じる", "The full-screen editor is not available on this page": "このページでは全画面エディターは使えません", "Back from the pitch editor — edits applied to the layer": "ピッチエディターから戻りました — 編集をレイヤーに反映しました", "Back from the pitch editor — project restored": "ピッチエディターから戻りました — プロジェクトを復元しました", "Back from the export page — project restored": "書き出しページから戻りました — プロジェクトを復元しました", "↩ Undo": "↩ 元に戻す", "↪ Redo": "↪ やり直し", "Project restored from autosave": "自動保存からプロジェクトを復元しました", "⚙ Params": "⚙ パラメータ", "Crossfade with Next": "次のクリップとクロスフェード", "No next clip on this track": "このトラックに次のクリップがありません", "Clips do not touch — move the next clip against this one first": "クリップが接していません — 次のクリップをくっつけてから実行してください", "Crossfade too short": "クロスフェードが短すぎます", "De-Esser": "ディエッサー", "Frequency": "周波数", "Standard": "標準", "Gentle": "ジェントル", "Strong Sibilance": "強い歯擦音", "High & Bright": "高域・明るめ", "Limiter": "リミッター", "Ducker (Sidechain)": "ダッカー（サイドチェイン）", "Key Source": "キーソース", "— None —": "— なし —", "This track ducks when the key track plays": "キートラックが鳴るとこのトラックが下がります", "Depth": "深さ", "No key selected": "キーが未選択です", "Vocal over Backing": "ボーカル優先", "Gentle Glue": "軽いグルー", "Pump": "パンピング", "Normalize": "ノーマライズ", "Measure Loudness": "ラウドネス測定", "Snapshots": "スナップショット", "Fade In Curve": "フェードイン曲線", "Fade Out Curve": "フェードアウト曲線", "Linear": "リニア", "Equal Power": "等パワー", "S-Curve": "S字曲線", "Noise Gate": "ノイズゲート", "Vocal Gate": "ボーカルゲート", "Tight (Noisy Room)": "タイト（ノイズの多い部屋）", "Gentle Expander": "緩やかなエキスパンダー", "Range": "範囲", "Metronome ON": "メトロノーム ON", "Metronome OFF": "メトロノーム OFF", "Count-in…": "カウントイン…", "Clip is silent — nothing to normalize": "クリップが無音です — ノーマライズできません", "Tail Fade": "曲尾フェード", "Custom (export.tailfade parameter)": "カスタム（export.tailfade パラメータ）", "Loudness Report (.txt)": "ラウドネスレポート（.txt）", "Saturation": "サチュレーション", "Subtle Warmth": "ほのかな温かみ", "Tape": "テープ", "Tube Grit": "チューブの粗さ", "Ping-Pong Delay": "ピンポンディレイ", "8th Ping-Pong": "8分ピンポン", "Wide & Long": "ワイド＆ロング", "Drive": "ドライブ", "Convolution Reverb": "コンボリューションリバーブ", "Room": "ルーム", "Hall": "ホール", "Cathedral": "カテドラル", "Small Room": "小部屋", "Spectrum": "スペクトラム", "Reference Track": "リファレンストラック", "Play Reference": "リファレンス再生", "No reference loaded": "リファレンス未読み込み", "History": "履歴", "Detect Key/BPM": "キー/BPM検出", "Vocal Rider": "ボーカルライダー", "Broadcast": "ブロードキャスト", "Subtle": "控えめ", "Target": "目標", "Speed": "速さ", "Repair:": "修復:", "Breath": "ブレス", "Level Syllables": "音節レベル均し", "De-Click": "クリック除去", "Mouth Clicks": "マウスクリック除去", "De-Plosive": "破裂音低減", "Sibilance": "歯擦音", "Check Gain Staging": "ゲインステージング確認", "Drift Fix": "ドリフト補正", "Vibrato": "ビブラート", "Portamento": "ポルタメント", "Room Noise": "部屋ノイズ除去", "Takes:": "テイク:", "Store Current as New Take": "現在の音を新規テイクとして保存", "Concatenate Track Clips": "トラックのクリップを連結", "Custom (Build Your Own)": "カスタム（自作）", "Platform Preset": "プラットフォームプリセット", "Custom": "カスタム", "SRC Quality": "SRC品質", "Remap Keys": "キー再割り当て", "Reset all keys": "キーをすべてリセット", "Starter (+6 dB)": "スターター（+6 dB）", "Blank": "空", "Air + Warmth": "エアー＋温かみ", "Multiband Comp": "マルチバンドコンプ", "Dynamic EQ": "ダイナミックEQ", "Low Thr": "低域しきい値", "Mid Thr": "中域しきい値", "High Thr": "高域しきい値", "Max Cut": "最大カット", "Folder": "フォルダ", "No folder": "フォルダなし", "Freeze Track": "トラックをフリーズ", "Unfreeze Track": "フリーズ解除", "Bounce in Place": "その場でバウンス", "Gain Line:": "ゲインライン:", "Add Point at Playhead": "再生位置にポイント追加", "Clear Line": "ラインを消去", "Master Chain": "マスターチェーン", "Master Comp": "マスターコンプ", "Doubler / ADT": "ダブラー/ADT", "ADT": "ADT", "Wide": "ワイド", "Spread": "広がり", "Timing:": "タイミング:", "Stretch 0.9x": "ストレッチ 0.9x", "Stretch 1.1x": "ストレッチ 1.1x", "Align to Top Track": "先頭トラックにタイミングを合わせる", "Formant:": "フォルマント:", "Preserve formants": "フォルマントを保持", "Scale": "スケール", "Harmony +4 st": "ハモリ +4", "Harmony +7 st": "ハモリ +7", "Use Loop": "ループを使う", "Remove DC offset": "DCオフセット除去", "Trim silence": "無音をトリム", "Dither (WAV)": "ディザ（WAV）", "Export Stems (per track)": "ステム書き出し（トラック別）", "Export All Formats": "全形式で書き出し", "Loop is not set": "ループが設定されていません", "Settings imported": "設定を読み込みました", "Settings import failed": "設定の読み込みに失敗しました", "VCA Group": "VCAグループ", "No VCA": "VCAなし", "Track Color": "トラック色", "Track Note": "トラックメモ", "Note for this track": "このトラックのメモ", "Mono downmix": "モノラルにダウンミックス", "Chorus": "コーラス", "Flanger": "フランジャー", "Phaser": "フェイザー", "Stereo Widener": "ステレオワイドナー", "Exciter": "エキサイター", "Hum Removal": "ハム除去", "Clarity Boost": "明瞭度ブースト", "Gentle Chorus": "穏やかなコーラス", "Lush": "ラッシュ", "Doubling": "ダブリング", "Classic Flanger": "定番フランジャー", "Jet": "ジェット", "Subtle Sweep": "控えめなスイープ", "Classic Phaser": "定番フェイザー", "Slow Sweep": "遅いスイープ", "Vocal Swirl": "ボーカルスワール", "Mild Width": "控えめな広がり", "Extra Wide": "特大ワイド", "Mono": "モノラル", "Gentle Air": "穏やかなエア", "Presence": "プレゼンス", "Strong": "強め", "Clarity": "明瞭", "Soft": "ソフト", "Rate": "レート", "Width": "幅", "Amount": "量", "Fundamental": "基音", "Split at Silence": "無音で分割", "Strip Silence": "無音を取り除く", "Reverse": "リバース", "Forward": "通常再生", "Glue with Next": "次のクリップと接着", "Keyboard Shortcuts": "キーボードショートカット", "No silence found": "無音が見つかりません", "No next clip to glue": "接着する次のクリップがありません", "Glued into one clip": "1つのクリップに接着しました", "Clip reversed": "クリップをリバースしました", "Clip forward": "クリップを通常再生に戻しました", "Snapshot storage is full — delete one first": "スナップショットがいっぱいです — 先に1つ削除してください", "Snapshots are not available here": "ここではスナップショットは使えません", "Microphone recording is not supported in this browser": "このブラウザではマイク録音に対応していません", "Nothing was recorded": "何も録音されませんでした", "Recording…": "録音中…", "Custom (loudness.target parameter)": "カスタム（loudness.target パラメータ）", "Back from the manual — project restored": "マニュアルから戻りました — プロジェクトを復元しました", "Rendering…": "書き出し中…", "Audio flows from the top stage down. Each stage is an independent unit; summaries always show here.": "音は上のステージから下へ流れます。各ステージは独立したユニットで、要約は常にここに表示されます。", "Click a block to select it; drag up / down to correct in semitones. \"Note ON/OFF\" returns a single note to the original.": "ブロックをクリックで選択し、上下ドラッグで半音単位に補正します。「ノート ON/OFF」は1つのノートだけを原音に戻します。", "Clips / Mixer — Independent Units (Stage 3)": "クリップ／ミキサー — 独立ユニット", "Collapse unused stages with \"Collapse\" in the stage header to hide their parameters. The chain always shows each stage's summary, so the state stays visible while collapsed.": "使わないステージはヘッダーの「折りたたむ」でパラメータを隠せます。チェーンには各ステージの要約が常に出るので、たたんでも状態は見えます。", "Compressor — Full Control": "コンプレッサー — フルコントロール", "Correction applies to playback and export. It targets monophonic singing only (no chords, overlapping sources, or time stretching).": "補正は再生と書き出しに反映されます。対象は単音の歌声のみです（和音・重なった音源・タイムストレッチは対象外）。", "Correction is never baked into the source. Playback and export derive it from source + layer each time. Turn the layer OFF for the original instantly; deleting it still keeps the source.": "補正が原音に焼き込まれることはありません。再生と書き出しは毎回、原音＋レイヤーから導出します。レイヤーを OFF にすれば即座に原音に戻り、削除しても原音は残ります。", "Dashed = detected position; solid blocks = corrected position (strength applied). Gray = disabled notes; when the layer is OFF, everything is gray.": "破線＝検出位置、実ブロック＝補正後（強さ適用済み）。グレー＝無効化したノート。レイヤー OFF のときは全部グレーになります。", "Each stage has presets (EQ \"Vocal Basic\" and \"De-Mud\", Compressor \"Cover Standard\", and more). You can also save the current settings under a name (saved for this session only).": "各ステージにはプリセットがあります（EQ の「ボーカル基本」「こもり解消」、コンプレッサーの「歌ってみた標準」など）。現在の設定に名前を付けて保存もできます（このセッション内のみ）。", "Edits change parameters only; the source audio is never rewritten. Summaries keep the state visible while collapsed.": "編集はパラメータのみで、原音は書き換わりません。折りたたんでも要約で状態が見えます。", "Effects — Each Stage in the Serial Chain Is Independent": "エフェクト — 直列チェーンの各ステージは独立しています", "Even if you split / trim the clip after analysis, the layer carries over in buffer-time coordinates.": "解析後にクリップを分割／トリムしても、レイヤーはバッファ時間の座標で引き継がれます。", "How It Works — the Non-Destructive Design (collapse / expand)": "仕組み — 非破壊の設計（折りたたみ／展開）", "No voiced notes were detected. The audio may be too quiet or not monophonic. The source audio remains untouched.": "有声ノートが検出されませんでした。音が小さすぎるか、単音でない可能性があります。原音はそのまま残っています。", "Not analyzed yet. Run \"Analyze Pitch\" to detect notes and create this layer (the source stays untouched).": "まだ解析していません。「ピッチ解析」を実行するとノートを検出してこのレイヤーを作ります（原音には触れません）。", "Parametric EQ — drag handles (horizontal = frequency / vertical = gain), wheel for Q": "パラメトリックEQ — ハンドルをドラッグ（横＝周波数／縦＝ゲイン）、ホイールで Q", "Pitch Correction — Non-Destructive Layer": "ピッチ補正 — 非破壊レイヤー", "Press \"Analyze Pitch\" to detect pitch with the YIN method and show it as notes (blocks). Drag blocks up or down to correct in semitones, or use \"Snap to Nearest Note\" to pull all notes to the nearest pitch. Correction only layers on top; the source is never rewritten.": "「ピッチ解析」を押すと YIN 法で音程を検出し、ノート（ブロック）として表示します。ブロックを上下にドラッグして半音単位で補正するか、「最寄りの音にスナップ」で全ノートを最寄りの音程へ寄せます。補正は上に重ねるだけで、原音は書き換わりません。", "Select a clip on the timeline first. For monophonic vocal / harmony tracks (not for chords or overlapping sources).": "先にタイムラインでクリップを選んでください。単音のボーカル／ハモリ向けです（和音や重なった音源には使えません）。", "Select a stage from the list to edit its parameters here. Each stage is independent: ON/OFF, reorder, per-stage presets, duplicate and collapse.": "リストからステージを選ぶと、ここでパラメータを編集できます。各ステージは独立していて、ON/OFF・並び替え・段別プリセット・複製・折りたたみができます。", "Sends feed the return reverb / delay. Route several tracks to a bus to process them together.": "センドはリターンのリバーブ／ディレイへ送ります。複数トラックをバスへまとめると一括で処理できます。", "There are whole-mixer presets too (Cover Standard / Vocal Up Front / Dry, etc.). You can also save the current mix under a name (saved for this session only).": "ミキサー全体のプリセットもあります（歌ってみた標準／ボーカル前面／ドライ等）。現在のミックスに名前を付けて保存もできます（このセッション内のみ）。", "This clip is on a backing / instrument track. Pitch correction is designed for monophonic vocals.": "このクリップはオケ／楽器トラックのものです。ピッチ補正は単音ボーカル向けの設計です。", "Re-analyze (rebuild layer)": "再解析（レイヤーを再構築）", "OFF — plays source": "OFF — 原音を再生", "Natural 60%": "ナチュラル 60%", "Standard 85%": "スタンダード 85%", "Full 100%": "フル 100%", "Pulls notes 60% of the way. Keeps vibrato and nuance.": "ノートを目標の60%まで寄せます。ビブラートとニュアンスを残します。", "The cover-song standard. Tunes pitch without sounding mechanical.": "歌ってみたの標準。機械的に聞こえない範囲で音程を整えます。", "Pulls fully to the target pitch. Meant to be combined with snap.": "目標の音程まで完全に寄せます。スナップとの併用が前提です。", "New bus name": "バス名を入力"};
  var ENR = {}; Object.keys(JA).forEach(function(k){ ENR[JA[k]] = k; });
  var PAT = [
    [/^Crossfade: ([\d.]+) s \(equal power\)$/, "クロスフェード: $1 秒（等パワー）"],
    [/^Limiter ON \(([\d.\-]+) dB\)$/, "リミッター ON（$1 dB）"],
    [/^Limiter OFF$/, "リミッター OFF"],
    [/^Integrated loudness: (.+) · Peak: (.+) · True Peak: (.+)$/, "統合ラウドネス: $1 · ピーク: $2 · トゥルーピーク: $3"],
    [/^Normalized: peak (.+) dB, gain now (.+)$/, "ノーマライズ: ピーク $1 dB、ゲインは $2 に"],
    [/^Split into (\d+) clips$/, "$1 個のクリップに分割しました"],
    [/^Tempo: (\d+) BPM$/, "テンポ: $1 BPM"],
    [/^Reference loaded: (.+)$/, "リファレンスを読み込みました: $1"],
    [/^Breath control: (\d+) breath\(s\) softened$/, "ブレス制御: $1 か所を弱めました"],
    [/^De-click: (\d+) sample\(s\) repaired$/, "クリック除去: $1 サンプルを修復"],
    [/^Mouth clicks: (\d+) sample\(s\) repaired$/, "マウスクリック除去: $1 サンプルを修復"],
    [/^Syllables leveled: (\d+) adjusted$/, "音節レベル均し: $1 か所を調整"],
    [/^Stretched x([\d.]+) -> ([\d.]+) s \(baked; Undo restores\)$/, "ストレッチ x$1 → $2 秒（焼き込み。取り消しで戻ります）"],
    [/^Harmony track created \((\+?\-?\d+) st, (\d+) notes\)$/, "ハモリトラックを作成（$1 半音、$2 ノート）"],
    [/^Aligned (\d+) onsets to the reference clip \(baked; Undo restores\)$/, "参照クリップに $1 か所の立ち上がりを合わせました（焼き込み。取り消しで戻ります）"],
    [/^Stripped silence: (\d+) clips$/, "無音を除去しました: $1 個のクリップ"],
    [/^Integrated loudness: (.+) · Peak: (.+)$/, "統合ラウドネス: $1 · ピーク: $2"],
    [/^Track duplicated: (.+)$/, "トラックを複製しました: $1"],
    [/^Added track: (.+)$/, "トラックを追加しました: $1"],
    [/^Renamed: (.+)$/, "名前を変更しました: $1"],
    [/^Snapshot saved: (.+)$/, "スナップショットを保存しました: $1"],
    [/^Snapshot loaded: (.+)$/, "スナップショットを読み込みました: $1"],
    [/^Snapshot deleted: (.+)$/, "スナップショットを削除しました: $1"],
    [/^Snapshot not found: (.+)$/, "スナップショットが見つかりません: $1"],
    [/^Microphone unavailable: (.+)$/, "マイクが使えません: $1"],
    [/^Recorded take added: (.+)$/, "録音テイクを追加しました: $1"],
    [/^Could not decode the recording: (.+)$/, "録音をデコードできませんでした: $1"],
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

