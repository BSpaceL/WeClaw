

(() => { // 🚀 作用域隔离防护服

    // 防止重复注入
    if (document.getElementById('agent-terminal')) return;

    console.log("🦞Agent 监控台 V6.5 已就绪...");

    // ============================
    // 1. 构建 UI
    // ============================
    const terminal = document.createElement('div');
    terminal.id = 'agent-terminal';
    terminal.style.cssText = `
      position: fixed; right: 20px; top: 20px; width: 380px;
      background: rgba(15, 15, 15, 0.98); border: 1px solid #10b981; border-radius: 8px;
      color: #4ade80; font-family: 'Menlo', 'Monaco', monospace; font-size: 13px;
      z-index: 2147483647; box-shadow: 0 8px 30px rgba(0,0,0,0.7);
      transition: height 0.3s ease; display: flex; flex-direction: column;
      height: 300px;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 15px; border-bottom: 1px solid #333; background: #0a0a0a; 
      border-radius: 8px 8px 0 0; font-weight: bold; cursor: move;
      display: flex; justify-content: space-between; align-items: center; user-select: none;
    `;
    
    const statusSpan = document.createElement('span');
    statusSpan.innerHTML = `🚀 待命 <span style="color:#666;">● Idle</span>`;
    
    const btnGroup = document.createElement('div');
    const clearBtn = document.createElement('span');
    clearBtn.innerText = '🧹';
    clearBtn.style.cssText = 'cursor:pointer; margin-right:10px; opacity:0.7;';
    
    const toggleBtn = document.createElement('span');
    toggleBtn.innerText = '➖';
    toggleBtn.style.cssText = 'cursor:pointer; font-weight:bold; padding:0 5px;';
    
    const content = document.createElement('div');
    content.id = 'agent-content';
    content.style.cssText = `
      flex-grow: 1; padding: 15px; overflow-y: auto; overflow-x: hidden;
      white-space: pre-wrap; word-break: break-all;
    `;
    content.innerHTML = `<div style="color:#666;">等待指令...</div>`;

    clearBtn.onclick = () => { content.innerHTML = ''; };
    
    let isCollapsed = false;
    toggleBtn.onclick = () => {
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
            terminal.style.height = '40px';
            terminal.style.overflow = 'hidden';
            content.style.display = 'none';
            toggleBtn.innerText = '口'; 
        } else {
            terminal.style.height = '300px';
            content.style.display = 'block';
            toggleBtn.innerText = '➖';
        }
    };

    btnGroup.appendChild(clearBtn);
    btnGroup.appendChild(toggleBtn);
    header.appendChild(statusSpan);
    header.appendChild(btnGroup);
    terminal.appendChild(header);
    terminal.appendChild(content);
    document.body.appendChild(terminal);

    function updateStatus(text, color = '#10b981') {
        statusSpan.innerHTML = `🚀 ${text} <span style="color:${color};font-size:12px;">●</span>`;
    }

    function showResult(text, type = 'info') {
        const div = document.createElement('div');
        div.style.marginBottom = '10px';
        div.style.padding = '8px';
        div.style.borderRadius = '4px';
        div.style.borderLeft = '3px solid #10b981';
        div.style.background = 'rgba(255,255,255,0.05)';
        
        if (type === 'cmd') {
            div.style.borderLeftColor = '#f59e0b';
            div.style.color = '#fff';
        } else if (type === 'result') {
            div.style.borderLeftColor = '#10b981';
            div.style.color = '#4ade80';
            div.style.fontWeight = 'bold';
        } else if (type === 'error') {
            div.style.borderLeftColor = '#ef4444';
            div.style.color = '#ef4444';
        }

        div.innerText = text;
        content.appendChild(div);
        content.scrollTop = content.scrollHeight;
    }

    // ============================
    // 2. 消息通信
    // ============================
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "AGENT_LOG") {
            console.log("[Agent Internal]:", msg.text);
            if (msg.text === '.') statusSpan.style.opacity = (statusSpan.style.opacity === '0.5' ? '1' : '0.5');
        }

        if (msg.type === "AGENT_CLEAR") {
            content.innerHTML = ''; 
            updateStatus("执行中...", "#f59e0b");
            if (isCollapsed) toggleBtn.click();
        }

        if (msg.type === "AGENT_FINISH") {
            updateStatus("完成", "#10b981");
            statusSpan.style.opacity = '1';
            let cleanText = msg.summary.replace("✅ 任务完成！\n📄 结果汇报：\n", ""); 
            showResult(cleanText, 'result');
            autoReplyWeChat(msg.summary);
        }
    });

    // ============================
    // 3. 指令捕捉 (防重影逻辑)
    // ============================
    
    // 🔥 全局锁：记录最后一次处理的指令和时间
    let lastProcessedText = "";
    let lastProcessedTime = 0;

    const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.dataset && node.dataset.agentProcessed) return;

                    const text = node.innerText || "";
                    
                    // 🔥 防死循环：忽略自己发出的带有"🤖执行汇报"的消息
                    if (!text.trim() || text.includes("🤖执行汇报")) return;

                    // 🔥 防抖：如果2秒内遇到完全一样的文本，说明是多层DOM重复触发，直接丢弃
                    if (text === lastProcessedText && (Date.now() - lastProcessedTime < 2000)) {
                        node.dataset.agentProcessed = "true";
                        return;
                    }

                    if (/^龙虾\s*stop/i.test(text)) {
                        lastProcessedText = text; lastProcessedTime = Date.now();
                        node.dataset.agentProcessed = "true";
                        chrome.runtime.sendMessage({ type: "STOP_AGENT_TASK" });
                        showResult("🛑 已手动强制终止", 'error');
                        updateStatus("已停止", "#ef4444");
                        return;
                    }

                    // 触发指令依然是你熟悉的“龙虾”
                    const match = text.match(/龙虾\s*(.+)/i);
                    if (match && match[1]) {
                        lastProcessedText = text; lastProcessedTime = Date.now();
                        node.dataset.agentProcessed = "true";
                        const prompt = match[1].trim();
                        
                        showResult(`指令: ${prompt}`, 'cmd');
                        
                        autoReplyWeChat("已接收指令，引擎启动中，期间请勿输入新指令...");
                        
                        chrome.runtime.sendMessage({ type: "START_AGENT_TASK", prompt: prompt });
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // ============================
    // 4. 自动回复 (并发锁 + 强力过滤逻辑)
    // ============================
    
    // 🔥 发送锁：确保同一时间只有一个回复任务在使用输入框
    let isReplying = false;

    async function autoReplyWeChat(text) {
        // 如果输入框正在被别的回复占用，就排队等待
        while (isReplying) {
            await new Promise(r => setTimeout(r, 200));
        }
        isReplying = true;

        try {
            console.log("🔎 正在寻找输入框...");
            const selectors = ['#editArea', 'div.input', '[contenteditable="true"]', 'div[role="textbox"]', '.chatInput', 'textarea'];
            let inputArea = null;
            for (let sel of selectors) {
                const els = document.querySelectorAll(sel);
                for (let el of els) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    if (rect.height > 0 && style.display !== 'none' && !el.disabled) {
                        inputArea = el;
                        break;
                    }
                }
                if (inputArea) break;
            }

            if (!inputArea) {
                showResult("⚠️ 发送失败：未找到输入框", 'error');
                return;
            }

            inputArea.click();
            inputArea.focus();
            await new Promise(r => setTimeout(r, 100));

            // 防御性清空
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);

            // 🔥 终极洁癖过滤：无论大模型返回的日志里有没有这俩字，强制替换成 "Agent"
            let sanitizedText = text.replace(/龙虾/g, "Agent");
            
            // 拼接全新的前缀
            const replyText = "🦞执行汇报：\n" + sanitizedText;
            
            const success = document.execCommand('insertText', false, replyText);
            if (!success) {
                inputArea.innerText = replyText;
                inputArea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            await new Promise(r => setTimeout(r, 500)); 

            const sendBtns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            const targetBtn = sendBtns.find(b => ['发送', 'Send', 'send'].includes(b.innerText?.trim()));
            if (targetBtn) {
                targetBtn.click();
            } else {
                inputArea.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
            }
            
            console.log("✅ 消息已发送");
        } catch (err) {
            showResult("❌ 发送异常: " + err.message, 'error');
        } finally {
            isReplying = false;
        }
    }
})();