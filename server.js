// DOBON Realtime Game Server (Room & Deal Sync)
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

// 部屋ごとのゲーム状態を保持
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

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  // 1. 部屋に入る（room_id で合流）
  socket.on('join_room', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        deck: [],
        discardHistory: [],
        turnIndex: 0,
        gameStarted: false
      };
    }

    const room = rooms[roomId];
    // すでに参加していなければ追加
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({
        id: socket.id,
        name: playerName || `Player ${room.players.length + 1}`,
        hand: [],
        score: 0
      });
    }

    console.log(`部屋 [${roomId}] 参加人数: ${room.players.length}`);

    // 参加者全員にメンバー更新を通知
    io.to(roomId).emit('room_updated', {
      players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length }))
    });
  });

  // 2. ホストが「対局開始」を押したとき（全員に同期配牌）
  socket.on('start_online_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    room.deck = createShuffledDeck();
    room.discardHistory = [];
    room.turnIndex = 0;
    room.gameStarted = true;

    // 各プレイヤーに5枚ずつ配る
    room.players.forEach(p => {
      p.hand = room.deck.splice(0, 5);
    });

    // 初期場札（8や2は避ける）
    let initialCard = room.deck.pop();
    while (initialCard.val === 8 || initialCard.val === 2) {
      room.deck.unshift(initialCard);
      initialCard = room.deck.pop();
    }
    room.discardHistory.push(initialCard);

    // 各プレイヤーに「自分の手札」と「全体の情報」を個別に送信
    room.players.forEach((p, idx) => {
      io.to(p.id).emit('game_started_sync', {
        myHand: p.hand,
        mySeatIndex: idx,
        players: room.players.map((other, oIdx) => ({
          seatIndex: oIdx,
          name: other.name,
          cardCount: other.hand.length
        })),
        initialCard: initialCard,
        deckCount: room.deck.length,
        turnSeatIndex: 0
      });
    });
  });
  // 3. 誰かがカードを出したとき（相手の画面に中継）
  socket.on('play_card', ({ roomId, card, designatedSuit }) => {
    socket.to(roomId).emit('card_played_sync', {
      senderId: socket.id,
      card: card,
      designatedSuit: designatedSuit
    });
  });

  // 4. 誰かが山札を引いたとき（本物のカードを渡す）
  socket.on('draw_card', ({ roomId, count }) => {
    const room = rooms[roomId];
    if (!room) return;

    const drawCount = count || 1;
    const drawnCards = [];

    for (let i = 0; i < drawCount; i++) {
      // 山札が切れたら捨て札をシャッフルして補充
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

    // 引いた本人には「本物のカードデータ」を届ける！
    socket.emit('my_card_drawn', {
      cards: drawnCards,
      deckCount: room.deck.length
    });

    // 部屋の相手には「引いた枚数」だけ通知してターンを回す！
    socket.to(roomId).emit('card_drawn_sync', {
      drawCount: drawnCards.length,
      deckCount: room.deck.length
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
