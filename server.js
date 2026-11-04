/**
 * DOBON Realtime Game Server
 * Game Version: 2026.00.001
 * File Version: server.js v0.1.0
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const GAME_VERSION = "2026.00.001";
const FILE_VERSION = "server.js v0.1.0";

app.get('/', (req, res) => {
  res.send(`DOBON Server is running! [Game: ${GAME_VERSION}] [File: ${FILE_VERSION}]`);
});

const rooms = {};

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = [
  { label: 'A', val: 1 }, { label: '2', val: 2 }, { label: '3', val: 3 },
  { label: '4', val: 4 }, { label: '5', val: 5 }, { label: '6', val: 6 },
  { label: '7', val: 7 }, { label: '8', val: 8 }, { label: '9', val: 9 },
  { label: '10', val: 10 }, { label: 'J', val: 11 }, { label: 'Q', val: 12 }, { label: 'K', val: 13 }
];

function createShuffledDeck() {
  const deck = [];
  for (let s of SUITS) {
    for (let v of VALUES) {
      deck.push({ suit: s, label: v.label, val: v.val, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const r = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[r]] = [deck[r], deck[i]];
  }
  return deck;
}

function getNextTurn(currentTurn, skips, direction, totalPlayers) {
  let next = (currentTurn + (1 + skips) * direction) % totalPlayers;
  while (next < 0) next += totalPlayers;
  return next;
}

function getLobbyRoomList() {
  const list = [];
  for (let rId in rooms) {
    const r = rooms[rId];
    const humanCount = r.players.filter(p => !p.isCpu).length;
    list.push({
      id: rId,
      name: r.roomName || `Room ${rId}`,
      playerCount: humanCount,
      maxPlayers: r.targetPlayerCount || 4,
      isPlaying: r.gameStarted
    });
  }
  return list;
}

// サーバー主導のCPU自動思考＆打牌処理
function handleServerCpuTurn(room) {
  if (!room || !room.gameStarted || room.isGameOver) return;
  const currentSeat = room.turnSeatIndex;
  const player = room.players[currentSeat];
  if (!player || !player.isCpu) return;

  setTimeout(() => {
    if (!room.gameStarted || room.turnSeatIndex !== currentSeat) return;

    const top = room.discardHistory[room.discardHistory.length - 1];
    
    // 2ドロー累積中の処理
    if (room.drawTwoStack > 0) {
      const idx2 = player.hand.findIndex(c => c && c.val === 2);
      if (idx2 !== -1) {
        // CPUが2を重ねる
        const card2 = player.hand.splice(idx2, 1)[0];
        room.drawTwoStack += 2;
        room.discardHistory.push(card2);
        
        io.to(room.roomId).emit('card_played_sync', {
          senderSeatIndex: currentSeat,
          card: card2,
          designatedSuit: null,
          remainingCardCount: player.hand.length,
          drawTwoStack: room.drawTwoStack,
          actionType: 'stack_2'
        });

        if (player.hand.length === 0) {
          endGameByWin(room, currentSeat, 'NORMAL WIN');
          return;
        }

        room.turnSeatIndex = getNextTurn(currentSeat, 0, room.direction, room.players.length);
        notifyNextTurn(room);
        return;
      } else {
        // CPUがドロー
        const drawCount = room.drawTwoStack;
        room.drawTwoStack = 0;
        for (let i = 0; i < drawCount; i++) {
          if (room.deck.length > 0) player.hand.push(room.deck.pop());
        }
        
        io.to(room.roomId).emit('card_drawn_sync', {
          senderSeatIndex: currentSeat,
          drawCount: drawCount,
          deckCount: room.deck.length
        });

        room.turnSeatIndex = getNextTurn(currentSeat, 0, room.direction, room.players.length);
        notifyNextTurn(room);
        return;
      }
    }

    // 出せるカードを探索
    const playableIndices = [];
    player.hand.forEach((c, idx) => {
      if (!c) return;
      const suitMatch = room.designatedSuit ? (c.suit === room.designatedSuit) : (c.suit === top.suit);
      const numMatch = (c.label === top.label);
      if (suitMatch || numMatch || c.val === 8) {
        playableIndices.push(idx);
      }
    });

    if (playableIndices.length > 0) {
      const pickIdx = playableIndices[Math.floor(Math.random() * playableIndices.length)];
      const playedCard = player.hand.splice(pickIdx, 1)[0];
      room.discardHistory.push(playedCard);

      let skips = 0;
      let suitChoice = null;

      if (playedCard.val === 8) {
        const counts = {};
        player.hand.forEach(c => { if (c) counts[c.suit] = (counts[c.suit] || 0) + 1; });
        suitChoice = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '♠';
        room.designatedSuit = suitChoice;
      } else {
        room.designatedSuit = null;
      }

      if (playedCard.val === 2) room.drawTwoStack += 2;
      else if (playedCard.val === 9) room.direction *= -1;
      else if (playedCard.val === 1) skips = 1;

      io.to(room.roomId).emit('card_played_sync', {
        senderSeatIndex: currentSeat,
        card: playedCard,
        designatedSuit: suitChoice,
        remainingCardCount: player.hand.length,
        drawTwoStack: room.drawTwoStack,
        actionType: playedCard.val === 1 ? 'skip' : (playedCard.val === 2 ? 'draw2' : 'normal')
      });

      if (player.hand.length === 0) {
        endGameByWin(room, currentSeat, 'NORMAL WIN');
        return;
      }

      room.turnSeatIndex = getNextTurn(currentSeat, skips, room.direction, room.players.length);
      notifyNextTurn(room);
    } else {
      // 山札から1枚引く
      let drawn = null;
      if (room.deck.length > 0) {
        drawn = room.deck.pop();
        player.hand.push(drawn);
      }

      io.to(room.roomId).emit('card_drawn_sync', {
        senderSeatIndex: currentSeat,
        drawCount: 1,
        deckCount: room.deck.length
      });

      room.turnSeatIndex = getNextTurn(currentSeat, 0, room.direction, room.players.length);
      notifyNextTurn(room);
    }
  }, 1800);
}

function notifyNextTurn(room) {
  io.to(room.roomId).emit('turn_changed_sync', {
    turnSeatIndex: room.turnSeatIndex,
    direction: room.direction
  });
  handleServerCpuTurn(room);
}

function endGameByWin(room, winnerSeat, winType) {
  room.gameStarted = false;
  room.isGameOver = true;
  io.to(room.roomId).emit('game_ended_sync', {
    winnerSeatIndex: winnerSeat,
    winnerName: room.players[winnerSeat].name,
    winningType: winType
  });
}

io.on('connection', (socket) => {
  socket.on('request_room_list', () => {
    socket.emit('room_list_updated', getLobbyRoomList());
  });

  socket.on('join_or_create_room', ({ roomId, roomName, playerName, targetPlayerCount }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        roomId: roomId,
        roomName: roomName || `Table ${roomId}`,
        targetPlayerCount: targetPlayerCount || 4,
        players: [],
        deck: [],
        discardHistory: [],
        turnSeatIndex: 0,
        direction: 1,
        drawTwoStack: 0,
        designatedSuit: null,
        gameStarted: false,
        isGameOver: false,
        roundNum: 1,
        multiplier: 1
      };
    }

    const room = rooms[roomId];
    const existingIdx = room.players.findIndex(p => p.id === socket.id || (p.name === playerName && !p.isCpu));
    if (existingIdx !== -1) {
      room.players[existingIdx].id = socket.id;
      room.players[existingIdx].name = playerName;
    } else {
      if (!room.gameStarted) {
        room.players.push({
          id: socket.id,
          name: playerName || `Player ${room.players.length + 1}`,
          hand: [],
          score: 0,
          isCpu: false
        });
      }
    }

    io.to(roomId).emit('room_detail_updated', {
      roomId: roomId,
      roomName: room.roomName,
      targetPlayerCount: room.targetPlayerCount,
      players: room.players.filter(p => !p.isCpu).map(p => ({ id: p.id, name: p.name })),
      gameStarted: room.gameStarted
    });

    io.emit('room_list_updated', getLobbyRoomList());
  });

  function startSyncGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const humanPlayers = room.players.filter(p => !p.isCpu);
    room.players = [...humanPlayers];
    const neededCpu = Math.max(0, (room.targetPlayerCount || 4) - room.players.length);

    for (let i = 1; i <= neededCpu; i++) {
      room.players.push({
        id: `cpu_${Date.now()}_${i}`,
        name: `CPU ${i}`,
        hand: [],
        score: 0,
        isCpu: true
      });
    }

    room.deck = createShuffledDeck();
    room.discardHistory = [];
    room.turnSeatIndex = 0;
    room.direction = 1;
    room.drawTwoStack = 0;
    room.designatedSuit = null;
    room.gameStarted = true;
    room.isGameOver = false;

    room.players.forEach(p => {
      p.hand = room.deck.splice(0, 5);
    });

    let initCard = room.deck.pop();
    while (initCard.val === 8 || initCard.val === 2) {
      room.deck.unshift(initCard);
      initCard = room.deck.pop();
    }
    room.discardHistory.push(initCard);

    room.players.forEach((p, idx) => {
      if (!p.isCpu) {
        io.to(p.id).emit('game_started_sync', {
          myHand: p.hand,
          mySeatIndex: idx,
          players: room.players.map((other, oIdx) => ({
            seatIndex: oIdx,
            name: other.name,
            cardCount: other.hand.length,
            isCpu: other.isCpu
          })),
          initialCard: initCard,
          deckCount: room.deck.length,
          turnSeatIndex: room.turnSeatIndex,
          roundNum: room.roundNum,
          multiplier: room.multiplier
        });
      }
    });

    io.emit('room_list_updated', getLobbyRoomList());
    handleServerCpuTurn(room);
  }

  socket.on('start_online_game', ({ roomId }) => {
    startSyncGame(roomId);
  });

  socket.on('play_card', ({ roomId, card, designatedSuit, remainingCardCount }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const senderIdx = room.players.findIndex(p => p.id === socket.id);
    if (senderIdx === -1 || senderIdx !== room.turnSeatIndex) return;

    room.players[senderIdx].hand.length = remainingCardCount;
    room.discardHistory.push(card);
    room.designatedSuit = designatedSuit || null;

    let skips = 0;
    if (card.val === 2) room.drawTwoStack += 2;
    else if (card.val === 9) room.direction *= -1;
    else if (card.val === 1) skips = 1;

    socket.to(roomId).emit('card_played_sync', {
      senderSeatIndex: senderIdx,
      card: card,
      designatedSuit: designatedSuit,
      remainingCardCount: remainingCardCount,
      drawTwoStack: room.drawTwoStack,
      actionType: card.val === 1 ? 'skip' : (card.val === 2 ? 'draw2' : 'normal')
    });

    if (remainingCardCount === 0) {
      endGameByWin(room, senderIdx, 'NORMAL WIN');
      return;
    }

    room.turnSeatIndex = getNextTurn(senderIdx, skips, room.direction, room.players.length);
    notifyNextTurn(room);
  });

  socket.on('draw_card', ({ roomId, count }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const senderIdx = room.players.findIndex(p => p.id === socket.id);
    if (senderIdx === -1 || senderIdx !== room.turnSeatIndex) return;

    const drawCount = count || (room.drawTwoStack > 0 ? room.drawTwoStack : 1);
    room.drawTwoStack = 0;
    const drawnCards = [];

    for (let i = 0; i < drawCount; i++) {
      if (room.deck.length > 0) drawnCards.push(room.deck.pop());
    }

    socket.emit('my_card_drawn', {
      cards: drawnCards,
      deckCount: room.deck.length
    });

    socket.to(roomId).emit('card_drawn_sync', {
      senderSeatIndex: senderIdx,
      drawCount: drawnCards.length,
      deckCount: room.deck.length
    });

    room.turnSeatIndex = getNextTurn(senderIdx, 0, room.direction, room.players.length);
    notifyNextTurn(room);
  });

  // チョンボ発生（ドロー2完全リセット＆次回倍率2倍）
  socket.on('chombo_occurred', ({ roomId, offenderSeatIndex, reason }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.drawTwoStack = 0; // 確実にクリア
    room.multiplier *= 2;
    room.gameStarted = false;
    room.isGameOver = true;

    io.to(roomId).emit('chombo_synced', {
      offenderSeatIndex: offenderSeatIndex,
      offenderName: room.players[offenderSeatIndex] ? room.players[offenderSeatIndex].name : 'Player',
      reason: reason,
      newMultiplier: room.multiplier
    });
  });

  socket.on('request_next_round', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundNum++;
    startSyncGame(roomId);
  });

  socket.on('disconnect', () => {
    for (let rId in rooms) {
      const room = rooms[rId];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
        if (room.players.filter(p => !p.isCpu).length === 0) {
          delete rooms[rId];
        } else {
          io.to(rId).emit('room_detail_updated', {
            roomId: rId,
            players: room.players.filter(p => !p.isCpu).map(p => ({ id: p.id, name: p.name })),
            gameStarted: room.gameStarted
          });
        }
      }
    }
    io.emit('room_list_updated', getLobbyRoomList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[${FILE_VERSION}] Server running on port ${PORT}`));
