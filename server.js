const express = require('express');
const WebSocket = require('ws');
const { Pool } = require('pg');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Vytvor tabuľky ak neexistujú
pool.query(`
  CREATE TABLE IF NOT EXISTS charge_sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE,
    charger_id VARCHAR(255),
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    energy_wh FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
  );
  
  CREATE TABLE IF NOT EXISTS charger_status (
    id SERIAL PRIMARY KEY,
    charger_id VARCHAR(255) UNIQUE,
    status VARCHAR(50),
    last_update TIMESTAMP DEFAULT NOW()
  );
`).catch(err => console.error('Tabuľky:', err));

// WebSocket server pre OCPP
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  const charger_id = req.url.split('/')[2] || 'unknown';
  console.log(`Charger pripojený: ${charger_id}`);

  // Ulož status do DB
  pool.query(
    `INSERT INTO charger_status (charger_id, status) VALUES ($1, $2) 
     ON CONFLICT (charger_id) DO UPDATE SET status=$2, last_update=NOW()`,
    [charger_id, 'connected']
  );

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`Správa od ${charger_id}:`, message);

      // Jednoduchá logika: Keď príde StartTransaction alebo MeterValues
      if (message[2] === 'MeterValues') {
        const meterValue = message[4]?.meterValue?.[0]?.sampledValue?.[0]?.value;
        if (meterValue) {
          const sessionId = message[4]?.transactionId || uuidv4();
          pool.query(
            `INSERT INTO charge_sessions (session_id, charger_id, energy_wh, start_time)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (session_id) DO UPDATE SET energy_wh=$3`,
            [sessionId, charger_id, meterValue]
          );
        }
      }

      // Pošli OK späť
      ws.send(JSON.stringify([3, message[1], {}]));
    } catch (err) {
      console.error('Chyba pri parsovaní:', err);
    }
  });

  ws.on('close', () => {
    pool.query(
      `UPDATE charger_status SET status='disconnected' WHERE charger_id=$1`,
      [charger_id]
    );
  });
});

// HTTP upgrade na WebSocket
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Server beží na porte ${process.env.PORT || 3000}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Endpoint na report JSON
app.
