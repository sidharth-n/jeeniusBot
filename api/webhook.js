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
const TEST_DURATION = 30 * 1000 // 30 seconds for testing
const activeTests = new Map()

// Start command
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id
  await ensureUser(chatId, msg.from)

  bot.sendMessage(
    chatId,
    'Welcome to the JEE Mock Test Bot! This test contains 5 questions and lasts for 30 seconds. Press "Start Test" when you\'re ready.',
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
    startTest(chatId)
  } else if (data.startsWith("answer_")) {
    handleAnswer(chatId, data)
  } else if (data === "skip") {
    sendNextQuestion(chatId)
  }
})

async function startTest(chatId) {
  const questions = await getQuestions()
  activeTests.set(chatId, {
    questions,
    currentQuestion: 0,
    score: 0,
    startTime: Date.now(),
  })

  sendNextQuestion(chatId)

  // Set timeout to end the test
  setTimeout(() => endTest(chatId), TEST_DURATION)
}

async function getQuestions() {
  const { rows } = await client.execute(
    "SELECT * FROM questions ORDER BY RANDOM() LIMIT 5"
  )
  return rows
}

async function sendNextQuestion(chatId) {
  const test = activeTests.get(chatId)
  if (!test || test.currentQuestion >= test.questions.length) {
    return endTest(chatId)
  }

  const question = test.questions[test.currentQuestion]
  const options = [
    { text: question.option_a, callback_data: "answer_a" },
    { text: question.option_b, callback_data: "answer_b" },
    { text: question.option_c, callback_data: "answer_c" },
    { text: question.option_d, callback_data: "answer_d" },
  ]

  bot.sendMessage(
    chatId,
    `Question ${test.currentQuestion + 1}: ${question.question}`,
    {
      reply_markup: {
        inline_keyboard: [
          ...options.map(option => [option]),
          [{ text: "Skip", callback_data: "skip" }],
        ],
      },
    }
  )
}

async function handleAnswer(chatId, data) {
  const test = activeTests.get(chatId)
  if (!test) return

  const question = test.questions[test.currentQuestion]
  const answer = data.split("_")[1]

  if (answer === question.correct_answer) {
    test.score++
  }

  test.currentQuestion++
  sendNextQuestion(chatId)
}

async function endTest(chatId) {
  const test = activeTests.get(chatId)
  if (!test) return

  const endTime = Date.now()
  const timeTaken = (endTime - test.startTime) / 1000

  await saveTestResult(chatId, test.score, test.questions.length, timeTaken)

  bot.sendMessage(
    chatId,
    `Test completed!\nScore: ${test.score}/${
      test.questions.length
    }\nTime taken: ${timeTaken.toFixed(2)} seconds`
  )

  activeTests.delete(chatId)
}

async function ensureUser(chatId, userInfo) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)",
    args: [chatId, userInfo.username, userInfo.first_name, userInfo.last_name],
  })
}

async function saveTestResult(chatId, score, totalQuestions, timeTaken) {
  const { rows } = await client.execute({
    sql: "SELECT id FROM users WHERE chat_id = ?",
    args: [chatId],
  })
  const userId = rows[0].id

  await client.execute({
    sql: "INSERT INTO tests (user_id, start_time, end_time, score, total_questions, correct_answers) VALUES (?, datetime(?), datetime(?), ?, ?, ?)",
    args: [
      userId,
      new Date(Date.now() - timeTaken * 1000).toISOString(),
      new Date().toISOString(),
      score,
      totalQuestions,
      score,
    ],
  })
}

// Error handling
bot.on("polling_error", error => {
  console.error(error)
})

console.log("Bot is running...")
