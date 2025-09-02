# Frontend Logic for WebRTC Video Calls

## Overview
This document outlines the complete frontend implementation needed to create video calls between two users using the deployed signaling server at `https://signalling-server-oqhy.onrender.com`.

## Core Components Needed

### 1. Signaling Connection Manager
- **WebSocket Connection**: Connect to `wss://signalling-server-oqhy.onrender.com/ws`
- **Connection State Management**: Track connection status, client ID, partner status
- **Message Handling**: Process all incoming/outgoing signaling messages
- **Reconnection Logic**: Handle connection drops and automatic reconnection

### 2. WebRTC Peer Connection Manager
- **Peer Connection Creation**: Initialize RTCPeerConnection with STUN/TURN servers
- **Media Stream Handling**: Get user's camera/microphone and create MediaStream
- **SDP Exchange**: Handle offer/answer creation and exchange
- **ICE Candidate Exchange**: Collect and relay ICE candidates between peers
- **Connection State Monitoring**: Track peer connection state changes

### 3. User Interface Components
- **Video Elements**: Display local and remote video streams
- **Connection Controls**: Connect, disconnect, next partner buttons
- **Status Indicators**: Show connection state, partner info, room ID
- **Settings Panel**: Camera/microphone selection, video quality options

## Detailed Implementation Logic

### Phase 1: Connection & Signaling

#### 1.1 Initialize Signaling Connection
```typescript
// Connect to deployed signaling server
const ws = new WebSocket('wss://signalling-server-oqhy.onrender.com/ws');

// Handle connection events
ws.onopen = () => {
  // Connection established
  // Server will send 'ready' message with clientId
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  handleSignalingMessage(message);
};
```

#### 1.2 User Authentication
```typescript
// Get user's IP address as unique identifier
const getUserIP = async () => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch (error) {
    // Fallback to timestamp-based ID
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
};

// Authenticate with signaling server
const authenticate = async () => {
  const userId = await getUserIP();
  ws.send(JSON.stringify({
    type: 'auth',
    userId: userId
  }));
};
```

#### 1.3 Signaling Message Handler
```typescript
const handleSignalingMessage = (message) => {
  switch (message.type) {
    case 'ready':
      // Store client ID from server
      setClientId(message.clientId);
      break;
      
    case 'matched':
      // Partner found - start WebRTC connection
      setPartnerId(message.partnerId);
      setRoomId(message.roomId);
      initiateWebRTCConnection();
      break;
      
    case 'partner-left':
      // Partner disconnected - cleanup
      cleanupWebRTCConnection();
      setPartnerId(null);
      setRoomId(null);
      break;
      
    case 'offer':
      // Handle incoming WebRTC offer
      handleIncomingOffer(message.sdp, message.from);
      break;
      
    case 'answer':
      // Handle incoming WebRTC answer
      handleIncomingAnswer(message.sdp, message.from);
      break;
      
    case 'ice':
      // Handle incoming ICE candidate
      handleIncomingICECandidate(message.candidate, message.from);
      break;
      
    case 'error':
      // Handle server errors
      console.error('Signaling error:', message.code, message.message);
      break;
  }
};
```

### Phase 2: WebRTC Implementation

#### 2.1 Media Stream Setup
```typescript
const setupMediaStream = async () => {
  try {
    // Get user's camera and microphone
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
    setLocalStream(stream);
    
    // Display local video
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    
    return stream;
  } catch (error) {
    console.error('Failed to get media stream:', error);
    throw error;
  }
};
```

#### 2.2 Peer Connection Setup
```typescript
const createPeerConnection = () => {
  // STUN servers for NAT traversal
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  };
  
  const peerConnection = new RTCPeerConnection(configuration);
  
  // Add local stream tracks to peer connection
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      // Send ICE candidate to partner via signaling server
      ws.send(JSON.stringify({
        type: 'ice',
        candidate: event.candidate
      }));
    }
  };
  
  // Handle incoming tracks
  peerConnection.ontrack = (event) => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = event.streams[0];
    }
    setRemoteStream(event.streams[0]);
  };
  
  // Monitor connection state
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    setConnectionState(peerConnection.connectionState);
  };
  
  return peerConnection;
};
```

#### 2.3 Initiating Connection (Caller)
```typescript
const initiateWebRTCConnection = async () => {
  try {
    // Setup media stream if not already done
    if (!localStream) {
      await setupMediaStream();
    }
    
    // Create peer connection
    const peerConnection = createPeerConnection();
    setPeerConnection(peerConnection);
    
    // Create offer
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    
    // Set local description
    await peerConnection.setLocalDescription(offer);
    
    // Send offer to partner via signaling server
    ws.send(JSON.stringify({
      type: 'offer',
      sdp: offer
    }));
    
  } catch (error) {
    console.error('Failed to initiate connection:', error);
  }
};
```

#### 2.4 Handling Incoming Offer (Callee)
```typescript
const handleIncomingOffer = async (sdp, from) => {
  try {
    // Setup media stream if not already done
    if (!localStream) {
      await setupMediaStream();
    }
    
    // Create peer connection
    const peerConnection = createPeerConnection();
    setPeerConnection(peerConnection);
    
    // Set remote description (offer)
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Create answer
    const answer = await peerConnection.createAnswer();
    
    // Set local description (answer)
    await peerConnection.setLocalDescription(answer);
    
    // Send answer to partner via signaling server
    ws.send(JSON.stringify({
      type: 'answer',
      sdp: answer
    }));
    
  } catch (error) {
    console.error('Failed to handle incoming offer:', error);
  }
};
```

#### 2.5 Handling Incoming Answer
```typescript
const handleIncomingAnswer = async (sdp, from) => {
  try {
    if (peerConnection) {
      // Set remote description (answer)
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  } catch (error) {
    console.error('Failed to handle incoming answer:', error);
  }
};
```

#### 2.6 ICE Candidate Handling
```typescript
const handleIncomingICECandidate = async (candidate, from) => {
  try {
    if (peerConnection) {
      // Add ICE candidate to peer connection
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (error) {
    console.error('Failed to add ICE candidate:', error);
  }
};
```

### Phase 3: User Interaction & Controls

#### 3.1 Signal Availability
```typescript
const signalAvailable = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'available' }));
    setStatus('waiting');
  }
};
```

#### 3.2 Next Partner Request
```typescript
const requestNextPartner = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Cleanup current connection
    cleanupWebRTCConnection();
    
    // Request next partner
    ws.send(JSON.stringify({ type: 'next' }));
    setStatus('waiting');
  }
};
```

#### 3.3 Leave Current Session
```typescript
const leaveSession = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Cleanup current connection
    cleanupWebRTCConnection();
    
    // Leave current session
    ws.send(JSON.stringify({ type: 'leave' }));
    setStatus('disconnected');
  }
};
```

#### 3.4 Connection Cleanup
```typescript
const cleanupWebRTCConnection = () => {
  if (peerConnection) {
    // Close peer connection
    peerConnection.close();
    setPeerConnection(null);
  }
  
  // Stop local stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  
  // Clear video elements
  if (localVideoRef.current) {
    localVideoRef.current.srcObject = null;
  }
  if (remoteVideoRef.current) {
    remoteVideoRef.current.srcObject = null;
  }
  
  setLocalStream(null);
  setRemoteStream(null);
  setPartnerId(null);
  setRoomId(null);
};
```

### Phase 4: State Management

#### 4.1 Required State Variables
```typescript
const [clientId, setClientId] = useState(null);
const [partnerId, setPartnerId] = useState(null);
const [roomId, setRoomId] = useState(null);
const [status, setStatus] = useState('disconnected'); // disconnected, connecting, connected, waiting, matched
const [connectionState, setConnectionState] = useState('new'); // new, connecting, connected, disconnected, failed
const [localStream, setLocalStream] = useState(null);
const [remoteStream, setRemoteStream] = useState(null);
const [peerConnection, setPeerConnection] = useState(null);
const [ws, setWs] = useState(null);
```

#### 4.2 Status Mapping
```typescript
const getStatusDisplay = () => {
  switch (status) {
    case 'disconnected':
      return 'Not Connected';
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return 'Connected to Server';
    case 'waiting':
      return 'Waiting for Partner...';
    case 'matched':
      return `Connected with Partner (${partnerId?.substring(0, 8)}...)`;
    default:
      return 'Unknown Status';
  }
};
```

### Phase 5: Error Handling & Edge Cases

#### 5.1 WebSocket Reconnection
```typescript
const setupWebSocketReconnection = () => {
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const reconnectDelay = 1000; // Start with 1 second
  
  const reconnect = () => {
    if (reconnectAttempts < maxReconnectAttempts) {
      setTimeout(() => {
        console.log(`Reconnection attempt ${reconnectAttempts + 1}`);
        connectToSignalingServer();
        reconnectAttempts++;
      }, reconnectDelay * Math.pow(2, reconnectAttempts)); // Exponential backoff
    } else {
      setStatus('failed');
      console.error('Max reconnection attempts reached');
    }
  };
  
  ws.onclose = () => {
    setStatus('disconnected');
    reconnect();
  };
};
```

#### 5.2 Media Stream Fallbacks
```typescript
const setupMediaStreamWithFallback = async () => {
  try {
    // Try HD video first
    return await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: true
    });
  } catch (error) {
    try {
      // Fallback to SD video
      return await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 24 },
        audio: true
      });
    } catch (error) {
      try {
        // Fallback to audio only
        return await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true
        });
      } catch (error) {
        throw new Error('No media devices available');
      }
    }
  }
};
```

#### 5.3 Connection Timeout Handling
```typescript
const setupConnectionTimeout = () => {
  const connectionTimeout = setTimeout(() => {
    if (status === 'waiting') {
      console.log('Connection timeout - no partner found');
      setStatus('timeout');
      // Optionally retry or show user message
    }
  }, 30000); // 30 seconds timeout
  
  return connectionTimeout;
};
```

## Implementation Order

1. **Setup basic WebSocket connection** to signaling server
2. **Implement user authentication** with IP-based user ID
3. **Add basic signaling message handling** (ready, matched, partner-left)
4. **Implement media stream setup** (camera/microphone access)
5. **Create WebRTC peer connection** with STUN servers
6. **Handle SDP offer/answer exchange**
7. **Implement ICE candidate exchange**
8. **Add user interface controls** (connect, next, leave)
9. **Implement error handling** and reconnection logic
10. **Add connection state monitoring** and status display

## Testing Checklist

- [ ] WebSocket connection to deployed server
- [ ] User authentication with IP address
- [ ] Media stream access (camera/microphone)
- [ ] Partner matching and room creation
- [ ] WebRTC connection establishment
- [ ] Video/audio streaming between peers
- [ ] Connection cleanup and partner switching
- [ ] Error handling and reconnection
- [ ] Mobile device compatibility
- [ ] Network connectivity issues handling

## Notes

- **STUN servers only**: Current implementation uses free Google STUN servers. For production, consider adding TURN servers for better connectivity.
- **IP-based user IDs**: Using IP addresses as user IDs may cause issues with users behind NAT or VPN. Consider implementing a more robust user identification system.
- **Browser compatibility**: Ensure WebRTC features are supported in target browsers (Chrome, Firefox, Safari, Edge).
- **Security**: Consider implementing additional security measures like DTLS-SRTP for encrypted media streams.
