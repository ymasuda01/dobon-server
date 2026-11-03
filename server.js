// DOBON Realtime Game Server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // どの端末・アプリからの接続も許可
    methods: ["GET", "POST"]
  }
});

// サーバー生存確認用のURL
app.get('/', (req, res) => {
  res.send('DOBON Server is running successfully!');
});

// 通信の受付（クライアントが接続してきたとき）
io.on('connection', (socket) => {
  console.log('プレイヤーが接続しました: ' + socket.id);

  // 動作確認テスト用：メッセージを受信したら全員に送り返す
  socket.on('test_ping', (data) => {
    console.log('受信データ:', data);
    io.emit('test_pong', {
      sender: socket.id,
      message: data.message,
      time: new Date().toLocaleTimeString()
    });
  });

  socket.on('disconnect', () => {
    console.log('プレイヤーが切断しました: ' + socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});