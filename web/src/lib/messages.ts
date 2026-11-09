import type { Messages } from "../../../shared/i18n";
import { processMessages } from "./messages.process";

export const messages = {
  "error.loadTemporary": {
    "en": "Unable to load right now",
    "zh-CN": "暂时无法加载",
    "zh-TW": "暫時無法載入"
  },
  "error.load": {
    "en": "Could not load",
    "zh-CN": "加载失败",
    "zh-TW": "載入失敗"
  },
  "error.connect": {
    "en": "Unable to connect right now",
    "zh-CN": "暂时无法连接",
    "zh-TW": "暫時無法連線"
  },
  "error.send": {
    "en": "Could not send",
    "zh-CN": "发送失败",
    "zh-TW": "傳送失敗"
  },
  "error.stop": {
    "en": "Could not stop",
    "zh-CN": "停止失败",
    "zh-TW": "停止失敗"
  },
  "error.logout": {
    "en": "Could not sign out",
    "zh-CN": "退出失败",
    "zh-TW": "登出失敗"
  },
  "error.rememberModel": {
    "en": "Could not save model preference",
    "zh-CN": "记住模型失败",
    "zh-TW": "儲存模型偏好失敗"
  },
  "error.switch": {
    "en": "Could not switch",
    "zh-CN": "切换失败",
    "zh-TW": "切換失敗"
  },
  "error.save": {
    "en": "Could not save",
    "zh-CN": "保存失败",
    "zh-TW": "儲存失敗"
  },
  "error.delete": {
    "en": "Could not delete",
    "zh-CN": "删除失败",
    "zh-TW": "刪除失敗"
  },
  "error.rerun": {
    "en": "Could not run again",
    "zh-CN": "重新运行失败",
    "zh-TW": "重新執行失敗"
  },
  "status.reconnecting": {
    "en": "Reconnecting",
    "zh-CN": "正在重连",
    "zh-TW": "正在重新連線"
  },
  "status.awaitingPermission": {
    "en": "Awaiting permission",
    "zh-CN": "等待授权",
    "zh-TW": "等待授權"
  },
  "status.awaitingReply": {
    "en": "Awaiting reply",
    "zh-CN": "等待回复",
    "zh-TW": "等待回覆"
  },
  "status.queued": {
    "en": "Queued",
    "zh-CN": "排队中",
    "zh-TW": "排隊中"
  },
  "status.awaitingWorkspace": {
    "en": "Waiting for workspace",
    "zh-CN": "等待工作区",
    "zh-TW": "等待工作區"
  },
  "status.stopping": {
    "en": "Stopping",
    "zh-CN": "正在停止",
    "zh-TW": "正在停止"
  },
  "status.processing": {
    "en": "Working",
    "zh-CN": "正在处理",
    "zh-TW": "正在處理"
  },
  "status.completed": {
    "en": "Completed",
    "zh-CN": "已完成",
    "zh-TW": "已完成"
  },
  "status.failed": {
    "en": "Incomplete",
    "zh-CN": "未完成",
    "zh-TW": "未完成"
  },
  "status.stopped": {
    "en": "Stopped",
    "zh-CN": "已停止",
    "zh-TW": "已停止"
  },
  "status.interrupted": {
    "en": "Interrupted",
    "zh-CN": "已中断",
    "zh-TW": "已中斷"
  },
  "chat.newConversation": {
    "en": "New conversation",
    "zh-CN": "新对话",
    "zh-TW": "新對話"
  },
  "status.loading": {
    "en": "Loading",
    "zh-CN": "加载中",
    "zh-TW": "載入中"
  },
  "common.close": {
    "en": "Close",
    "zh-CN": "关闭",
    "zh-TW": "關閉"
  },
  "error.cancel": {
    "en": "Could not cancel",
    "zh-CN": "取消失败",
    "zh-TW": "取消失敗"
  },
  "chat.editMessage": {
    "en": "Edit message",
    "zh-CN": "编辑消息",
    "zh-TW": "編輯訊息"
  },
  "chat.regenerateConfirm": {
    "en": "Regenerate response?",
    "zh-CN": "重新生成？",
    "zh-TW": "重新產生？"
  },
  "common.cancel": {
    "en": "Cancel",
    "zh-CN": "取消",
    "zh-TW": "取消"
  },
  "chat.rerun": {
    "en": "Run again",
    "zh-CN": "重新运行",
    "zh-TW": "重新執行"
  },
  "chat.messageContent": {
    "en": "Message content",
    "zh-CN": "消息内容",
    "zh-TW": "訊息內容"
  },
  "chat.rerunWarning": {
    "en": "Running again may repeat actions.",
    "zh-CN": "重新运行可能再次执行操作。",
    "zh-TW": "重新執行可能再次執行操作。"
  },
  "reasoning.budget": {
    "en": "Thinking budget",
    "zh-CN": "思考预算",
    "zh-TW": "思考預算"
  },
  "error.upload": {
    "en": "Could not upload",
    "zh-CN": "上传失败",
    "zh-TW": "上傳失敗"
  },
  "error.microphone": {
    "en": "Could not use the microphone",
    "zh-CN": "未能使用麦克风",
    "zh-TW": "無法使用麥克風"
  },
  "composer.supplementPlaceholder": {
    "en": "Add more details…",
    "zh-CN": "补充内容…",
    "zh-TW": "補充內容…"
  },
  "composer.placeholder": {
    "en": "What would you like to do?",
    "zh-CN": "你想做些什么？",
    "zh-TW": "你想做些什麼？"
  },
  "composer.messageLabel": {
    "en": "Message",
    "zh-CN": "发消息",
    "zh-TW": "傳送訊息"
  },
  "composer.addFile": {
    "en": "Add files",
    "zh-CN": "添加文件",
    "zh-TW": "加入檔案"
  },
  "composer.chooseModel": {
    "en": "Choose model",
    "zh-CN": "选择模型",
    "zh-TW": "選擇模型"
  },
  "common.default": {
    "en": "Default",
    "zh-CN": "默认",
    "zh-TW": "預設"
  },
  "reasoning.effort": {
    "en": "Thinking level",
    "zh-CN": "思考程度",
    "zh-TW": "思考程度"
  },
  "reasoning.thinking": {
    "en": "Thinking",
    "zh-CN": "思考",
    "zh-TW": "思考"
  },
  "reasoning.on": {
    "en": "Thinking · On",
    "zh-CN": "思考 · 开启",
    "zh-TW": "思考 · 開啟"
  },
  "reasoning.off": {
    "en": "Thinking · Off",
    "zh-CN": "思考 · 关闭",
    "zh-TW": "思考 · 關閉"
  },
  "common.on": {
    "en": "On",
    "zh-CN": "开启",
    "zh-TW": "開啟"
  },
  "computer.allow": {
    "en": "Allow computer use",
    "zh-CN": "允许使用电脑",
    "zh-TW": "允許使用電腦"
  },
  "computer.allowOnce": {
    "en": "Computer use · This turn only",
    "zh-CN": "允许使用电脑 · 仅本次",
    "zh-TW": "允許使用電腦 · 僅限本次"
  },
  "computer.allowOn": {
    "en": "Computer use · On",
    "zh-CN": "允许使用电脑 · 开启",
    "zh-TW": "允許使用電腦 · 開啟"
  },
  "computer.allowOff": {
    "en": "Computer use · Off",
    "zh-CN": "允许使用电脑 · 关闭",
    "zh-TW": "允許使用電腦 · 關閉"
  },
  "computer.once": {
    "en": "Computer · Once",
    "zh-CN": "电脑·本次",
    "zh-TW": "電腦·本次"
  },
  "computer.position": {
    "en": "Position",
    "zh-CN": "坐标",
    "zh-TW": "座標"
  },
  "computer.from": {
    "en": "From",
    "zh-CN": "起点",
    "zh-TW": "起點"
  },
  "computer.to": {
    "en": "To",
    "zh-CN": "终点",
    "zh-TW": "終點"
  },
  "computer.direction": {
    "en": "Direction",
    "zh-CN": "方向",
    "zh-TW": "方向"
  },
  "computer.button": {
    "en": "Button",
    "zh-CN": "按键",
    "zh-TW": "按鍵"
  },
  "computer.buttonLeft": {
    "en": "Left click",
    "zh-CN": "左键",
    "zh-TW": "左鍵"
  },
  "computer.buttonMiddle": {
    "en": "Middle click",
    "zh-CN": "中键",
    "zh-TW": "中鍵"
  },
  "computer.buttonRight": {
    "en": "Right click",
    "zh-CN": "右键",
    "zh-TW": "右鍵"
  },
  "computer.buttonDouble": {
    "en": "Double click",
    "zh-CN": "双击",
    "zh-TW": "雙擊"
  },
  "computer.characters": {
    "en": "Characters",
    "zh-CN": "字符",
    "zh-TW": "字元"
  },
  "computer.content": {
    "en": "Content",
    "zh-CN": "内容",
    "zh-TW": "內容"
  },
  "computer.keys": {
    "en": "Keys",
    "zh-CN": "组合键",
    "zh-TW": "組合鍵"
  },
  "computer.resolution": {
    "en": "Resolution",
    "zh-CN": "分辨率",
    "zh-TW": "解析度"
  },
  "computer.scrollUp": {
    "en": { "one": "Up {count} click", "other": "Up {count} clicks" },
    "zh-CN": "向上 {count} 格",
    "zh-TW": "向上 {count} 格"
  },
  "computer.scrollDown": {
    "en": { "one": "Down {count} click", "other": "Down {count} clicks" },
    "zh-CN": "向下 {count} 格",
    "zh-TW": "向下 {count} 格"
  },
  "computer.scrollLeft": {
    "en": { "one": "Left {count} click", "other": "Left {count} clicks" },
    "zh-CN": "向左 {count} 格",
    "zh-TW": "向左 {count} 格"
  },
  "computer.scrollRight": {
    "en": { "one": "Right {count} click", "other": "Right {count} clicks" },
    "zh-CN": "向右 {count} 格",
    "zh-TW": "向右 {count} 格"
  },
  "computer.noWindows": {
    "en": "No windows",
    "zh-CN": "没有窗口",
    "zh-TW": "沒有視窗"
  },
  "computer.noApps": {
    "en": "No applications",
    "zh-CN": "没有应用",
    "zh-TW": "沒有應用程式"
  },
  "computer.focused": {
    "en": "Focused",
    "zh-CN": "焦点",
    "zh-TW": "焦點"
  },
  "computer.queueNext": {
    "en": "You're next",
    "zh-CN": "即将轮到你",
    "zh-TW": "即將輪到你"
  },
  "computer.queueReady": {
    "en": "Ready to start",
    "zh-CN": "现在可以开始操作",
    "zh-TW": "現在可以開始操作"
  },
  "computer.act.click": {
    "en": "Click",
    "zh-CN": "点击",
    "zh-TW": "點擊"
  },
  "computer.act.move": {
    "en": "Move pointer",
    "zh-CN": "移动指针",
    "zh-TW": "移動指標"
  },
  "computer.act.drag": {
    "en": "Drag",
    "zh-CN": "拖拽",
    "zh-TW": "拖曳"
  },
  "computer.act.scroll": {
    "en": "Scroll",
    "zh-CN": "滚动",
    "zh-TW": "捲動"
  },
  "computer.act.type": {
    "en": "Type text",
    "zh-CN": "输入文本",
    "zh-TW": "輸入文字"
  },
  "computer.act.key": {
    "en": "Press keys",
    "zh-CN": "按键",
    "zh-TW": "按鍵"
  },
  "computer.act.screenshot": {
    "en": "Screenshot",
    "zh-CN": "截图",
    "zh-TW": "截圖"
  },
  "computer.act.observe": {
    "en": "Observe screen",
    "zh-CN": "观察屏幕",
    "zh-TW": "觀察螢幕"
  },
  "computer.act.windows": {
    "en": "Windows",
    "zh-CN": "窗口列表",
    "zh-TW": "視窗清單"
  },
  "computer.act.apps": {
    "en": "Available apps",
    "zh-CN": "可用应用",
    "zh-TW": "可用應用程式"
  },
  "computer.queueWaited": {
    "en": "Waited",
    "zh-CN": "已等待",
    "zh-TW": "已等待"
  },
  "computer.queueTook": {
    "en": "Took",
    "zh-CN": "用时",
    "zh-TW": "用時"
  },
  "computer.resDesktop": {
    "en": "Desktop",
    "zh-CN": "桌面",
    "zh-TW": "桌面"
  },
  "computer.resProject": {
    "en": "Workspace",
    "zh-CN": "工作区",
    "zh-TW": "工作區"
  },
  "computer.queueSlot": {
    "en": "Ahead of you",
    "zh-CN": "排在你前面",
    "zh-TW": "排在你前面"
  },
  "computer.queueYouTip": {
    "en": "Your request",
    "zh-CN": "你的任务",
    "zh-TW": "你的任務"
  },
  "permission.scopeChip": {
    "en": "This conversation only",
    "zh-CN": "仅限当前对话",
    "zh-TW": "僅限目前對話"
  },
  "computer.queueYou": {
    "en": "You",
    "zh-CN": "你",
    "zh-TW": "你"
  },
  "computer.queuePausedHint": {
    "en": "Waiting time is not counted while paused",
    "zh-CN": "暂停期间不计入等待时间",
    "zh-TW": "暫停期間不計入等待時間"
  },
  "computer.queueFooter": {
    "en": "First come, first served. Continues automatically when the computer is free.",
    "zh-CN": "按先到先得顺序分配，电脑空闲后自动继续。",
    "zh-TW": "依先到先得順序分配，電腦空閒後自動繼續。"
  },
  "computer.queuedPill": {
    "en": "Queued",
    "zh-CN": "排队中",
    "zh-TW": "排隊中"
  },
  "computer.queuedTitle": {
    "en": "Waiting for the computer",
    "zh-CN": "正在等待电脑",
    "zh-TW": "正在等待電腦"
  },
  "computer.queuedHint": {
    "en": "You'll take control as soon as it is free.",
    "zh-CN": "电脑空闲后你将立即获得控制权。",
    "zh-TW": "電腦空閒後你將立即取得控制權。"
  },
  "computer.aiControlling": {
    "en": "Ochi is controlling",
    "zh-CN": "Ochi 正在控制",
    "zh-TW": "Ochi 正在控制"
  },
  "computer.youControlling": {
    "en": "You are controlling",
    "zh-CN": "你正在控制",
    "zh-TW": "你正在控制"
  },
  "computer.badgeAi": {
    "en": "Ochi is operating · your input is paused",
    "zh-CN": "Ochi 正在操作 · 你的输入已暂停",
    "zh-TW": "Ochi 正在操作 · 你的輸入已暫停"
  },
  "computer.badgeUser": {
    "en": "You are in control · Ochi is paused",
    "zh-CN": "你正在控制 · Ochi 已暂停",
    "zh-TW": "你正在控制 · Ochi 已暫停"
  },
  "computer.badgeWatching": {
    "en": "Viewing · read only",
    "zh-CN": "观看中 · 只读",
    "zh-TW": "觀看中 · 唯讀"
  },
  "computer.disconnectedTitle": {
    "en": "Connection lost",
    "zh-CN": "连接已断开",
    "zh-TW": "連線已中斷"
  },
  "computer.disconnectedHint": {
    "en": "The desktop can't be reached right now.",
    "zh-CN": "暂时无法访问桌面。",
    "zh-TW": "暫時無法存取桌面。"
  },
  "computer.connecting": {
    "en": "Connecting…",
    "zh-CN": "正在连接…",
    "zh-TW": "正在連線…"
  },
  "computer.reconnecting": {
    "en": "Reconnecting…",
    "zh-CN": "正在重新连接…",
    "zh-TW": "正在重新連線…"
  },
  "computer.returnToOchi": {
    "en": "Hand back to Ochi",
    "zh-CN": "归还给 Ochi",
    "zh-TW": "歸還給 Ochi"
  },
  "computer.takeoverToType": {
    "en": "Take control to send text",
    "zh-CN": "接管后可发送文本",
    "zh-TW": "接管後可傳送文字"
  },
  "computer.log": {
    "en": "Activity",
    "zh-CN": "操作记录",
    "zh-TW": "操作記錄"
  },
  "computer.logEmpty": {
    "en": "Nothing yet in this window",
    "zh-CN": "此窗口中暂无记录",
    "zh-TW": "此視窗中暫無記錄"
  },
  "computer.logConnected": {
    "en": "Connected",
    "zh-CN": "已连接",
    "zh-TW": "已連線"
  },
  "computer.logDisconnected": {
    "en": "Disconnected",
    "zh-CN": "连接断开",
    "zh-TW": "連線中斷"
  },
  "computer.logTookOver": {
    "en": "You took control",
    "zh-CN": "你接管了控制",
    "zh-TW": "你接管了控制"
  },
  "computer.logReleased": {
    "en": "Control returned to Ochi",
    "zh-CN": "已归还给 Ochi",
    "zh-TW": "已歸還給 Ochi"
  },
  "computer.logOchiStarted": {
    "en": "Ochi started controlling",
    "zh-CN": "Ochi 开始控制",
    "zh-TW": "Ochi 開始控制"
  },
  "computer.logOchiStopped": {
    "en": "Ochi stopped controlling",
    "zh-CN": "Ochi 已停止控制",
    "zh-TW": "Ochi 已停止控制"
  },
  "computer.logSent": {
    "en": { "one": "Sent {count} character", "other": "Sent {count} characters" },
    "zh-CN": "发送了 {count} 个字符",
    "zh-TW": "傳送了 {count} 個字元"
  },
  "computer.logKey": {
    "en": "Pressed {key}",
    "zh-CN": "按下 {key}",
    "zh-TW": "按下 {key}"
  },
  "permission.heading": {
    "en": "Ochi wants to use your computer",
    "zh-CN": "Ochi 想要使用你的电脑",
    "zh-TW": "Ochi 想要使用你的電腦"
  },
  "permission.intro": {
    "en": "Needed for steps that use existing files, the desktop or connected tools.",
    "zh-CN": "用于需要已有文件、桌面或已连接工具的步骤。",
    "zh-TW": "用於需要既有檔案、桌面或已連線工具的步驟。"
  },
  "permission.capFiles": {
    "en": "Files and Projects",
    "zh-CN": "文件与项目",
    "zh-TW": "檔案與專案"
  },
  "permission.capFilesHint": {
    "en": "Read and change existing files",
    "zh-CN": "读取并修改已有文件",
    "zh-TW": "讀取並修改既有檔案"
  },
  "permission.capDesktop": {
    "en": "Desktop and browser",
    "zh-CN": "桌面与浏览器",
    "zh-TW": "桌面與瀏覽器"
  },
  "permission.capDesktopHint": {
    "en": "See the screen, click, type and open apps",
    "zh-CN": "查看屏幕、点击、输入并打开应用",
    "zh-TW": "查看畫面、點擊、輸入並開啟應用程式"
  },
  "permission.capTools": {
    "en": "Skills and MCP",
    "zh-CN": "技能与 MCP",
    "zh-TW": "技能與 MCP"
  },
  "permission.capToolsHint": {
    "en": "Use installed skills and connected tools",
    "zh-CN": "使用已安装的技能和已连接的工具",
    "zh-TW": "使用已安裝的技能和已連線的工具"
  },
  "permission.notice": {
    "en": "Ochi can see everything on the desktop. Avoid opening sensitive pages while it works.",
    "zh-CN": "Ochi 可看到桌面上的所有内容，请避免打开敏感页面。",
    "zh-TW": "Ochi 可看到桌面上的所有內容，請避免開啟敏感頁面。"
  },
  "permission.allowedTitle": {
    "en": "Computer access allowed",
    "zh-CN": "已允许使用电脑",
    "zh-TW": "已允許使用電腦"
  },
  "permission.scopeConversation": {
    "en": "For this conversation",
    "zh-CN": "本对话内有效",
    "zh-TW": "本對話內有效"
  },
  "permission.deniedTitle": {
    "en": "Computer access denied",
    "zh-CN": "已拒绝使用电脑",
    "zh-TW": "已拒絕使用電腦"
  },
  "permission.deniedHint": {
    "en": "Ochi won't use this computer",
    "zh-CN": "Ochi 不会使用这台电脑",
    "zh-TW": "Ochi 不會使用這台電腦"
  },
  "computer.title": {
    "en": "Computer",
    "zh-CN": "电脑",
    "zh-TW": "電腦"
  },
  "computer.exitFullscreenHint": {
    "en": "Press Esc to exit full screen",
    "zh-CN": "按 Esc 退出全屏",
    "zh-TW": "按 Esc 結束全螢幕"
  },
  "computer.specialKeys": {
    "en": "Special keys",
    "zh-CN": "特殊按键",
    "zh-TW": "特殊按鍵"
  },
  "computer.reconnectingHint": {
    "en": "Connecting to the workspace desktop",
    "zh-CN": "正在连接到工作区桌面",
    "zh-TW": "正在連線到工作區桌面"
  },
  "composer.supplementLabel": {
    "en": "Add instructions to the current task",
    "zh-CN": "补充当前任务要求",
    "zh-TW": "補充目前工作的要求"
  },
  "composer.supplementNoFiles": {
    "en": "Additional instructions cannot include attachments yet",
    "zh-CN": "补充要求暂不支持附件",
    "zh-TW": "補充要求暫不支援附件"
  },
  "composer.supplement": {
    "en": "Add",
    "zh-CN": "补充",
    "zh-TW": "補充"
  },
  "composer.stopRecording": {
    "en": "Stop recording",
    "zh-CN": "停止录音",
    "zh-TW": "停止錄音"
  },
  "composer.voiceInput": {
    "en": "Voice input",
    "zh-CN": "语音输入",
    "zh-TW": "語音輸入"
  },
  "composer.stopTask": {
    "en": "Stop current task",
    "zh-CN": "停止当前任务",
    "zh-TW": "停止目前工作"
  },
  "common.stop": {
    "en": "Stop",
    "zh-CN": "停止",
    "zh-TW": "停止"
  },
  "composer.stopAndSend": {
    "en": "Stop and send now",
    "zh-CN": "停止并立即发送",
    "zh-TW": "停止並立即傳送"
  },
  "composer.queue": {
    "en": "Queue message",
    "zh-CN": "排队发送",
    "zh-TW": "排隊傳送"
  },
  "common.send": {
    "en": "Send",
    "zh-CN": "发送",
    "zh-TW": "傳送"
  },
  "computer.accessError": {
    "en": "Cannot access computer",
    "zh-CN": "无法访问电脑",
    "zh-TW": "無法存取電腦"
  },
  "computer.unavailable": {
    "en": "Computer is temporarily unavailable",
    "zh-CN": "电脑暂时不可用",
    "zh-TW": "電腦暫時無法使用"
  },
  "computer.connectError": {
    "en": "Cannot connect to computer",
    "zh-CN": "无法连接电脑",
    "zh-TW": "無法連線至電腦"
  },
  "error.connection": {
    "en": "Connection failed",
    "zh-CN": "连接失败",
    "zh-TW": "連線失敗"
  },
  "computer.takeoverError": {
    "en": "Could not take control",
    "zh-CN": "接管失败",
    "zh-TW": "接管失敗"
  },
  "computer.watching": {
    "en": "Viewing",
    "zh-CN": "观看中",
    "zh-TW": "觀看中"
  },
  "status.connecting": {
    "en": "Connecting",
    "zh-CN": "正在连接",
    "zh-TW": "正在連線"
  },
  "status.disconnected": {
    "en": "Disconnected",
    "zh-CN": "连接断开",
    "zh-TW": "連線中斷"
  },
  "computer.inUse": {
    "en": "In use",
    "zh-CN": "正在使用",
    "zh-TW": "正在使用"
  },
  "common.reconnect": {
    "en": "Reconnect",
    "zh-CN": "重新连接",
    "zh-TW": "重新連線"
  },
  "computer.actualSize": {
    "en": "Actual size",
    "zh-CN": "原始大小",
    "zh-TW": "原始大小"
  },
  "computer.fit": {
    "en": "Fit to screen",
    "zh-CN": "适应屏幕",
    "zh-TW": "符合螢幕大小"
  },
  "computer.dragView": {
    "en": "Pan view",
    "zh-CN": "拖动视图",
    "zh-TW": "拖曳畫面"
  },
  "common.exitFullscreen": {
    "en": "Exit full screen",
    "zh-CN": "退出全屏",
    "zh-TW": "離開全螢幕"
  },
  "common.fullscreen": {
    "en": "Full screen",
    "zh-CN": "全屏",
    "zh-TW": "全螢幕"
  },
  "computer.cancelWait": {
    "en": "Cancel waiting",
    "zh-CN": "取消等待",
    "zh-TW": "取消等待"
  },
  "computer.takeover": {
    "en": "Take control",
    "zh-CN": "接管",
    "zh-TW": "接管"
  },
  "computer.keyboard": {
    "en": "Keyboard",
    "zh-CN": "键盘",
    "zh-TW": "鍵盤"
  },
  "computer.typeText": {
    "en": "Type text",
    "zh-CN": "输入文字",
    "zh-TW": "輸入文字"
  },
  "computer.sendText": {
    "en": "Send text to computer",
    "zh-CN": "输入到电脑",
    "zh-TW": "輸入至電腦"
  },
  "file.loadError": {
    "en": "Cannot load file",
    "zh-CN": "无法加载文件",
    "zh-TW": "無法載入檔案"
  },
  "file.preview": {
    "en": "Preview",
    "zh-CN": "预览",
    "zh-TW": "預覽"
  },
  "file.source": {
    "en": "Source",
    "zh-CN": "源码",
    "zh-TW": "原始碼"
  },
  "file.download": {
    "en": "Download",
    "zh-CN": "下载",
    "zh-TW": "下載"
  },
  "file.downloadFile": {
    "en": "Download file",
    "zh-CN": "下载文件",
    "zh-TW": "下載檔案"
  },
  "file.imageDetails": {
    "en": "Image details",
    "zh-CN": "图片详情",
    "zh-TW": "圖片詳細資訊"
  },
  "process.notSynced": {
    "en": "Process history has not synced yet",
    "zh-CN": "处理记录尚未同步",
    "zh-TW": "處理記錄尚未同步"
  },
  "process.title": {
    "en": "Process",
    "zh-CN": "处理过程",
    "zh-TW": "處理過程"
  },
  "process.reasoning": {
    "en": "Thinking process",
    "zh-CN": "思考过程",
    "zh-TW": "思考過程"
  },
  "error.login": {
    "en": "Could not sign in",
    "zh-CN": "登录失败",
    "zh-TW": "登入失敗"
  },
  "login.username": {
    "en": "Username",
    "zh-CN": "账号",
    "zh-TW": "帳號"
  },
  "login.password": {
    "en": "Password",
    "zh-CN": "密码",
    "zh-TW": "密碼"
  },
  "login.signIn": {
    "en": "Sign in",
    "zh-CN": "登录",
    "zh-TW": "登入"
  },
  "login.signingIn": {
    "en": "Signing in…",
    "zh-CN": "正在登录…",
    "zh-TW": "正在登入…"
  },
  "composer.uploading": {
    "en": "Uploading files",
    "zh-CN": "正在上传文件",
    "zh-TW": "正在上傳檔案"
  },
  "tasks.starting": {
    "en": "Starting…",
    "zh-CN": "正在启动…",
    "zh-TW": "正在啟動…"
  },
  "common.copied": {
    "en": "Copied",
    "zh-CN": "已复制",
    "zh-TW": "已複製"
  },
  "common.copy": {
    "en": "Copy",
    "zh-CN": "复制",
    "zh-TW": "複製"
  },
  "message.stopSpeech": {
    "en": "Stop reading aloud",
    "zh-CN": "停止朗读",
    "zh-TW": "停止朗讀"
  },
  "message.readAloud": {
    "en": "Read aloud",
    "zh-CN": "朗读",
    "zh-TW": "朗讀"
  },
  "message.regenerate": {
    "en": "Regenerate",
    "zh-CN": "重新生成",
    "zh-TW": "重新產生"
  },
  "message.listLabel": {
    "en": "Messages",
    "zh-CN": "消息列表",
    "zh-TW": "訊息列表"
  },
  "message.loadEarlier": {
    "en": "Load earlier messages",
    "zh-CN": "加载更早的消息",
    "zh-TW": "載入更早的訊息"
  },
  "hero.morning": {
    "en": "Good morning, {name}",
    "zh-CN": "早上好，{name}",
    "zh-TW": "早安，{name}"
  },
  "hero.afternoon": {
    "en": "Good afternoon, {name}",
    "zh-CN": "下午好，{name}",
    "zh-TW": "午安，{name}"
  },
  "hero.evening": {
    "en": "Good evening, {name}",
    "zh-CN": "晚上好，{name}",
    "zh-TW": "晚安，{name}"
  },
  "hero.sub": {
    "en": "What shall we work on today?",
    "zh-CN": "今天想一起处理什么？",
    "zh-TW": "今天想一起處理什麼？"
  },
  "hero.suggest.code": {
    "en": "Write an LRU cache with unit tests",
    "zh-CN": "写一个带单元测试的 LRU 缓存",
    "zh-TW": "寫一個帶單元測試的 LRU 快取"
  },
  "hero.suggest.research": {
    "en": "Research vector database options for 2026",
    "zh-CN": "调研一下 2026 年向量数据库的选型",
    "zh-TW": "調研一下 2026 年向量資料庫的選型"
  },
  "hero.suggest.image": {
    "en": "Generate an illustration of a snowy mountain under aurora",
    "zh-CN": "生成一张极光下的雪山插画",
    "zh-TW": "生成一張極光下的雪山插畫"
  },
  "hero.suggest.computer": {
    "en": "Open the browser and organize this week's bills",
    "zh-CN": "打开浏览器，帮我整理这周的账单",
    "zh-TW": "打開瀏覽器，幫我整理這週的帳單"
  },
  "message.latest": {
    "en": "Jump to latest message",
    "zh-CN": "回到最新消息",
    "zh-TW": "回到最新訊息"
  },
  "process.reasoningSummary": {
    "en": "Thinking summary",
    "zh-CN": "思考摘要",
    "zh-TW": "思考摘要"
  },
  "process.waitComputer": {
    "en": "Waiting for computer",
    "zh-CN": "等待电脑",
    "zh-TW": "等待電腦"
  },
  "process.waitProject": {
    "en": "Waiting for project workspace",
    "zh-CN": "等待项目工作区",
    "zh-TW": "等待專案工作區"
  },
  "tool.computerQueue": {
    "en": "Computer queue",
    "zh-CN": "电脑排队",
    "zh-TW": "電腦排隊"
  },
  "tool.computerRelease": {
    "en": "Release computer",
    "zh-CN": "释放电脑",
    "zh-TW": "釋放電腦"
  },
  "tool.filesCopy": {
    "en": "Transfer file",
    "zh-CN": "传输文件",
    "zh-TW": "傳輸檔案"
  },
  "process.thinking": {
    "en": "Thinking",
    "zh-CN": "思考中",
    "zh-TW": "思考中"
  },
  "process.replying": {
    "en": "Responding",
    "zh-CN": "正在回复",
    "zh-TW": "正在回覆"
  },
  "process.window": {
    "en": "Window",
    "zh-CN": "窗口",
    "zh-TW": "視窗"
  },
  "process.element": {
    "en": "UI element",
    "zh-CN": "界面元素",
    "zh-TW": "介面元素"
  },
  "process.verification": {
    "en": "Complete verification in the computer, then reply to continue.",
    "zh-CN": "需要在电脑中完成验证；完成后回复以继续。",
    "zh-TW": "需要在電腦中完成驗證；完成後回覆以繼續。"
  },
  "file.title": {
    "en": "File",
    "zh-CN": "文件",
    "zh-TW": "檔案"
  },
  "file.writeSize": {
    "en": "Bytes written",
    "zh-CN": "写入大小",
    "zh-TW": "寫入大小"
  },
  "common.type": {
    "en": "Type",
    "zh-CN": "类型",
    "zh-TW": "類型"
  },
  "browser.tabs": {
    "en": "Tabs",
    "zh-CN": "标签页",
    "zh-TW": "分頁"
  },
  "browser.currentPage": {
    "en": "Current page",
    "zh-CN": "当前页面",
    "zh-TW": "目前頁面"
  },
  "process.exitStatus": {
    "en": "Exit status",
    "zh-CN": "退出状态",
    "zh-TW": "結束狀態"
  },
  "process.partialOutput": {
    "en": "Partial output",
    "zh-CN": "部分输出",
    "zh-TW": "部分輸出"
  },
  "file.directory": {
    "en": "Directory",
    "zh-CN": "目录",
    "zh-TW": "目錄"
  },
  "process.duration": {
    "en": "Duration",
    "zh-CN": "耗时",
    "zh-TW": "耗時"
  },
  "process.fullOutput": {
    "en": "Full output",
    "zh-CN": "完整输出",
    "zh-TW": "完整輸出"
  },
  "process.stderr": {
    "en": "Error output",
    "zh-CN": "错误输出",
    "zh-TW": "錯誤輸出"
  },
  "file.format": {
    "en": "Format",
    "zh-CN": "格式",
    "zh-TW": "格式"
  },
  "file.size": {
    "en": "Size",
    "zh-CN": "大小",
    "zh-TW": "大小"
  },
  "file.pages": {
    "en": "Pages",
    "zh-CN": "页数",
    "zh-TW": "頁數"
  },
  "process.awaitingVerification": {
    "en": "Awaiting verification",
    "zh-CN": "等待人工验证",
    "zh-TW": "等待人工驗證"
  },
  "status.inProgress": {
    "en": "In progress",
    "zh-CN": "进行中",
    "zh-TW": "進行中"
  },
  "process.exit": {
    "en": "Exit",
    "zh-CN": "退出",
    "zh-TW": "結束"
  },
  "process.viewScreenshot": {
    "en": "View action screenshot",
    "zh-CN": "查看操作截图",
    "zh-TW": "查看操作截圖"
  },
  "process.result": {
    "en": "Action result",
    "zh-CN": "操作结果",
    "zh-TW": "操作結果"
  },
  "process.addedContent": {
    "en": "Added content",
    "zh-CN": "新增内容",
    "zh-TW": "新增內容"
  },
  "file.content": {
    "en": "File contents",
    "zh-CN": "文件内容",
    "zh-TW": "檔案內容"
  },
  "process.output": {
    "en": "Output",
    "zh-CN": "输出",
    "zh-TW": "輸出"
  },
  "process.technicalDetails": {
    "en": "Technical details",
    "zh-CN": "技术详情",
    "zh-TW": "技術詳細資訊"
  },
  "process.screenshot": {
    "en": "Action screenshot",
    "zh-CN": "操作截图",
    "zh-TW": "操作截圖"
  },
  "error.details": {
    "en": "Error details",
    "zh-CN": "错误详情",
    "zh-TW": "錯誤詳細資訊"
  },
  "queue.title": {
    "en": "Queue",
    "zh-CN": "排队",
    "zh-TW": "排隊"
  },
  "queue.edit": {
    "en": "Edit queued message",
    "zh-CN": "编辑排队消息",
    "zh-TW": "編輯排隊訊息"
  },
  "queue.cancel": {
    "en": "Cancel queued message",
    "zh-CN": "取消排队消息",
    "zh-TW": "取消排隊訊息"
  },
  "common.save": {
    "en": "Save",
    "zh-CN": "保存",
    "zh-TW": "儲存"
  },
  "queue.content": {
    "en": "Queued message content",
    "zh-CN": "排队消息内容",
    "zh-TW": "排隊訊息內容"
  },
  "instruction.title": {
    "en": "Additional instructions",
    "zh-CN": "补充要求",
    "zh-TW": "補充要求"
  },
  "common.retry": {
    "en": "Retry",
    "zh-CN": "重试",
    "zh-TW": "重試"
  },
  "message.viewResponse": {
    "en": "View response",
    "zh-CN": "查看答复",
    "zh-TW": "查看回覆"
  },
  "search.noResults": {
    "en": "No results found",
    "zh-CN": "没有找到相关结果",
    "zh-TW": "找不到相關結果"
  },
  "error.search": {
    "en": "Search failed",
    "zh-CN": "搜索失败",
    "zh-TW": "搜尋失敗"
  },
  "search.conversations": {
    "en": "Search conversations",
    "zh-CN": "搜索对话",
    "zh-TW": "搜尋對話"
  },
  "search.allConversations": {
    "en": "Search all conversations",
    "zh-CN": "搜索全部对话",
    "zh-TW": "搜尋所有對話"
  },
  "search.results": {
    "en": "Search results",
    "zh-CN": "搜索结果",
    "zh-TW": "搜尋結果"
  },
  "search.noConversations": {
    "en": "No conversations found",
    "zh-CN": "没有找到对话",
    "zh-TW": "找不到對話"
  },
  "common.loadMore": {
    "en": "Load more",
    "zh-CN": "加载更多",
    "zh-TW": "載入更多"
  },
  "sidebar.conversationList": {
    "en": "Conversation list",
    "zh-CN": "会话列表",
    "zh-TW": "對話列表"
  },
  "sidebar.expand": {
    "en": "Expand sidebar",
    "zh-CN": "展开侧栏",
    "zh-TW": "展開側邊欄"
  },
  "sidebar.resize": {
    "en": "Resize sidebar",
    "zh-CN": "调整侧栏宽度",
    "zh-TW": "調整側邊欄寬度"
  },
  "sidebar.collapse": {
    "en": "Collapse sidebar",
    "zh-CN": "收起侧栏",
    "zh-TW": "收合側邊欄"
  },
  "sidebar.close": {
    "en": "Close sidebar",
    "zh-CN": "关闭侧栏",
    "zh-TW": "關閉側邊欄"
  },
  "tasks.title": {
    "en": "Scheduled tasks",
    "zh-CN": "定时任务",
    "zh-TW": "排程工作"
  },
  "projects.title": {
    "en": "Projects",
    "zh-CN": "项目",
    "zh-TW": "專案"
  },
  "chat.conversations": {
    "en": "Conversations",
    "zh-CN": "对话",
    "zh-TW": "對話"
  },
  "sidebar.recent": {
    "en": "Recent conversations",
    "zh-CN": "最近对话",
    "zh-TW": "最近對話"
  },
  "common.rename": {
    "en": "Rename",
    "zh-CN": "重命名",
    "zh-TW": "重新命名"
  },
  "common.delete": {
    "en": "Delete",
    "zh-CN": "删除",
    "zh-TW": "刪除"
  },
  "sidebar.group.today": {
    "en": "Today",
    "zh-CN": "今天",
    "zh-TW": "今天"
  },
  "sidebar.group.yesterday": {
    "en": "Yesterday",
    "zh-CN": "昨天",
    "zh-TW": "昨天"
  },
  "sidebar.group.week": {
    "en": "Past 7 days",
    "zh-CN": "过去 7 天",
    "zh-TW": "過去 7 天"
  },
  "sidebar.group.older": {
    "en": "Older",
    "zh-CN": "更早",
    "zh-TW": "更早"
  },
  "sidebar.role.admin": {
    "en": "Administrator",
    "zh-CN": "管理员",
    "zh-TW": "管理員"
  },
  "sidebar.role.user": {
    "en": "Member",
    "zh-CN": "成员",
    "zh-TW": "成員"
  },
  "sidebar.earlier": {
    "en": "Earlier conversations",
    "zh-CN": "更早的对话",
    "zh-TW": "更早的對話"
  },
  "sidebar.accountMenu": {
    "en": "Account menu",
    "zh-CN": "账户菜单",
    "zh-TW": "帳戶選單"
  },
  "settings.title": {
    "en": "Settings",
    "zh-CN": "设置",
    "zh-TW": "設定"
  },
  "sidebar.admin": {
    "en": "Administration",
    "zh-CN": "管理后台",
    "zh-TW": "管理後台"
  },
  "login.signOut": {
    "en": "Sign out",
    "zh-CN": "退出登录",
    "zh-TW": "登出"
  },
  "chat.rename": {
    "en": "Rename conversation",
    "zh-CN": "重命名对话",
    "zh-TW": "重新命名對話"
  },
  "chat.name": {
    "en": "Conversation name",
    "zh-CN": "对话名称",
    "zh-TW": "對話名稱"
  },
  "chat.deleteConfirm": {
    "en": "Delete conversation?",
    "zh-CN": "删除对话？",
    "zh-TW": "刪除對話？"
  },
  "sidebar.open": {
    "en": "Open sidebar",
    "zh-CN": "打开侧栏",
    "zh-TW": "開啟側邊欄"
  },
  "process.collapseThinking": {
    "en": "Collapse thinking",
    "zh-CN": "收起思考",
    "zh-TW": "收合思考"
  },
  "process.expandThinking": {
    "en": "Expand thinking",
    "zh-CN": "展开思考",
    "zh-TW": "展開思考"
  },
  "message.title": {
    "en": "Message",
    "zh-CN": "消息",
    "zh-TW": "訊息"
  },
  "message.copied": {
    "en": "Message copied",
    "zh-CN": "已复制消息",
    "zh-TW": "已複製訊息"
  },
  "message.copy": {
    "en": "Copy message",
    "zh-CN": "复制消息",
    "zh-TW": "複製訊息"
  },
  "common.edit": {
    "en": "Edit",
    "zh-CN": "编辑",
    "zh-TW": "編輯"
  },
  "message.resend": {
    "en": "Resend",
    "zh-CN": "重新发送",
    "zh-TW": "重新傳送"
  },
  "plugins.title": {
    "en": "Plugins",
    "zh-CN": "插件",
    "zh-TW": "外掛程式"
  },
  "plugins.refresh": {
    "en": "Refresh plugins",
    "zh-CN": "刷新插件",
    "zh-TW": "重新整理外掛程式"
  },
  "plugins.loading": {
    "en": "Loading plugins",
    "zh-CN": "加载插件",
    "zh-TW": "載入外掛程式"
  },
  "plugins.required": {
    "en": "Enabled by administrator",
    "zh-CN": "管理员默认开启",
    "zh-TW": "管理員預設啟用"
  },
  "plugins.empty": {
    "en": "No plugins available",
    "zh-CN": "暂无可用插件",
    "zh-TW": "目前沒有可用的外掛程式"
  },
  "memory.fact": {
    "en": "Fact",
    "zh-CN": "事实",
    "zh-TW": "事實"
  },
  "memory.preference": {
    "en": "Preference",
    "zh-CN": "偏好",
    "zh-TW": "偏好"
  },
  "memory.sessionSummary": {
    "en": "Conversation summary",
    "zh-CN": "会话摘要",
    "zh-TW": "對話摘要"
  },
  "memory.projectSummary": {
    "en": "Project summary",
    "zh-CN": "项目摘要",
    "zh-TW": "專案摘要"
  },
  "settings.categories": {
    "en": "Settings categories",
    "zh-CN": "设置分类",
    "zh-TW": "設定分類"
  },
  "settings.appearance": {
    "en": "Appearance",
    "zh-CN": "外观",
    "zh-TW": "外觀"
  },
  "memory.title": {
    "en": "Memory",
    "zh-CN": "记忆",
    "zh-TW": "記憶"
  },
  "settings.theme": {
    "en": "Theme",
    "zh-CN": "主题",
    "zh-TW": "主題"
  },
  "settings.look": {
    "en": "Style",
    "zh-CN": "风格",
    "zh-TW": "風格"
  },
  "settings.lookQuiet": {
    "en": "Quiet",
    "zh-CN": "静谧",
    "zh-TW": "靜謐"
  },
  "settings.lookMono": {
    "en": "Mono",
    "zh-CN": "单色等宽",
    "zh-TW": "單色等寬"
  },
  "settings.canvas": {
    "en": "Layout",
    "zh-CN": "布局",
    "zh-TW": "版面"
  },
  "settings.canvasSheet": {
    "en": "Paper",
    "zh-CN": "纸张",
    "zh-TW": "紙張"
  },
  "settings.canvasFlat": {
    "en": "Flat",
    "zh-CN": "平面",
    "zh-TW": "平面"
  },
  "settings.light": {
    "en": "Light",
    "zh-CN": "浅色",
    "zh-TW": "淺色"
  },
  "settings.dark": {
    "en": "Dark",
    "zh-CN": "深色",
    "zh-TW": "深色"
  },
  "memory.edit": {
    "en": "Edit memory",
    "zh-CN": "编辑记忆",
    "zh-TW": "編輯記憶"
  },
  "memory.add": {
    "en": "Add memory",
    "zh-CN": "添加记忆",
    "zh-TW": "新增記憶"
  },
  "memory.enable": {
    "en": "Enable memory",
    "zh-CN": "启用记忆",
    "zh-TW": "啟用記憶"
  },
  "common.content": {
    "en": "Content",
    "zh-CN": "内容",
    "zh-TW": "內容"
  },
  "memory.kind": {
    "en": "Memory type",
    "zh-CN": "记忆类型",
    "zh-TW": "記憶類型"
  },
  "memory.scope": {
    "en": "Scope",
    "zh-CN": "范围",
    "zh-TW": "範圍"
  },
  "memory.scopeLabel": {
    "en": "Memory scope",
    "zh-CN": "记忆范围",
    "zh-TW": "記憶範圍"
  },
  "memory.personal": {
    "en": "Personal",
    "zh-CN": "个人",
    "zh-TW": "個人"
  },
  "memory.search": {
    "en": "Search memories",
    "zh-CN": "搜索记忆",
    "zh-TW": "搜尋記憶"
  },
  "memory.filter": {
    "en": "Filter memories",
    "zh-CN": "筛选记忆",
    "zh-TW": "篩選記憶"
  },
  "common.saving": {
    "en": "Saving…",
    "zh-CN": "正在保存…",
    "zh-TW": "正在儲存…"
  },
  "common.add": {
    "en": "Add",
    "zh-CN": "添加",
    "zh-TW": "新增"
  },
  "memory.allScopes": {
    "en": "All scopes",
    "zh-CN": "全部范围",
    "zh-TW": "所有範圍"
  },
  "memory.allKinds": {
    "en": "All types",
    "zh-CN": "全部类型",
    "zh-TW": "所有類型"
  },
  "common.reset": {
    "en": "Reset",
    "zh-CN": "重置",
    "zh-TW": "重設"
  },
  "common.automatic": {
    "en": "Automatic",
    "zh-CN": "自动",
    "zh-TW": "自動"
  },
  "common.manual": {
    "en": "Manual",
    "zh-CN": "手动",
    "zh-TW": "手動"
  },
  "memory.sourceConversation": {
    "en": "Source conversation",
    "zh-CN": "来源对话",
    "zh-TW": "來源對話"
  },
  "memory.sourceExcerpt": {
    "en": "Source excerpt",
    "zh-CN": "来源片段",
    "zh-TW": "來源片段"
  },
  "memory.delete": {
    "en": "Delete memory",
    "zh-CN": "删除记忆",
    "zh-TW": "刪除記憶"
  },
  "memory.noResults": {
    "en": "No memories found",
    "zh-CN": "没有找到记忆",
    "zh-TW": "找不到記憶"
  },
  "memory.empty": {
    "en": "No memories yet",
    "zh-CN": "暂无记忆",
    "zh-TW": "尚無記憶"
  },
  "permission.once": {
    "en": "This turn only",
    "zh-CN": "仅本次",
    "zh-TW": "僅限本次"
  },
  "permission.conversation": {
    "en": "Allow for this conversation",
    "zh-CN": "此对话允许",
    "zh-TW": "允許此對話使用"
  },
  "permission.deny": {
    "en": "Don't allow",
    "zh-CN": "不允许",
    "zh-TW": "不允許"
  },
  "waiting.placeholder": {
    "en": "Enter a reply",
    "zh-CN": "输入回复",
    "zh-TW": "輸入回覆"
  },
  "waiting.reply": {
    "en": "Reply",
    "zh-CN": "回复",
    "zh-TW": "回覆"
  },
  "common.continue": {
    "en": "Continue",
    "zh-CN": "继续",
    "zh-TW": "繼續"
  },
  "runError.artifacts": {
    "en": "The task could not finish. Existing files are still available.",
    "zh-CN": "任务未能完成，已有文件仍可使用。",
    "zh-TW": "工作未能完成，現有檔案仍可使用。"
  },
  "runError.outputLimit": {
    "en": "The model reached its output limit before finishing the reply.",
    "zh-CN": "模型已达到本轮输出上限，回复尚未完成。",
    "zh-TW": "模型已達到本輪輸出上限，回覆尚未完成。"
  },
  "runError.context": {
    "en": "This conversation cannot continue right now. Please try again.",
    "zh-CN": "暂时无法继续这段对话，请重试。",
    "zh-TW": "暫時無法繼續這段對話，請重試。"
  },
  "runError.interrupted": {
    "en": "The task was interrupted. Please try again.",
    "zh-CN": "任务已中断，请重试。",
    "zh-TW": "工作已中斷，請重試。"
  },
  "runError.timeout": {
    "en": "The response timed out. Please try again.",
    "zh-CN": "响应超时，请重试。",
    "zh-TW": "回應逾時，請重試。"
  },
  "runError.provider": {
    "en": "The model could not finish its reply. Please try again.",
    "zh-CN": "模型暂时未能完成回复，请重试。",
    "zh-TW": "模型暫時未能完成回覆，請重試。"
  },
  "runError.failed": {
    "en": "The task could not finish. Please try again.",
    "zh-CN": "任务未能完成，请重试。",
    "zh-TW": "工作未能完成，請重試。"
  },
  "error.credentials": {
    "en": "Incorrect username or password",
    "zh-CN": "账号或密码不正确",
    "zh-TW": "帳號或密碼不正確"
  },
  "error.signInAgain": {
    "en": "Please sign in again",
    "zh-CN": "请重新登录",
    "zh-TW": "請重新登入"
  },
  "error.notFound": {
    "en": "Content not found",
    "zh-CN": "内容不存在",
    "zh-TW": "內容不存在"
  },
  "error.sessionBusy": {
    "en": "This conversation is running",
    "zh-CN": "此对话正在运行",
    "zh-TW": "此對話正在執行"
  },
  "error.conflict": {
    "en": "This action conflicts with another operation",
    "zh-CN": "当前操作发生冲突",
    "zh-TW": "目前操作發生衝突"
  },
  "error.rateLimited": {
    "en": "Please try again later",
    "zh-CN": "请稍后再试",
    "zh-TW": "請稍後再試"
  },
  "error.unavailable": {
    "en": "Service is temporarily unavailable",
    "zh-CN": "服务暂时不可用",
    "zh-TW": "服務暫時無法使用"
  },
  "error.messageRequired": {
    "en": "Enter a message first",
    "zh-CN": "请先输入消息",
    "zh-TW": "請先輸入訊息"
  },
  "error.forbidden": {
    "en": "Access denied",
    "zh-CN": "无法访问",
    "zh-TW": "無法存取"
  },
  "error.fileSize": {
    "en": "File is too large. Choose a file up to 32 MB.",
    "zh-CN": "文件太大，请选择 32 MB 以内的文件",
    "zh-TW": "檔案太大，請選擇 32 MB 以內的檔案"
  },
  "error.request": {
    "en": "Request failed. Please try again.",
    "zh-CN": "请求失败，请重试",
    "zh-TW": "請求失敗，請重試"
  },
  "error.installTimeout": {
    "en": "Installation timed out",
    "zh-CN": "安装超时",
    "zh-TW": "安裝逾時"
  },
  "error.install": {
    "en": "Installation failed",
    "zh-CN": "安装失败",
    "zh-TW": "安裝失敗"
  },
  "tool.exec": {
    "en": "Run code",
    "zh-CN": "运行代码",
    "zh-TW": "執行程式碼"
  },
  "tool.image": {
    "en": "Generate image",
    "zh-CN": "生成图片",
    "zh-TW": "產生圖片"
  },
  "tool.filesList": {
    "en": "Browse files",
    "zh-CN": "浏览文件",
    "zh-TW": "瀏覽檔案"
  },
  "tool.filesRead": {
    "en": "Read file",
    "zh-CN": "读取文件",
    "zh-TW": "讀取檔案"
  },
  "tool.filesWrite": {
    "en": "Write file",
    "zh-CN": "写入文件",
    "zh-TW": "寫入檔案"
  },
  "tool.publishFile": {
    "en": "Deliver file",
    "zh-CN": "交付文件",
    "zh-TW": "交付檔案"
  },
  "tool.browserGoto": {
    "en": "Open page",
    "zh-CN": "打开网页",
    "zh-TW": "開啟網頁"
  },
  "tool.browserObserve": {
    "en": "Inspect page",
    "zh-CN": "查看网页",
    "zh-TW": "查看網頁"
  },
  "tool.browserClick": {
    "en": "Click page",
    "zh-CN": "点击网页",
    "zh-TW": "點擊網頁"
  },
  "tool.browserType": {
    "en": "Fill page",
    "zh-CN": "填写网页",
    "zh-TW": "填寫網頁"
  },
  "tool.browserScroll": {
    "en": "Browse page",
    "zh-CN": "浏览网页",
    "zh-TW": "瀏覽網頁"
  },
  "tool.browserScreenshot": {
    "en": "Capture page",
    "zh-CN": "截取网页",
    "zh-TW": "擷取網頁"
  },
  "tool.browserTabs": {
    "en": "View tabs",
    "zh-CN": "查看标签页",
    "zh-TW": "查看分頁"
  },
  "tool.browserSelectTab": {
    "en": "Switch tab",
    "zh-CN": "切换标签页",
    "zh-TW": "切換分頁"
  },
  "tool.browserUpload": {
    "en": "Upload file",
    "zh-CN": "上传文件",
    "zh-TW": "上傳檔案"
  },
  "tool.browserStatus": {
    "en": "View browser status",
    "zh-CN": "查看浏览器状态",
    "zh-TW": "查看瀏覽器狀態"
  },
  "tool.browserResume": {
    "en": "Resume browsing",
    "zh-CN": "继续浏览",
    "zh-TW": "繼續瀏覽"
  },
  "tool.browserAction": {
    "en": "Interact with page",
    "zh-CN": "操作网页",
    "zh-TW": "操作網頁"
  },
  "tool.computerObserve": {
    "en": "Inspect desktop",
    "zh-CN": "查看桌面内容",
    "zh-TW": "查看桌面內容"
  },
  "tool.computerScreenshot": {
    "en": "View computer",
    "zh-CN": "查看电脑",
    "zh-TW": "查看電腦"
  },
  "tool.computerClick": {
    "en": "Click computer",
    "zh-CN": "点击电脑",
    "zh-TW": "點擊電腦"
  },
  "tool.computerKey": {
    "en": "Use keyboard",
    "zh-CN": "操作键盘",
    "zh-TW": "操作鍵盤"
  },
  "tool.computerScroll": {
    "en": "Scroll computer",
    "zh-CN": "滚动电脑",
    "zh-TW": "捲動電腦畫面"
  },
  "tool.computerMove": {
    "en": "Move pointer",
    "zh-CN": "移动指针",
    "zh-TW": "移動指標"
  },
  "tool.computerDrag": {
    "en": "Drag on computer",
    "zh-CN": "拖动电脑",
    "zh-TW": "拖曳電腦畫面"
  },
  "tool.computerWindows": {
    "en": "Switch window",
    "zh-CN": "切换窗口",
    "zh-TW": "切換視窗"
  },
  "tool.computerApps": {
    "en": "Use application",
    "zh-CN": "使用应用",
    "zh-TW": "使用應用程式"
  },
  "tool.search": {
    "en": "Search the web",
    "zh-CN": "搜索资料",
    "zh-TW": "搜尋資料"
  },
  "tool.fetch": {
    "en": "Read page",
    "zh-CN": "读取网页",
    "zh-TW": "讀取網頁"
  },
  "tool.skillsList": {
    "en": "Find skills",
    "zh-CN": "查找 Skills",
    "zh-TW": "尋找 Skills"
  },
  "tool.skillsRead": {
    "en": "Read skill",
    "zh-CN": "读取 Skill",
    "zh-TW": "讀取 Skill"
  },
  "tool.memorySearch": {
    "en": "Find memories",
    "zh-CN": "查找记忆",
    "zh-TW": "尋找記憶"
  },
  "tool.memorySave": {
    "en": "Save memory",
    "zh-CN": "保存记忆",
    "zh-TW": "儲存記憶"
  },
  "tool.scheduleList": {
    "en": "View scheduled tasks",
    "zh-CN": "查看定时任务",
    "zh-TW": "查看排程工作"
  },
  "tool.scheduleCreate": {
    "en": "Create scheduled task",
    "zh-CN": "创建定时任务",
    "zh-TW": "建立排程工作"
  },
  "tool.scheduleUpdate": {
    "en": "Update scheduled task",
    "zh-CN": "更新定时任务",
    "zh-TW": "更新排程工作"
  },
  "tool.computerPermission": {
    "en": "Request computer access",
    "zh-CN": "请求使用电脑",
    "zh-TW": "請求使用電腦"
  },
  "status.running": {
    "en": "Running",
    "zh-CN": "运行中",
    "zh-TW": "執行中"
  },
  "status.skipped": {
    "en": "Skipped",
    "zh-CN": "已跳过",
    "zh-TW": "已略過"
  },
  "instruction.received": {
    "en": "Received",
    "zh-CN": "已接收",
    "zh-TW": "已接收"
  },
  "instruction.applied": {
    "en": "Applied",
    "zh-CN": "已应用",
    "zh-TW": "已套用"
  },
  "instruction.queued": {
    "en": "Queued",
    "zh-CN": "已排队",
    "zh-TW": "已排隊"
  },
  "instruction.notApplied": {
    "en": "Not applied",
    "zh-CN": "未应用",
    "zh-TW": "未套用"
  },
  "instruction.unconfirmed": {
    "en": "Cannot confirm right now",
    "zh-CN": "暂时无法确认",
    "zh-TW": "暫時無法確認"
  },
  "instruction.syncError": {
    "en": "Additional instruction status cannot sync right now",
    "zh-CN": "补充状态暂时无法同步",
    "zh-TW": "補充狀態暫時無法同步"
  },
  "instruction.finished": {
    "en": "The task ended or the additional instructions were not received",
    "zh-CN": "任务已结束或补充未被接收",
    "zh-TW": "工作已結束或未收到補充要求"
  },
  "instruction.notSent": {
    "en": "Additional instructions were not sent",
    "zh-CN": "补充未发送",
    "zh-TW": "補充未傳送"
  },
  "instruction.uncertain": {
    "en": "Cannot confirm the additional instructions right now",
    "zh-CN": "补充要求暂时无法确认",
    "zh-TW": "補充要求暫時無法確認"
  },
  "instruction.tooLong": {
    "en": "Additional instructions are too long",
    "zh-CN": "补充要求太长",
    "zh-TW": "補充要求太長"
  },
  "schedule.invalidDate": {
    "en": "Invalid date or time",
    "zh-CN": "日期或时间无效",
    "zh-TW": "日期或時間無效"
  },
  "schedule.invalidTimezone": {
    "en": "Invalid time zone",
    "zh-CN": "时区无效",
    "zh-TW": "時區無效"
  },
  "schedule.nonexistentTime": {
    "en": "This time does not exist in the selected time zone",
    "zh-CN": "此时间在所选时区不存在",
    "zh-TW": "此時間在所選時區不存在"
  },
  "projects.all": {
    "en": "All projects",
    "zh-CN": "所有项目",
    "zh-TW": "所有專案"
  },
  "projects.create": {
    "en": "Create project",
    "zh-CN": "创建项目",
    "zh-TW": "建立專案"
  },
  "projects.manage": {
    "en": "Manage project",
    "zh-CN": "管理项目",
    "zh-TW": "管理專案"
  },
  "projects.settings": {
    "en": "Project settings",
    "zh-CN": "项目设置",
    "zh-TW": "專案設定"
  },
  "projects.delete": {
    "en": "Delete project",
    "zh-CN": "删除项目",
    "zh-TW": "刪除專案"
  },
  "projects.instructions": {
    "en": "Project instructions",
    "zh-CN": "项目说明",
    "zh-TW": "專案說明"
  },
  "projects.searchConversations": {
    "en": "Search project conversations",
    "zh-CN": "搜索项目对话",
    "zh-TW": "搜尋專案對話"
  },
  "common.closeSearch": {
    "en": "Close search",
    "zh-CN": "关闭搜索",
    "zh-TW": "關閉搜尋"
  },
  "projects.newConversation": {
    "en": "New project conversation",
    "zh-CN": "项目新对话",
    "zh-TW": "專案新對話"
  },
  "chat.empty": {
    "en": "No conversations yet",
    "zh-CN": "暂无对话",
    "zh-TW": "尚無對話"
  },
  "projects.empty": {
    "en": "No projects yet",
    "zh-CN": "暂无项目",
    "zh-TW": "尚無專案"
  },
  "projects.edit": {
    "en": "Edit project",
    "zh-CN": "编辑项目",
    "zh-TW": "編輯專案"
  },
  "common.name": {
    "en": "Name",
    "zh-CN": "名称",
    "zh-TW": "名稱"
  },
  "projects.deleteConfirm": {
    "en": "Delete project?",
    "zh-CN": "删除项目？",
    "zh-TW": "刪除專案？"
  },
  "schedule.once": {
    "en": "Once",
    "zh-CN": "单次",
    "zh-TW": "單次"
  },
  "tasks.disable": {
    "en": "Disable task",
    "zh-CN": "停用任务",
    "zh-TW": "停用工作"
  },
  "tasks.enable": {
    "en": "Enable task",
    "zh-CN": "启用任务",
    "zh-TW": "啟用工作"
  },
  "schedule.next": {
    "en": "Next",
    "zh-CN": "下次",
    "zh-TW": "下次"
  },
  "tasks.disabled": {
    "en": "Disabled",
    "zh-CN": "已停用",
    "zh-TW": "已停用"
  },
  "tasks.executionMissing": {
    "en": "Execution not found",
    "zh-CN": "执行记录不存在",
    "zh-TW": "執行記錄不存在"
  },
  "error.update": {
    "en": "Could not update",
    "zh-CN": "更新失败",
    "zh-TW": "更新失敗"
  },
  "tasks.noResult": {
    "en": "No execution result yet",
    "zh-CN": "暂无执行结果",
    "zh-TW": "尚無執行結果"
  },
  "error.execution": {
    "en": "Execution failed",
    "zh-CN": "执行失败",
    "zh-TW": "執行失敗"
  },
  "tasks.back": {
    "en": "Back to tasks",
    "zh-CN": "返回任务",
    "zh-TW": "返回工作"
  },
  "tasks.result": {
    "en": "Execution result",
    "zh-CN": "执行结果",
    "zh-TW": "執行結果"
  },
  "tasks.create": {
    "en": "Create task",
    "zh-CN": "创建任务",
    "zh-TW": "建立工作"
  },
  "chat.open": {
    "en": "Open conversation",
    "zh-CN": "打开对话",
    "zh-TW": "開啟對話"
  },
  "tasks.enabled": {
    "en": "Enabled",
    "zh-CN": "已启用",
    "zh-TW": "已啟用"
  },
  "tasks.run": {
    "en": "Run",
    "zh-CN": "执行",
    "zh-TW": "執行"
  },
  "tasks.delete": {
    "en": "Delete task",
    "zh-CN": "删除任务",
    "zh-TW": "刪除工作"
  },
  "tasks.continuous": {
    "en": "Continuous conversation",
    "zh-CN": "连续对话",
    "zh-TW": "連續對話"
  },
  "tasks.isolated": {
    "en": "Isolated execution",
    "zh-CN": "独立执行",
    "zh-TW": "獨立執行"
  },
  "tasks.history": {
    "en": "Execution history",
    "zh-CN": "执行历史",
    "zh-TW": "執行歷史"
  },
  "tasks.emptyHistory": {
    "en": "No execution history yet",
    "zh-CN": "暂无执行记录",
    "zh-TW": "尚無執行記錄"
  },
  "tasks.filter": {
    "en": "Filter tasks",
    "zh-CN": "筛选任务",
    "zh-TW": "篩選工作"
  },
  "common.all": {
    "en": "All",
    "zh-CN": "全部",
    "zh-TW": "全部"
  },
  "tasks.task": {
    "en": "Task",
    "zh-CN": "任务",
    "zh-TW": "工作"
  },
  "schedule.title": {
    "en": "Schedule",
    "zh-CN": "安排",
    "zh-TW": "排程"
  },
  "tasks.latestRun": {
    "en": "Latest run",
    "zh-CN": "最近执行",
    "zh-TW": "最近執行"
  },
  "tasks.enableLabel": {
    "en": "Enable",
    "zh-CN": "启用",
    "zh-TW": "啟用"
  },
  "tasks.viewResult": {
    "en": "View execution result",
    "zh-CN": "查看执行结果",
    "zh-TW": "查看執行結果"
  },
  "tasks.notRun": {
    "en": "Not run yet",
    "zh-CN": "未执行",
    "zh-TW": "尚未執行"
  },
  "tasks.runNow": {
    "en": "Run now",
    "zh-CN": "立即执行",
    "zh-TW": "立即執行"
  },
  "tasks.edit": {
    "en": "Edit task",
    "zh-CN": "编辑任务",
    "zh-TW": "編輯工作"
  },
  "tasks.emptyFiltered": {
    "en": "No tasks in this category",
    "zh-CN": "暂无此类任务",
    "zh-TW": "沒有此類工作"
  },
  "tasks.empty": {
    "en": "No tasks yet",
    "zh-CN": "暂无任务",
    "zh-TW": "尚無工作"
  },
  "schedule.frequency": {
    "en": "Frequency",
    "zh-CN": "频率",
    "zh-TW": "頻率"
  },
  "schedule.daily": {
    "en": "Daily",
    "zh-CN": "每天",
    "zh-TW": "每天"
  },
  "schedule.weekly": {
    "en": "Weekly",
    "zh-CN": "每周",
    "zh-TW": "每週"
  },
  "schedule.interval": {
    "en": "Fixed interval",
    "zh-CN": "固定间隔",
    "zh-TW": "固定間隔"
  },
  "schedule.intervalMinutes": {
    "en": "Interval (minutes)",
    "zh-CN": "间隔（分钟）",
    "zh-TW": "間隔（分鐘）"
  },
  "schedule.dateTime": {
    "en": "Date and time",
    "zh-CN": "日期与时间",
    "zh-TW": "日期與時間"
  },
  "schedule.time": {
    "en": "Time",
    "zh-CN": "时间",
    "zh-TW": "時間"
  },
  "schedule.weekday": {
    "en": "Weekday",
    "zh-CN": "星期",
    "zh-TW": "星期"
  },
  "common.advanced": {
    "en": "Advanced settings",
    "zh-CN": "高级设置",
    "zh-TW": "進階設定"
  },
  "schedule.timezone": {
    "en": "Time zone",
    "zh-CN": "时区",
    "zh-TW": "時區"
  },
  "projects.none": {
    "en": "No project",
    "zh-CN": "无项目",
    "zh-TW": "無專案"
  },
  "model.title": {
    "en": "Model",
    "zh-CN": "模型",
    "zh-TW": "模型"
  },
  "model.default": {
    "en": "Default model",
    "zh-CN": "默认模型",
    "zh-TW": "預設模型"
  },
  "schedule.context": {
    "en": "Context",
    "zh-CN": "上下文",
    "zh-TW": "上下文"
  },
  "schedule.isolated": {
    "en": "Run independently each time",
    "zh-CN": "每次独立执行",
    "zh-TW": "每次獨立執行"
  },
  "schedule.reuse": {
    "en": "Reuse a conversation",
    "zh-CN": "复用指定对话",
    "zh-TW": "重用指定對話"
  },
  "chat.selected": {
    "en": "Conversation selected",
    "zh-CN": "已选择对话",
    "zh-TW": "已選擇對話"
  },
  "chat.choose": {
    "en": "Choose conversation",
    "zh-CN": "选择对话",
    "zh-TW": "選擇對話"
  },
  "tasks.deleteConfirm": {
    "en": "Delete task?",
    "zh-CN": "删除任务？",
    "zh-TW": "刪除工作？"
  },
  "process.steps": {
    "en": {
      "one": "{count} step",
      "other": "{count} steps"
    },
    "zh-CN": "{count} 步",
    "zh-TW": "{count} 步"
  },
  "process.completedSteps": {
    "en": {
      "one": "Completed {count} step",
      "other": "Completed {count} steps"
    },
    "zh-CN": "已完成 {count} 步",
    "zh-TW": "已完成 {count} 步"
  },
  "process.elapsed": {
    "en": "Elapsed {duration}",
    "zh-CN": "用时 {duration}",
    "zh-TW": "耗時 {duration}"
  },
  "process.results": {
    "en": {
      "one": "{count} result",
      "other": "{count} results"
    },
    "zh-CN": "{count} 个结果",
    "zh-TW": "{count} 個結果"
  },
  "reasoning.budgetValue": {
    "en": "Thinking budget · {count} tokens",
    "zh-CN": "思考预算 · {count} tokens",
    "zh-TW": "思考預算 · {count} tokens"
  },
  "reasoning.effortValue": {
    "en": "Thinking level · {level}",
    "zh-CN": "思考程度 · {level}",
    "zh-TW": "思考程度 · {level}"
  },
  "file.remove": {
    "en": "Remove {name}",
    "zh-CN": "移除 {name}",
    "zh-TW": "移除 {name}"
  },
  "file.viewImage": {
    "en": "View image {name}",
    "zh-CN": "查看图片 {name}",
    "zh-TW": "查看圖片 {name}"
  },
  "file.downloadName": {
    "en": "Download {name}",
    "zh-CN": "下载 {name}",
    "zh-TW": "下載 {name}"
  },
  "chat.manage": {
    "en": "Manage {name}",
    "zh-CN": "管理 {name}",
    "zh-TW": "管理 {name}"
  },
  "chat.count": {
    "en": {
      "one": "{count} conversation",
      "other": "{count} conversations"
    },
    "zh-CN": "{count} 个对话",
    "zh-TW": "{count} 個對話"
  },
  "duration.seconds": {
    "en": "{seconds}s",
    "zh-CN": "{seconds} 秒",
    "zh-TW": "{seconds} 秒"
  },
  "duration.minutesSeconds": {
    "en": "{minutes}m {seconds}s",
    "zh-CN": "{minutes} 分 {seconds} 秒",
    "zh-TW": "{minutes} 分 {seconds} 秒"
  },
  "duration.hoursMinutes": {
    "en": "{hours}h {minutes}m",
    "zh-CN": "{hours} 小时 {minutes} 分",
    "zh-TW": "{hours} 小時 {minutes} 分"
  },
  "schedule.dailyAt": {
    "en": "Every day at {time}",
    "zh-CN": "每天 {time}",
    "zh-TW": "每天 {time}"
  },
  "schedule.weeklyAt": {
    "en": "Every {days} at {time}",
    "zh-CN": "每周 {days} {time}",
    "zh-TW": "每週 {days} {time}"
  },
  "schedule.everyMinutes": {
    "en": {
      "one": "Every {count} minute",
      "other": "Every {count} minutes"
    },
    "zh-CN": "每 {count} 分钟",
    "zh-TW": "每 {count} 分鐘"
  },
  "schedule.nextAt": {
    "en": "Next {time}",
    "zh-CN": "下次 {time}",
    "zh-TW": "下次 {time}"
  },
  "tasks.enableName": {
    "en": "Enable {name}",
    "zh-CN": "启用 {name}",
    "zh-TW": "啟用 {name}"
  },
  "tasks.executionCount": {
    "en": {
      "one": "{count} execution",
      "other": "{count} executions"
    },
    "zh-CN": "{count} 次",
    "zh-TW": "{count} 次"
  },
  "file.count": {
    "en": {
      "one": "{count} file",
      "other": "{count} files"
    },
    "zh-CN": "{count} 个文件",
    "zh-TW": "{count} 個檔案"
  },
  "tasks.viewLatest": {
    "en": "View latest result for {name}",
    "zh-CN": "查看 {name} 最近执行结果",
    "zh-TW": "查看 {name} 最近執行結果"
  },
  "tasks.runName": {
    "en": "Run {name} now",
    "zh-CN": "立即执行 {name}",
    "zh-TW": "立即執行 {name}"
  },
  "tasks.editName": {
    "en": "Edit {name}",
    "zh-CN": "编辑 {name}",
    "zh-TW": "編輯 {name}"
  },
  "settings.language": {
    "en": "Language",
    "zh-CN": "语言",
    "zh-TW": "語言"
  },
  "settings.systemLanguage": {
    "en": "System default",
    "zh-CN": "跟随系统",
    "zh-TW": "跟隨系統"
  },
  "settings.languageEnglish": {
    "en": "English",
    "zh-CN": "English",
    "zh-TW": "English"
  },
  "settings.languageSimplified": {
    "en": "简体中文",
    "zh-CN": "简体中文",
    "zh-TW": "简体中文"
  },
  "settings.languageTraditional": {
    "en": "繁體中文",
    "zh-CN": "繁體中文",
    "zh-TW": "繁體中文"
  },
  "reasoning.providerDefault": {
    "en": "Provider default",
    "zh-CN": "提供商默认",
    "zh-TW": "提供者預設"
  },
  "reasoning.level.on": {
    "en": "On",
    "zh-CN": "开启",
    "zh-TW": "開啟"
  },
  "reasoning.level.off": {
    "en": "Off",
    "zh-CN": "关闭",
    "zh-TW": "關閉"
  },
  "reasoning.level.none": {
    "en": "None",
    "zh-CN": "不思考",
    "zh-TW": "不思考"
  },
  "reasoning.level.minimal": {
    "en": "Minimal",
    "zh-CN": "极少",
    "zh-TW": "極少"
  },
  "reasoning.level.low": {
    "en": "Low",
    "zh-CN": "低",
    "zh-TW": "低"
  },
  "reasoning.level.medium": {
    "en": "Medium",
    "zh-CN": "中",
    "zh-TW": "中"
  },
  "reasoning.level.high": {
    "en": "High",
    "zh-CN": "高",
    "zh-TW": "高"
  },
  "reasoning.level.xhigh": {
    "en": "Extra high",
    "zh-CN": "极高",
    "zh-TW": "極高"
  },
  "reasoning.level.max": {
    "en": "Maximum",
    "zh-CN": "最高",
    "zh-TW": "最高"
  },
  "common.tokens": {
    "en": "tokens",
    "zh-CN": "Token",
    "zh-TW": "Token"
  },
  "memory.assistant": {
    "en": "Assistant",
    "zh-CN": "助手",
    "zh-TW": "助理"
  },
  "markdown.close": {
    "en": "Close",
    "zh-CN": "关闭",
    "zh-TW": "關閉"
  },
  "markdown.copied": {
    "en": "Copied",
    "zh-CN": "已复制",
    "zh-TW": "已複製"
  },
  "markdown.copyCode": {
    "en": "Copy code",
    "zh-CN": "复制代码",
    "zh-TW": "複製程式碼"
  },
  "markdown.copyLink": {
    "en": "Copy link",
    "zh-CN": "复制链接",
    "zh-TW": "複製連結"
  },
  "markdown.copyTable": {
    "en": "Copy table",
    "zh-CN": "复制表格",
    "zh-TW": "複製表格"
  },
  "markdown.copyTableAsCsv": {
    "en": "Copy table as CSV",
    "zh-CN": "复制为 CSV",
    "zh-TW": "複製為 CSV"
  },
  "markdown.copyTableAsMarkdown": {
    "en": "Copy table as Markdown",
    "zh-CN": "复制为 Markdown",
    "zh-TW": "複製為 Markdown"
  },
  "markdown.copyTableAsTsv": {
    "en": "Copy table as TSV",
    "zh-CN": "复制为 TSV",
    "zh-TW": "複製為 TSV"
  },
  "markdown.downloadDiagram": {
    "en": "Download diagram",
    "zh-CN": "下载图表",
    "zh-TW": "下載圖表"
  },
  "markdown.downloadDiagramAsMmd": {
    "en": "Download diagram as MMD",
    "zh-CN": "下载为 MMD",
    "zh-TW": "下載為 MMD"
  },
  "markdown.downloadDiagramAsPng": {
    "en": "Download diagram as PNG",
    "zh-CN": "下载为 PNG",
    "zh-TW": "下載為 PNG"
  },
  "markdown.downloadDiagramAsSvg": {
    "en": "Download diagram as SVG",
    "zh-CN": "下载为 SVG",
    "zh-TW": "下載為 SVG"
  },
  "markdown.downloadFile": {
    "en": "Download file",
    "zh-CN": "下载文件",
    "zh-TW": "下載檔案"
  },
  "markdown.downloadImage": {
    "en": "Download image",
    "zh-CN": "下载图片",
    "zh-TW": "下載圖片"
  },
  "markdown.downloadTable": {
    "en": "Download table",
    "zh-CN": "下载表格",
    "zh-TW": "下載表格"
  },
  "markdown.downloadTableAsCsv": {
    "en": "Download table as CSV",
    "zh-CN": "下载表格为 CSV",
    "zh-TW": "下載表格為 CSV"
  },
  "markdown.downloadTableAsMarkdown": {
    "en": "Download table as Markdown",
    "zh-CN": "下载表格为 Markdown",
    "zh-TW": "下載表格為 Markdown"
  },
  "markdown.exitFullscreen": {
    "en": "Exit fullscreen",
    "zh-CN": "退出全屏",
    "zh-TW": "離開全螢幕"
  },
  "markdown.externalLinkWarning": {
    "en": "You are opening an external website.",
    "zh-CN": "即将打开外部网站。",
    "zh-TW": "即將開啟外部網站。"
  },
  "markdown.imageNotAvailable": {
    "en": "Image not available",
    "zh-CN": "图片无法加载",
    "zh-TW": "無法載入圖片"
  },
  "markdown.openExternalLink": {
    "en": "Open external link",
    "zh-CN": "打开外部链接",
    "zh-TW": "開啟外部連結"
  },
  "markdown.openLink": {
    "en": "Open link",
    "zh-CN": "打开链接",
    "zh-TW": "開啟連結"
  },
  "markdown.resetView": {
    "en": "Reset view",
    "zh-CN": "重置视图",
    "zh-TW": "重設檢視"
  },
  "markdown.viewFullscreen": {
    "en": "View fullscreen",
    "zh-CN": "全屏查看",
    "zh-TW": "全螢幕檢視"
  },
  "markdown.zoomIn": {
    "en": "Zoom in",
    "zh-CN": "放大",
    "zh-TW": "放大"
  },
  "process.processed": {
    "en": "Processed",
    "zh-CN": "已处理",
    "zh-TW": "已處理"
  },
  "process.thoughtFor": {
    "en": "Thought for {duration}",
    "zh-CN": "已思考 {duration}",
    "zh-TW": "已思考 {duration}"
  },
  "process.thought": {
    "en": "Thought",
    "zh-CN": "已思考",
    "zh-TW": "已思考"
  },
  "process.failedAfter": {
    "en": "Stopped by an error after {duration}",
    "zh-CN": "处理 {duration} 后出错",
    "zh-TW": "處理 {duration} 後出錯"
  },
  "process.stoppedAfter": {
    "en": "Stopped · processed {duration}",
    "zh-CN": "已停止 · 处理了 {duration}",
    "zh-TW": "已停止 · 處理了 {duration}"
  },
  "process.toolCalls": {
    "en": {
      "one": "{count} tool call",
      "other": "{count} tool calls"
    },
    "zh-CN": "{count} 个工具调用",
    "zh-TW": "{count} 個工具呼叫"
  },
  "process.generating": {
    "en": "Generating image…",
    "zh-CN": "正在生成图片…",
    "zh-TW": "正在產生圖片…"
  },
  "process.copyCommand": {
    "en": "Copy command",
    "zh-CN": "复制命令",
    "zh-TW": "複製指令"
  },
  "markdown.zoomOut": {
    "en": "Zoom out",
    "zh-CN": "缩小",
    "zh-TW": "縮小"
  },
  "common.undo": {
    "en": "Undo",
    "zh-CN": "撤销",
    "zh-TW": "復原"
  },
  "memory.deleted": {
    "en": "Memory deleted",
    "zh-CN": "记忆已删除",
    "zh-TW": "記憶已刪除"
  },
  "plugins.skillCount": {
    "en": "{count} skills",
    "zh-CN": "{count} 个技能",
    "zh-TW": "{count} 個技能"
  },
  "plugins.mcpCount": {
    "en": "{count} MCP servers",
    "zh-CN": "{count} 个 MCP 服务",
    "zh-TW": "{count} 個 MCP 服務"
  },
  "file.copy": {
    "en": "Copy",
    "zh-CN": "复制",
    "zh-TW": "複製"
  },
  "file.copied": {
    "en": "Copied",
    "zh-CN": "已复制",
    "zh-TW": "已複製"
  },
  "file.fileSize": {
    "en": "Size",
    "zh-CN": "大小",
    "zh-TW": "大小"
  },
  "file.type": {
    "en": "Type",
    "zh-CN": "类型",
    "zh-TW": "類型"
  },
  "file.lineCount": {
    "en": {
      "one": "{count} line",
      "other": "{count} lines"
    },
    "zh-CN": "{count} 行",
    "zh-TW": "{count} 行"
  },
  "file.linesClipped": {
    "en": "Showing the first {count} lines",
    "zh-CN": "仅显示前 {count} 行",
    "zh-TW": "僅顯示前 {count} 行"
  },
  "file.previewError": {
    "en": "Could not preview this file",
    "zh-CN": "无法预览此文件",
    "zh-TW": "無法預覽此檔案"
  },
  "file.rowsClipped": {
    "en": "Showing the first {count} rows",
    "zh-CN": "仅显示前 {count} 行",
    "zh-TW": "僅顯示前 {count} 列"
  },
  "file.rowsColumns": {
    "en": "{rows} rows × {columns} columns",
    "zh-CN": "{rows} 行 × {columns} 列",
    "zh-TW": "{rows} 列 × {columns} 欄"
  },
  "file.sortedAscending": {
    "en": "Sorted by {column}, ascending",
    "zh-CN": "按 {column} 升序",
    "zh-TW": "依 {column} 遞增排序"
  },
  "file.sortedDescending": {
    "en": "Sorted by {column}, descending",
    "zh-CN": "按 {column} 降序",
    "zh-TW": "依 {column} 遞減排序"
  },
  "file.sourceOf": {
    "en": "Source of {name}",
    "zh-CN": "{name} 的源码",
    "zh-TW": "{name} 的原始碼"
  },
  "file.tableOf": {
    "en": "Table {name}",
    "zh-CN": "表格 {name}",
    "zh-TW": "表格 {name}"
  },
  "file.table": {
    "en": "Table",
    "zh-CN": "表格",
    "zh-TW": "表格"
  },
  "file.truncated": {
    "en": "Only the beginning of this file is shown. Download it to see everything.",
    "zh-CN": "仅显示文件开头部分，下载后可查看全部内容。",
    "zh-TW": "僅顯示檔案開頭部分，下載後可查看全部內容。"
  },
  "file.unsupported": {
    "en": "This file type cannot be previewed.",
    "zh-CN": "此文件类型暂不支持预览。",
    "zh-TW": "此檔案類型暫不支援預覽。"
  },
  "file.unsupportedNote": {
    "en": "Archives and binaries cannot be previewed safely in the browser. Download the file to open it.",
    "zh-CN": "压缩包和二进制文件无法在浏览器中安全预览，请下载后查看。",
    "zh-TW": "壓縮檔和二進位檔案無法在瀏覽器中安全預覽，請下載後查看。"
  },
  "file.location": {
    "en": "Location",
    "zh-CN": "位置",
    "zh-TW": "位置"
  },
  "file.viewMode": {
    "en": "View mode",
    "zh-CN": "查看方式",
    "zh-TW": "檢視方式"
  },
  "file.wrap": {
    "en": "Wrap lines",
    "zh-CN": "自动换行",
    "zh-TW": "自動換行"
  },
  "viewer.copied": {
    "en": "Image copied",
    "zh-CN": "图片已复制",
    "zh-TW": "圖片已複製"
  },
  "viewer.copyFailed": {
    "en": "Could not copy the image",
    "zh-CN": "无法复制图片",
    "zh-TW": "無法複製圖片"
  },
  "viewer.copyImage": {
    "en": "Copy image",
    "zh-CN": "复制图片",
    "zh-TW": "複製圖片"
  },
  "viewer.counter": {
    "en": "{current} / {total}",
    "zh-CN": "{current} / {total}",
    "zh-TW": "{current} / {total}"
  },
  "viewer.dimensions": {
    "en": "Dimensions",
    "zh-CN": "尺寸",
    "zh-TW": "尺寸"
  },
  "viewer.fileSize": {
    "en": "File size",
    "zh-CN": "文件大小",
    "zh-TW": "檔案大小"
  },
  "viewer.format": {
    "en": "Format",
    "zh-CN": "格式",
    "zh-TW": "格式"
  },
  "viewer.goTo": {
    "en": "Go to image {n}",
    "zh-CN": "查看第 {n} 张",
    "zh-TW": "查看第 {n} 張"
  },
  "viewer.info": {
    "en": "Image details",
    "zh-CN": "图片详情",
    "zh-TW": "圖片詳細資訊"
  },
  "viewer.label": {
    "en": "Image viewer: {name}",
    "zh-CN": "图片查看器：{name}",
    "zh-TW": "圖片檢視器：{name}"
  },
  "viewer.model": {
    "en": "Model",
    "zh-CN": "模型",
    "zh-TW": "模型"
  },
  "viewer.next": {
    "en": "Next image",
    "zh-CN": "下一张",
    "zh-TW": "下一張"
  },
  "viewer.previous": {
    "en": "Previous image",
    "zh-CN": "上一张",
    "zh-TW": "上一張"
  },
  "viewer.prompt": {
    "en": "Prompt",
    "zh-CN": "提示词",
    "zh-TW": "提示詞"
  },
  "viewer.quality": {
    "en": "Quality",
    "zh-CN": "质量",
    "zh-TW": "品質"
  },
  "viewer.resetZoom": {
    "en": "Reset zoom",
    "zh-CN": "重置缩放",
    "zh-TW": "重設縮放"
  },
  "viewer.revisedPrompt": {
    "en": "Revised prompt",
    "zh-CN": "优化后的提示词",
    "zh-TW": "優化後的提示詞"
  },
  "file.generating": {
    "en": "Generating…",
    "zh-CN": "生成中…",
    "zh-TW": "產生中…"
  },
  "file.pageCount": {
    "en": {
      "one": "{count} page",
      "other": "{count} pages"
    },
    "zh-CN": "{count} 页",
    "zh-TW": "{count} 頁"
  },
  "file.pageThumb": {
    "en": "Page {n}",
    "zh-CN": "第 {n} 页",
    "zh-TW": "第 {n} 頁"
  },
  "file.pdfFit": {
    "en": "Fit width",
    "zh-CN": "适应宽度",
    "zh-TW": "適應寬度"
  },
  "file.pdfPosition": {
    "en": "{current} / {total}",
    "zh-CN": "{current} / {total}",
    "zh-TW": "{current} / {total}"
  },
  "file.pdfError": {
    "en": "This PDF could not be read.",
    "zh-CN": "无法读取这个 PDF。",
    "zh-TW": "無法讀取這個 PDF。"
  },
  "artifact.history": {
    "en": "Version history",
    "zh-CN": "版本历史",
    "zh-TW": "版本記錄"
  },
  "artifact.download": {
    "en": "Download",
    "zh-CN": "下载",
    "zh-TW": "下載"
  },
  "viewer.zoomIn": {
    "en": "Zoom in",
    "zh-CN": "放大",
    "zh-TW": "放大"
  },
  "viewer.zoomOut": {
    "en": "Zoom out",
    "zh-CN": "缩小",
    "zh-TW": "縮小"
  },
  "artifact.label": {
    "en": "Artifact: {name}",
    "zh-CN": "制品：{name}",
    "zh-TW": "成品：{name}"
  },
  "artifact.resize": {
    "en": "Resize panel",
    "zh-CN": "调整面板宽度",
    "zh-TW": "調整面板寬度"
  },
  "artifact.versions": {
    "en": "Version history",
    "zh-CN": "版本历史",
    "zh-TW": "版本記錄"
  },
  "artifact.latest": {
    "en": "Latest",
    "zh-CN": "最新",
    "zh-TW": "最新"
  },
  "artifact.code": {
    "en": "Code",
    "zh-CN": "代码",
    "zh-TW": "程式碼"
  },
  "artifact.device": {
    "en": "Device size",
    "zh-CN": "设备尺寸",
    "zh-TW": "裝置尺寸"
  },
  "artifact.desktop": {
    "en": "Desktop",
    "zh-CN": "桌面",
    "zh-TW": "桌面"
  },
  "artifact.tablet": {
    "en": "Tablet",
    "zh-CN": "平板",
    "zh-TW": "平板"
  },
  "artifact.phone": {
    "en": "Phone",
    "zh-CN": "手机",
    "zh-TW": "手機"
  },
  "artifact.reload": {
    "en": "Reload",
    "zh-CN": "重新加载",
    "zh-TW": "重新載入"
  },
  "artifact.sandboxNote": {
    "en": "Runs in a sandbox with no access to your account or data",
    "zh-CN": "沙盒运行，无法访问你的账号与数据",
    "zh-TW": "沙盒執行，無法存取你的帳號與資料"
  },
  "artifact.svgNote": {
    "en": "Rendered as an image, no scripts run",
    "zh-CN": "作为图片渲染，不会执行任何脚本",
    "zh-TW": "以圖片方式呈現，不會執行任何指令碼"
  },
  "artifact.kind": {
    "en": "Artifact · {type}",
    "zh-CN": "制品 · {type}",
    "zh-TW": "成品 · {type}"
  },
  "artifact.openName": {
    "en": "Open {name} in the side panel",
    "zh-CN": "在侧边栏打开 {name}",
    "zh-TW": "在側邊欄開啟 {name}"
  },
  "artifact.openSide": {
    "en": "Open in side panel",
    "zh-CN": "在侧边打开",
    "zh-TW": "在側邊開啟"
  },
  "artifact.open": {
    "en": "Open",
    "zh-CN": "打开",
    "zh-TW": "開啟"
  },
  "artifact.untitled": {
    "en": "New artifact",
    "zh-CN": "新制品",
    "zh-TW": "新成品"
  },
  "artifact.building": {
    "en": "Generating…",
    "zh-CN": "正在生成…",
    "zh-TW": "正在產生…"
  },
  "artifact.cancelled": {
    "en": "Cancelled",
    "zh-CN": "已取消",
    "zh-TW": "已取消"
  },
  "settings.general": {
    "en": "General",
    "zh-CN": "通用",
    "zh-TW": "一般"
  },
  "settings.account": {
    "en": "Account",
    "zh-CN": "账户",
    "zh-TW": "帳戶"
  },
  "settings.desc.general": {
    "en": "Language and interface preferences",
    "zh-CN": "语言与界面偏好",
    "zh-TW": "語言與介面偏好"
  },
  "settings.desc.appearance": {
    "en": "Theme, style and layout",
    "zh-CN": "主题、风格与布局",
    "zh-TW": "主題、風格與版面"
  },
  "settings.desc.memory": {
    "en": "What Ochi remembers between conversations",
    "zh-CN": "Ochi 在对话之间记住的内容",
    "zh-TW": "Ochi 在對話之間記住的內容"
  },
  "settings.desc.plugins": {
    "en": "Plugins available to your account",
    "zh-CN": "可供你的账户使用的插件",
    "zh-TW": "可供你的帳戶使用的外掛"
  },
  "settings.desc.account": {
    "en": "Profile and session",
    "zh-CN": "资料与登录会话",
    "zh-TW": "資料與登入工作階段"
  },
  "settings.languageSection": {
    "en": "Language",
    "zh-CN": "语言",
    "zh-TW": "語言"
  },
  "settings.languageHint": {
    "en": "Applies immediately",
    "zh-CN": "更改后立即生效",
    "zh-TW": "變更後立即生效"
  },
  "settings.saved": {
    "en": "Saved",
    "zh-CN": "已保存",
    "zh-TW": "已儲存"
  },
  "settings.profile": {
    "en": "Profile",
    "zh-CN": "资料",
    "zh-TW": "資料"
  },
  "settings.username": {
    "en": "Username",
    "zh-CN": "用户名",
    "zh-TW": "使用者名稱"
  },
  "settings.role": {
    "en": "Role",
    "zh-CN": "角色",
    "zh-TW": "角色"
  },
  "settings.sessionSection": {
    "en": "Session",
    "zh-CN": "会话",
    "zh-TW": "工作階段"
  },
  "settings.signOutHint": {
    "en": "End this session on this device",
    "zh-CN": "在此设备上结束当前会话",
    "zh-TW": "在此裝置上結束目前工作階段"
  },
  "settings.sectionLabel": {
    "en": "Display",
    "zh-CN": "显示",
    "zh-TW": "顯示"
  },
  "memory.saved": {
    "en": "Saved memories",
    "zh-CN": "已保存的记忆",
    "zh-TW": "已儲存的記憶"
  },
  "memory.enableHint": {
    "en": "Allow Ochi to reference these in new conversations",
    "zh-CN": "允许 Ochi 在新对话中引用这些内容",
    "zh-TW": "允許 Ochi 在新對話中參考這些內容"
  },
  "memory.emptyHint": {
    "en": "Ochi will note preferences when it is useful. You can also add them by hand.",
    "zh-CN": "聊天时 Ochi 会在合适的时候记下你的偏好，你也可以手动添加。",
    "zh-TW": "聊天時 Ochi 會在適當的時候記下你的偏好，你也可以手動新增。"
  },
  "memory.noResultsHint": {
    "en": "Nothing matches this filter.",
    "zh-CN": "没有符合当前筛选的内容。",
    "zh-TW": "沒有符合目前篩選的內容。"
  },
  "plugins.emptyHint": {
    "en": "Plugins your administrator publishes will appear here.",
    "zh-CN": "管理员发布的插件会显示在这里。",
    "zh-TW": "管理員發布的外掛會顯示在這裡。"
  },
  "composer.searchModels": {
    "en": "Search models",
    "zh-CN": "搜索模型",
    "zh-TW": "搜尋模型"
  },
  "composer.noModels": {
    "en": "No matching models",
    "zh-CN": "没有匹配的模型",
    "zh-TW": "沒有符合的模型"
  },
  "composer.uploadFile": {
    "en": "Upload file",
    "zh-CN": "上传文件",
    "zh-TW": "上傳檔案"
  },
  "composer.uploadImage": {
    "en": "Upload image",
    "zh-CN": "上传图片",
    "zh-TW": "上傳圖片"
  },
  "message.seconds": {
    "en": "{n}s",
    "zh-CN": "{n} 秒",
    "zh-TW": "{n} 秒"
  },
  "message.minutes": {
    "en": "{m}m {s}s",
    "zh-CN": "{m} 分 {s} 秒",
    "zh-TW": "{m} 分 {s} 秒"
  },
  "sidebar.pin": {
    "en": "Pin",
    "zh-CN": "置顶",
    "zh-TW": "置頂"
  },
  "sidebar.unpin": {
    "en": "Unpin",
    "zh-CN": "取消置顶",
    "zh-TW": "取消置頂"
  },
  "sidebar.pinned": {
    "en": "Pinned",
    "zh-CN": "已置顶",
    "zh-TW": "已置頂"
  },
  "sidebar.pinnedToast": {
    "en": "Pinned",
    "zh-CN": "已置顶",
    "zh-TW": "已置頂"
  },
  "sidebar.unpinned": {
    "en": "Unpinned",
    "zh-CN": "已取消置顶",
    "zh-TW": "已取消置頂"
  },
  "sidebar.export": {
    "en": "Export as Markdown",
    "zh-CN": "导出为 Markdown",
    "zh-TW": "匯出為 Markdown"
  },
  "sidebar.exported": {
    "en": "Exported",
    "zh-CN": "已导出",
    "zh-TW": "已匯出"
  },
  "sidebar.exportFailed": {
    "en": "Export failed",
    "zh-CN": "导出失败",
    "zh-TW": "匯出失敗"
  },
  "sidebar.search": {
    "en": "Search",
    "zh-CN": "搜索",
    "zh-TW": "搜尋"
  },
  "sidebar.deleteBody": {
    "en": "Delete \"{title}\" permanently? This cannot be undone.",
    "zh-CN": "永久删除“{title}”?此操作无法撤销。",
    "zh-TW": "永久刪除「{title}」?此操作無法復原。"
  },
  "export.you": {
    "en": "You",
    "zh-CN": "你",
    "zh-TW": "你"
  },
  "export.assistant": {
    "en": "Assistant",
    "zh-CN": "助手",
    "zh-TW": "助理"
  },
  "palette.placeholder": {
    "en": "Search conversations or run a command",
    "zh-CN": "搜索对话或执行命令",
    "zh-TW": "搜尋對話或執行命令"
  },
  "palette.commands": {
    "en": "Commands",
    "zh-CN": "命令",
    "zh-TW": "命令"
  },
  "palette.conversations": {
    "en": "Conversations",
    "zh-CN": "对话",
    "zh-TW": "對話"
  },
  "palette.empty": {
    "en": "No results",
    "zh-CN": "没有结果",
    "zh-TW": "沒有結果"
  },
  "settings.models": {
    "en": "Models",
    "zh-CN": "模型",
    "zh-TW": "模型"
  },
  "settings.desc.models": {
    "en": "Models you can chat with and your default",
    "zh-CN": "可用于对话的模型与默认模型",
    "zh-TW": "可用於對話的模型與預設模型"
  },
  "settings.data": {
    "en": "Data & privacy",
    "zh-CN": "数据与隐私",
    "zh-TW": "資料與隱私"
  },
  "settings.desc.data": {
    "en": "Export what Ochi remembers and reset this device",
    "zh-CN": "导出 Ochi 的记忆，重置本设备设置",
    "zh-TW": "匯出 Ochi 的記憶，重設本裝置設定"
  },
  "settings.sec.defaults": {
    "en": "New chat defaults",
    "zh-CN": "新对话默认值",
    "zh-TW": "新對話預設值"
  },
  "settings.defaultModel": {
    "en": "Default model",
    "zh-CN": "默认模型",
    "zh-TW": "預設模型"
  },
  "settings.defaultModelHint": {
    "en": "Used when a new chat starts",
    "zh-CN": "新对话开始时使用",
    "zh-TW": "新對話開始時使用"
  },
  "settings.computerDefault": {
    "en": "Computer access",
    "zh-CN": "计算机权限",
    "zh-TW": "電腦權限"
  },
  "settings.computerDefaultHint": {
    "en": "Let new chats use the remote computer by default",
    "zh-CN": "新对话默认允许使用远程计算机",
    "zh-TW": "新對話預設允許使用遠端電腦"
  },
  "settings.sec.display": {
    "en": "Display",
    "zh-CN": "显示",
    "zh-TW": "顯示"
  },
  "settings.textSize": {
    "en": "Text size",
    "zh-CN": "文字大小",
    "zh-TW": "文字大小"
  },
  "settings.textSizeHint": {
    "en": "Scales conversation and interface text on this device",
    "zh-CN": "调整本设备上对话与界面的整体字号",
    "zh-TW": "調整本裝置上對話與介面的整體字級"
  },
  "settings.density": {
    "en": "Density",
    "zh-CN": "界面密度",
    "zh-TW": "介面密度"
  },
  "settings.densityHint": {
    "en": "Spacing between rows and messages",
    "zh-CN": "控制行与消息之间的间距",
    "zh-TW": "控制列與訊息之間的間距"
  },
  "settings.densityCompact": {
    "en": "Compact",
    "zh-CN": "紧凑",
    "zh-TW": "緊湊"
  },
  "settings.densityCozy": {
    "en": "Standard",
    "zh-CN": "标准",
    "zh-TW": "標準"
  },
  "settings.densityRoomy": {
    "en": "Roomy",
    "zh-CN": "宽松",
    "zh-TW": "寬鬆"
  },
  "settings.reduceMotion": {
    "en": "Reduce motion",
    "zh-CN": "减少动态效果",
    "zh-TW": "減少動態效果"
  },
  "settings.reduceMotionHint": {
    "en": "Skip transitions and spring animations; also follows your system setting",
    "zh-CN": "关闭过渡与弹性动画；同时遵循系统设置",
    "zh-TW": "關閉轉場與彈性動畫；同時遵循系統設定"
  },
  "settings.themeSystem": {
    "en": "System",
    "zh-CN": "跟随系统",
    "zh-TW": "跟隨系統"
  },
  "settings.textSizeValue": {
    "en": "{value}%",
    "zh-CN": "{value}%",
    "zh-TW": "{value}%"
  },
  "settings.modelsAvailable": {
    "en": "{count} models",
    "zh-CN": "{count} 个模型",
    "zh-TW": "{count} 個模型"
  },
  "settings.modelDefault": {
    "en": "Default",
    "zh-CN": "默认",
    "zh-TW": "預設"
  },
  "settings.setDefault": {
    "en": "Set as default",
    "zh-CN": "设为默认",
    "zh-TW": "設為預設"
  },
  "settings.modelVision": {
    "en": "Vision",
    "zh-CN": "视觉",
    "zh-TW": "視覺"
  },
  "settings.modelTools": {
    "en": "Tools",
    "zh-CN": "工具",
    "zh-TW": "工具"
  },
  "settings.modelImage": {
    "en": "Image",
    "zh-CN": "绘图",
    "zh-TW": "繪圖"
  },
  "settings.modelsEmpty": {
    "en": "No models available",
    "zh-CN": "没有可用的模型",
    "zh-TW": "沒有可用的模型"
  },
  "settings.modelsEmptyHint": {
    "en": "Your administrator has not enabled any chat models yet.",
    "zh-CN": "管理员尚未启用任何对话模型。",
    "zh-TW": "管理員尚未啟用任何對話模型。"
  },
  "settings.modelsNote": {
    "en": "Providers and keys are managed by your administrator.",
    "zh-CN": "服务商与密钥由管理员统一管理。",
    "zh-TW": "服務商與金鑰由管理員統一管理。"
  },
  "settings.modelsLoadFailed": {
    "en": "Could not load models",
    "zh-CN": "无法加载模型",
    "zh-TW": "無法載入模型"
  },
  "settings.sec.yourData": {
    "en": "Your data",
    "zh-CN": "你的数据",
    "zh-TW": "你的資料"
  },
  "settings.exportMemories": {
    "en": "Export memories",
    "zh-CN": "导出记忆",
    "zh-TW": "匯出記憶"
  },
  "settings.exportMemoriesHint": {
    "en": "Download everything Ochi remembers about you as JSON",
    "zh-CN": "将 Ochi 记住的全部内容下载为 JSON",
    "zh-TW": "將 Ochi 記住的全部內容下載為 JSON"
  },
  "settings.exportAction": {
    "en": "Export",
    "zh-CN": "导出",
    "zh-TW": "匯出"
  },
  "settings.exporting": {
    "en": "Exporting…",
    "zh-CN": "正在导出…",
    "zh-TW": "正在匯出…"
  },
  "settings.exportDone": {
    "en": "Memories exported",
    "zh-CN": "记忆已导出",
    "zh-TW": "記憶已匯出"
  },
  "settings.sec.device": {
    "en": "This device",
    "zh-CN": "本设备",
    "zh-TW": "本裝置"
  },
  "settings.resetAppearance": {
    "en": "Reset appearance",
    "zh-CN": "重置外观",
    "zh-TW": "重設外觀"
  },
  "settings.resetAppearanceHint": {
    "en": "Theme, style, layout, text size and density return to defaults",
    "zh-CN": "主题、风格、布局、字号与密度恢复默认",
    "zh-TW": "主題、風格、版面、字級與密度恢復預設"
  },
  "settings.resetAction": {
    "en": "Reset",
    "zh-CN": "重置",
    "zh-TW": "重設"
  },
  "settings.resetDone": {
    "en": "Appearance reset",
    "zh-CN": "外观已重置",
    "zh-TW": "外觀已重設"
  },
  "settings.dataNote": {
    "en": "Appearance is stored in this browser only. Memories and preferences are stored in your account.",
    "zh-CN": "外观仅保存在此浏览器中；记忆与偏好保存在你的账户中。",
    "zh-TW": "外觀僅儲存在此瀏覽器中；記憶與偏好儲存在你的帳戶中。"
  },
  "settings.back": {
    "en": "Settings",
    "zh-CN": "设置",
    "zh-TW": "設定"
  },
  "settings.closeLabel": {
    "en": "Close settings",
    "zh-CN": "关闭设置",
    "zh-TW": "關閉設定"
  },
  "settings.displayName": {
    "en": "Name",
    "zh-CN": "名称",
    "zh-TW": "名稱"
  },
  "settings.sec.account": {
    "en": "Account",
    "zh-CN": "账户",
    "zh-TW": "帳戶"
  },
  "memory.added": {
    "en": "Memory added",
    "zh-CN": "已添加记忆",
    "zh-TW": "已新增記憶"
  },
  "memory.updated": {
    "en": "Memory updated",
    "zh-CN": "记忆已更新",
    "zh-TW": "記憶已更新"
  },
  "memory.editHint": {
    "en": "Press Cmd/Ctrl+Enter to save",
    "zh-CN": "按 Cmd/Ctrl+Enter 保存",
    "zh-TW": "按 Cmd/Ctrl+Enter 儲存"
  },
  "memory.placeholder": {
    "en": "For example: I do code reviews on Friday afternoons",
    "zh-CN": "例如：我习惯在周五下午做代码评审",
    "zh-TW": "例如：我習慣在週五下午做程式碼審查"
  },
  "plugins.sec.title": {
    "en": "Plugins",
    "zh-CN": "插件",
    "zh-TW": "外掛"
  },
  "plugins.note": {
    "en": "Plugins bundle skills and MCP servers published by your administrator. Switch them on or off for your account.",
    "zh-CN": "插件由管理员发布，包含技能与 MCP 服务器；可按需为你的账户开启或关闭。",
    "zh-TW": "外掛由管理員發布，包含技能與 MCP 伺服器；可依需求為你的帳戶開啟或關閉。"
  },
  "settings.providers": {
    "en": "Providers",
    "zh-CN": "模型服务商",
    "zh-TW": "模型服務商"
  },
  ...processMessages,
  "settings.sec.languageInput": {
    "en": "Language & input",
    "zh-CN": "语言与输入",
    "zh-TW": "語言與輸入"
  },
  "settings.sendKey": {
    "en": "Send message",
    "zh-CN": "发送消息",
    "zh-TW": "傳送訊息"
  },
  "settings.sendKeyHint": {
    "en": "This device only. The other combination inserts a line break.",
    "zh-CN": "仅保存在本设备；另一种组合键用于换行。",
    "zh-TW": "僅儲存在本裝置；另一種組合鍵用於換行。"
  },
  "settings.sendKeyMod": {
    "en": "Cmd/Ctrl Enter",
    "zh-CN": "Cmd/Ctrl Enter",
    "zh-TW": "Cmd/Ctrl Enter"
  }
} as const satisfies Messages;
