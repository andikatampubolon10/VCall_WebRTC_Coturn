module.exports = {
  apps: [
    {
      name: 'webrtc-gateway',
      cwd: './gateway',
      script: 'index.js',
      env: {
        PORT: 3000
      }
    },
    {
      name: 'app-a-doctor',
      cwd: './app-a',
      script: 'server.js',
      env: {
        PORT: 3001,
        GATEWAY_URL: 'ws://localhost:3000'
      }
    },
    {
      name: 'app-b-patient',
      cwd: './app-b',
      script: 'server.js',
      env: {
        PORT: 3002,
        GATEWAY_URL: 'ws://localhost:3000'
      }
    }
  ]
};

