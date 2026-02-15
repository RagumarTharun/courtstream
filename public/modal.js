(function () {
    // 1. Inject Styles
    const style = document.createElement("style");
    style.innerHTML = `
      .custom-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(4px);
        z-index: 10000;
        display: none;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.2s;
      }
      .custom-modal-overlay.open {
        display: flex;
        opacity: 1;
      }
  
      .custom-modal {
        background: #161922;
        border: 1px solid #262b3d;
        border-radius: 20px;
        padding: 32px;
        width: 90%;
        max-width: 400px;
        text-align: center;
        transform: translateY(20px);
        transition: transform 0.2s;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      }
      .custom-modal-overlay.open .custom-modal {
        transform: translateY(0);
      }
  
      .custom-modal h3 {
        margin: 0 0 12px;
        font-size: 20px;
        color: #fff;
        font-family: system-ui, sans-serif;
      }
  
      .custom-modal p {
        color: #9aa0b4;
        margin-bottom: 24px;
        line-height: 1.5;
        font-size: 15px;
        font-family: system-ui, sans-serif;
      }

      .custom-modal input {
        width: 100%;
        background: #0f1115;
        border: 1px solid #262b3d;
        color: white;
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 24px;
        font-family: system-ui;
        font-size: 16px; 
        box-sizing: border-box;
      }
      .custom-modal input:focus {
        outline: none;
        border-color: #3b82f6;
      }
  
      .custom-modal-btns {
        display: flex;
        gap: 12px;
      }
  
      .custom-modal-btn {
        flex: 1;
        padding: 14px;
        border-radius: 12px;
        border: none;
        font-weight: 600;
        cursor: pointer;
        font-size: 15px;
        transition: opacity 0.2s;
        font-family: system-ui, sans-serif;
      }
      .custom-modal-btn:hover { opacity: 0.9; }
  
      .cm-btn-cancel { background: #262b3d; color: #fff; }
      .cm-btn-confirm { background: #3b82f6; color: #fff; }
      .cm-btn-danger { background: #ef4444; color: #fff; }
    `;
    document.head.appendChild(style);

    // 2. Inject HTML
    const overlay = document.createElement("div");
    overlay.className = "custom-modal-overlay";
    overlay.innerHTML = `
      <div class="custom-modal">
        <h3 id="cmTitle">Title</h3>
        <p id="cmMsg">Message</p>
        <div id="cmInputContainer" style="display:none;">
            <input type="text" id="cmInput" autocomplete="off">
        </div>
        <div class="custom-modal-btns" id="cmBtns">
          <!-- Buttons injected dynamically -->
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 3. Logic
    const titleEl = document.getElementById("cmTitle");
    const msgEl = document.getElementById("cmMsg");
    const btnsEl = document.getElementById("cmBtns");
    const inputContainer = document.getElementById("cmInputContainer");
    const inputEl = document.getElementById("cmInput");

    let resolvePromise = null;

    function reset() {
        titleEl.innerText = "";
        msgEl.innerText = "";
        inputEl.value = "";
        inputContainer.style.display = "none";
        btnsEl.innerHTML = "";
        resolvePromise = null;
    }

    function close() {
        overlay.classList.remove("open");
        setTimeout(reset, 200);
    }

    function show(title, msg, type = "alert", placeholder = "") {
        return new Promise(resolve => {
            reset();
            resolvePromise = resolve;

            titleEl.innerText = title;
            msgEl.innerText = msg;
            overlay.classList.add("open");

            if (type === "prompt") {
                inputContainer.style.display = "block";
                inputEl.placeholder = placeholder;
                setTimeout(() => inputEl.focus(), 100);
            }

            // Create Buttons
            const cancelBtn = document.createElement("button");
            cancelBtn.className = "custom-modal-btn cm-btn-cancel";
            cancelBtn.innerText = "Cancel";
            cancelBtn.onclick = () => {
                close();
                resolve(type === "prompt" ? null : false);
            };

            const confirmBtn = document.createElement("button");
            confirmBtn.className = "custom-modal-btn " + (type === "destructive" ? "cm-btn-danger" : "cm-btn-confirm");
            confirmBtn.innerText = type === "destructive" ? "Delete" : "OK";
            confirmBtn.onclick = () => {
                close();
                if (type === "prompt") resolve(inputEl.value);
                else resolve(true);
            };

            if (type === "alert") {
                btnsEl.appendChild(confirmBtn);
            } else {
                btnsEl.appendChild(cancelBtn);
                btnsEl.appendChild(confirmBtn);
            }

            // Handle Enter key for prompt
            if (type === "prompt") {
                inputEl.onkeydown = (e) => {
                    if (e.key === "Enter") confirmBtn.click();
                    if (e.key === "Escape") cancelBtn.click();
                }
            }
        });
    }

    // 4. Override Native Functions
    window.alert = async (msg) => {
        await show("Alert", msg, "alert");
    };

    window.confirm = async (msg) => {
        // Simple confirm override. For more control, use showModal directly
        return await show("Confirm", msg, "confirm");
    };

    window.prompt = async (msg, defaultValue = "") => {
        return await show("Input Required", msg, "prompt", defaultValue);
    };

    // 5. Expose Custom API for titles/types
    window.showModal = show;

})();
