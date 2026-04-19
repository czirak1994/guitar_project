/* ===== AI Guitar Coach — Frontend Logic ===== */

const socket = io();

// === DOM Elements ===
const els = {
    connectionStatus: document.getElementById("connectionStatus"),
    statusDot: document.querySelector(".status-dot"),
    statusText: document.querySelector(".status-text"),
    deviceSelect: document.getElementById("deviceSelect"),
    bpmInput: document.getElementById("bpmInput"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    currentNote: document.getElementById("currentNote"),
    currentCents: document.getElementById("currentCents"),
    currentFreq: document.getElementById("currentFreq"),
    confidenceFill: document.getElementById("confidenceFill"),
    confidenceText: document.getElementById("confidenceText"),
    levelFill: document.getElementById("levelFill"),
    levelDb: document.getElementById("levelDb"),
    timingDeviation: document.getElementById("timingDeviation"),
    timingConsistency: document.getElementById("timingConsistency"),
    onTimeRatio: document.getElementById("onTimeRatio"),
    accuracyRing: document.getElementById("accuracyRing"),
    accuracyText: document.getElementById("accuracyText"),
    noteHistory: document.getElementById("noteHistory"),
    feedbackMessages: document.getElementById("feedbackMessages"),
    errorList: document.getElementById("errorList"),
    noteCard: document.getElementById("noteCard"),
};

let isRunning = false;
let noteCount = 0;
const MAX_HISTORY_NOTES = 60;

// === Socket Connection ===
socket.on("connect", () => {
    els.statusDot.classList.add("connected");
    els.statusText.textContent = "Connected";
    loadDevices();
});

socket.on("disconnect", () => {
    els.statusDot.classList.remove("connected");
    els.statusText.textContent = "Disconnected";
});

// === Load Audio Devices ===
async function loadDevices() {
    try {
        const res = await fetch("/api/devices");
        const devices = await res.json();
        els.deviceSelect.innerHTML = "";

        if (devices.length === 0) {
            els.deviceSelect.innerHTML = '<option value="">No input devices found</option>';
            return;
        }

        devices.forEach(d => {
            const opt = document.createElement("option");
            opt.value = d.index;
            opt.textContent = `${d.name} (${d.channels}ch, ${d.sample_rate}Hz)`;
            els.deviceSelect.appendChild(opt);
        });
    } catch (e) {
        console.error("Failed to load devices:", e);
        els.deviceSelect.innerHTML = '<option value="">Error loading devices</option>';
    }
}

// === Start / Stop ===
els.startBtn.addEventListener("click", async () => {
    const device = els.deviceSelect.value;
    const bpm = parseInt(els.bpmInput.value) || 120;

    try {
        const res = await fetch("/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device: device ? parseInt(device) : null, bpm }),
        });
        const data = await res.json();

        if (data.status === "started" || data.status === "already_running") {
            isRunning = true;
            els.startBtn.disabled = true;
            els.stopBtn.disabled = false;
            noteCount = 0;
            clearHistory();
        }
    } catch (e) {
        console.error("Start failed:", e);
    }
});

els.stopBtn.addEventListener("click", async () => {
    try {
        const res = await fetch("/api/stop", { method: "POST" });
        const data = await res.json();
        isRunning = false;
        els.startBtn.disabled = false;
        els.stopBtn.disabled = true;
    } catch (e) {
        console.error("Stop failed:", e);
    }
});

// === Real-time Audio Updates ===
socket.on("audio_update", (data) => {
    if (!isRunning) return;

    // Update note display
    if (data.note && data.note !== "—") {
        const parts = parseNote(data.note);
        els.currentNote.textContent = parts.name;
        updateCentsDisplay(parts.cents);
        els.currentFreq.textContent = `${data.freq_hz.toFixed(1)} Hz`;

        // Pulse animation
        els.noteCard.classList.add("pulse");
        setTimeout(() => els.noteCard.classList.remove("pulse"), 150);
    } else if (data.is_silent) {
        els.currentNote.textContent = "—";
        els.currentCents.textContent = "";
        els.currentFreq.textContent = "— Hz";
    }

    // Update confidence
    const confPct = Math.round(data.confidence * 100);
    els.confidenceFill.style.width = `${confPct}%`;
    els.confidenceText.textContent = `${confPct}%`;

    // Update level meter
    updateLevelMeter(data.db);

    // Add to note history if a note was detected
    if (data.detected_note) {
        addNoteToHistory(data.detected_note);
    }
});

// === Session Report ===
socket.on("session_report", (report) => {
    // Update timing metrics
    els.timingDeviation.textContent = `${report.timing_error_ms > 0 ? '+' : ''}${report.timing_error_ms.toFixed(0)}ms`;
    els.timingConsistency.textContent = `${report.timing_consistency.toFixed(0)}/100`;
    els.onTimeRatio.textContent = `${(report.on_time_ratio * 100).toFixed(0)}%`;

    // Update accuracy ring
    updateAccuracyRing(report.accuracy_pct);

    // Update feedback messages
    updateFeedback(report.messages);

    // Update error list
    updateErrors(report.errors);
});

// === Helper Functions ===

function parseNote(noteStr) {
    // Parse "A4 (+5c)" format
    const match = noteStr.match(/^([A-G]#?\d)\s*\(([+-]?\d+)c\)$/);
    if (match) {
        return { name: match[1], cents: parseInt(match[2]) };
    }
    return { name: noteStr, cents: 0 };
}

function updateCentsDisplay(cents) {
    if (cents === 0) {
        els.currentCents.textContent = "in tune";
        els.currentCents.className = "note-cents in-tune";
    } else {
        const sign = cents > 0 ? "+" : "";
        els.currentCents.textContent = `${sign}${cents}c`;
        els.currentCents.className = `note-cents ${cents > 0 ? 'sharp' : 'flat'}`;
    }
}

function updateLevelMeter(db) {
    // Map dB to percentage (-60dB = 0%, 0dB = 100%)
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    els.levelFill.style.height = `${pct}%`;
    els.levelDb.textContent = db > -100 ? `${db.toFixed(1)} dB` : "-∞ dB";

    els.levelFill.classList.remove("hot", "clipping");
    if (db > -3) {
        els.levelFill.classList.add("clipping");
    } else if (db > -12) {
        els.levelFill.classList.add("hot");
    }
}

function updateAccuracyRing(pct) {
    const circumference = 2 * Math.PI * 52; // r=52
    const offset = circumference * (1 - pct / 100);
    els.accuracyRing.style.strokeDashoffset = offset;
    els.accuracyText.textContent = `${pct.toFixed(0)}%`;

    // Color based on accuracy
    const color = pct >= 90 ? "var(--accent-green)"
                : pct >= 70 ? "var(--accent-amber)"
                : "var(--accent-red)";
    els.accuracyRing.style.stroke = color;
}

function addNoteToHistory(noteData) {
    // Remove placeholder
    const placeholder = els.noteHistory.querySelector(".history-placeholder");
    if (placeholder) placeholder.remove();

    const el = document.createElement("span");
    el.className = "history-note";
    el.textContent = noteData.note;
    el.title = `${noteData.freq_hz}Hz, ${noteData.cents}c, ${noteData.db}dB`;

    els.noteHistory.appendChild(el);
    noteCount++;

    // Trim old notes
    while (els.noteHistory.children.length > MAX_HISTORY_NOTES) {
        els.noteHistory.removeChild(els.noteHistory.firstChild);
    }

    // Auto-scroll
    els.noteHistory.scrollTop = els.noteHistory.scrollHeight;
}

function clearHistory() {
    els.noteHistory.innerHTML = '<div class="history-placeholder">Play some notes to see history...</div>';
    els.feedbackMessages.innerHTML = '<div class="feedback-placeholder">Start playing to receive feedback...</div>';
    els.errorList.innerHTML = '<div class="error-placeholder">No issues detected</div>';
    els.timingDeviation.textContent = "—";
    els.timingConsistency.textContent = "—";
    els.onTimeRatio.textContent = "—";
    els.accuracyText.textContent = "—";
    els.accuracyRing.style.strokeDashoffset = 326.7;
}

function updateFeedback(messages) {
    els.feedbackMessages.innerHTML = "";
    messages.forEach(msg => {
        const div = document.createElement("div");
        div.className = "feedback-msg";

        // Classify message type
        if (msg.startsWith("✅") || msg.startsWith("👍")) {
            div.classList.add("positive");
        } else if (msg.startsWith("⚠")) {
            div.classList.add("warning");
        } else if (msg.includes("📊")) {
            // summary — default style
        }

        div.textContent = msg;
        els.feedbackMessages.appendChild(div);
    });
}

function updateErrors(errors) {
    if (!errors || errors.length === 0) {
        els.errorList.innerHTML = '<div class="error-placeholder">No issues detected ✨</div>';
        return;
    }

    els.errorList.innerHTML = "";
    errors.forEach(err => {
        const div = document.createElement("div");
        div.className = `error-item severity-${err.severity}`;

        const icon = err.severity === "error" ? "🔴"
                   : err.severity === "warning" ? "🟡"
                   : "🔵";

        div.innerHTML = `
            <span class="error-icon">${icon}</span>
            <div>
                <div class="error-text">${err.message}</div>
                <div class="error-text" style="font-size:11px;color:var(--text-muted);margin-top:2px">${err.detail}</div>
            </div>
        `;
        els.errorList.appendChild(div);
    });
}

// Add pulse animation style
const style = document.createElement("style");
style.textContent = `
    .card-note.pulse { border-color: var(--accent-purple); box-shadow: var(--shadow-glow); }
`;
document.head.appendChild(style);
