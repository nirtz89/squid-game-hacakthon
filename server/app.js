import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { VM } from "vm2";

const app = express();
const server = app.listen(process.env.PORT || 8080);

const messageState = {
  WAITING_START: "WaitingStart",
  QUESTION: "Question",
  PASSED: "Passed",
  PLAYING: "Playing",
  ELIMINATED: "Eliminated",
  GAME_OVER: "GameOver",
  PLAYER_ALREADY_JOINED: "PlayerAlreadyJoined",
  GAME_ALREADY_STARTED: "GameAlreadyStarted"
};

const messageType = {
  STATUS: "Status",
  JOIN: "Join",
  SUBMIT: "Submit"
};

const wss = new WebSocketServer({ server });
// this will make Express serve your static files
app.use(express.static("./build-client"));
app.get("/", function(req, res) {
  res.sendFile("./build-client/index.html");
});

function runCodeIsolated(code, params) {
  try {
    const vm = new VM({
      timeout: 1000,
      sandbox: {}
    });

    return vm.run(`(${code})(${params})`);
  } catch (error) {
    console.log(error);
  }
  console.log('Ran runCodeIsolated');
  return false;
}

const questionTimeout = 10000;
const maxPlayerCount = 1;
const questions = [
  {
    description:
      "Write a function that accepts an array of native numbers as a parameter and returns the sum of multiplication of every two adjacent cells",
    validators: [code => runCodeIsolated(code, `[1,2,3]`) === 8],
    codeTemplate: "(arr) => { }"
  },
  {
    description: "2",
    validators: [() => true]
  }
];
let gameState = {
  clients: [],
  currentQuestion: 0,
  state: "NotStarted"
};

wss.getUniqueID = function() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + "-" + s4();
};

let iterationHandle = null;

function validateSubmission(code, question) {
  if (code) {
    return question.validators.every(validator => validator(code));
  }
  return false;
}

function resetGame() {
  gameState = {
    clients: [],
    currentQuestion: 0,
    state: "NotStarted"
  };
}

function playNextQuestion() {
  [...wss.clients]
    .filter(
      c =>
        gameState.clients.find(client => client.id === c.id).status !==
        messageState.ELIMINATED
    )
    .forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: messageType.STATUS,
            state: messageState.QUESTION,
            qNum: gameState.currentQuestion,
            totalQ: questions.length,
            description: questions[gameState.currentQuestion].description,
            timeLeft: questionTimeout,
            codeTemplate: questions[gameState.currentQuestion].codeTemplate
          })
        );
      }
      gameState.clients.find(c => c.id === client.id).status =
        messageState.PLAYING;
    });
  iterationHandle = setTimeout(() => {
    gameState.currentQuestion++;
    if (gameState.currentQuestion === questions.length) {
      gameState.state = messageState.GAME_OVER;
      wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: messageType.STATUS,
              state: messageState.GAME_OVER,
              winners: gameState.clients
                .filter(c => c.status === messageState.PASSED)
                .map(c => c.playerName),
              losers: gameState.clients
                .filter(c => c.status === messageState.ELIMINATED)
                .map(c => c.playerName)
            })
          );
          client.close();
        }
      });
      resetGame();
    } else {
      [...wss.clients]
        .filter(
          c =>
            gameState.clients.find(client => client.id === c.id).status ===
            messageState.PLAYING
        )
        .forEach(function each(client) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: messageType.STATUS,
                state: messageState.ELIMINATED
              })
            );
          }
          gameState.clients.find(c => c.id === client.id).status =
            messageState.ELIMINATED;
        });
      playNextQuestion();
    }
  }, questionTimeout);
}

wss.on("connection", function connection(ws) {
  ws.id = wss.getUniqueID();
  ws.on("close", function close() {
    console.log("disconnected");
    const client = gameState.clients.find(c => c.id === ws.id);
    if (client) {
      gameState.clients = gameState.clients.splice(
        gameState.clients.indexOf(client),
        1
      );
      if (gameState.clients.length === 0) {
        clearTimeout(iterationHandle);
        resetGame();
      }
    }
  });

  ws.on("message", function incoming(message) {
    try {
      message = JSON.parse(message);
    } catch (error) {
      console.log(error);
      return;
    }

    console.log(`Received message ${JSON.stringify(message)}`);
    switch (message.type) {
      case "Join":
        if (gameState.state !== "NotStarted") {
          ws.send(
            JSON.stringify({
              type: messageType.STATUS,
              state: messageState.GAME_ALREADY_STARTED
            })
          );
          return;
        }
        if (
          gameState.clients.some(
            c =>
              c.playerName.toLocaleLowerCase() ===
                message.playerName.toLocaleLowerCase() || c.id === ws.id
          )
        ) {
          ws.send(
            JSON.stringify({
              type: messageType.STATUS,
              state: messageState.PLAYER_ALREADY_JOINED
            })
          );
        } else {
          gameState.clients.push({
            playerName: message.playerName,
            status: messageState.PLAYING,
            id: ws.id
          });
          if (gameState.clients.length === maxPlayerCount) {
            gameState.state = "Started";
            playNextQuestion();
          } else {
            wss.clients.forEach(function each(client) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: messageType.STATUS,
                    state: messageState.WAITING_START,
                    players: gameState.clients.map(c => c.playerName)
                  })
                );
              }
            });
          }
        }
        break;
      case "Submit":
        if (
          gameState.state !== "NotStarted" &&
          message.qNum === gameState.currentQuestion &&
          gameState.clients.find(c => c.id === ws.id).status !==
            messageState.ELIMINATED
        ) {
          if (
            validateSubmission(
              message.code,
              questions[gameState.currentQuestion]
            )
          ) {
            gameState.clients.find(c => c.id === ws.id).status =
              messageState.PASSED;
            ws.send(
              JSON.stringify({
                type: messageType.STATUS,
                state: messageState.PASSED
              })
            );
          } else {
            gameState.clients.find(c => c.id === ws.id).status =
              messageState.ELIMINATED;
            ws.send(
              JSON.stringify({
                type: messageType.STATUS,
                state: messageState.ELIMINATED
              })
            );
          }
        }
        break;
      default:
        break;
    }
  });
});
