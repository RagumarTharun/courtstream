(function () {
    // 1. Inject Styles
    const style = document.createElement("style");
    style.innerHTML = `
      /* FAB */
      .feedback-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        background: #3b82f6;
        border-radius: 50%;
        box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 9999;
        transition: transform 0.2s;
      }
      .feedback-fab:hover { transform: scale(1.1); }
      .feedback-fab svg { width: 24px; height: 24px; fill: white; }
  
      /* MODAL */
      .fb-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.8);
        z-index: 10000;
        display: none;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
        opacity: 0;
        transition: opacity 0.3s;
      }
      .fb-modal-overlay.open { display: flex; opacity: 1; }
  
      .fb-modal {
        background: #161922;
        border: 1px solid #262b3d;
        width: 100%;
        max-width: 400px;
        border-radius: 16px;
        padding: 24px;
        transform: translateY(20px);
        transition: transform 0.3s;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      }
      .fb-modal-overlay.open .fb-modal { transform: translateY(0); }
  
      .fb-title { color: white; margin: 0 0 16px; font-size: 18px; font-family: system-ui; }
      .fb-label { color: #9aa0b4; display: block; margin-bottom: 8px; font-size: 14px; font-family: system-ui; }
      
      .fb-input, .fb-select, .fb-textarea {
        width: 100%;
        background: #0f1115;
        border: 1px solid #262b3d;
        color: white;
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 16px;
        font-family: system-ui;
        font-size: 14px;
      }
      .fb-textarea { min-height: 100px; resize: vertical; }
  
      .fb-actions { display: flex; gap: 12px; margin-top: 8px; }
      .fb-btn {
        flex: 1;
        padding: 12px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
        font-weight: 600;
        font-family: system-ui;
      }
      .fb-cancel { background: #262b3d; color: white; }
      .fb-submit { background: #3b82f6; color: white; }
      .fb-submit:disabled { opacity: 0.5; cursor: not-allowed; }
  
      /* LOADING OVERLAY */
      .loader-overlay {
        position: fixed;
        inset: 0;
        background: #0f1115;
        z-index: 20000;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.5s;
      }
      .loader-icon {
        width: 80px;
        height: 80px;
        animation: pulse 1.5s infinite ease-in-out;
      }
      @keyframes pulse {
        0% { transform: scale(0.95); opacity: 0.8; }
        50% { transform: scale(1.05); opacity: 1; }
        100% { transform: scale(0.95); opacity: 0.8; }
      }
    `;
    document.head.appendChild(style);

    // 2. Inject HTML
    const container = document.createElement("div");
    container.innerHTML = `
      <!-- FAB -->
      <div class="feedback-fab" id="fbFab" title="Submit Feedback">
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
      </div>
  
      <!-- MODAL -->
      <div class="fb-modal-overlay" id="fbOverlay">
        <div class="fb-modal">
          <h3 class="fb-title">Submit Feedback</h3>
          
          <label class="fb-label">Category</label>
          <select id="fbCategory" class="fb-select">
            <option value="Bug">Bug Report</option>
            <option value="Improvement">Feature Request</option>
            <option value="Other">Other</option>
          </select>
  
          <label class="fb-label">Description</label>
          <textarea id="fbDesc" class="fb-textarea" placeholder="Tell us what's happening..."></textarea>
  
          <div class="fb-actions">
            <button class="fb-btn fb-cancel" id="fbCancel">Cancel</button>
            <button class="fb-btn fb-submit" id="fbSubmit">Send Feedback</button>
          </div>
        </div>
      </div>
  
      <!-- LOADING -->
      <div class="loader-overlay" id="appLoader">
        <!-- Play button inside Basketball SVG (Theme Logo) -->
        <svg class="loader-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" stroke="#ef4444" />
          <path d="M2.5 12h19M12 2.5a14 14 0 0 1 0 19M12 2.5a14 14 0 0 0 0 19" stroke="#ef4444" opacity="0.5" />
          <path d="M9.5 8l6 4-6 4V8z" fill="white" stroke="none" />
        </svg>
      </div>
    `;
    document.body.appendChild(container);

    // 3. Logic
    const fab = document.getElementById("fbFab");
    const overlay = document.getElementById("fbOverlay");
    const cancelBtn = document.getElementById("fbCancel");
    const submitBtn = document.getElementById("fbSubmit");
    const descInput = document.getElementById("fbDesc");
    const catInput = document.getElementById("fbCategory");
    const loader = document.getElementById("appLoader");

    // Toggle Modal
    fab.onclick = () => overlay.classList.add("open");
    const close = () => {
        overlay.classList.remove("open");
        descInput.value = "";
    };
    cancelBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    // Submit
    submitBtn.onclick = async () => {
        const desc = descInput.value.trim();
        if (!desc) return alert("Please enter a description.");

        submitBtn.disabled = true;
        submitBtn.innerText = "Sending...";

        try {
            const payload = {
                page_url: window.location.href,
                category: catInput.value,
                description: desc,
                metadata: {
                    userAgent: navigator.userAgent,
                    screen: `${window.screen.width}x${window.screen.height}`,
                    language: navigator.language
                }
            };

            const res = await fetch("/api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                alert("Thank you for your feedback!");
                close();
            } else {
                alert("Failed to send feedback. Please try again.");
            }
        } catch (e) {
            console.error(e);
            alert("Error sending feedback.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Send Feedback";
        }
    };

    // Loader Logic
    window.addEventListener("load", () => {
        setTimeout(() => {
            loader.style.opacity = "0";
            setTimeout(() => loader.remove(), 500);
        }, 600); // Slight delay to show off animation
    });

})();
