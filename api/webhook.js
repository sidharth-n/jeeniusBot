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
  console.log(
    `[${new Date().toISOString()}] /start command received from chat ID: ${chatId}`
  )

  try {
    await ensureUser(chatId, msg.from)
    console.log(
      `[${new Date().toISOString()}] User ensured in database for chat ID: ${chatId}`
    )

    // If there's an active test, end it
    if (activeTests.has(chatId)) {
      console.log(
        `[${new Date().toISOString()}] Ending existing test for chat ID: ${chatId}`
      )
      await endTest(chatId, true)
    }

    console.log(
      `[${new Date().toISOString()}] Sending welcome message to chat ID: ${chatId}`
    )
    await bot.sendMessage(
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
    console.log(
      `[${new Date().toISOString()}] Welcome message sent to chat ID: ${chatId}`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in /start command for chat ID ${chatId}:`,
      error
    )
    await bot.sendMessage(chatId, "An error occurred. Please try again later.")
  }
})

// Handle button callbacks
bot.on("callback_query", async callbackQuery => {
  const chatId = callbackQuery.message.chat.id
  const data = callbackQuery.data
  console.log(
    `[${new Date().toISOString()}] Callback query received from chat ID ${chatId}: ${data}`
  )

  try {
    if (data === "start_test") {
      await startTest(chatId)
    } else if (data === "next" || data === "skip") {
      await handleNextQuestion(chatId, callbackQuery.message.message_id)
    }

    // Answer the callback query to remove the loading state
    await bot.answerCallbackQuery(callbackQuery.id)
    console.log(
      `[${new Date().toISOString()}] Callback query answered for chat ID ${chatId}`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error handling callback query for chat ID ${chatId}:`,
      error
    )
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "An error occurred. Please try again.",
    })
    await bot.sendMessage(
      chatId,
      "An error occurred. Please send /start to restart the test."
    )
  }
})

// Handle poll answers
bot.on("poll_answer", async pollAnswer => {
  const chatId = pollAnswer.user.id
  console.log(
    `[${new Date().toISOString()}] Poll answer received from chat ID ${chatId}`
  )

  try {
    const test = activeTests.get(chatId)
    if (!test) {
      console.log(
        `[${new Date().toISOString()}] No active test found for chat ID ${chatId}`
      )
      return
    }

    const userAnswer = pollAnswer.option_ids[0]
    console.log(
      `[${new Date().toISOString()}] User answer for chat ID ${chatId}: ${userAnswer}`
    )

    await updateAnswer(chatId, test.currentQuestion, userAnswer)

    // Change "Skip" button to "Next" button
    console.log(
      `[${new Date().toISOString()}] Changing Skip button to Next for chat ID ${chatId}`
    )
    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[{ text: "Next", callback_data: "next" }]],
      },
      {
        chat_id: chatId,
        message_id: test.currentMessageId,
      }
    )
    console.log(
      `[${new Date().toISOString()}] Button changed for chat ID ${chatId}`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error handling poll answer for chat ID ${chatId}:`,
      error
    )
    await bot.sendMessage(
      chatId,
      "An error occurred while recording your answer. Please continue with the next question."
    )
  }
})

async function startTest(chatId) {
  console.log(
    `[${new Date().toISOString()}] Starting test for chat ID ${chatId}`
  )
  try {
    const questions = await getQuestions()
    console.log(
      `[${new Date().toISOString()}] Retrieved ${
        questions.length
      } questions for chat ID ${chatId}`
    )

    activeTests.set(chatId, {
      questions,
      currentQuestion: 0,
      currentMessageId: null,
    })

    await sendNextQuestion(chatId)
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error starting test for chat ID ${chatId}:`,
      error
    )
    await bot.sendMessage(
      chatId,
      "An error occurred while starting the test. Please try again later."
    )
  }
}

async function getQuestions() {
  console.log(`[${new Date().toISOString()}] Fetching questions from database`)
  const { rows } = await client.execute("SELECT * FROM questions")
  console.log(
    `[${new Date().toISOString()}] Fetched ${
      rows.length
    } questions from database`
  )
  return rows
}

async function sendNextQuestion(chatId) {
  console.log(
    `[${new Date().toISOString()}] Sending next question for chat ID ${chatId}`
  )
  const test = activeTests.get(chatId)
  if (!test || test.currentQuestion >= test.questions.length) {
    console.log(
      `[${new Date().toISOString()}] No more questions for chat ID ${chatId}, ending test`
    )
    return endTest(chatId)
  }

  const question = test.questions[test.currentQuestion]
  const options = [
    question.option_a,
    question.option_b,
    question.option_c,
    question.option_d,
  ]

  console.log(
    `[${new Date().toISOString()}] Sending question ${
      test.currentQuestion + 1
    } to chat ID ${chatId}`
  )
  try {
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
    console.log(
      `[${new Date().toISOString()}] Question sent to chat ID ${chatId}, message ID: ${
        message.message_id
      }`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error sending question to chat ID ${chatId}:`,
      error
    )
    await bot.sendMessage(
      chatId,
      "An error occurred while sending the question. Please send /start to restart the test."
    )
  }
}

async function handleNextQuestion(chatId, messageId) {
  console.log(
    `[${new Date().toISOString()}] Handling next question for chat ID ${chatId}`
  )
  const test = activeTests.get(chatId)
  if (!test) {
    console.log(
      `[${new Date().toISOString()}] No active test found for chat ID ${chatId}`
    )
    await bot.sendMessage(
      chatId,
      "No active test found. Please send /start to begin a new test."
    )
    return
  }

  try {
    console.log(
      `[${new Date().toISOString()}] Stopping poll for chat ID ${chatId}, message ID: ${messageId}`
    )
    await bot.stopPoll(chatId, messageId)
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error stopping poll for chat ID ${chatId}:`,
      error
    )
    // Continue even if stopping the poll fails
  }

  test.currentQuestion++
  await sendNextQuestion(chatId)
}

async function updateAnswer(chatId, questionIndex, userAnswer) {
  console.log(
    `[${new Date().toISOString()}] Updating answer for chat ID ${chatId}, question ${
      questionIndex + 1
    }`
  )
  try {
    const { rows } = await client.execute({
      sql: "SELECT id FROM users WHERE chat_id = ?",
      args: [chatId],
    })
    const userId = rows[0].id

    await client.execute({
      sql: "INSERT OR REPLACE INTO user_answers (user_id, question_id, answer) VALUES (?, ?, ?)",
      args: [userId, questionIndex + 1, userAnswer],
    })
    console.log(
      `[${new Date().toISOString()}] Answer updated in database for chat ID ${chatId}`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error updating answer in database for chat ID ${chatId}:`,
      error
    )
    throw error
  }
}

async function endTest(chatId, isRestart = false) {
  console.log(
    `[${new Date().toISOString()}] Ending test for chat ID ${chatId}, isRestart: ${isRestart}`
  )
  const test = activeTests.get(chatId)
  if (!test) {
    console.log(
      `[${new Date().toISOString()}] No active test found for chat ID ${chatId}`
    )
    return
  }

  if (!isRestart) {
    try {
      const results = await calculateResults(chatId)
      let resultMessage = `Test completed!\n\nTotal Questions: ${results.totalQuestions}\nAttempted: ${results.attempted}\nCorrect: ${results.correct}\nIncorrect: ${results.incorrect}\nUnattempted: ${results.unattempted}\n\nTotal Score: ${results.totalScore}`

      console.log(
        `[${new Date().toISOString()}] Sending result message to chat ID ${chatId}`
      )
      await bot.sendMessage(chatId, resultMessage)
      await bot.sendMessage(
        chatId,
        "The answer key will be published later. Send /start to take the test again."
      )
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error calculating or sending results for chat ID ${chatId}:`,
        error
      )
      await bot.sendMessage(
        chatId,
        "An error occurred while calculating your results. Please contact support."
      )
    }
  }

  activeTests.delete(chatId)
  console.log(`[${new Date().toISOString()}] Test ended for chat ID ${chatId}`)
}

async function calculateResults(chatId) {
  console.log(
    `[${new Date().toISOString()}] Calculating results for chat ID ${chatId}`
  )
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

  console.log(
    `[${new Date().toISOString()}] Results calculated for chat ID ${chatId}: Total: ${totalQuestions}, Attempted: ${attempted}, Correct: ${correct}, Incorrect: ${incorrect}, Unattempted: ${unattempted}, Score: ${totalScore}`
  )

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
  console.log(
    `[${new Date().toISOString()}] Ensuring user in database for chat ID ${chatId}`
  )
  try {
    await client.execute({
      sql: "INSERT OR IGNORE INTO users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)",
      args: [
        chatId,
        userInfo.username,
        userInfo.first_name,
        userInfo.last_name,
      ],
    })
    console.log(
      `[${new Date().toISOString()}] User ensured in database for chat ID ${chatId}`
    )
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error ensuring user in database for chat ID ${chatId}:`,
      error
    )
    throw error
  }
}

// Error handling
bot.on("polling_error", error => {
  console.error(`[${new Date().toISOString()}] Polling error:`, error)
})

console.log(`[${new Date().toISOString()}] Bot is running...`)
