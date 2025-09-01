const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const REQUEUE_ON_PARTNER_LEAVE = (process.env.REQUEUE_ON_PARTNER_LEAVE || 'true') === 'true';

// Registries
const clients = new Map(); // clientId -> { id, ws, userId?, partnerId?, roomId?, isAvailable }
const waitingQueue = []; // FIFO

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('WebRTC Signaling Server (Node.js)');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN.length) {
    const origin = req.headers.origin || '';
    if (!ALLOWED_ORIGIN.includes(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  const id = crypto.randomUUID();
  const client = { id, ws, userId: null, partnerId: null, roomId: null, isAvailable: false };
  clients.set(id, client);

  console.log(`Client connected: ${id}`);

  // Send ready message with client ID
  sendToClient(client, { type: 'ready', clientId: id });

  ws.on('message', (data) => {
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
  // In a real app, you'd validate the token here
  console.log(`Client ${client.id} authenticated as ${client.userId || 'anonymous'}`);
}

function handleAvailable(client) {
  if (client.partnerId) {
    sendToClient(client, { type: 'error', code: 'ALREADY_PAIRED', message: 'Already paired with a partner' });
    return;
  }

  client.isAvailable = true;
  
  // Try to find a partner
  const partner = findAvailablePartner(client.id);
  if (partner) {
    createRoom(client, partner);
  } else {
    // Add to waiting queue
    if (!waitingQueue.includes(client.id)) {
      waitingQueue.push(client.id);
    }
  }
}

function findAvailablePartner(excludeId) {
  for (const [clientId, client] of clients) {
    if (clientId !== excludeId && client.isAvailable && !client.partnerId) {
      return client;
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
  
  // Remove from waiting queue
  const index1 = waitingQueue.indexOf(client1.id);
  if (index1 > -1) waitingQueue.splice(index1, 1);
  const index2 = waitingQueue.indexOf(client2.id);
  if (index2 > -1) waitingQueue.splice(index2, 1);
  
  // Notify both clients
  sendToClient(client1, { type: 'matched', roomId, partnerId: client2.id });
  sendToClient(client2, { type: 'matched', roomId, partnerId: client1.id });
  
  console.log(`Room created: ${roomId} between ${client1.id} and ${client2.id}`);
}

function handleOffer(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  
  const partner = clients.get(client.partnerId);
  if (partner) {
    sendToClient(partner, { type: 'offer', from: client.id, sdp: message.sdp });
  }
}

function handleAnswer(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  
  const partner = clients.get(client.partnerId);
  if (partner) {
    sendToClient(partner, { type: 'answer', from: client.id, sdp: message.sdp });
  }
}

function handleIce(client, message) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  
  const partner = clients.get(client.partnerId);
  if (partner) {
    sendToClient(partner, { type: 'ice', from: client.id, candidate: message.candidate });
  }
}

function handleNext(client) {
  if (!client.partnerId) {
    sendToClient(client, { type: 'error', code: 'NOT_PAIRED', message: 'Not paired with a partner' });
    return;
  }
  
  // Notify partner that client wants to leave
  const partner = clients.get(client.partnerId);
  if (partner) {
    sendToClient(partner, { type: 'partner-left' });
    
    // Reset partner's state
    partner.partnerId = null;
    partner.roomId = null;
    
    if (REQUEUE_ON_PARTNER_LEAVE) {
      partner.isAvailable = true;
      if (!waitingQueue.includes(partner.id)) {
        waitingQueue.push(partner.id);
      }
    }
  }
  
  // Reset client's state
  client.partnerId = null;
  client.roomId = null;
  client.isAvailable = false;
  
  // Remove from waiting queue
  const index = waitingQueue.indexOf(client.id);
  if (index > -1) waitingQueue.splice(index, 1);
  
  console.log(`Client ${client.id} requested next partner`);
}

function handleLeave(client) {
  if (client.partnerId) {
    const partner = clients.get(client.partnerId);
    if (partner) {
      sendToClient(partner, { type: 'partner-left' });
      
      // Reset partner's state
      partner.partnerId = null;
      partner.roomId = null;
      
      if (REQUEUE_ON_PARTNER_LEAVE) {
        partner.isAvailable = true;
        if (!waitingQueue.includes(partner.id)) {
          waitingQueue.push(partner.id);
        }
      }
    }
  }
  
  // Reset client's state
  client.partnerId = null;
  client.roomId = null;
  client.isAvailable = false;
  
  // Remove from waiting queue
  const index = waitingQueue.indexOf(client.id);
  if (index > -1) waitingQueue.splice(index, 1);
  
  console.log(`Client ${client.id} left`);
}

function handleClientDisconnect(client) {
  console.log(`Client disconnected: ${client.id}`);
  
  if (client.partnerId) {
    const partner = clients.get(client.partnerId);
    if (partner) {
      sendToClient(partner, { type: 'partner-left' });
      
      // Reset partner's state
      partner.partnerId = null;
      partner.roomId = null;
      
      if (REQUEUE_ON_PARTNER_LEAVE) {
        partner.isAvailable = true;
        if (!waitingQueue.includes(partner.id)) {
          waitingQueue.push(partner.id);
        }
      }
    }
  }
  
  // Remove from waiting queue
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
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

server.listen(PORT, () => {
  console.log(`WebRTC Signaling Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
});
