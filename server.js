// DOBON Realtime Game Server (Lobby, Auto-CPU & Complete Sync Engine)
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

app.get('/', (req, res) => {
  res.send('DOBON Server is running successfully!');
});

// 部屋データ管理
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

// ロビー用の部屋一覧データを生成
function getLobbyRoomList() {
  const list = [];
  for (let rId in rooms) {
    const r = rooms[rId];
    // 接続中の人間プレイヤー数をカウント
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

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  // ロビーの部屋一覧を要求されたとき
  socket.on('request_room_list', () => {
    socket.emit('room_list_updated', getLobbyRoomList());
  });

  // 1. 部屋の作成または入室
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
        roundNum: 1,
        multiplier: 1
      };
    }

    const room = rooms[roomId];

    // ★ゾンビ防止：同じソケットや同名プレイヤーがいたら更新、なければ追加★
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

    // 全体のロビー一覧も更新
    io.emit('room_list_updated', getLobbyRoomList());
  });

  // 2. 対局開始（不足人数にCPUを自動追加して同期スタート）
  function startSyncGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // ★不足分をCPUで自動補完（例: 2人ならCPUを2人足して4人にする）★
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

    // 5枚ずつ配る
    room.players.forEach(p => {
      p.hand = room.deck.splice(0, 5);
    });

    // 初期場札
    let initCard = room.deck.pop();
    while (initCard.val === 8 || initCard.val === 2) {
      room.deck.unshift(initCard);
      initCard = room.deck.pop();
    }
    room.discardHistory.push(initCard);

    // 全員に同期送信
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
  }

  socket.on('start_online_game', ({ roomId }) => {
    startSyncGame(roomId);
  });

  // 3. カードを出す（8の二重送信防止 ＆ 手番同期）
  socket.on('play_card', ({ roomId, card, designatedSuit, remainingCardCount }) => {
    const room = rooms[roomId];
    if (!room) return;

    const senderIdx = room.players.findIndex(p => p.id === socket.id);
    if (senderIdx === -1) return;

    room.players[senderIdx].hand.length = remainingCardCount;
    room.discardHistory.push(card);
    room.designatedSuit = designatedSuit || null;

    let skips = 0;
    if (card.val === 2) room.drawTwoStack += 2;
    else if (card.val === 9) room.direction *= -1;
    else if (card.val === 1) skips = 1;

    // 通常上がり勝利判定
    if (remainingCardCount === 0) {
      room.gameStarted = false;
      io.to(roomId).emit('game_ended_sync', {
        winnerSeatIndex: senderIdx,
        winnerName: room.players[senderIdx].name,
        winningType: 'NORMAL WIN'
      });
      return;
    }

    room.turnSeatIndex = getNextTurn(senderIdx, skips, room.direction, room.players.length);

    // 部屋の他プレイヤーへ同期
    socket.to(roomId).emit('card_played_sync', {
      senderSeatIndex: senderIdx,
      card: card,
      designatedSuit: designatedSuit,
      remainingCardCount: remainingCardCount,
      nextTurnSeatIndex: room.turnSeatIndex,
      drawTwoStack: room.drawTwoStack
    });
  });

  // 4. 山札を引く
  socket.on('draw_card', ({ roomId, count }) => {
    const room = rooms[roomId];
    if (!room) return;

    const senderIdx = room.players.findIndex(p => p.id === socket.id);
    if (senderIdx === -1) return;

    const drawCount = count || (room.drawTwoStack > 0 ? room.drawTwoStack : 1);
    room.drawTwoStack = 0;
    const drawnCards = [];

    for (let i = 0; i < drawCount; i++) {
      if (room.deck.length === 0 && room.discardHistory.length > 1) {
        const top = room.discardHistory.pop();
        room.deck = room.discardHistory.slice();
        room.discardHistory = [top];
        for (let j = room.deck.length - 1; j > 0; j--) {
          const r = Math.floor(Math.random() * (j + 1));
          [room.deck[j], room.deck[r]] = [room.deck[r], room.deck[j]];
        }
      }
      if (room.deck.length > 0) drawnCards.push(room.deck.pop());
    }

    socket.emit('my_card_drawn', {
      cards: drawnCards,
      deckCount: room.deck.length
    });

    room.turnSeatIndex = getNextTurn(senderIdx, 0, room.direction, room.players.length);

    socket.to(roomId).emit('card_drawn_sync', {
      senderSeatIndex: senderIdx,
      drawCount: drawnCards.length,
      deckCount: room.deck.length,
      nextTurnSeatIndex: room.turnSeatIndex
    });
  });

  // 5. チョンボ発生（勝者なし・全員に×2倍を同期通知）
  socket.on('chombo_occurred', ({ roomId, offenderSeatIndex, reason }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.multiplier *= 2;
    room.gameStarted = false;

    io.to(roomId).emit('chombo_synced', {
      offenderSeatIndex: offenderSeatIndex,
      offenderName: room.players[offenderSeatIndex] ? room.players[offenderSeatIndex].name : 'Player',
      reason: reason,
      newMultiplier: room.multiplier
    });
  });

  // 6. 次のラウンドへ移行
  socket.on('request_next_round', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundNum++;
    startSyncGame(roomId);
  });

  // ★切断時のゾンビ完全消去★
  socket.on('disconnect', () => {
    for (let rId in rooms) {
      const room = rooms[rId];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
        if (room.players.filter(p => !p.isCpu).length === 0) {
          delete rooms[rId]; // 人間がゼロになったら部屋削除
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
