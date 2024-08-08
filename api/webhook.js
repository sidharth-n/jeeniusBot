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
const TEST_DURATION = 600 * 1000 // 30 seconds for testing
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

  const question = test.questions[test.currentQuestion]
  const userAnswer = pollAnswer.option_ids[0]

  test.answers[test.currentQuestion] = userAnswer

  if (userAnswer === question.correct_option_id) {
    test.score++
  }

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
    score: 0,
    startTime: Date.now(),
    answers: new Array(questions.length).fill(null),
    currentMessageId: null,
  })

  await sendNextQuestion(chatId)

  // Set timeout to end the test
  setTimeout(() => endTest(chatId), TEST_DURATION)
}

async function getQuestions() {
  const { rows } = await client.execute(
    "SELECT * FROM questions ORDER BY RANDOM() LIMIT 5"
  )
  return rows.map((question, index) => ({
    ...question,
    correct_option_id: ["a", "b", "c", "d"].indexOf(question.correct_answer),
  }))
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
      type: "quiz",
      correct_option_id: question.correct_option_id,
      explanation:
        "Select your answer or press 'Skip' to move to the next question.",
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

  // If the question wasn't answered, mark it as skipped
  if (test.answers[test.currentQuestion] === null) {
    test.answers[test.currentQuestion] = "skipped"
  }

  test.currentQuestion++
  await bot.stopPoll(chatId, messageId)
  await sendNextQuestion(chatId)
}

async function endTest(chatId) {
  const test = activeTests.get(chatId)
  if (!test) return

  const endTime = Date.now()
  const timeTaken = (endTime - test.startTime) / 1000

  // Stop all active polls
  for (let i = 0; i <= test.currentQuestion; i++) {
    if (test.answers[i] === null) {
      test.answers[i] = "unanswered"
    }
    try {
      await bot.stopPoll(
        chatId,
        test.currentMessageId - (test.currentQuestion - i)
      )
    } catch (error) {
      console.error(`Failed to stop poll for question ${i + 1}:`, error)
    }
  }

  await saveTestResult(
    chatId,
    test.score,
    test.questions.length,
    timeTaken,
    test.answers
  )

  let resultMessage = `Test completed!\nScore: ${test.score}/${
    test.questions.length
  }\nTime taken: ${timeTaken.toFixed(2)} seconds\n\nQuestion summary:`
  test.answers.forEach((answer, index) => {
    resultMessage += `\nQ${index + 1}: ${
      answer === "skipped"
        ? "Skipped"
        : answer === "unanswered"
        ? "Unanswered"
        : answer === test.questions[index].correct_option_id
        ? "Correct"
        : "Incorrect"
    }`
  })

  bot.sendMessage(chatId, resultMessage)

  // Send timeout message
  bot.sendMessage(chatId, "Time's up! The test has ended.")

  activeTests.delete(chatId)
}

async function ensureUser(chatId, userInfo) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)",
    args: [chatId, userInfo.username, userInfo.first_name, userInfo.last_name],
  })
}

async function saveTestResult(
  chatId,
  score,
  totalQuestions,
  timeTaken,
  answers
) {
  const { rows } = await client.execute({
    sql: "SELECT id FROM users WHERE chat_id = ?",
    args: [chatId],
  })
  const userId = rows[0].id

  await client.execute({
    sql: "INSERT INTO tests (user_id, start_time, end_time, score, total_questions, correct_answers, answers) VALUES (?, datetime(?), datetime(?), ?, ?, ?, ?)",
    args: [
      userId,
      new Date(Date.now() - timeTaken * 1000).toISOString(),
      new Date().toISOString(),
      score,
      totalQuestions,
      score,
      JSON.stringify(answers),
    ],
  })
}

// Error handling
bot.on("polling_error", error => {
  console.error(error)
})

console.log("Bot is running...")
