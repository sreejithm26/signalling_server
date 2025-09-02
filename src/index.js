const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

// Optional Redis for horizontal scaling
let Redis = null;
try {
  // Lazy require so local dev without Redis still works
  // eslint-disable-next-line global-require
  Redis = require('ioredis');
} catch (_) {}

const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const REQUEUE_ON_PARTNER_LEAVE = (process.env.REQUEUE_ON_PARTNER_LEAVE || 'true') === 'true';
const REDIS_URL = process.env.REDIS_URL || '';
const INSTANCE_ID = process.env.INSTANCE_ID || `inst-${crypto.randomUUID()}`;

// Rate limiting config (per-connection)
const MAX_MSG_PER_SECOND = parseInt(process.env.MAX_MSG_PER_SECOND || '40', 10);

// Registries
const clients = new Map(); // clientId -> { id, ws, userId?, partnerId?, roomId?, isAvailable, rate?, lastSeen? }
const waitingQueue = []; // In-memory FIFO (fallback when Redis not configured)

// Redis setup (optional)
let redis = null;
let redisSub = null;
const SIGNAL_CHANNEL = 'webrtc:signal';
const WAITING_LIST = 'webrtc:waiting';

if (REDIS_URL && Redis) {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

  redisSub.subscribe(SIGNAL_CHANNEL, (err) => {
    if (err) console.error('Redis subscribe error:', err);
  });

  redisSub.on('message', (_channel, raw) => {
    try {
      const msg = JSON.parse(raw);
      const targetId = msg.to;
      const payload = msg.payload;
      const client = clients.get(targetId);
      if (client) {
        sendToClient(client, payload);
      }
    } catch (e) {
      console.error('Bad pubsub message:', e);
    }
  });

  console.log(`Redis enabled. Instance ${INSTANCE_ID}`);
} else {
  if (REDIS_URL) {
    console.warn('REDIS_URL provided but ioredis not installed. Skipping Redis.');
  } else {
    console.log('Redis not configured; running single-instance mode.');
  }
}

const app = express();
app.use(express.json());

app.get('/healthz', async (_req, res) => {
  const health = { ok: true, uptime: process.uptime(), clients: clients.size, instanceId: INSTANCE_ID };
  if (redis) {
    try {
      const pong = await redis.ping();
      health.redis = pong === 'PONG';
    } catch (_) {
      health.redis = false;
    }
  }
  res.status(200).json(health);
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('WebRTC Signaling Server (Node.js)');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Heartbeat for dead connection cleanup
function setupHeartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN.length) {
    const origin = req.headers.origin || '';
    if (!ALLOWED_ORIGIN.includes(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  setupHeartbeat(ws);

  const id = crypto.randomUUID();
  const client = { id, ws, userId: null, partnerId: null, roomId: null, isAvailable: false, rate: { ts: 0, count: 0 } };
  clients.set(id, client);

  console.log(`Client connected: ${id} on ${INSTANCE_ID}`);

  // Send ready message with client ID
  sendToClient(client, { type: 'ready', clientId: id });

  ws.on('message', (data) => {
    if (!rateLimitOK(client)) {
      sendToClient(client, { type: 'error', code: 'RATE_LIMIT', message: 'Too many messages' });
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      handleMessage(client, message);
    } catch (error) {
      console.error('Invalid message format:', error);
      sendToClient(client, { type: 'error', code: 'INVALID_FORMAT', message: 'Invalid message format' });
    }
  });

  ws.on('close', () => {
    handleClientDisconnect(client);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    handleClientDisconnect(client);
  });
});

function rateLimitOK(client) {
  const now = Date.now();
  if (now - client.rate.ts > 1000) {
    client.rate.ts = now;
    client.rate.count = 1;
    return true;
  }
  client.rate.count += 1;
  return client.rate.count <= MAX_MSG_PER_SECOND;
}

function handleMessage(client, message) {
  console.log(`Message from ${client.id}:`, message.type);

  switch (message.type) {
    case 'auth':
      handleAuth(client, message);
      break;
    case 'available':
      handleAvailable(client);
      break;
    case 'offer':
      handleOffer(client, message);
      break;
    case 'answer':
      handleAnswer(client, message);
      break;
    case 'ice':
      handleIce(client, message);
      break;
    case 'next':
      handleNext(client);
      break;
    case 'leave':
      handleLeave(client);
      break;
    case 'ping':
      sendToClient(client, { type: 'pong' });
      break;
    default:
      sendToClient(client, { type: 'error', code: 'UNKNOWN_TYPE', message: 'Unknown message type' });
  }
}

function handleAuth(client, message) {
  client.userId = message.userId || null;
  client.lastSeen = Date.now();
  console.log(`Client ${client.id} authenticated as ${client.userId || 'anonymous'}`);
}

async function handleAvailable(client) {
  if (client.partnerId) {
    sendToClient(client, { type: 'error', code: 'ALREADY_PAIRED', message: 'Already paired with a partner' });
    return;
  }

  client.isAvailable = true;

  if (redis) {
    try {
      // Try to find a partner globally
      const partnerId = await tryMatchGlobal(client.id);
      if (partnerId) {
        const partnerLocal = clients.get(partnerId);
        if (partnerLocal) {
          createRoom(client, partnerLocal);
        } else {
          // Partner on another instance; notify both via pubsub
          const roomId = crypto.randomUUID();
          client.partnerId = partnerId;
          client.roomId = roomId;
          client.isAvailable = false;
          sendToClient(client, { type: 'matched', roomId, partnerId });

          await publishSignal(partnerId, { type: 'matched', roomId, partnerId: client.id });
        }
        return;
      }

      // No partner found; enqueue globally
      await redis.lpush(WAITING_LIST, client.id);
      return;
    } catch (e) {
      console.error('Redis matchmaking error, falling back to local:', e);
    }
  }

  // Local fallback
  const partner = findAvailablePartner(client.id);
  if (partner) {
    createRoom(client, partner);
  } else {
    if (!waitingQueue.includes(client.id)) {
      waitingQueue.push(client.id);
    }
  }
}

async function tryMatchGlobal(selfId) {
  // Attempt to find partner in Redis waiting list without matching self
  if (!redis) return null;
  for (let i = 0; i < 5; i += 1) {
    const partnerId = await redis.rpop(WAITING_LIST);
    if (!partnerId) return null;
    if (partnerId !== selfId) return partnerId;
    // If popped self by race, push back and continue
    await redis.lpush(WAITING_LIST, partnerId);
  }
  return null;
}

function findAvailablePartner(excludeId) {
  for (const [clientId, c] of clients) {
    if (clientId !== excludeId && c.isAvailable && !c.partnerId) {
      return c;
    }
  }
  return null;
}

function createRoom(client1, client2) {
  const roomId = crypto.randomUUID();

  client1.partnerId = client2.id;
  client1.roomId = roomId;
  client1.isAvailable = false;

  client2.partnerId = client1.id;
  client2.roomId = roomId;
  client2.isAvailable = false;

  // Remove from local waiting queue
  const index1 = waitingQueue.indexOf(client1.id);
  if (index1 > -1) waitingQueue.splice(index1, 1);
  const index2 = waitingQueue.indexOf(client2.id);
  if (index2 > -1) waitingQueue.splice(index2, 1);

  // Notify both clients
  sendToClient(client1, { type: 'matched', roomId, partnerId: client2.id });
  sendToClient(client2, { type: 'matched', roomId, partnerId: client1.id });

  console.log(`Room created: ${roomId} between ${client1.id} and ${client2.id}`);
}

function relayToPartner(partnerId, messagePayload) {
  const partner = clients.get(partnerId);
  if (partner) {
    sendToClient(partner, messagePayload);
    return true;
  }
  if (redis) {
    publishSignal(partnerId, messagePayload).catch((e) => console.error('Publish error:', e));
    return true;
  }
  return false;
}

async function publishSignal(partnerId, payload) {
  if (!redis) return;
  const msg = { to: partnerId, payload };
  await redis.publish(SIGNAL_CHANNEL, JSON.stringify(msg));
}

function handleOffer(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  relayToPartner(client.partnerId, { type: 'offer', from: client.id, sdp: message.sdp });
}

function handleAnswer(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  relayToPartner(client.partnerId, { type: 'answer', from: client.id, sdp: message.sdp });
}

function handleIce(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  relayToPartner(client.partnerId, { type: 'ice', from: client.id, candidate: message.candidate });
}

function handleNext(client) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }

  // Notify partner that client wants to leave
  const partnerId = client.partnerId;
  relayToPartner(partnerId, { type: 'partner-left' });

  // Reset partner state locally if present
  const partner = clients.get(partnerId);
  if (partner) {
    partner.partnerId = null;
    partner.roomId = null;
    if (REQUEUE_ON_PARTNER_LEAVE) {
      partner.isAvailable = true;
      if (redis) {
        redis.lpush(WAITING_LIST, partner.id).catch(() => {});
      } else if (!waitingQueue.includes(partner.id)) {
        waitingQueue.push(partner.id);
      }
    }
  }

  // Reset client state
  client.partnerId = null;
  client.roomId = null;
  client.isAvailable = false;

  // Remove from local waiting queue
  const index = waitingQueue.indexOf(client.id);
  if (index > -1) waitingQueue.splice(index, 1);

  console.log(`Client ${client.id} requested next partner`);
}

function handleLeave(client) {
  if (client.partnerId) {
    const partnerId = client.partnerId;
    relayToPartner(partnerId, { type: 'partner-left' });

    const partner = clients.get(partnerId);
    if (partner) {
      partner.partnerId = null;
      partner.roomId = null;
      if (REQUEUE_ON_PARTNER_LEAVE) {
        partner.isAvailable = true;
        if (redis) {
          redis.lpush(WAITING_LIST, partner.id).catch(() => {});
        } else if (!waitingQueue.includes(partner.id)) {
          waitingQueue.push(partner.id);
        }
      }
    }
  }

  // Reset client state
  client.partnerId = null;
  client.roomId = null;
  client.isAvailable = false;

  // Remove from local waiting queue
  const index = waitingQueue.indexOf(client.id);
  if (index > -1) waitingQueue.splice(index, 1);

  console.log(`Client ${client.id} left`);
}

function handleClientDisconnect(client) {
  console.log(`Client disconnected: ${client.id}`);

  if (client.partnerId) {
    const partnerId = client.partnerId;
    relayToPartner(partnerId, { type: 'partner-left' });

    const partner = clients.get(partnerId);
    if (partner) {
      partner.partnerId = null;
      partner.roomId = null;
      if (REQUEUE_ON_PARTNER_LEAVE) {
        partner.isAvailable = true;
        if (redis) {
          redis.lpush(WAITING_LIST, partner.id).catch(() => {});
        } else if (!waitingQueue.includes(partner.id)) {
          waitingQueue.push(partner.id);
        }
      }
    }
  }

  // Remove from local waiting queue
  const index = waitingQueue.indexOf(client.id);
  if (index > -1) waitingQueue.splice(index, 1);

  // Remove from clients registry
  clients.delete(client.id);
}

function sendToClient(client, message) {
  if (client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send message to client:', error);
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  try { if (redis) await redis.quit(); } catch (_) {}
  try { if (redisSub) await redisSub.quit(); } catch (_) {}
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  try { if (redis) await redis.quit(); } catch (_) {}
  try { if (redisSub) await redisSub.quit(); } catch (_) {}
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

server.listen(PORT, () => {
  console.log(`WebRTC Signaling Server running on port ${PORT}`);
  console.log(`Instance ID: ${INSTANCE_ID}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
});
