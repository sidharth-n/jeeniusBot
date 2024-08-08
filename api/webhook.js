const TelegramBot = require("node-telegram-bot-api")
const { createClient } = require("@libsql/client")

// Initialize the bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })

// Initialize the database client
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

// Global variables
const activeTests = new Map()

// Start command
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  await ensureUser(chatId, msg.from)

  // If there's an active test, end it
  if (activeTests.has(chatId)) {
    await endTest(chatId, true)
  }

  bot.sendMessage(
    chatId,
    'Welcome to the JEE Mock Test Bot! This test contains multiple-choice questions. Press "Start Test" when you\'re ready.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Start Test", callback_data: "start_test" }],
        ],
      },
    }
  )
})

// Handle button callbacks
bot.on("callback_query", async callbackQuery => {
  const chatId = callbackQuery.message.chat.id
  const data = callbackQuery.data

  if (data === "start_test") {
    await startTest(chatId)
  } else if (data === "next" || data === "skip") {
    await handleNextQuestion(chatId, callbackQuery.message.message_id)
  }

  // Answer the callback query to remove the loading state
  bot.answerCallbackQuery(callbackQuery.id)
})

// Handle poll answers
bot.on("poll_answer", async pollAnswer => {
  const chatId = pollAnswer.user.id
  const test = activeTests.get(chatId)
  if (!test) return

  const userAnswer = pollAnswer.option_ids[0]

  await updateAnswer(chatId, test.currentQuestion, userAnswer)

  // Change "Skip" button to "Next" button
  await bot.editMessageReplyMarkup(
    {
      inline_keyboard: [[{ text: "Next", callback_data: "next" }]],
    },
    {
      chat_id: chatId,
      message_id: test.currentMessageId,
    }
  )
})

async function startTest(chatId) {
  const questions = await getQuestions()
  activeTests.set(chatId, {
    questions,
    currentQuestion: 0,
    currentMessageId: null,
  })

  await sendNextQuestion(chatId)
}

async function getQuestions() {
  const { rows } = await client.execute("SELECT * FROM questions")
  return rows
}

async function sendNextQuestion(chatId) {
  const test = activeTests.get(chatId)
  if (!test || test.currentQuestion >= test.questions.length) {
    return endTest(chatId)
  }

  const question = test.questions[test.currentQuestion]
  const options = [
    question.option_a,
    question.option_b,
    question.option_c,
    question.option_d,
  ]

  const message = await bot.sendPoll(
    chatId,
    `Question ${test.currentQuestion + 1}: ${question.question}`,
    options,
    {
      is_anonymous: false,
      type: "regular",
      allows_multiple_answers: false,
      reply_markup: {
        inline_keyboard: [[{ text: "Skip", callback_data: "skip" }]],
      },
    }
  )

  // Store the message ID for later reference
  test.currentMessageId = message.message_id
}

async function handleNextQuestion(chatId, messageId) {
  const test = activeTests.get(chatId)
  if (!test) return

  test.currentQuestion++
  await bot.stopPoll(chatId, messageId)
  await sendNextQuestion(chatId)
}

async function updateAnswer(chatId, questionIndex, userAnswer) {
  const { rows } = await client.execute({
    sql: "SELECT id FROM users WHERE chat_id = ?",
    args: [chatId],
  })
  const userId = rows[0].id

  await client.execute({
    sql: "INSERT OR REPLACE INTO user_answers (user_id, question_id, answer) VALUES (?, ?, ?)",
    args: [userId, questionIndex + 1, userAnswer],
  })
}

async function endTest(chatId, isRestart = false) {
  const test = activeTests.get(chatId)
  if (!test) return

  if (!isRestart) {
    const results = await calculateResults(chatId)
    let resultMessage = `Test completed!\n\nTotal Questions: ${results.totalQuestions}\nAttempted: ${results.attempted}\nCorrect: ${results.correct}\nIncorrect: ${results.incorrect}\nUnattempted: ${results.unattempted}\n\nTotal Score: ${results.totalScore}`

    bot.sendMessage(chatId, resultMessage)
    bot.sendMessage(
      chatId,
      "The answer key will be published later. Send /start to take the test again."
    )
  }

  activeTests.delete(chatId)
}

async function calculateResults(chatId) {
  const { rows: userRows } = await client.execute({
    sql: "SELECT id FROM users WHERE chat_id = ?",
    args: [chatId],
  })
  const userId = userRows[0].id

  const { rows: answerRows } = await client.execute({
    sql: "SELECT q.id, q.correct_answer, ua.answer FROM questions q LEFT JOIN user_answers ua ON q.id = ua.question_id AND ua.user_id = ?",
    args: [userId],
  })

  let correct = 0
  let incorrect = 0
  let unattempted = 0

  answerRows.forEach(row => {
    if (row.answer === null) {
      unattempted++
    } else if (
      row.answer === ["a", "b", "c", "d"].indexOf(row.correct_answer)
    ) {
      correct++
    } else {
      incorrect++
    }
  })

  const totalQuestions = answerRows.length
  const attempted = correct + incorrect
  const totalScore = correct * 4 - incorrect

  return {
    totalQuestions,
    attempted,
    correct,
    incorrect,
    unattempted,
    totalScore,
  }
}

async function ensureUser(chatId, userInfo) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)",
    args: [chatId, userInfo.username, userInfo.first_name, userInfo.last_name],
  })
}

// Error handling
bot.on("polling_error", error => {
  console.error(error)
})

console.log("Bot is running...")
