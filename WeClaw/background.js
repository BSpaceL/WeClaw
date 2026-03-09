
let isAgentRunning = false;
let abortSignal = false;
let globalAbortController = null;
let filehelperTabId = null; 

const PLATFORM_ENDGAME_MAP = {
    "weibo.com": ["发送"],
    "zhihu.com": ["发布"],
    "xiaohongshu.com": ["发布"], 
    "default": ["发送", "发布", "发表", "发帖","评论"]
};

chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

function sendLog(text) {
    chrome.runtime.sendMessage({type: "AGENT_LOG", text: text}).catch(()=>{});
    if (filehelperTabId) {
        chrome.tabs.sendMessage(filehelperTabId, {type: "AGENT_LOG", text: text}).catch(()=>{});
    }
}

function clearLog() {
    chrome.runtime.sendMessage({type: "AGENT_CLEAR"}).catch(()=>{});
    if (filehelperTabId) {
        chrome.tabs.sendMessage(filehelperTabId, {type: "AGENT_CLEAR"}).catch(()=>{});
    }
}

function sendSummaryToWeChat(summaryText) {
    if (filehelperTabId) {
        chrome.tabs.get(filehelperTabId, (tab) => {
            if (!chrome.runtime.lastError && tab) {
                chrome.tabs.sendMessage(filehelperTabId, {type: "AGENT_FINISH", summary: summaryText}).catch(err => {
                    console.error("汇报发送失败:", err);
                });
            }
        });
    }
}

function safeParseJSON(str) {
    try {
        let cleanStr = str.replace(/```json/gi, '').replace(/```/gi, '').trim();
        const match = cleanStr.match(/\{[\s\S]*\}/);
        if (match) cleanStr = match[0];
        return JSON.parse(cleanStr); 
    } catch (e) {
        return null; 
    }
}

const sendMessageAsync = (tabId, message) => {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(response);
        });
    });
};

const randomSleep = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "START_AGENT_TASK") {
        if (sender && sender.tab) filehelperTabId = sender.tab.id; 
        runAgent(request.prompt);
        sendResponse({status: "started"});
    } else if (request.type === "STOP_AGENT_TASK") {
        if (isAgentRunning) {
            abortSignal = true;
            if (globalAbortController) globalAbortController.abort();
            sendLog('\n\n🚨 [最高指令] 收到中止信号！正在物理切断网络连接...\n');
        }
    }
    return true;
});

async function runAgent(promptText) {
    if (isAgentRunning) { sendLog("⚠️ 任务执行中，请勿重复下达指令！"); return; }

    clearLog(); isAgentRunning = true; abortSignal = false; globalAbortController = new AbortController();
    let tabsToClose = []; let originalTabId = filehelperTabId; let finalTaskStatus = "未知状态";
    let totalPromptTokens = 0; let totalCompletionTokens = 0;

    const { savedApiKey } = await chrome.storage.local.get(['savedApiKey']);
    if (!savedApiKey) {
        sendLog("❌ 权限拦截：请确保在侧边栏填写了 API Key！"); 
        isAgentRunning = false; return;
    }

    const apiKey = savedApiKey;
    const currentTimeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const API_URL = 'https://api.siliconflow.cn/v1/chat/completions';
    const MODEL_PLANNER = 'Pro/MiniMaxAI/MiniMax-M2.5'; 
    const MODEL_ACTOR = 'Pro/deepseek-ai/DeepSeek-V3.2'; 

    async function fetchWithHeartbeat(modelName, promptContent) {
        let heartbeat = setInterval(() => sendLog('.'), 1000); 
        let maxRetries = 3;
        let currentRetry = 0;

        while (currentRetry <= maxRetries) {
            if (abortSignal) break;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 95000);
                const signal = globalAbortController.signal.aborted ? globalAbortController.signal : controller.signal;

                const res = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: promptContent }], response_format: { type: 'json_object' } }),
                    signal: signal
                });
                clearTimeout(timeoutId); 

                if (!res.ok) {
                    if (res.status === 429 || res.status >= 500) {
                        currentRetry++;
                        sendLog(`⚠️ 接口拥堵 (${res.status})，退避重试 ${currentRetry}/${maxRetries}...`);
                        await randomSleep(2000 * currentRetry, 4000 * currentRetry);
                        continue;
                    }
                    throw new Error(`API Error: ${res.status}`);
                }

                const data = await res.json();
                clearInterval(heartbeat);
                
                if (data.usage) {
                    totalPromptTokens += data.usage.prompt_tokens || 0;
                    totalCompletionTokens += data.usage.completion_tokens || 0;
                }
                return data;

            } catch (err) {
                if (currentRetry === maxRetries || abortSignal) {
                    clearInterval(heartbeat); throw err;
                }
                currentRetry++;
                sendLog(`⚠️ 网络波动，重连中...`);
                await randomSleep(2000, 3000);
            }
        }
    }

    let MAX_STEPS = 15; let currentStep = 1; let actionHistory = []; let currentScanMode = "ALL"; let planText = ""; let globalClipboard = "空";

    try {
        sendLog(`🚀 [最高指令下达] 目标：${promptText}`);
        
        sendLog(`\n🧐 [情报分析局] 正在解析目标意图...`);
        const intentPrompt = `分析用户目标："${promptText}"
请将其归类为以下三种意图之一，严格返回 JSON 格式：
1. "QA"：纯静态知识问答、打招呼、闲聊。绝对不需要联网实时查询。
2. "READ"：需要获取实时信息、看热搜、读文章、查最新动态、总结网页内容。
3. "ACTION"：需要在网页上执行特定操作，如发帖、评论、点赞、上传等。

返回格式: {"type": "QA" | "READ" | "ACTION", "reason": "极简理由"}`;

        let intentObj = { type: "ACTION", reason: "默认兜底" }; 
        try {
            const intentRes = await fetchWithHeartbeat(MODEL_ACTOR, intentPrompt);
            let parsed = safeParseJSON(intentRes.choices[0].message.content);
            if(parsed && parsed.type) intentObj = parsed;
        } catch(e) { 
            sendLog(`⚠️ 意图解析网络波动，默认采用 ACTION 模式`); 
        }

        sendLog(`🎯 [意图锁定] ${intentObj.type} (${intentObj.reason})`);

        let intentGuidance = "";
        if (intentObj.type === "QA") {
            intentGuidance = "🔴 司令部已定性：此任务为【纯知识问答】。你必须直接返回 {\"direct_answer\": \"...\"}，禁止生成网页操作 plan。";
        } else if (intentObj.type === "READ") {
            intentGuidance = "🔴 司令部已定性：此任务为【获取实时信息/阅读】。你绝对不能使用 direct_answer 敷衍或道歉！必须生成前往对应网站(如看热搜去 momoyu.cc)的 plan，且首步 mode 设为 'ALL'。";
        } else {
            intentGuidance = "🔴 司令部已定性：此任务为【网页交互操作】。你必须生成详细的 plan 执行步骤，且首步 mode 设为 'ACTION_ONLY'。";
        }
        
        let consensusReached = false; let debateRound = 1; const MAX_DEBATE_ROUNDS = 8; 
        let currentDraftStr = ""; let finalPlanObj = null; let criticFeedback = "";

        while (!consensusReached && debateRound <= MAX_DEBATE_ROUNDS) {
            if (abortSignal) break;
            sendLog(`\n🔄 [赛博指挥部] 第 ${debateRound} 轮战术推演...`);
            sendLog(`🧠 [参谋长 MiniMax] 正在构建行动计划`);
            
            let plannerPrompt = `你是一个Web Agent的作战参谋。用户目标："${promptText}"
【系统强制时间】：${currentTimeStr}

${intentGuidance}

🚨【决策树 - 严格执行】：
1. 🧠 **直接问答/通用知识**：返回 {"direct_answer": "..."}。
2. 🌐 **需要操作或查询信息**：返回 {"plan": [...]}。

🚨【跨站任务 - 专属直达 URL (极为重要)】：
如果用户的目标涉及以下平台，Step 1 的 url 必须**原封不动**使用以下深层链接：
- 微博发帖：https://weibo.com
- 知乎发想法：https://www.zhihu.com
- 小红书发图文：https://creator.xiaohongshu.com/publish/publish?from=menu&target=image
- 任何网站看热搜：https://momoyu.cc/

🚨【任务核心流程】：
Step 1: 上述任务访问专属直达 URL 
Step 2: 按照目标网站的交互逻辑，逐步完成输入和点击。
Step 3: 如果是操作发帖，点击最终的发布按钮；如果是查询读取，则提取页面内容。

🔥【小红书专属战术规划 (强制执行)】：
只要用户是在小红书发图文，且未明确要求上传本地硬盘文件，你必须规划为“AI文字配图”路线。Plan 必须类似这样：
Step 1: 点击文字配图。
Step 2: 输入配图文案，点击生成图片。
Step 3: 点击下一步。
Step 4: 填写标题与正文，点击发布。

严格返回JSON (A/B二选一)：
A. {"direct_answer": "..."}
B. {"plan": [ {"step": 1, "task": "...", "url": "...", "mode": "..."} ]}`;

            if (criticFeedback) plannerPrompt += `\n\n🚨 【内审局反馈意见】：\n"${criticFeedback}"\n请修正后重新输出！`;

            let plannerData;
            try { 
                const data = await fetchWithHeartbeat(MODEL_PLANNER, plannerPrompt); 
                plannerData = data.choices[0].message.content;
            } catch(e) { sendLog("❌ MiniMax接口异常"); throw e; }
            currentDraftStr = plannerData;

            sendLog(`🕵️ [内审局 DeepSeek] 正在审查草案`);
            
            const reviewerPrompt = `你是督导官。审查：\n${currentDraftStr}\n
标准：
1. 🚫 直答防偷懒审查：如果用户要求“看热搜”、“查最新信息”、“搜索”，但草案给出了包含“抱歉”、“无法实时获取”等字眼的 direct_answer，必须严厉驳回 (is_approved: false)！要求其生成访问对应网址(如 momoyu.cc)的 plan！
2. 🌐 操作类审查：检查 URL 是否正确。特别是小红书发帖，必须是 creator.xiaohongshu.com 的深层链接！如果是看热搜资讯，建议跳往 https://momoyu.cc/ ！

⚠️ **大方向对直接通过 (is_approved: true)！**
如果不通过，填写理由。严格返回 JSON。`;

            let rawReviewerResponse;
            try { 
                const data = await fetchWithHeartbeat(MODEL_ACTOR, reviewerPrompt); 
                rawReviewerResponse = data.choices[0].message.content;
            } catch(e) { sendLog("❌ DeepSeek接口异常"); throw e; }
            
            let reviewerObj = safeParseJSON(rawReviewerResponse);
            
            if (!reviewerObj) {
                criticFeedback = "JSON格式解析失败，请确保返回纯JSON！";
                debateRound++; continue; 
            }

            if (reviewerObj.is_approved === false) {
                let rawReason = reviewerObj.feedback_for_planner || reviewerObj.feedback || "";
                if (!rawReason || String(rawReason).trim().length === 0) {
                    criticFeedback = "内审局驳回但未给理由。";
                } else {
                    criticFeedback = String(rawReason).trim();
                }
            }

            if (reviewerObj.is_approved === true) {
                consensusReached = true;
                let draftObj = safeParseJSON(currentDraftStr);
                if (!draftObj) draftObj = {plan: []};
                if (draftObj.direct_answer) reviewerObj.direct_answer = draftObj.direct_answer;
                if (!reviewerObj.plan || reviewerObj.plan.length === 0) reviewerObj.plan = draftObj.plan;
                finalPlanObj = reviewerObj;
                sendLog(`✅ [内审局决议] 方案通过！`);
            } else {
                sendLog(`❌ [内审局驳回] 理由: ${criticFeedback}`);
                if (debateRound === MAX_DEBATE_ROUNDS) {
                    finalPlanObj = safeParseJSON(currentDraftStr); 
                    if (!finalPlanObj) throw new Error("推演彻底失败");
                }
            }
            debateRound++;
        }

        if (abortSignal) throw new Error("AbortSignal");

        if (finalPlanObj.direct_answer) {
            sendLog(`\n💡 [知识库直出] 跳过浏览器操作。`);
            sendLog(`=============================`);
            sendLog(finalPlanObj.direct_answer);
            sendLog(`=============================`);
            finalTaskStatus = `✅ 问答完成：\n${finalPlanObj.direct_answer}`;
            currentStep = MAX_STEPS + 1; 
        } 
        else if (!finalPlanObj.plan || !Array.isArray(finalPlanObj.plan) || finalPlanObj.plan.length === 0) {
            sendLog(`⚠️ 自动生成闲聊任务...`);
            finalPlanObj.plan = [{ step: 1, task: "直接回复", url: "current", mode: "ALL" }];
        }

        if (!finalPlanObj.direct_answer) {
            planText = finalPlanObj.plan.map(p => `Step ${p.step}: ${p.task} [${p.mode || "ALL"}]`).join('\n');
            sendLog(`📋 [最终作战大纲] 签署完毕\n${planText}`);

            let firstStep = finalPlanObj.plan[0];
            let targetUrl = firstStep.url; 
            
            if (targetUrl && targetUrl !== "current") {
                if (targetUrl.includes("momoyu.cc")) targetUrl = "https://momoyu.cc/";
                sendLog(`🚀 检测到跨站任务，执行【母舰跳跃】直达战场：${targetUrl}`);
                const jumpTab = await chrome.tabs.create({ url: targetUrl, active: true });
                if (jumpTab && jumpTab.id) tabsToClose.push(jumpTab.id);
                await randomSleep(5000, 7000); 
            }
        }

        while (currentStep <= MAX_STEPS) {
            if (abortSignal) break;
            sendLog(`\n⏳ [第 ${currentStep}/${MAX_STEPS} 步] 提取状态...`);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { sendLog(`❌ 雷达丢失目标！`); throw new Error("雷达丢失目标"); }

            let currentDomain = "default";
            try { currentDomain = new URL(tab.url).hostname; } catch(e) {}

            let finalKeywords = PLATFORM_ENDGAME_MAP["default"];
            for (let domain in PLATFORM_ENDGAME_MAP) {
                if (currentDomain.includes(domain)) {
                    finalKeywords = PLATFORM_ENDGAME_MAP[domain];
                    break;
                }
            }

            let intendedMode = "ALL"; 
            const currentPlanItem = finalPlanObj.plan ? finalPlanObj.plan.find(p => p.step === currentStep) : null;
            
            if (currentPlanItem && currentPlanItem.mode) {
                intendedMode = currentPlanItem.mode;
            } else {
                let taskText = (currentPlanItem ? currentPlanItem.task : "").toLowerCase();
                if (/发帖|评论|输入|写|post|input|login|sign|publish/.test(taskText)) {
                    intendedMode = "ACTION_ONLY";
                }
            }
            currentScanMode = intendedMode;
            sendLog(`📷 视觉模式切换: ${currentScanMode === 'ACTION_ONLY' ? '🔴 聚焦(操作)' : '🟢 全景(阅读)'}`);

            let hasInputBefore = actionHistory.some(h => h.includes("input:yes"));
            let hasClickedSend = actionHistory.some(h => h.includes("(Clicked SEND)"));
            
            if (hasInputBefore && hasClickedSend) {
                sendLog(`🛡️ [流程锁] 检测到完整发帖流程 (Input -> 终极点击)，任务强制完结！`);
                finalTaskStatus = `✅ 任务完成！`;
                break; 
            }

            var scanRes = await sendMessageAsync(tab.id, { type: "scan-dom", mode: currentScanMode });
            
            if (scanRes.error || !scanRes || scanRes.status !== "success") {
                 try {
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    await randomSleep(1000, 1500);
                    scanRes = await sendMessageAsync(tab.id, { type: "scan-dom", mode: currentScanMode });
                } catch(e) {}
            }

            let domData = scanRes && scanRes.data ? scanRes.data : "";
            if (domData.length > 12000) domData = domData.substring(0, 12000) + "\n...(截断)";

            const systemPrompt = `[Role] WeClaw Web Agent
[Goal] "${promptText}"
[URL] ${tab.url}
[Plan]
${planText}

[History (最近5步)]
${actionHistory.slice(-5).join('\n')} 

🔴🔴 【执行铁律 (最高优先级，违者将被拦截)】
1. 🛡️ 流程锁定 (Sequence Lock)：
   - 必须先完成输入(Input)，才能去点击(Click)最后的操作按钮。
   - 🚨 警告：如果 History 显示已经对目标成功输入过了(input:yes)，严禁对同一个框再次输入！直接去找按钮！

2. 🎯 ID 防傻核对 (ID Verification)：
   - 准备点击 按钮 时，必须核对 targetId！绝不允许出现“点按钮却点到了刚才那个输入框 ID”的失误。
   - 🚨 【动态 ID 警告】：每次扫描 DOM，元素的 ID 都是重新生成的！绝对不能拿 History 里的旧数字 ID 和当前的 DOM 瞎对比！必须通过 History 里记录的“(动作:xxx)”中文描述，来判断自己上一步到底点的是什么功能！

3. ⏳ 【耐心等待铁律】：
   - 如果 DOM 文本中包含“图片生成中”、“生成中”、“请稍候”等提示，说明系统正在异步处理！
   - 此时你**绝对禁止**执行任何点击或输入，必须严格返回 {"type":"wait", "reason":"等待图片生成"}！

4. ✅ 【完结判别与防偷懒铁律】(必须严格遵守，违者打回)：
   - 🚨 严禁纸上谈兵：如果你意图点击【发布】按钮，你必须真正输出 {"type":"execute-id", "targetId":...} 去点它！绝对不能直接输出 done！
   - [发帖成功标志]：只有当你在上一轮真正派发了 execute-id 点击了最终的发布/发送按钮，且 History 中出现了 "(Clicked SEND)" 标志时，你这一轮才可以输出 done！没看到标志前，禁止完结！
   - [读取信息类]：提取完毕后 -> 立刻 Done！

📚 【特定网站专精技能一：知乎 (zhihu.com) "发想法"专精战术】
- 阶段一(破冰展开)：初始页面只显示“分享此刻的想法...”或【发想法】按钮。你的动作：【纯点击】它以展开编辑器！(🚨严禁在此阶段试图输入任何文字，会直接报错！)
- 阶段二(靶向输入)：编辑器完全展开后，出现标题框和正文框。你的动作：将目标文本输入到【正文框】(提示语通常为“分享你此刻的想法...”)！(🚨严禁把正文填到标题框里！)
- 阶段三(绝杀发布)：输入完毕后，右下角的按钮名称会变成【发布】。你的动作：纯点击这个【发布】按钮！(🚨此时绝对不要再去点“发想法”！)

📚 【特定网站专精技能二：小红书创作者中心 (xiaohongshu.com)】
- 关卡 1：初始状态下，寻找并纯点击【文字配图】按钮！
- 关卡 2：弹窗打开后，你的首要任务是【输入】！寻找 DOM 中的 <textarea> 标签或带有类似“真诚分享经验”占位符的输入框，将配图文案输入进去！(必须执行 inputText)
- 关卡 3：确认输入完成后，寻找并点击弹窗中的【生成图片】按钮！
- 关卡 4：图片生成后进入预览页，寻找并点击左下角的【下一步】按钮！(如果找不到下一步，请使用 wait 技能等待)
- 关卡 5：最终排版页，填写标题框 -> 填写正文框 -> 点击底部红色【发布】按钮！(点击发布后，才能在下一轮返回 done)

📚 【特定网站专精技能三：获取信息/看热搜 (momoyu.cc 等)】
- 你的动作：直接仔细阅读下方 DOM 提供的 [正文预览] 信息。
- 完结与汇报：立刻提取出用户需要的具体信息，并将它们排版成易读的文本，全部写在 done 指令的 reason 字段里！

[DOM]\n${domData}

[Output JSON Only (严禁空指令)]
{"type":"execute-id", "targetId":..., "inputText":"...", "reason":"..."} 
{"type":"done", "reason":"..."} 
{"type":"wait", "reason":"..."}`;

            sendLog(`🧠 前线装甲思考中`);
            let command = null;
            try {
                let data = await fetchWithHeartbeat(MODEL_ACTOR, systemPrompt);
                let commandStr = data.choices[0].message.content;
                command = safeParseJSON(commandStr);
            } catch (e) {
                sendLog(`⚠️ 思考连接中断，重试...`);
                await randomSleep(2000, 3000);
            }

            if (abortSignal) break;
            
            if (!command || !command.type) {
                sendLog("⚠️ 收到空指令/格式错误，强制进行等待和重试...");
                actionHistory.push(`[system] ❌ 你上一轮输出了空内容或非标准JSON，请严格遵守格式！`);
                await randomSleep(1500, 2000);
                currentStep++; continue;
            }


            if (command.type === "done" && intentObj.type === "ACTION") {
                let hasClickedSendFlag = actionHistory.some(h => h.includes("(Clicked SEND)"));
                if (!hasClickedSendFlag && /发|写|post|publish|发布/.test(promptText)) {
                    sendLog(`⚠️ [督战队拦截] 侦测到装甲企图提前完结！强制打回重做。`);
                    actionHistory.push(`[system] ❌ 严重警告：你的任务是发帖，但 History 中还没有出现 (Clicked SEND) 标志，说明你还没点击最后的【发布】按钮！严禁提前输出 done！请立即输出 execute-id 去真实点击发布按钮！`);
                    await randomSleep(1500, 2000);
                    currentStep++; continue;
                }
            }

            if (command.nextScanMode) currentScanMode = command.nextScanMode;
            if (command.clipboard) globalClipboard = command.clipboard;

            let safeReason = command.reason || "执行动作";
            sendLog(`💡 意图: ${safeReason}`);
            
            let historyLog = `[${command.type}]`;
            let shortReason = safeReason.replace(/\s+/g, '').substring(0, 12); 
            if (command.targetId) historyLog += ` id:${command.targetId} (动作:${shortReason})`;
            if (command.inputText) historyLog += ` input:yes`; 
            

            let lastInputId = null;
            for (let i = actionHistory.length - 1; i >= 0; i--) {
                let m = actionHistory[i].match(/id:(\d+).*input:yes/);
                if (m) { lastInputId = parseInt(m[1]); break; }
            }
            let hasInput = command.inputText || lastInputId !== null;

            let targetDesc = "";
            if (command.type === "execute-id" && command.targetId) {
                let domLines = domData.split('\n');
                for (let line of domLines) {
                    if (line.includes(`[ID:${command.targetId}]`)) {
                        targetDesc = line;
                        break;
                    }
                }
            }
            let isTargetAnInput = targetDesc.includes("[✍️核心输入框-打字在这里]");

            let isFinalPublish = false;
            let isIntermediate = false;

            if (command.type === "execute-id" && !command.inputText) {
                isFinalPublish = finalKeywords.some(k => 
                    targetDesc.includes(k) || 
                    safeReason.includes(`点击${k}`) || 
                    safeReason.includes(`点${k}`)
                );

                let intermediateKeywords = ["下一步", "生成图片"];
                isIntermediate = intermediateKeywords.some(k => 
                    targetDesc.includes(k) || 
                    safeReason.includes(`点击${k}`) || 
                    safeReason.includes(`点${k}`)
                );
            }

            let isSendIntent = isFinalPublish || isIntermediate;

            if (isSendIntent && command.type === "execute-id" && hasInput) {
                if (isTargetAnInput) {
                    sendLog(`🛑 [智商锁] 致命失误拦截：Agent 试图点击'输入框'(ID:${command.targetId})作为按钮！`);
                    command.type = "wait"; 
                    historyLog = `[execute-id] id:${command.targetId} ❌ 严重警告：你刚才点击了【输入框】，请仔细寻找并点击真正的【按钮】！`;
                } else {
                    if (isFinalPublish) {
                        historyLog += ` (Clicked SEND)`;
                        sendLog(`🏁 识别到当前平台 [${currentDomain}] 的终极动作，进入最后核验流程！`);
                    } else {
                        historyLog += ` (Clicked Intermediate Step)`;
                        sendLog(`➡️ 执行平台中间步骤，流程继续...`);
                    }
                }
            }
            
            actionHistory.push(historyLog);

            if (command.type === "done") {
                sendLog(`\n🎉 任务圆满完成！(耗时 ${currentStep} 步)`); 
                finalTaskStatus = `✅ 任务完成！\n📄 结果汇报：\n${safeReason}`; 
                break;
            } else if (command.type === "pause") {
                sendLog(`\n🛑 引擎悬停！呼叫人类：${safeReason}`); 
                finalTaskStatus = `⏸️ 任务中断：${safeReason}`; break;
            } else if (command.type === "wait") {
                sendLog(`⏳ [战术等待] 侦测到异步加载或等待指令，停表观察...`);
                await randomSleep(4000, 6000);
                currentStep--; 
            } else if (command.type === "execute-js") {
                const res = await sendMessageAsync(tab.id, command);
                if(res.error || !res.success) actionHistory.push(`❌ JS报错: ${res.error}`);
                await randomSleep(2000, 3000); 
            } else if (command.type === "execute-id") {
                sendLog(`⚡ 动作目标: [ID: ${command.targetId}]`);
                const res = await sendMessageAsync(tab.id, command);
                if (res.error || !res.success) {
                    actionHistory.push(`❌ 操作失败: ${res.error}`);
                    sendLog(`❌ 失败: ${res.error}`);
                } else {
                    actionHistory.push(`✅ 成功`);
                    
                    if (!command.inputText) {
                        let isGenerating = safeReason.includes("生成图片") || historyLog.includes("生成图片");
                        let minWait = isGenerating ? 10000 : 4000;
                        let maxWait = isGenerating ? 15000 : 6000;
                        sendLog(`⏳ 让子弹飞一会儿... (等待页面响应${isGenerating ? ' - 延长等待AI作图完成' : ''})`);
                        await randomSleep(minWait, maxWait); 
                    }
                }
            }
            currentStep++;
        }
    } catch (error) {
        if (error.message === "AbortSignal" || abortSignal) finalTaskStatus = `🛑 任务已被手动中止。`;
        else { sendLog(`\n❌ 发生异常: ${error.message}`); finalTaskStatus = `❌ 失败：${error.message}`; }
    } finally {
        const total = totalPromptTokens + totalCompletionTokens;
        sendLog(`\n📊 消耗统计: 输入${totalPromptTokens} + 输出${totalCompletionTokens} = 总计${total}`);
        
        if (tabsToClose.length > 0) {
            sendLog(`\n🧹 [无痕协议] 正在清理衍生标签页...`);
            await randomSleep(3000, 3500); 
            for (const tId of tabsToClose) { try { await chrome.tabs.remove(tId); } catch(e){} }
            
            if (originalTabId) { 
                try { 
                    await chrome.tabs.update(originalTabId, { active: true }); 
                    sendLog(`⌛ 正在唤醒母舰，准备汇报...`);
                    await randomSleep(1500, 2000);
                } catch(e){} 
            }
            sendLog(`✨ 现场清理完毕。`);
        }
        
        finalTaskStatus = finalTaskStatus.replace(/龙虾/g, "Agent");
        sendSummaryToWeChat(finalTaskStatus);
        
        isAgentRunning = false; globalAbortController = null;
    }
}
