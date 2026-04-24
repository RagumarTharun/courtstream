(function() {
    // We only want to trigger this AFTER login
    const checkUserInterval = setInterval(() => {
        // If currentUser exists (from fetch("/me") in index.html)
        if (typeof currentUser !== "undefined" && currentUser) {
            clearInterval(checkUserInterval);
            initHomeTutorial();
        } else if (typeof currentUser !== "undefined" && currentUser === null && document.getElementById("guestMenu").style.display === "flex") {
            // Un-authenticated. Stop looking.
            clearInterval(checkUserInterval);
        }
    }, 200);

    function initHomeTutorial() {
        const urlParams = new URLSearchParams(window.location.search);
        if (localStorage.getItem("cs_home_tour_v2") && !urlParams.has("tour")) {
            return;
        }

        const steps = [
            {
                id: "createBtn",
                title: "Start a Match",
                text: "Click here to create a new live session and start streaming instantly.",
                pos: "bottom"
            },
            {
                id: "appsNav",
                title: "Apps & Ecosystem",
                text: "CourtStream includes dedicated Scorekeeper, AI Director, and Video Editor dashboards. Access them all right here.",
                pos: "bottom-left"
            },
            {
                id: "streamList",
                title: "Live Sessions",
                text: "Any active streams or past sessions securely stored on your account will appear here.",
                pos: "bottom"
            }
        ];

        let currentStep = 0;

        // Inject CSS
        const style = document.createElement("style");
        style.innerHTML = `
            #tutorialOverlay {
                position: fixed;
                top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.75);
                z-index: 99998;
                transition: opacity 0.3s ease;
                pointer-events: none;
            }
            .tutorial-highlight {
                position: relative;
                z-index: 99999 !important;
                box-shadow: 0 0 0 4px var(--blue, #3b82f6), 0 0 20px rgba(59, 130, 246, 0.5) !important;
                background: var(--panel, #161922) !important;
                border-radius: 8px;
                pointer-events: auto;
            }
            #tutorialBox {
                position: absolute;
                z-index: 100000;
                background: var(--panel, #161922);
                border: 1px solid var(--blue, #3b82f6);
                border-radius: 12px;
                padding: 20px;
                width: 300px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.8);
                color: var(--text, #e6e6eb);
                font-family: system-ui, sans-serif;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                opacity: 0;
                transform: translateY(10px);
                pointer-events: auto;
            }
            #tutorialBox.active {
                opacity: 1;
                transform: translateY(0);
            }
            #tutorialTitle {
                font-size: 16px;
                font-weight: 700;
                color: #fff;
                margin: 0 0 8px 0;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            #tutorialText {
                font-size: 14px;
                color: var(--muted, #9aa0b4);
                line-height: 1.5;
                margin: 0 0 20px 0;
            }
            .tutorial-actions {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .tut-btn {
                background: transparent;
                border: 1px solid var(--border, #262b3d);
                color: var(--text, #e6e6eb);
                padding: 6px 14px;
                border-radius: 6px;
                font-size: 13px;
                cursor: pointer;
                transition: 0.2s;
            }
            .tut-btn.primary {
                background: var(--blue, #3b82f6);
                border-color: var(--blue, #3b82f6);
                color: #fff;
                font-weight: 600;
            }
            .tut-btn:hover {
                opacity: 0.8;
            }
            #tutorialCounter {
                font-size: 12px;
                color: var(--muted, #9aa0b4);
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement("div");
        overlay.id = "tutorialOverlay";
        document.body.appendChild(overlay);

        const box = document.createElement("div");
        box.id = "tutorialBox";
        box.innerHTML = `
            <div id="tutorialTitle">
                <span id="tutTitleStr"></span>
                <span id="tutorialCounter"></span>
            </div>
            <p id="tutorialText"></p>
            <div class="tutorial-actions">
                <button class="tut-btn" id="tutSkipBtn">Skip Tour</button>
                <button class="tut-btn primary" id="tutNextBtn">Next</button>
            </div>
        `;
        document.body.appendChild(box);

        const titleEl = document.getElementById("tutTitleStr");
        const textEl = document.getElementById("tutorialText");
        const counterEl = document.getElementById("tutorialCounter");
        const nextBtn = document.getElementById("tutNextBtn");
        const skipBtn = document.getElementById("tutSkipBtn");

        let currentHighlight = null;

        function finishTutorial() {
            localStorage.setItem("cs_home_tour_v2", "true");
            overlay.style.opacity = "0";
            box.style.opacity = "0";
            if (currentHighlight) {
                currentHighlight.classList.remove("tutorial-highlight");
            }
            setTimeout(() => {
                overlay.remove();
                box.remove();
                style.remove();
            }, 300);
        }

        function showStep(index) {
            if (currentHighlight) {
                currentHighlight.classList.remove("tutorial-highlight");
            }

            const step = steps[index];
            let target = document.getElementById(step.id);
            
            // For empty lists, highlight the empty state div instead of the zero-height streamList
            if (step.id === 'streamList') {
                const emptyState = document.getElementById("emptyState");
                if (emptyState && emptyState.style.display !== "none") {
                    target = emptyState;
                }
            }
            
            if (!target) {
                console.warn("Tutorial target not found:", step.id);
                if(index < steps.length - 1) {
                    currentStep++;
                    showStep(currentStep);
                } else {
                    finishTutorial();
                }
                return;
            }

            currentHighlight = target;
            currentHighlight.classList.add("tutorial-highlight");
            
            const rect = target.getBoundingClientRect();
            
            titleEl.textContent = step.title;
            textEl.textContent = step.text;
            counterEl.textContent = `${index + 1} / ${steps.length}`;
            
            if (index === steps.length - 1) {
                nextBtn.textContent = "Done";
            } else {
                nextBtn.textContent = "Next";
            }

            box.classList.remove("active");
            
            setTimeout(() => {
                const boxWidth = 300;
                const boxHeight = box.offsetHeight || 150;
                const padding = 20;

                let top = 0;
                let left = 0;

                if (step.pos === "bottom-left") {
                    top = rect.bottom + padding;
                    left = rect.right - boxWidth;
                    if (left < padding) left = rect.left;
                } else if (step.pos === "left") {
                    top = rect.top;
                    left = rect.left - boxWidth - padding;
                } else if (step.pos === "bottom") {
                    top = rect.bottom + padding;
                    left = rect.left + (rect.width / 2) - (boxWidth / 2);
                }

                if (top + boxHeight > window.innerHeight) top = window.innerHeight - boxHeight - padding;
                if (left + boxWidth > window.innerWidth) left = window.innerWidth - boxWidth - padding;
                if (top < padding) top = padding;
                if (left < padding) left = padding;

                box.style.top = `${top}px`;
                box.style.left = `${left}px`;
                box.classList.add("active");
            }, 50);
        }

        nextBtn.onclick = () => {
            currentStep++;
            if (currentStep >= steps.length) {
                finishTutorial();
            } else {
                showStep(currentStep);
            }
        };

        skipBtn.onclick = finishTutorial;

        setTimeout(() => {
            showStep(0);
        }, 500);
    }
})();
