{
  "name": "ocpp-central",
  "version": "1.0.0",
  "description": "OCPP Central System for Loxone Wallbox",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "pg": "^8.11.3",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.1"
  }
}
