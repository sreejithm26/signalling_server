# WebRTC Signaling Server

A Node.js-based WebRTC signaling server that enables peer-to-peer video/audio connections between clients. This server handles the signaling phase of WebRTC connections, allowing clients to exchange SDP offers/answers and ICE candidates for random video chat applications.

## Features

- **Real-time signaling**: WebSocket-based communication for instant message exchange
- **Automatic pairing**: FIFO queue system for matching available clients
- **Room management**: Automatic room creation and cleanup
- **Origin validation**: Configurable CORS-like origin restrictions
- **Health monitoring**: Built-in health check endpoint
- **Graceful shutdown**: Proper cleanup on server termination
- **Production ready**: Docker containerization and Render deployment support

## Architecture

The server implements a simple but effective signaling protocol:

1. **Connection**: Clients connect via WebSocket and receive a unique client ID
2. **Authentication**: Optional user identification (can be extended with JWT)
3. **Availability**: Clients signal they're ready to be paired
4. **Matching**: Server pairs available clients using FIFO queue
5. **Signaling**: Relays WebRTC SDP offers/answers and ICE candidates
6. **Disconnection**: Automatic cleanup and partner notification

## Message Protocol

### Client → Server
- `{ type: 'auth', userId?: string, token?: string }` - Authenticate client
- `{ type: 'available' }` - Signal availability for pairing
- `{ type: 'offer', sdp: string }` - Send WebRTC offer
- `{ type: 'answer', sdp: string }` - Send WebRTC answer
- `{ type: 'ice', candidate: object }` - Send ICE candidate
- `{ type: 'next' }` - Request new partner
- `{ type: 'leave' }` - Leave current session
- `{ type: 'ping' }` - Keep-alive ping

### Server → Client
- `{ type: 'ready', clientId: string }` - Connection established
- `{ type: 'matched', roomId: string, partnerId: string }` - Partner found
- `{ type: 'partner-left' }` - Partner disconnected
- `{ type: 'error', code: string, message: string }` - Error notification
- `{ type: 'pong' }` - Ping response
- Relayed messages: `{ type: 'offer'|'answer'|'ice', from: string, ... }`

## Quick Start

### Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start development server**:
   ```bash
   npm run dev
   ```

3. **Access endpoints**:
   - Server: http://localhost:8080
   - WebSocket: ws://localhost:8080/ws
   - Health check: http://localhost:8080/healthz

### Production

1. **Build and start**:
   ```bash
   npm start
   ```

2. **Docker**:
   ```bash
   docker build -t webrtc-signaling .
   docker run -p 8080:8080 webrtc-signaling
   ```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `ALLOWED_ORIGIN` | `''` | Comma-separated list of allowed origins |
| `REQUEUE_ON_PARTNER_LEAVE` | `true` | Whether to requeue clients when partner leaves |

## Deployment

### Render (Recommended)

1. **Push to Git repository**
2. **Connect repository to Render**
3. **Create new Web Service**
4. **Select Docker environment**
5. **Deploy**

The `render.yaml` file provides automatic configuration.

### Manual Docker Deployment

```bash
# Build image
docker build -t webrtc-signaling .

# Run container
docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ALLOWED_ORIGIN=https://yourdomain.com \
  --name webrtc-signaling \
  webrtc-signaling
```

### Other Platforms

The server can be deployed to any platform supporting Node.js or Docker:
- Heroku
- DigitalOcean App Platform
- AWS ECS/Fargate
- Google Cloud Run
- Azure Container Instances

## Client Integration

### JavaScript/TypeScript

```javascript
const ws = new WebSocket('wss://yourserver.com/ws');

ws.onopen = () => {
  console.log('Connected to signaling server');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'ready':
      console.log('Client ID:', message.clientId);
      break;
    case 'matched':
      console.log('Matched with partner:', message.partnerId);
      break;
    case 'offer':
      // Handle WebRTC offer
      break;
    // ... handle other message types
  }
};

// Signal availability
ws.send(JSON.stringify({ type: 'available' }));
```

### React Hook Example

```typescript
import { useEffect, useRef, useState } from 'react';

export function useSignaling(serverUrl: string) {
  const ws = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  useEffect(() => {
    ws.current = new WebSocket(serverUrl);
    
    ws.current.onopen = () => setIsConnected(true);
    ws.current.onclose = () => setIsConnected(false);
    
    ws.current.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'ready':
          setClientId(message.clientId);
          break;
        case 'matched':
          setPartnerId(message.partnerId);
          break;
        case 'partner-left':
          setPartnerId(null);
          break;
      }
    };

    return () => ws.current?.close();
  }, [serverUrl]);

  const signalAvailable = () => {
    ws.current?.send(JSON.stringify({ type: 'available' }));
  };

  const sendOffer = (sdp: string) => {
    ws.current?.send(JSON.stringify({ type: 'offer', sdp }));
  };

  const sendAnswer = (sdp: string) => {
    ws.current?.send(JSON.stringify({ type: 'answer', sdp }));
  };

  const sendIceCandidate = (candidate: any) => {
    ws.current?.send(JSON.stringify({ type: 'ice', candidate }));
  };

  const nextPartner = () => {
    ws.current?.send(JSON.stringify({ type: 'next' }));
  };

  return {
    isConnected,
    clientId,
    partnerId,
    signalAvailable,
    sendOffer,
    sendAnswer,
    sendIceCandidate,
    nextPartner,
  };
}
```

## Security Considerations

- **Origin validation**: Use `ALLOWED_ORIGIN` to restrict client access
- **Rate limiting**: Consider implementing rate limiting for production use
- **Authentication**: Extend the auth system with proper JWT validation
- **HTTPS/WSS**: Always use secure connections in production
- **Input validation**: Validate all incoming messages

## Performance

- **Memory efficient**: Uses Maps for O(1) client lookups
- **Scalable**: Stateless design allows horizontal scaling
- **Low latency**: WebSocket-based for real-time communication
- **Connection pooling**: Efficient WebSocket connection management

## Monitoring

- **Health checks**: `/healthz` endpoint for load balancer health checks
- **Logging**: Comprehensive console logging for debugging
- **Metrics**: Consider adding Prometheus metrics for production monitoring

## Troubleshooting

### Common Issues

1. **WebSocket connection fails**:
   - Check if server is running
   - Verify WebSocket path (`/ws`)
   - Check firewall/network settings

2. **Clients not pairing**:
   - Ensure clients send `available` message
   - Check if `REQUEUE_ON_PARTNER_LEAVE` is set correctly
   - Verify WebSocket connection is stable

3. **ICE candidates not working**:
   - Ensure proper STUN/TURN server configuration on client
   - Check network NAT traversal

### Debug Mode

Enable detailed logging by setting environment variable:
```bash
DEBUG=* npm start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
- Create a GitHub issue
- Check the troubleshooting section
- Review the message protocol documentation
