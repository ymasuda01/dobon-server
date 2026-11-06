/**
 * DOBON Realtime Game Server
 * Game Version: 2026.00.004
 * File Version: server.js v0.1.3
 * Features: Quick Match, Room Search/Sort, Spectating, Vote Abort/Expand,
 *           Lowest-Score CPU Replacement, Disconnect/Timeout Auto-CPU Handling.
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

const GAME_VERSION = "2026.00.004";
const FILE_VERSION = "server.js v0.1.3";

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

// 部屋一覧の取得（優先度ソート ＆ フィルター対応）
function getLobbyRoomList() {
  const list = [];
  for (let rId in rooms) {
    const r = rooms[rId];
    const humanPlayers = r.players.filter(p => !p.isCpu);
    const spectatorCount = r.spectators ? r.spectators.length : 0;
    const isFull = humanPlayers.length >= r.targetPlayerCount;
    
    // 優先度判定 (1: 空き未開始/合間, 2: 対戦中, 3: 観戦あり, 4: 満員)
    let priority = 4;
    if (isFull) {
      priority = 4;
    } else if (!r.gameStarted) {
      priority = 1;
    } else if (spectatorCount > 0) {
      priority = 3;
    } else {
      priority = 2;
    }

    list.push({
      id: rId,
      name: r.roomName,
      isPrivate: !!r.isPrivate,
      playerCount: humanPlayers.length,
      maxPlayers: r.targetPlayerCount,
      originalCapacity: r.originalCapacity,
      spectatorCount: spectatorCount,
      isPlaying: r.gameStarted,
      timeLimit: r.timeLimit || 25,
      priority: priority
    });
  }

  // ソート：優先度順（昇順）、同じなら作成順
  list.sort((a, b) => a.priority - b.priority);
  return list;
}

// サーバー側CPU思考・打牌
function handleServerCpuTurn(room) {
  if (!room || !room.gameStarted || room.isGameOver || room.isNakiPaused) return;
  const currentSeat = room.turnSeatIndex;
  const player = room.players[currentSeat];
  if (!player || !player.isCpu) return;

  clearTimeout(room.turnTimer);

  room.turnTimer = setTimeout(() => {
    if (!room.gameStarted || room.turnSeatIndex !== currentSeat || room.isGameOver || room.isNakiPaused) return;

    const top = room.discardHistory[room.discardHistory.length - 1];

    if (room.drawTwoStack > 0) {
      const idx2 = player.hand.findIndex(c => c && c.val === 2);
      if (idx2 !== -1) {
        const card2 = player.hand.splice(idx2, 1)[0];
        room.drawTwoStack += 2;
        room.discardHistory.push(card2);
        
        io.to(room.roomId).emit('card_played_sync', {
          senderSeatIndex: currentSeat,
          card: card2,
          designatedSuit: null,
          remainingCardCount: player.hand.length,
          drawTwoStack: room.drawTwoStack
        });

        if (player.hand.length === 0) {
          endGameByWin(room, currentSeat, 'NORMAL WIN');
          return;
        }

        room.turnSeatIndex = getNextTurn(currentSeat, 0, room.direction, room.players.length);
        notifyNextTurn(room);
        return;
      } else {
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
        drawTwoStack: room.drawTwoStack
      });

      if (player.hand.length === 0) {
        endGameByWin(room, currentSeat, 'NORMAL WIN');
        return;
      }

      room.turnSeatIndex = getNextTurn(currentSeat, skips, room.direction, room.players.length);
      notifyNextTurn(room);
    } else {
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
  }, 1600);
}

// 手番の更新とタイマー監視（1分放置＝自動CPU化）
function notifyNextTurn(room) {
  clearTimeout(room.turnTimer);

  io.to(room.roomId).emit('turn_changed_sync', {
    turnSeatIndex: room.turnSeatIndex,
    direction: room.direction
  });

  const curPlayer = room.players[room.turnSeatIndex];
  if (!curPlayer) return;

  if (curPlayer.isCpu) {
    handleServerCpuTurn(room);
  } else {
    // 人間プレイヤーの放置監視（上限最大60秒）
    const limitMs = Math.min(room.timeLimit || 25, 60) * 1000;
    room.turnTimer = setTimeout(() => {
      if (!room.gameStarted || room.isGameOver || room.isNakiPaused) return;
      if (room.turnSeatIndex === curPlayer.seatIndex && !curPlayer.isCpu) {
        console.log(`[放置タイムアウト] ${curPlayer.name} をCPU代行へ切り替えます`);
        curPlayer.isCpu = true;
        curPlayer.name = `${curPlayer.name} (CPU代行)`;
        io.to(room.roomId).emit('player_turned_cpu', {
          seatIndex: curPlayer.seatIndex,
          newName: curPlayer.name
        });
        handleServerCpuTurn(room);
      }
    }, limitMs);
  }
}

function recordRoomHistory(room, type, winnerName, loserName, points) {
  if (!room.history) room.history = [];
  room.history.push({
    round: room.roundNum,
    type: type,
    winner: winnerName,
    loser: loserName || '全員',
    points: points,
    scoresAfter: room.players.map(p => ({ name: p.name, score: p.score }))
  });
}

function endGameByWin(room, winnerSeat, winType) {
  clearTimeout(room.turnTimer);
  room.gameStarted = false;
  room.isGameOver = true;
  room.drawTwoStack = 0;
  room.nextRoundStarter = winnerSeat;

  const winner = room.players[winnerSeat];
  recordRoomHistory(room, winType, winner ? winner.name : 'Winner', null, 0);

  // ラウンド終了後の卓人数管理（拡張参加者が抜けていたら元規定人数に戻す）
  cleanupRoomCapacity(room);

  // 待機観戦者をゲーム参加へ昇格（スコア最低CPUから入れ替え）
  promoteSpectatorsToPlayers(room);

  io.to(room.roomId).emit('game_ended_sync', {
    winnerSeatIndex: winnerSeat,
    winnerName: winner ? winner.name : 'Winner',
    winningType: winType,
    roomHistory: room.history
  });

  io.emit('room_list_updated', getLobbyRoomList());
}

// 拡張卓の人数戻し
function cleanupRoomCapacity(room) {
  const currentHumans = room.players.filter(p => !p.isCpu).length;
  if (room.targetPlayerCount > room.originalCapacity && currentHumans <= room.originalCapacity) {
    room.targetPlayerCount = room.originalCapacity;
    // 規定数を超える余分なCPUを削除
    while (room.players.length > room.targetPlayerCount && room.players.some(p => p.isCpu)) {
      const cpuIdx = room.players.findLastIndex(p => p.isCpu);
      if (cpuIdx !== -1) room.players.splice(cpuIdx, 1);
    }
  }
}

// スコア最低CPUから人間へ入れ替え
function promoteSpectatorsToPlayers(room) {
  if (!room.spectators || room.spectators.length === 0) return;

  while (room.spectators.length > 0) {
    const nextSpectator = room.spectators.shift();
    // 枠に空きがある場合
    if (room.players.length < room.targetPlayerCount) {
      room.players.push({
        id: nextSpectator.id,
        socketId: nextSpectator.socketId,
        name: nextSpectator.name,
        hand: [],
        score: 0,
        isCpu: false
      });
      continue;
    }
    // 枠がいっぱいでCPUがいる場合：スコアが最も低いCPUを探して交代
    const cpuPlayers = room.players.filter(p => p.isCpu);
    if (cpuPlayers.length > 0) {
      cpuPlayers.sort((a, b) => a.score - b.score);
      const lowestCpu = cpuPlayers[0];
      const targetIdx = room.players.findIndex(p => p === lowestCpu);
      if (targetIdx !== -1) {
        room.players[targetIdx] = {
          id: nextSpectator.id,
          socketId: nextSpectator.socketId,
          name: nextSpectator.name,
          hand: [],
          score: 0,
          isCpu: false
        };
      }
    } else {
      // 交代できるCPUも空きもない場合は観戦者に戻す
      room.spectators.unshift(nextSpectator);
      break;
    }
  }
}

// 新ラウンドの同期開始
function startSyncGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearTimeout(room.turnTimer);

  // 不足分をCPUで補完
  const humanPlayers = room.players.filter(p => !p.isCpu);
  room.players = [...humanPlayers];
  const neededCpu = Math.max(0, room.targetPlayerCount - room.players.length);

  for (let i = 1; i <= neededCpu; i++) {
    room.players.push({
      id: `cpu_${Date.now()}_${i}`,
      name: `CPU ${i}`,
      hand: [],
      score: 0,
      isCpu: true
    });
  }

  // 座席インデックスの付与
  room.players.forEach((p, idx) => {
    p.seatIndex = idx;
  });

  room.deck = createShuffledDeck();
  room.discardHistory = [];
  room.direction = 1;
  room.drawTwoStack = 0;
  room.designatedSuit = null;
  room.gameStarted = true;
  room.isGameOver = false;
  room.isNakiPaused = false;
  room.abortVotes = null;

  room.turnSeatIndex = (room.nextRoundStarter !== undefined) ? room.nextRoundStarter : 0;
  if (room.turnSeatIndex >= room.players.length) room.turnSeatIndex = 0;

  room.players.forEach(p => {
    p.hand = room.deck.splice(0, 5);
  });

  let initCard = room.deck.pop();
  while (initCard.val === 8 || initCard.val === 2) {
    deck.unshift(initCard);
    initCard = room.deck.pop();
  }
  room.discardHistory.push(initCard);

  // プレイヤー全員に送信
  room.players.forEach((p, idx) => {
    if (!p.isCpu) {
      io.to(p.id).emit('game_started_sync', {
        myHand: p.hand,
        mySeatIndex: idx,
        isSpectator: false,
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
        multiplier: room.multiplier,
        timeLimit: room.timeLimit,
        roomHistory: room.history || []
      });
    }
  });

  // 観戦者全員に送信
  if (room.spectators) {
    room.spectators.forEach(spec => {
      io.to(spec.id).emit('game_started_sync', {
        myHand: [],
        mySeatIndex: -1,
        isSpectator: true,
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
        multiplier: room.multiplier,
        timeLimit: room.timeLimit,
        roomHistory: room.history || []
      });
    });
  }

  io.emit('room_list_updated', getLobbyRoomList());
  notifyNextTurn(room);
}

io.on('connection', (socket) => {
  // ロビー情報要求
  socket.on('request_room_list', () => {
    socket.emit('room_list_updated', getLobbyRoomList());
  });

  // クイックマッチ（自動マッチング）
  socket.on('quick_match', ({ playerName }) => {
    let bestRoom = null;
    const sorted = getLobbyRoomList();

    // 1. 空いているオープン待機部屋
    bestRoom = sorted.find(r => !r.isPrivate && !r.isPlaying && r.playerCount < r.maxPlayers);
    // 2. 空きのある対戦中オープン部屋
    if (!bestRoom) {
      bestRoom = sorted.find(r => !r.isPrivate && r.isPlaying && r.playerCount < r.maxPlayers);
    }

    if (bestRoom) {
      socket.emit('quick_match_found', { roomId: bestRoom.id });
    } else {
      // 部屋がなければ4人卓のオープン部屋を自動作成
      const newRoomId = String(Math.floor(Math.random() * 9000 + 1000));
      socket.emit('quick_match_found', { roomId: newRoomId, isNew: true });
    }
  });

  // 部屋参加／作成
  socket.on('join_or_create_room', ({ roomId, roomName, playerName, targetPlayerCount, timeLimit, isPrivate, password, asSpectatorOnly }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      const cap = Math.min(Math.max(parseInt(targetPlayerCount) || 4, 2), 6);
      rooms[roomId] = {
        roomId: roomId,
        roomName: roomName || `Table ${roomId}`,
        isPrivate: !!isPrivate,
        password: password || '',
        targetPlayerCount: cap,
        originalCapacity: cap,
        timeLimit: parseInt(timeLimit) || 25,
        players: [],
        spectators: [],
        deck: [],
        discardHistory: [],
        turnSeatIndex: 0,
        nextRoundStarter: 0,
        direction: 1,
        drawTwoStack: 0,
        designatedSuit: null,
        gameStarted: false,
        isGameOver: false,
        roundNum: 1,
        multiplier: 1,
        history: [],
        isNakiPaused: false
      };
    }

    const room = rooms[roomId];

    // パスワード照合
    if (room.isPrivate && room.password && room.password !== password) {
      socket.emit('room_join_error', { message: 'パスワードが違います' });
      socket.leave(roomId);
      return;
    }

    // 既存参加者の再接続チェック
    const existingIdx = room.players.findIndex(p => p.id === socket.id || (p.name === playerName && !p.isCpu));
    if (existingIdx !== -1) {
      room.players[existingIdx].id = socket.id;
      room.players[existingIdx].name = playerName;
      room.players[existingIdx].isDisconnected = false;
    } else if (asSpectatorOnly || room.gameStarted) {
      // 観戦モード参加（対局中または観戦希望）
      if (!room.spectators.find(s => s.id === socket.id)) {
        room.spectators.push({ id: socket.id, name: playerName, wantsToPlay: !asSpectatorOnly });
      }
      socket.emit('entered_as_spectator', {
        roomId: roomId,
        isPlaying: room.gameStarted
      });

      // 対局中かつ参戦希望の場合：進行中ラウンドの「流し投票」を全員へ通知
      if (room.gameStarted && !asSpectatorOnly) {
        room.abortVotes = new Set();
        io.to(roomId).emit('prompt_abort_round', {
          applicantName: playerName,
          neededVotes: room.players.filter(p => !p.isCpu).length
        });
      }
    } else {
      // 規定人数内での直接参加
      if (room.players.filter(p => !p.isCpu).length < 6) {
        room.players.push({
          id: socket.id,
          name: playerName,
          hand: [],
          score: 0,
          isCpu: false
        });
      }
    }

    // 卓人数の拡張チェック（人間プレイヤーが規定人数を超え、6人以下の場合の全会一致投票）
    const humanCount = room.players.filter(p => !p.isCpu).length;
    if (humanCount > room.targetPlayerCount && humanCount <= 6 && !room.gameStarted) {
      io.to(roomId).emit('prompt_expand_table', {
        newCount: humanCount,
        neededVotes: humanCount - 1
      });
    }

    io.to(roomId).emit('room_detail_updated', {
      roomId: roomId,
      roomName: room.roomName,
      targetPlayerCount: room.targetPlayerCount,
      players: room.players.filter(p => !p.isCpu).map(p => ({ id: p.id, name: p.name })),
      spectators: room.spectators.map(s => ({ id: s.id, name: s.name })),
      gameStarted: room.gameStarted
    });

    io.emit('room_list_updated', getLobbyRoomList());
  });

  // 流し（ノーゲーム）投票
  socket.on('vote_abort_round', ({ roomId, agree }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || !room.abortVotes) return;

    if (!agree) {
      // 1人でも拒否なら否決・即終了
      room.abortVotes = null;
      io.to(roomId).emit('abort_round_result', { agreed: false });
      return;
    }

    room.abortVotes.add(socket.id);
    const needed = room.players.filter(p => !p.isCpu).length;
    if (room.abortVotes.size >= needed) {
      // 全員一致で可決！現在のラウンドをノーゲームにして合流
      room.abortVotes = null;
      clearTimeout(room.turnTimer);
      promoteSpectatorsToPlayers(room);
      io.to(roomId).emit('abort_round_result', { agreed: true });
      startSyncGame(roomId);
    }
  });

  // 卓拡張投票
  socket.on('vote_expand_table', ({ roomId, agree }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (agree) {
      room.targetPlayerCount = Math.min(room.targetPlayerCount + 1, 6);
      io.to(roomId).emit('table_expanded_confirmed', { newCapacity: room.targetPlayerCount });
      io.emit('room_list_updated', getLobbyRoomList());
    }
  });

  // 対局開始
  socket.on('start_online_game', ({ roomId }) => {
    startSyncGame(roomId);
  });

  // 打牌同期
  socket.on('play_card', ({ roomId, card, designatedSuit, remainingCardCount }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.isGameOver || room.isNakiPaused) return;

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
      drawTwoStack: room.drawTwoStack
    });

    if (remainingCardCount === 0) {
      endGameByWin(room, senderIdx, 'NORMAL WIN');
      return;
    }

    room.turnSeatIndex = getNextTurn(senderIdx, skips, room.direction, room.players.length);
    notifyNextTurn(room);
  });

  // ドロー同期
  socket.on('draw_card', ({ roomId, count }) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.isGameOver || room.isNakiPaused) return;

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

  // 鳴き一時停止
  socket.on('pause_for_naki', ({ roomId, nakiType }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.isNakiPaused = true;
    clearTimeout(room.turnTimer);
    const actorIdx = room.players.findIndex(p => p.id === socket.id);
    socket.to(roomId).emit('game_paused_by_naki', {
      actorName: room.players[actorIdx] ? room.players[actorIdx].name : '相手',
      nakiType: nakiType
    });
  });

  socket.on('resume_from_naki', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.isNakiPaused = false;
    socket.to(roomId).emit('game_resumed_from_naki');
    notifyNextTurn(room);
  });

  // ドボン成立同期
  socket.on('dobon_declared_sync', ({ roomId, winnerSeatIndex, loserSeatIndex, winType, points, loserHandCount }) => {
    const room = rooms[roomId];
    if (!room) return;

    clearTimeout(room.turnTimer);
    room.gameStarted = false;
    room.isGameOver = true;
    room.drawTwoStack = 0;
    room.nextRoundStarter = winnerSeatIndex;

    const winner = room.players[winnerSeatIndex];
    const loser = room.players[loserSeatIndex];
    if (winner && loser) {
      winner.score += points;
      loser.score -= points;
      recordRoomHistory(room, winType, winner.name, loser.name, points);
    }

    cleanupRoomCapacity(room);
    promoteSpectatorsToPlayers(room);

    io.to(roomId).emit('dobon_result_broadcast', {
      winnerSeatIndex: winnerSeatIndex,
      loserSeatIndex: loserSeatIndex,
      winnerName: winner ? winner.name : 'Winner',
      loserName: loser ? loser.name : 'Loser',
      winType: winType,
      points: points,
      loserHandCount: loserHandCount,
      roomHistory: room.history
    });

    io.emit('room_list_updated', getLobbyRoomList());
  });

  // チョンボ同期
  socket.on('chombo_occurred', ({ roomId, offenderSeatIndex, reason }) => {
    const room = rooms[roomId];
    if (!room) return;
    clearTimeout(room.turnTimer);
    room.drawTwoStack = 0;
    room.multiplier *= 2;
    room.gameStarted = false;
    room.isGameOver = true;
    room.nextRoundStarter = offenderSeatIndex;

    recordRoomHistory(room, 'CHOMBO', 'なし', room.players[offenderSeatIndex] ? room.players[offenderSeatIndex].name : 'Player', 0);

    cleanupRoomCapacity(room);
    promoteSpectatorsToPlayers(room);

    io.to(roomId).emit('chombo_synced', {
      offenderSeatIndex: offenderSeatIndex,
      offenderName: room.players[offenderSeatIndex] ? room.players[offenderSeatIndex].name : 'Player',
      reason: reason,
      newMultiplier: room.multiplier,
      roomHistory: room.history
    });

    io.emit('room_list_updated', getLobbyRoomList());
  });

  socket.on('request_next_round', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.roundNum++;
    startSyncGame(roomId);
  });

  // 切断処理（プレイ中は即CPU代行、ペナルティなし）
  socket.on('disconnect', () => {
    for (let rId in rooms) {
      const room = rooms[rId];
      // 観戦者の切断
      if (room.spectators) {
        room.spectators = room.spectators.filter(s => s.id !== socket.id);
      }
      // プレイヤーの切断
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        const p = room.players[pIdx];
        if (room.gameStarted && !room.isGameOver) {
          // 対局中：即座にCPUへ交代してラウンド続行
          console.log(`[離脱] ${p.name} が対戦中に離脱したためCPUへ交代`);
          p.isCpu = true;
          p.name = `${p.name} (CPU)`;
          io.to(rId).emit('player_turned_cpu', {
            seatIndex: pIdx,
            newName: p.name
          });
          // 離脱した人の手番ならそのままCPU思考発火
          if (room.turnSeatIndex === pIdx) {
            handleServerCpuTurn(room);
          }
        } else {
          // 待機中：部屋から削除
          room.players.splice(pIdx, 1);
        }

        // 人間がゼロになったら部屋削除
        if (room.players.filter(pl => !pl.isCpu).length === 0 && (!room.spectators || room.spectators.length === 0)) {
          clearTimeout(room.turnTimer);
          delete rooms[rId];
        }
      }
    }
    io.emit('room_list_updated', getLobbyRoomList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[${FILE_VERSION}] Server running on port ${PORT}`));
