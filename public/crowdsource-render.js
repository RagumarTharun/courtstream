const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const renderBtn = document.getElementById('renderBtn');
const clearBtn = document.getElementById('clearBtn');

// State
let cameras = {}; // camId -> { videoFile: File, metaFile: File, metadata: Object }

dropZone.onclick = () => fileInput.click();

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
};

dropZone.ondragleave = () => dropZone.classList.remove('dragover');

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
};

fileInput.onchange = (e) => handleFiles(e.target.files);

clearBtn.onclick = () => {
    cameras = {};
    updateUI();
};

async function handleFiles(files) {
    for (const file of Array.from(files)) {
        if (file.name.endsWith('.zip')) {
            try {
                const zip = await JSZip.loadAsync(file);
                for (const filename of Object.keys(zip.files)) {
                    const zipEntry = zip.files[filename];
                    if (zipEntry.dir) continue;
                    
                    const match = filename.match(/crowdcam_([A-Z0-9]+)_/);
                    let camId = match ? match[1] : filename.split('.')[0];
                    if (!cameras[camId]) cameras[camId] = {};

                    if (filename.endsWith('.json')) {
                        const text = await zipEntry.async("text");
                        try {
                            const meta = JSON.parse(text);
                            if (meta.camId) {
                                camId = meta.camId;
                                if (!cameras[camId]) cameras[camId] = {};
                            }
                            cameras[camId].metaFile = file; // placeholder
                            cameras[camId].metadata = meta;
                        } catch(e) {}
                    } else if (filename.match(/\.(webm|mp4)$/i)) {
                        const blob = await zipEntry.async("blob");
                        const videoFile = new File([blob], filename, { type: filename.endsWith('.mp4') ? 'video/mp4' : 'video/webm' });
                        cameras[camId].videoFile = videoFile;
                    }
                }
            } catch(e) {
                console.error("Failed to unzip", e);
            }
        } else {
            const match = file.name.match(/crowdcam_([A-Z0-9]+)_/);
            let camId = match ? match[1] : null;

            if (file.name.endsWith('.json')) {
                try {
                    const text = await file.text();
                    const meta = JSON.parse(text);
                    if (meta.camId) {
                        camId = meta.camId;
                        if (!cameras[camId]) cameras[camId] = {};
                        cameras[camId].metaFile = file;
                        cameras[camId].metadata = meta;
                    }
                } catch(e) {
                    console.error("Invalid JSON", file.name);
                }
            } else if (file.type.startsWith('video/')) {
                if (!camId) camId = file.name.split('.')[0]; 
                if (!cameras[camId]) cameras[camId] = {};
                cameras[camId].videoFile = file;
            }
        }
    }
    updateUI();
}

function updateUI() {
    fileList.innerHTML = '';
    let readyCount = 0;
    const camIds = Object.keys(cameras);

    if (camIds.length === 0) {
        renderBtn.classList.remove('active');
        return;
    }

    camIds.forEach(camId => {
        const cam = cameras[camId];
        const isReady = cam.videoFile && cam.metadata;
        if (isReady) readyCount++;

        const div = document.createElement('div');
        div.className = 'cam-group';
        div.innerHTML = `
            <div class="cam-info">
                <span class="cam-id">Cam: ${camId}</span>
                <div class="file-badges">
                    <span class="badge ${cam.videoFile ? 'found' : ''}">🎥 Video</span>
                    <span class="badge ${cam.metadata ? 'found' : ''}">📋 Meta</span>
                </div>
            </div>
            <div class="status ${isReady ? 'ready' : 'waiting'}">
                ${isReady ? 'Ready' : 'Waiting for pair...'}
            </div>
        `;
        fileList.appendChild(div);
    });

    if (readyCount > 0 && readyCount === camIds.length) {
        renderBtn.classList.add('active');
    } else {
        renderBtn.classList.remove('active');
    }
}

// Generate Master Edit Decision List aligned with real-time wall-clock timestamps
function generateMasterEDL() {
    const readyCams = Object.values(cameras).filter(c => c.videoFile && c.metadata);
    if (readyCams.length === 0) return null;

    // 1. Collect all timeline state-change events across all cameras
    const timelineEvents = [];
    readyCams.forEach(cam => {
        if (!cam.metadata || !Array.isArray(cam.metadata.events)) return;
        cam.metadata.events.forEach(ev => {
            timelineEvents.push({
                camId: cam.metadata.camId,
                absTime: cam.metadata.startTimeAbs + ev.timestampMs,
                state: ev.state
            });
        });
    });

    if (timelineEvents.length === 0) return [];

    // Sort chronologically by absolute wall-clock time
    timelineEvents.sort((a, b) => a.absTime - b.absTime);

    // 2. Walk timeline tracking active 'Good View' stack
    const cuts = [];
    const activeCamStack = []; // Stack of active camIds ordered by activation time
    let currentCutCamId = null;
    let currentCutStartAbs = null;

    timelineEvents.forEach(ev => {
        const { camId, absTime, state } = ev;

        if (state === 'on') {
            // Good View activated by this camera
            if (currentCutCamId && absTime > currentCutStartAbs) {
                cuts.push({
                    camId: currentCutCamId,
                    startAbs: currentCutStartAbs,
                    endAbs: absTime
                });
            }

            if (!activeCamStack.includes(camId)) {
                activeCamStack.push(camId);
            }
            currentCutCamId = camId;
            currentCutStartAbs = absTime;

        } else if (state === 'off') {
            // Good View deactivated
            const index = activeCamStack.indexOf(camId);
            if (index !== -1) {
                activeCamStack.splice(index, 1);
            }

            if (currentCutCamId === camId) {
                if (absTime > currentCutStartAbs) {
                    cuts.push({
                        camId: currentCutCamId,
                        startAbs: currentCutStartAbs,
                        endAbs: absTime
                    });
                }

                if (activeCamStack.length > 0) {
                    currentCutCamId = activeCamStack[activeCamStack.length - 1];
                    currentCutStartAbs = absTime;
                } else {
                    currentCutCamId = null;
                    currentCutStartAbs = null;
                }
            }
        }
    });

    console.log("Master EDL Cuts (Real-Time Aligned):", cuts);

    // 3. Translate absolute real-time cuts into relative video timestamps for FFmpeg
    const ffmpegSegments = cuts.map(cut => {
        const camData = cameras[cut.camId].metadata;
        const vidStartSec = Math.max(0, (cut.startAbs - camData.startTimeAbs) / 1000);
        const durationSec = (cut.endAbs - cut.startAbs) / 1000;
        return {
            camId: cut.camId,
            vidStartSec: Number(vidStartSec.toFixed(3)),
            durationSec: Number(durationSec.toFixed(3))
        };
    }).filter(seg => seg.durationSec >= 0.1);

    console.log("Final FFmpeg Segments:", ffmpegSegments);
    return ffmpegSegments;
}


/* FFmpeg Rendering Logic */
let ffmpegInstance = null;
let ffmpegRef = null;
let fetchFileRef = null;

async function ensureFFmpeg() {
    if (ffmpegInstance) return { ffmpeg: ffmpegRef, fetchFile: fetchFileRef };

    const { FFmpeg } = window.FFmpegWASM;
    const { fetchFile } = window.FFmpegUtil;
    const ffmpeg = new FFmpeg();

    ffmpeg.on("log", ({ message }) => console.log("FFmpeg:", message));

    await ffmpeg.load({
        coreURL: '/lib/ffmpeg/ffmpeg-core.js',
        wasmURL: '/lib/ffmpeg/ffmpeg-core.wasm',
        workerLoadURL: '/lib/ffmpeg/814.ffmpeg.js'
    });

    ffmpegRef = ffmpeg;
    fetchFileRef = fetchFile;
    ffmpegInstance = true;
    return { ffmpeg, fetchFile };
}

renderBtn.onclick = async () => {
    if (!renderBtn.classList.contains('active')) return;

    const segments = generateMasterEDL();
    if (!segments || segments.length === 0) {
        alert("No valid events found to render.");
        return;
    }

    document.getElementById('progressPanel').style.display = 'flex';
    const progressText = document.getElementById('progressText');

    try {
        progressText.innerText = "Loading FFmpeg Engine...";
        const { ffmpeg, fetchFile } = await ensureFFmpeg();

        // Load files into WASM memory
        const memFiles = {};
        const readyCams = Object.values(cameras).filter(c => c.videoFile && c.metadata);
        
        for (let i = 0; i < readyCams.length; i++) {
            const cam = readyCams[i];
            progressText.innerText = `Loading Video ${i+1}/${readyCams.length}...`;
            
            const ext = cam.videoFile.name.split('.').pop();
            const safeName = `iso_${cam.metadata.camId}.${ext}`;
            
            await ffmpeg.writeFile(safeName, await fetchFile(cam.videoFile));
            memFiles[cam.metadata.camId] = safeName;
        }

        // Process Segments
        const segmentFiles = [];
        for (let i = 0; i < segments.length; i++) {
            progressText.innerText = `Processing Segment ${i+1}/${segments.length}...`;
            const seg = segments[i];
            const inputFile = memFiles[seg.camId];
            const outputFile = `seg_${i}.mp4`;

            // Simple extract and re-encode to normalize (crucial for concat)
            const args = [
                "-ss", String(seg.vidStartSec),
                "-t", String(seg.durationSec),
                "-i", inputFile,
                "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
                "-r", "30",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
                outputFile
            ];

            const result = await ffmpeg.exec(args);
            if (result !== 0) throw new Error(`Segment ${i} failed to render.`);
            segmentFiles.push(outputFile);
        }

        // Stitching
        progressText.innerText = "Stitching Final Master Cut...";
        const listContent = segmentFiles.map(s => `file '${s}'`).join("\n");
        await ffmpeg.writeFile("list.txt", listContent);
        
        const finalName = `master_render.mp4`;
        const concatResult = await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", finalName]);
        if (concatResult !== 0) throw new Error("Concat stitching failed.");

        // Download
        progressText.innerText = "Finishing...";
        const data = await ffmpeg.readFile(finalName);
        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        a.href = url;
        a.download = `CrowdMaster_${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        document.getElementById('progressPanel').style.display = 'none';

    } catch (err) {
        console.error(err);
        alert("An error occurred during rendering.");
        document.getElementById('progressPanel').style.display = 'none';
    }
};
