document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['savedApiKey'], (result) => {
        if (result.savedApiKey) document.getElementById('apiKey').value = result.savedApiKey;
    });
});

const terminal = document.getElementById('terminal');

function addLog(text) {
    if (text === '.') {
        if (terminal.lastChild) terminal.lastChild.textContent += '.';
        return;
    }
    const logLine = document.createElement('div');
    logLine.className = 'log-item'; 
    logLine.textContent = text;
    terminal.appendChild(logLine);
    terminal.scrollTop = terminal.scrollHeight;
}

document.getElementById('saveBtn').addEventListener('click', () => {
    const key = document.getElementById('apiKey').value.trim();
    if (key) {
        chrome.storage.local.set({ savedApiKey: key }, () => {
            const status = document.getElementById('status');
            status.style.display = 'block';
            setTimeout(() => status.style.display = 'none', 2000);
            addLog("✅ 密钥已安全写入底层海马体！");
        });
    }
});

document.getElementById('abortBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "STOP_AGENT_TASK" });
    addLog("🛑 已向后台引擎发送物理熔断指令！");
});

// 🚀 核心：接收后台的日志广播并打印
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AGENT_LOG") addLog(msg.text);
    if (msg.type === "AGENT_CLEAR") terminal.innerHTML = `<div style="color:#10b981; font-weight:bold; margin-bottom:10px;">🚀 接收到新指令，异构引擎启动...</div>`;
});