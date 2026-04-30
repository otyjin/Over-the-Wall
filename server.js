/**
 * Over the Wall v2.1 — Node.js WebSocket Server
 * ================================================
 * 실행: node server.js
 * 의존성: npm install
 *
 * 구조:
 *  - engine.js 를 require() 해서 게임 로직 재사용
 *  - 방(Room) 단위로 2인 매칭
 *  - 한 서버에서 여러 방 동시 운영 가능
 *  - 재접속 지원 (sessionId 기반)
 */

const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { newState, processAction } = require("./engine.js");

const PORT = process.env.PORT || 3000;

// ── HTTP 서버 — index.html / engine.js 정적 파일 제공 ──────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
};

const httpServer = http.createServer((req, res) => {
  // 기본 경로는 index.html
  let filePath = req.url === "/" ? "/index.html" : req.url;
  // 경로 탐색 공격 방지
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(__dirname, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const ext  = path.extname(fullPath);
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

// ── 방(Room) 관리 ──────────────────────────────────────────────────
/**
 * rooms: Map<roomId, Room>
 * Room: {
 *   id: string,
 *   state: GameState,
 *   players: { BLACK: Client|null, WHITE: Client|null },
 * }
 *
 * clients: Map<sessionId, Client>
 * Client: { ws, sessionId, roomId, role }
 */
const rooms   = new Map();
const clients = new Map();

function generateId(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function createRoom(roomId) {
  const room = {
    id:      roomId,
    state:   newState(),
    players: { BLACK: null, WHITE: null },
    restartVotes: { BLACK: false, WHITE: false },
  };
  rooms.set(roomId, room);
  console.log(`[Room] Created: ${roomId}`);
  return room;
}


function getRoomInfo(room) {
  return {
    roomId:      room.id,
    blackJoined: room.players.BLACK !== null,
    whiteJoined: room.players.WHITE !== null,
  };
}

// ── 메시지 전송 헬퍼 ────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  for (const role of ["BLACK", "WHITE"]) {
    const c = room.players[role];
    if (c) send(c.ws, obj);
  }
}

function broadcastState(room, extraMsg = null) {
  const payload = { type: "state", state: room.state };
  if (extraMsg) payload.state = { ...room.state, last_msg: extraMsg };
  broadcast(room, payload);
}

function resetRestartVotes(room) {
  room.restartVotes = { BLACK: false, WHITE: false };
}

// ── WebSocket 서버 ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const sessionId = generateId(12);
  console.log(`[WS] Connected: ${sessionId}`);

  // 클라이언트 등록 (방 배정 전)
  const client = { ws, sessionId, roomId: null, role: null };
  clients.set(sessionId, client);

  // 접속 즉시 sessionId 전달
  send(ws, { type: "connected", sessionId });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(client, msg);
  });

  ws.on("close", () => {
    console.log(`[WS] Disconnected: ${sessionId}`);
    handleDisconnect(client);
  });

  ws.on("error", (e) => console.error(`[WS] Error ${sessionId}:`, e.message));
});

// ── 메시지 처리 ────────────────────────────────────────────────────
function handleMessage(client, msg) {
  switch (msg.type) {

    // 새 방 만들기
    case "create_room": {
      const roomId = generateId(6);
      const room   = createRoom(roomId);
      const role   = "BLACK";   // 방을 만든 사람은 BLACK
      joinRoom(client, room, role);
      send(client.ws, {
        type:  "room_created",
        roomId, role,
        state: room.state,
      });
      console.log(`[Room] ${client.sessionId} created room ${roomId} as ${role}`);
      break;
    }

    // 방 참가 (roomId 지정)
    case "join_room": {
      const roomId = (msg.roomId || "").toUpperCase().trim();
      const room   = rooms.get(roomId);

      if (!room) {
        send(client.ws, { type: "error", msg: `Room "${roomId}" not found.` });
        return;
      }
      
      if (room.players.BLACK && room.players.WHITE) {
        resetRestartVotes(room);
        broadcast(room, { type: "game_start", state: room.state });
        console.log(`[Room] ${roomId} — Both players ready, game starting!`);
      }

      // 빈 역할 탐색
      let role = null;
      if (!room.players.BLACK) role = "BLACK";
      else if (!room.players.WHITE) role = "WHITE";

      if (!role) {
        send(client.ws, { type: "error", msg: "Room is full." });
        return;
      }

      joinRoom(client, room, role);
      send(client.ws, {
        type:  "room_joined",
        roomId, role,
        state: room.state,
      });
      console.log(`[Room] ${client.sessionId} joined room ${roomId} as ${role}`);

      // 2명 모두 입장 시 양쪽에 알림
      if (room.players.BLACK && room.players.WHITE) {
        broadcast(room, { type: "game_start", state: room.state });
        console.log(`[Room] ${roomId} — Both players ready, game starting!`);
      }
      break;
    }

    // 게임 액션 (이동, 벽 설치 등)
    case "action": {
      const room = getClientRoom(client);
      if (!room) { send(client.ws, { type: "error", msg: "Not in a room." }); return; }
      if (room.state.game_over) { send(client.ws, { type: "error", msg: "Game is over." }); return; }
      if (room.state.current_turn !== client.role) {
        send(client.ws, { type: "error", msg: "Not your turn." }); return;
      }

      try {
        const result = processAction(msg.action, room.state);
        if (!result.ok) {
          send(client.ws, { type: "error", msg: result.msg }); return;
        }
        resetRestartVotes(room);
        broadcastState(room);
      } catch (e) {
        console.error("[Action Error]", e);
        send(client.ws, { type: "error", msg: "Server action error." });
      }
      break;
    }

    // 재시작
    case "restart": {
      const room = getClientRoom(client);
      if (!room) return;
    
      // 게임이 끝났으면 즉시 재시작
      if (room.state.game_over) {
        room.state = newState();
        resetRestartVotes(room);
        broadcast(room, { type: "state", state: room.state });
        console.log(`[Room] ${room.id} restarted after game over`);
        break;
      }
    
      // 진행 중이면 동의 기록
      if (room.restartVotes[client.role]) {
        send(client.ws, {
          type: "restart_pending",
          msg: "You have already requested a restart. Waiting for opponent approval...",
          votes: room.restartVotes,
        });
        break;
      }
      room.restartVotes[client.role] = true;
    
      const otherRole = client.role === "BLACK" ? "WHITE" : "BLACK";
      const other = room.players[otherRole];
    
      // ★ 먼저 양쪽 동의 완료 여부 확인
      if (room.restartVotes.BLACK && room.restartVotes.WHITE) {
        room.state = newState();
        resetRestartVotes(room);
        broadcast(room, {
          type: "state",
          state: room.state,
        });
        console.log(`[Room] ${room.id} restarted by mutual agreement`);
        break;
      }
    
      // ★ 아직 한 명만 동의한 상태일 때만 알림 전송
      send(client.ws, {
        type: "restart_pending",
        msg: "Restart request sent. Waiting for opponent approval...",
        votes: room.restartVotes,
      });
    
      if (other) {
        send(other.ws, {
          type: "restart_requested",
          msg: `${client.role} requested a restart. Press restart to accept.`,
          votes: room.restartVotes,
        });
      }
    
      break;
    }


    // 재접속 (sessionId 재사용)
    case "reconnect": {
      const oldSession = msg.sessionId;
      const old = clients.get(oldSession);
      if (old && old.roomId) {
        const room = rooms.get(old.roomId);
        if (room) {
          // 기존 소켓 교체
          client.roomId = old.roomId;
          client.role   = old.role;
          room.players[old.role] = client;
          clients.delete(oldSession);
          clients.set(client.sessionId, client);
          send(client.ws, {
            type:  "reconnected",
            role:  client.role,
            roomId: room.id,
            state: room.state,
          });
          console.log(`[Room] ${client.sessionId} reconnected to ${room.id} as ${client.role}`);
          return;
        }
      }
      send(client.ws, { type: "error", msg: "Reconnect failed: session not found." });
      break;
    }

    default:
      send(client.ws, { type: "error", msg: `Unknown message type: ${msg.type}` });
  }
}

function joinRoom(client, room, role) {
  client.roomId = room.id;
  client.role   = role;
  room.players[role] = client;
}

function getClientRoom(client) {
  return client.roomId ? rooms.get(client.roomId) : null;
}

function handleDisconnect(client) {
  clients.delete(client.sessionId);
  const room = getClientRoom(client);
  if (!room) return;

  // 상대방에게 알림 (방은 유지 — 재접속 대기)
  const otherRole = client.role === "BLACK" ? "WHITE" : "BLACK";
  const other = room.players[otherRole];
  if (other) {
    send(other.ws, {
      type: "opponent_disconnected",
      msg:  `${client.role} disconnected. Waiting for reconnect...`,
    });
  }

  // 슬롯만 비움 (방은 남김)
  room.players[client.role] = null;

  // 양쪽 모두 없으면 방 정리
  if (!room.players.BLACK && !room.players.WHITE) {
    rooms.delete(room.id);
    console.log(`[Room] ${room.id} removed (empty)`);
  }
}

// ── 시작 ───────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  // 로컬 IP 출력
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  let localIp = "localhost";
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        localIp = iface.address; break;
      }
    }
  }

  console.log("=".repeat(52));
  console.log("   Over the Wall v2.1  —  WebSocket Server");
  console.log(`   Local  : http://${localIp}:${PORT}`);
  console.log(`   Local  : http://localhost:${PORT}`);
  console.log("   같은 Wi-Fi 기기에서 위 주소로 접속하세요.");
  console.log("   인터넷 배포 시 PORT 환경변수를 설정하세요.");
  console.log("=".repeat(52));
});
