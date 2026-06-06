// audiodirector.js

let audioCtx = null;
const audioAnalyzers = {}; // id -> { analyser, dataArray, gainMultiplier, baseline, rollingAvg, calibrationSamples }
let autoAudioEnabled = false;
let isCalibrating = false;
let lastSwitchTime = 0;
const SWITCH_DEBOUNCE_MS = 1000;

// Confidence Accumulator
let accumulationWindowTimer = null;
const ACCUMULATOR_MS = 150;
let confidenceScores = {}; // id -> score

function toggleAutoAudio() {
  autoAudioEnabled = !autoAudioEnabled;
  const btn = document.getElementById("autoAudioBtn");
  const txt = document.getElementById("autoAudioBtnText");
  if (autoAudioEnabled) {
    btn.classList.add("active");
    txt.innerText = "Auto: ON";
    if (!audioCtx) initAudioCtx();
  } else {
    btn.classList.remove("active");
    txt.innerText = "Auto: OFF";
  }
}

// Expose globally for HTML onclick
window.toggleAutoAudio = toggleAutoAudio;

function initAudioCtx() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function calibrateMics() {
  if (!audioCtx) initAudioCtx();
  if (!audioCtx) {
    alert("Audio Context not supported or initialized.");
    return;
  }
  
  alert("Calibrating mics... Stand in the center of the court and bounce the ball once loudly during the next 5 seconds.");
  isCalibrating = true;
  
  // Reset existing baseline data
  Object.keys(audioAnalyzers).forEach(id => {
    audioAnalyzers[id].calibrationSamples = [];
  });
  
  setTimeout(() => {
    isCalibrating = false;
    let report = "Calibration complete:\n";
    Object.keys(audioAnalyzers).forEach(id => {
      const a = audioAnalyzers[id];
      if (a.calibrationSamples && a.calibrationSamples.length > 0) {
        // Impact Impulse Peak: Find the absolute maximum peak
        const peak = Math.max(...a.calibrationSamples, 0.1); 
        a.baseline = peak;
        // Normalize: target a peak of 100
        a.gainMultiplier = 100 / peak;
        report += `${peers[id]?.name || id}: Peak ${peak.toFixed(1)}, Multiplier ${a.gainMultiplier.toFixed(2)}\n`;
      }
    });
    console.log(report);
    
    // Show temporary overlay for calibration results
    const badge = document.getElementById('streamBadge');
    if (badge) {
      const orig = badge.innerText;
      badge.innerText = "✅ Calibration Complete";
      setTimeout(() => badge.innerText = orig, 3000);
    }
  }, 5000);
}

window.calibrateMics = calibrateMics;

function ensureVuMeters() {
  if (typeof peers === 'undefined') return;
  Object.keys(peers).forEach(id => {
    const slot = peers[id].slot;
    if (slot && !slot.querySelector('.vu-meter')) {
      const vuContainer = document.createElement('div');
      vuContainer.className = 'vu-meter';
      vuContainer.style = 'position:absolute; right:10px; bottom:10px; width:10px; height:60px; background:rgba(0,0,0,0.5); border-radius:5px; overflow:hidden; z-index:5; pointer-events:none; border:1px solid rgba(255,255,255,0.2);';
      
      const vuFill = document.createElement('div');
      vuFill.className = 'vu-fill';
      vuFill.style = 'position:absolute; bottom:0; left:0; width:100%; height:0%; background:var(--green); transition:height 0.1s, background-color 0.2s;';
      
      vuContainer.appendChild(vuFill);
      slot.appendChild(vuContainer);
    }
  });
}

function analyzeAudioLoop() {
  requestAnimationFrame(analyzeAudioLoop);
  
  ensureVuMeters();
  
  // 1. Ensure all active peers have analyzers
  if (typeof peers !== 'undefined' && audioCtx) {
    Object.keys(peers).forEach(id => {
      const p = peers[id];
      if (p.stream && !audioAnalyzers[id]) {
        try {
          // In WebRTC, the MediaStream might only have video tracks initially. Check for audio.
          if (p.stream.getAudioTracks().length > 0) {
            const source = audioCtx.createMediaStreamSource(p.stream);
            
            // BiquadFilterNode for 120Hz bandpass, Q = 2.0
            const filter = audioCtx.createBiquadFilter();
            filter.type = "bandpass";
            filter.frequency.value = 120;
            filter.Q.value = 2.0;
            
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5; // lower smoothing for faster transient detection
            
            source.connect(filter);
            filter.connect(analyser);
            
            audioAnalyzers[id] = {
              analyser: analyser,
              dataArray: new Uint8Array(analyser.frequencyBinCount),
              baseline: 0,
              gainMultiplier: 1.0,
              rollingAvg: 0,
              calibrationSamples: []
            };
            console.log("🎤 Audio analyzer attached for", id);
          }
        } catch(e) {
          console.warn("Could not attach audio source for", id, e);
        }
      }
    });
  }
  
  // 2. Process audio levels
  const now = Date.now();
  
  Object.keys(audioAnalyzers).forEach(id => {
    // If peer was removed, cleanup
    if (typeof peers === 'undefined' || !peers[id] || !peers[id].stream) {
      delete audioAnalyzers[id];
      return;
    }
    
    const a = audioAnalyzers[id];
    a.analyser.getByteFrequencyData(a.dataArray);
    
    // With a 120Hz bandpass filter, the target energy will be primarily in the lowest bins.
    // For 48kHz, fftSize=256, bin 0 is 0-93Hz, bin 1 is 93-281Hz (perfect for 120Hz).
    let energy = Math.max(a.dataArray[0], a.dataArray[1]);
    
    if (isCalibrating) {
      a.calibrationSamples.push(energy);
    }
    
    // Apply calibration multiplier
    const adjustedEnergy = energy * a.gainMultiplier;
    
    // Update VU meter UI
    const slot = peers[id].slot;
    if (slot) {
      const fill = slot.querySelector('.vu-fill');
      if (fill) {
        const pct = Math.min(100, (adjustedEnergy / 150) * 100);
        fill.style.height = `${pct}%`;
        fill.style.background = pct > 80 ? 'var(--red)' : (pct > 50 ? '#eab308' : 'var(--green)');
      }
    }
    
    // Rolling average to detect transients (sudden spikes)
    a.rollingAvg = (a.rollingAvg * 0.9) + (adjustedEnergy * 0.1);
    
    // Transient threshold: spike is significantly higher than rolling average and absolute minimum
    if (autoAudioEnabled && !isCalibrating) {
      if (adjustedEnergy > a.rollingAvg + 30 && adjustedEnergy > 40) {
        // Accumulate confidence instead of switching immediately
        if (!confidenceScores[id]) confidenceScores[id] = 0;
        confidenceScores[id] += adjustedEnergy;
        
        if (!accumulationWindowTimer) {
          accumulationWindowTimer = setTimeout(() => {
            // Find highest confidence score
            let bestId = null;
            let maxScore = 0;
            Object.keys(confidenceScores).forEach(cid => {
              if (confidenceScores[cid] > maxScore) {
                maxScore = confidenceScores[cid];
                bestId = cid;
              }
            });
            
            // Auto Switch Logic
            if (bestId && (Date.now() - lastSwitchTime > SWITCH_DEBOUNCE_MS)) {
              if (typeof currentLiveId !== 'undefined' && currentLiveId !== bestId) {
                console.log(`🎤 Transient detected! Confidence switch to ${bestId}. Score: ${maxScore.toFixed(1)}`);
                
                if (typeof setLiveCamera === 'function') {
                  setLiveCamera(bestId);
                }
                lastSwitchTime = Date.now();
                
                // Visual indicator
                const streamBadge = document.getElementById('streamBadge');
                if (streamBadge) {
                  const originalHtml = streamBadge.innerHTML;
                  streamBadge.innerHTML = `<span style="color:var(--red);">🎙️ SWITCHED TO ${peers[bestId]?.name || 'CAMERA'}</span>`;
                  streamBadge.style.borderColor = "var(--red)";
                  setTimeout(() => {
                    streamBadge.innerHTML = originalHtml;
                    streamBadge.style.borderColor = "";
                  }, 1500);
                }
              }
            }
            
            // Reset accumulator
            confidenceScores = {};
            accumulationWindowTimer = null;
          }, ACCUMULATOR_MS);
        }
      }
    }
  });
}

// Start the loop
analyzeAudioLoop();

// Auto-initialize audio context on first user interaction
document.body.addEventListener('click', () => {
  if (!audioCtx) initAudioCtx();
}, { once: true });
