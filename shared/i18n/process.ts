import { createTranslator, type Messages } from "./index";

const messages = {
  "instruction.title": {
    "en": "Additional instructions",
    "zh-CN": "补充要求",
    "zh-TW": "補充要求"
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
  }
} as const satisfies Messages;

export const processT = createTranslator(messages);
