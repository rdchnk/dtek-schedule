
import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"

import {
  GROUP,
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

let getShutdownsDataRetries = 0

// Отримання графіка ДТЕК
const getShutdownsData = async () => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({
    headless: true,
  })

  try {
    const browserPage = await browser.newPage()

    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("not found")
    }

    const data = JSON.parse(match[1])

    console.log("✅ Getting shutdowns data finished.")
    return data
  } catch (error) {
    console.error(
      `❌ Getting shutdowns data failed: ${error.message}.`
    )
  } finally {
    await browser.close()
  }

  if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting shutdowns data again...")

    await new Promise((resolve) =>
      setTimeout(resolve, RETRIES_TIMEOUT)
    )

    getShutdownsDataRetries++
    return await getShutdownsData()
  }

  throw new Error(
    `Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

// Формування погодинного графіка
function generateSchedule({ data, today }) {
  console.log("🌀 Generating schedule...")

  try {
    const hoursStates = data[today][GROUP]

    if (!hoursStates) {
      throw new Error(`group ${GROUP} not found`)
    }

    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = hoursStates[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(
            createPeriod({ hour, power: true })
          )
          break

        case PowerState.OFF:
          setSchedule(
            createPeriod({ hour, power: false })
          )
          break

        case PowerState.HALF_ON:
          setSchedule(
            createPeriod({
              hour,
              endMin: 30,
              power: true,
            })
          )

          setSchedule(
            createPeriod({
              hour,
              startMin: 30,
              power: false,
            })
          )
          break

        case PowerState.HALF_OFF:
          setSchedule(
            createPeriod({
              hour,
              endMin: 30,
              power: false,
            })
          )

          setSchedule(
            createPeriod({
              hour,
              startMin: 30,
              power: true,
            })
          )
          break
      }
    })

    console.log("✅ Generating schedule finished.")
    return schedule
  } catch (error) {
    throw new Error(
      `❌ Generating schedule failed: ${error.message}.`
    )
  }
}

// Формування Telegram-повідомлення
function generateMessage(schedule = [], update) {
  console.log("🌀 Generating message...")

  const isShutdownsExists = schedule.some(
    ({ power }) => !power
  )

  const scheduleText = (
    isShutdownsExists
      ? schedule.filter(({ power }) => !power)
      : schedule
  )
    .map(
      ({ begin, end }) =>
        `${isShutdownsExists ? "🪫" : "🔋"} <code>${begin} — ${end}</code>`
    )
    .join("\n")

  const text = [
    "⚡️ <b>Графік відключень на сьогодні:</b>",
    scheduleText,
    "",
    `📢 <i>${update}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  return { text, scheduleText }
}

// Надсилання повідомлення одному користувачу
async function sendToChat(chatId, { text, scheduleText }) {
  let lastMessage = loadLastMessage(chatId) || {}

  const isScheduleChanged =
    lastMessage.scheduleText !== scheduleText

  const isEdit =
    Boolean(lastMessage.message_id) &&
    !isScheduleChanged

  const isReply =
    Boolean(lastMessage.message_id) &&
    isScheduleChanged

  const method = isEdit
    ? "editMessageText"
    : "sendMessage"

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_notification: checkIsNight(),
  }

  if (isEdit) {
    payload.message_id = lastMessage.message_id
  }

  if (isReply) {
    payload.reply_parameters = {
      message_id: lastMessage.message_id,
      allow_sending_without_reply: true,
    }
  }

  let lastError

  for (
    let attempt = 0;
    attempt <= RETRIES_MAX_COUNT;
    attempt++
  ) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      )

      const data = await response.json()

      if (
        data.description?.includes(
          "message is not modified"
        )
      ) {
        console.log(
          `🟡 Chat ${chatId}: message unchanged.`
        )
        return
      }

      if (!data.ok) {
        throw new Error(
          data.description || "Telegram API error"
        )
      }

      saveLastMessage(chatId, {
        ...data.result,
        scheduleText,
      })

      console.log(
        `🟢 Chat ${chatId}: notification sent.`
      )

      return
    } catch (error) {
      lastError = error

      console.error(
        `❌ Chat ${chatId}, attempt ${attempt + 1}: ${error.message}`
      )

      if (attempt < RETRIES_MAX_COUNT) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRIES_TIMEOUT)
        )
      }
    }
  }

  // Якщо редагування старого повідомлення не вдалося,
  // скидаємо його стан для наступного запуску.
  if (isEdit) {
    deleteLastMessage(chatId)
  }

  throw new Error(
    `Chat ${chatId}: ${lastError?.message}`
  )
}

// Розсилка всім отримувачам
async function sendNotification(message) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing Telegram bot token.")
  }

  if (!TELEGRAM_CHAT_IDS.length) {
    throw new Error("Missing Telegram chat IDs.")
  }

  console.log(
    `🌀 Sending to ${TELEGRAM_CHAT_IDS.length} chats...`
  )

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map((chatId) =>
      sendToChat(chatId, message)
    )
  )

  let failed = 0

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed++

      console.error(
        `❌ Chat ${TELEGRAM_CHAT_IDS[index]}: ${result.reason.message}`
      )
    }
  })

  console.log(
    `📨 Sent successfully: ${results.length - failed}/${results.length}`
  )

  if (failed > 0) {
    throw new Error(
      `Failed to notify ${failed} chat(s).`
    )
  }
}

// Головний запуск
async function run() {
  const data = await getShutdownsData()

  const groups = data.data?.[data.today] ?? {}

  if (!Object.keys(groups).length) {
    console.log("🔋 No schedule for today.")
    return
  }

  const schedule = generateSchedule(data)
  const message = generateMessage(
    schedule,
    data.update
  )

  await sendNotification(message)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
