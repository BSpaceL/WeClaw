
const STATE = {
    elementMap: new Map(), 
    idCounter: 0,
    lastHighlight: null
};

function getXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `//*[@id="${el.id}"]`;
    if (el === document.body) return '/html/body';
    let ix = 1, sibling = el.previousSibling;
    while (sibling) {
        if (sibling.nodeType === 1 && sibling.tagName === el.tagName) ix++;
        sibling = sibling.previousSibling;
    }
    return getXPath(el.parentNode) + '/' + el.tagName.toLowerCase() + '[' + ix + ']';
}

function queryDeep(root, selector) {
    let results = Array.from(root.querySelectorAll(selector));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.shadowRoot) {
            results = results.concat(queryDeep(node.shadowRoot, selector));
        }
    }
    return results;
}

function scanPage(mode = "ALL") {
    STATE.elementMap.clear();
    STATE.idCounter = 0;
    
    let selectors = 'a, button, input, textarea, [role="button"], [tabindex="0"], [contenteditable="true"], div[class*="btn"], span[class*="btn"], div[class*="button"], div[class*="input" i], div[class*="textarea" i]';

    let elements = queryDeep(document, selectors);
    
    const allDivs = Array.from(document.querySelectorAll('div, span'));
    allDivs.forEach(el => {
        const text = (el.innerText || "").trim();
        if (["生成图片", "下一步", "发布", "文字配图"].includes(text)) {
            if (!elements.includes(el)) elements.push(el);
        }
    });

    let interactables = [];
    let pageText = document.body.innerText || "";
    pageText = pageText.replace(/\s+/g, ' ').trim().substring(0, 8000);
    
    let resultLog = `📄 [页面] ${document.title}\n`;
    if (mode === "ALL") resultLog += `📰 [正文预览]: ${pageText}\n\n`;
    resultLog += `🎯 [探测到以下交互元素]:\n`;

    elements.forEach(el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return;
        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) return;

        const id = ++STATE.idCounter;
        STATE.elementMap.set(id, { node: el, xpath: getXPath(el) });
        
        let tag = el.tagName.toLowerCase();
        let text = (el.innerText || el.value || "").replace(/\s+/g, ' ').slice(0, 50);
        let placeholder = el.placeholder || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || "";
        let className = el.className || "";
        
        let contextTag = "";
        if (/search|搜索|查找|find/i.test(placeholder + className)) contextTag += " [⚠️可能是搜索框]";
        if (/发送|发布|下一步|生成图片|文字配图/i.test(text + el.title + className)) contextTag += " [🔥核心操作目标]";
        if (tag === 'textarea' || tag === 'input' || el.isContentEditable || /input|textarea/i.test(className)) {
            contextTag += " [✍️核心输入框-打字在这里]";
        }

        let desc = `[ID:${id}] <${tag}> "${text}" ${placeholder ? `(提示:${placeholder})` : ''}${contextTag}`;
        interactables.push(desc);
    });

    return resultLog + interactables.join('\n');
}

async function executeAction(cmd) {
    const targetId = parseInt(cmd.targetId);
    let targetData = STATE.elementMap.get(targetId);
    if (!targetData) return { success: false, error: "ID失效，请重新扫描" };

    let el = targetData.node;
    if (!document.contains(el)) {
        try {
            const recovered = document.evaluate(targetData.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (recovered) el = recovered;
            else return { success: false, error: "元素已消失" };
        } catch(e) { return { success: false, error: "复活失败" }; }
    }

    try {
        if (cmd.inputText) {
            if (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT' && !el.isContentEditable) {
                const inputs = Array.from(el.querySelectorAll('input, textarea, [contenteditable="true"]'));
                const visibleInput = inputs.find(i => window.getComputedStyle(i).display !== 'none' && window.getComputedStyle(i).visibility !== 'hidden');
                if (visibleInput) el = visibleInput;
                else if (inputs.length > 0) el = inputs[0];
            }

            el.scrollIntoView({ behavior: "smooth", block: "center" });
            
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
            el.focus();
            await new Promise(r => setTimeout(r, 100));

            if (el.isContentEditable) {
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, cmd.inputText);
                if (!el.innerText.includes(cmd.inputText)) el.innerText = cmd.inputText;
            } else {
                const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                
                if (nativeSetter) nativeSetter.call(el, '');
                else el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                
                if (nativeSetter) nativeSetter.call(el, cmd.inputText);
                else el.value = cmd.inputText;
                
                el.setAttribute('value', cmd.inputText);
                el.innerHTML = cmd.inputText; 
            }

            const eventOpts = { bubbles: true, composed: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', { ...eventOpts, key: 'Process' }));
            el.dispatchEvent(new InputEvent('beforeinput', { ...eventOpts, inputType: 'insertText', data: cmd.inputText }));
            el.dispatchEvent(new Event('input', eventOpts));
            el.dispatchEvent(new InputEvent('input', { ...eventOpts, inputType: 'insertText', data: cmd.inputText }));
            el.dispatchEvent(new KeyboardEvent('keyup', { ...eventOpts, key: 'Enter', keyCode: 13 }));
            el.dispatchEvent(new Event('change', eventOpts));

            el.blur();
            el.dispatchEvent(new Event('focusout', eventOpts));

            return { success: true, message: "输入成功" };

        } else {
            // ==========================================
            // 🎯 V14.2 拟真人类单发狙击 (防并发风控 + 随机坐标版)
            // ==========================================
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            await new Promise(r => setTimeout(r, 200));

            const rect = el.getBoundingClientRect();
            // 🌟 加入随机偏移，模拟人类点击的不精确性，避开绝对中心点风控
            const offsetX = (Math.random() - 0.5) * (rect.width * 0.4);
            const offsetY = (Math.random() - 0.5) * (rect.height * 0.4);
            const cx = rect.left + rect.width / 2 + offsetX;
            const cy = rect.top + rect.height / 2 + offsetY;

            let pointEl = document.elementFromPoint(cx, cy) || el;
            const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, clientX: cx, clientY: cy };

            // 1. 模拟鼠标轨迹与悬停
            pointEl.dispatchEvent(new MouseEvent('mouseover', opts));
            pointEl.dispatchEvent(new MouseEvent('mouseenter', opts));
            pointEl.dispatchEvent(new MouseEvent('mousemove', opts));
            await new Promise(r => setTimeout(r, 120));

            // 2. 真实物理按压
            pointEl.dispatchEvent(new PointerEvent('pointerdown', opts));
            pointEl.dispatchEvent(new MouseEvent('mousedown', opts));
            await new Promise(r => setTimeout(r, 85)); 

            // 3. 释放按压
            pointEl.dispatchEvent(new PointerEvent('pointerup', opts));
            pointEl.dispatchEvent(new MouseEvent('mouseup', opts));
            
            // 4. 🌟 绝对单发点击 (保证无论如何只送出一次 click 事件)
            let clickDispatched = pointEl.dispatchEvent(new MouseEvent('click', opts));
            
            // 绝不双重触发！只有在 dispatch 拦截时才用原生兜底
            if (!clickDispatched) {
                if (typeof pointEl.click === 'function') {
                    try { pointEl.click(); } catch(e) {}
                } else {
                    try { el.click(); } catch(e) {}
                }
            }

            return { success: true, message: "拟真点击完成" };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    (async () => {
        try {
            if (req.type === "scan-dom") sendResponse({ status: "success", data: scanPage(req.mode) });
            else if (req.type === "execute-id") sendResponse(await executeAction(req));
            else if (req.type === "scroll") { window.scrollBy({ top: 400, behavior: "smooth" }); sendResponse({ status: "success" }); }
        } catch (e) { sendResponse({ status: "error", error: e.toString() }); }
    })();
    return true; 
});