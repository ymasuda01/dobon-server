// DOBON Realtime Game Server - Complete Sync Engine
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

// 部屋ごとの状態管理
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

// 次のターンの座席番号を計算（スキップやリバースに対応）
function getNextTurn(currentTurn, skips, direction, totalPlayers) {
  let next = (currentTurn + (1 + skips) * direction) % totalPlayers;
  while (next < 0) next += totalPlayers;
  return next;
}

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  // 1. 部屋への参加
  socket.on('join_room', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        deck: [],
        discardHistory: [],
        turnSeatIndex: 0,
        direction: 1, // 1:時計回り, -1:反時計回り
        drawTwoStack: 0,
        designatedSuit: null,
        gameStarted: false,
        roundNum: 1
      };
    }

    const room = rooms[roomId];
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({
        id: socket.id,
        name: playerName || `Player ${room.players.length + 1}`,
        hand: [],
        score: 0
      });
    }

    io.to(roomId).emit('room_updated', {
      players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length }))
    });
  });

  // 2. 対局開始（新ラウンド配牌）
  function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

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

    // 初期場札（8や2は避ける）
    let initCard = room.deck.pop();
    while (initCard.val === 8 || initCard.val === 2) {
      room.deck.unshift(initCard);
      initCard = room.deck.pop();
    }
    room.discardHistory.push(initCard);

    // 全員に同期送信
    room.players.forEach((p, idx) => {
      io.to(p.id).emit('game_started_sync', {
        myHand: p.hand,
        mySeatIndex: idx,
        players: room.players.map((other, oIdx) => ({
          seatIndex: oIdx,
          name: other.name,
          cardCount: other.hand.length,
          socketId: other.id
        })),
        initialCard: initCard,
        deckCount: room.deck.length,
        turnSeatIndex: room.turnSeatIndex,
        roundNum: room.roundNum
      });
    });
  }

  socket.on('start_online_game', ({ roomId }) => {
    startNewRound(roomId);
  });

  // 3. カードを出す（打牌の完全同期）
  socket.on('play_card', ({ roomId, card, designatedSuit, remainingCardCount, isLastDeclared }) => {
    const room = rooms[roomId];
    if (!room) return;

    const senderIdx = room.players.findIndex(p => p.id === socket.id);
    if (senderIdx === -1) return;

    // サーバー側で手札枚数を正確に更新（ラスト誤判定を防止）
    room.players[senderIdx].hand.length = remainingCardCount;
    room.discardHistory.push(card);
    room.designatedSuit = designatedSuit || null;

    // 特殊カード判定
    let skips = 0;
    if (card.val === 2) {
      room.drawTwoStack += 2;
    } else if (card.val === 9) {
      room.direction *= -1; // リバース
    } else if (card.val === 1) {
      skips = 1; // スキップ（2人対戦なら出した人の番が継続！）
    }

    // 勝利判定（手札が0枚になった時のみ勝敗確定！）
    if (remainingCardCount === 0) {
      room.gameStarted = false;
      io.to(roomId).emit('game_ended_sync', {
        winnerSeatIndex: senderIdx,
        winnerName: room.players[senderIdx].name,
        winningType: 'NORMAL WIN'
      });
      return;
    }

    // 次のターンの座席を決定
    room.turnSeatIndex = getNextTurn(senderIdx, skips, room.direction, room.players.length);

    // 相手全員に打牌と次の手番を通知
    socket.to(roomId).emit('card_played_sync', {
      senderSeatIndex: senderIdx,
      card: card,
      designatedSuit: designatedSuit,
      remainingCardCount: remainingCardCount,
      nextTurnSeatIndex: room.turnSeatIndex,
      drawTwoStack: room.drawTwoStack
    });
  });

  // 4. 山札を引く（ドローの同期）
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
      if (room.deck.length > 0) {
        drawnCards.push(room.deck.pop());
      }
    }

    // 引いた本人に本物のカードを渡す
    socket.emit('my_card_drawn', {
      cards: drawnCards,
      deckCount: room.deck.length
    });

    // 次のターンへ
    room.turnSeatIndex = getNextTurn(senderIdx, 0, room.direction, room.players.length);

    // 相手には枚数と次の手番を通知
    socket.to(roomId).emit('card_drawn_sync', {
      senderSeatIndex: senderIdx,
      drawCount: drawnCards.length,
      deckCount: room.deck.length,
      nextTurnSeatIndex: room.turnSeatIndex
    });
  });

  // 5. ネクストラウンド要求（全員を次のラウンドへ移行）
  socket.on('request_next_round', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundNum++;
    startNewRound(roomId);
  });

  socket.on('disconnect', () => {
    console.log('切断:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
