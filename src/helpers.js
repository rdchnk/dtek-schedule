
import fs from "node:fs"
import path from "node:path"
import { LAST_MESSAGE_FILE } from "./constants.js"

function addLeadingZero(str) {
  if (typeof str !== "string" && typeof str !== "number") return
  return String(str).padStart(2, "0")
}

export function createPeriod({ hour, startMin = 0, endMin = 0, power }) {
  const begin = `${addLeadingZero(hour)}:${addLeadingZero(startMin)}`
  const end =
    endMin === 0
      ? `${addLeadingZero(hour + 1)}:00`
      : `${addLeadingZero(hour)}:${addLeadingZero(endMin)}`

  return {
    begin,
    end,
    power,
  }
}

export function useSchedule(schedule) {
  const setSchedule = (period) => {
    const last = schedule.at(-1)

    if (last?.power === period.power) {
      last.end = period.end
    } else {
      schedule.push(period)
    }
  }

  return [schedule, setSchedule]
}

export function getCurrentTime() {
  const now = new Date()

  const date = now.toLocaleDateString("uk-UA", {
    timeZone: "Europe/Kyiv",
  })

  const time = now.toLocaleTimeString("uk-UA", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
  })

  return `${date} ${time}`
}

export function checkIsNight() {
  const hours = Number(
    new Date().toLocaleString("en-US", {
      timeZone: "Europe/Kyiv",
      hour: "numeric",
      hour12: false,
    })
  )

  return hours >= 22 || hours < 8
}

// Окремий файл стану для кожного Telegram-користувача
function getLastMessageFile(chatId) {
  if (!/^-?\d+$/.test(String(chatId))) {
    throw new Error("Invalid Telegram Chat ID")
  }

  return path.join(
    path.dirname(LAST_MESSAGE_FILE),
    `last-message-${chatId}.json`
  )
}

// Завантаження останнього повідомлення користувача
export function loadLastMessage(chatId) {
  const file = getLastMessageFile(chatId)

  // Підтримка старого файлу для першого користувача
  const source = fs.existsSync(file)
    ? file
    : String(chatId) === String(process.env.TELEGRAM_CHAT_ID) &&
        fs.existsSync(LAST_MESSAGE_FILE)
      ? LAST_MESSAGE_FILE
      : null

  if (!source) return null

  const lastMessage = JSON.parse(
    fs.readFileSync(source, "utf8").trim()
  )

  if (lastMessage?.date) {
    const messageDay = new Date(
      lastMessage.date * 1000
    ).toLocaleDateString("en-CA", {
      timeZone: "Europe/Kyiv",
    })

    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Kyiv",
    })

    if (messageDay < today) {
      deleteLastMessage(chatId)
      return null
    }
  }

  return lastMessage
}

// Збереження останнього повідомлення користувача
export function saveLastMessage(
  chatId,
  { date, message_id, scheduleText } = {}
) {
  const file = getLastMessageFile(chatId)

  fs.mkdirSync(path.dirname(file), {
    recursive: true,
  })

  fs.writeFileSync(
    file,
    JSON.stringify({
      message_id,
      date,
      scheduleText,
    })
  )
}

// Видалення стану конкретного користувача
export function deleteLastMessage(chatId) {
  const file = getLastMessageFile(chatId)

  fs.rmSync(file, { force: true })

  if (String(chatId) === String(process.env.TELEGRAM_CHAT_ID)) {
    fs.rmSync(LAST_MESSAGE_FILE, { force: true })
  }
}
