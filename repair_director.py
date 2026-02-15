
import re

with open('public/director.html', 'r') as f:
    content = f.read()

# 1. Revert startRecording corruption
# Find the specific block that was incorrectly replaced
start_recording_bad = r'if \(isIsoMode\) \{.*?socket\.emit\(\"stop-iso\", \{ room: streamId \}\);.*?location\.href = \"downloads\.html\";.*?return; /\* Stop further execution in this function \*/.*?\} else \{'

start_recording_good = """if (isIsoMode) {
        // ISO MODE CHECKS
      } else {
        // LEGACY MODE CHECKS
        if (!hasStream) {
          console.warn("Legacy Start Failed: No stream selected");
          return alert("Select a camera first");
        }
      }"""

new_content = re.sub(start_recording_bad, start_recording_good, content, flags=re.DOTALL)

# 2. Correct stopRecording logic
stop_recording_replacement = """if (isIsoMode) {
        socket.emit("stop-iso", { room: streamId });
        
        // Handover to downloads.html
        localStorage.setItem("isoSessionId", isoSessionId);
        localStorage.setItem("isoStreamId", streamId);
        localStorage.setItem("isoEdl", JSON.stringify(isoEdl));

        console.log("Redirecting to Download Manager...");
        location.href = "downloads.html";
        return;"""

# Find the start of isIsoMode block in stopRecording
# It starts after clearInterval(recordTimerInt);
stop_start_anchor = "clearInterval(recordTimerInt);"
stop_start_idx = new_content.find('if (isIsoMode) {', new_content.find(stop_start_anchor))
stop_end_marker = "} else {"
stop_end_idx = new_content.find(stop_end_marker, stop_start_idx)

if stop_start_idx != -1 and stop_end_idx != -1:
    new_content = new_content[:stop_start_idx] + stop_recording_replacement + "\n      " + new_content[stop_end_idx:]

with open('public/director.html', 'w') as f:
    f.write(new_content)
