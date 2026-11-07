/**
 * DOBON Realtime Game Server
 * Game Version: 2026.00.006
 * File Version: server.js v0.1.4
 * Updates: Direction fixed to Counter-Clockwise (-1), Sync Animation Timing,
 *          Winner-First Start, Room History, Auto-CPU & Reconnection Handling.
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

const GAME_VERSION = "2026.00.0
