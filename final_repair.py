
path = 'public/director.html'
with open(path, 'r') as f:
    lines = f.readlines()

# 1. Correct startRecording (lines around 983)
# We want to find the isIsoMode block and ensure it is clean
start_rec_idx = -1
for i, line in enumerate(lines):
    if 'function startRecording()' in line:
        start_rec_idx = i
        break

if start_rec_idx != -1:
    # Find the corrupted block
    for j in range(start_rec_idx, start_rec_idx + 50):
        if 'if (isIsoMode) {' in lines[j]:
            # Replace until next '} else {'
            end_j = -1
            for k in range(j, j + 40):
                if '} else {' in lines[k]:
                    end_j = k
                    break
            if end_j != -1:
                replacement_lines = [
                    '      if (isIsoMode) {\n',
                    '        // ISO MODE CHECKS\n',
                    '      } else {\n'
                ]
                lines[j:end_j+1] = replacement_lines
                break

# 2. Correct stopRecording (lines around 1068)
stop_rec_idx = -1
for i, line in enumerate(lines):
    if 'async function stopRecording()' in line:
        stop_rec_idx = i
        break

if stop_rec_idx != -1:
    # Find the isIsoMode block
    target_start = -1
    for j in range(stop_rec_idx, stop_rec_idx + 50):
        if 'if (isIsoMode) {' in lines[j]:
            target_start = j
            break
    
    if target_start != -1:
        # Find the end of this block
        target_end = -1
        # It ends before } else {
        for k in range(target_start, target_start + 150):
            if '} else {' in lines[k]:
                target_end = k
                break
        
        if target_end != -1:
            replacement_stop = [
                '      if (isIsoMode) {\n',
                '        socket.emit("stop-iso", { room: streamId });\n',
                '        \n',
                '        // Handover to downloads.html\n',
                '        localStorage.setItem("isoSessionId", isoSessionId);\n',
                '        localStorage.setItem("isoStreamId", streamId);\n',
                '        localStorage.setItem("isoEdl", JSON.stringify(isoEdl));\n',
                '\n',
                '        console.log("Redirecting to Download Manager...");\n',
                '        location.href = "downloads.html";\n',
                '        return;\n',
                '      } else {\n'
            ]
            lines[target_start:target_end+1] = replacement_stop

with open(path, 'w') as f:
    f.writelines(lines)
print("Director fully restored and updated via line indices")
