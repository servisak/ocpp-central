const express = require('express');
const WebSocket = require('ws');
const { Pool } = require('pg');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

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

  pool.query(
    `INSERT INTO charger_status (charger_id, status) VALUES ($1, $2) 
     ON CONFLICT (charger_id) DO UPDATE SET status=$2, last_update=NOW()`,
    [charger_id, 'connected']
  );

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log(`Správa od ${charger_id}:`, message);

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

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Server beží na porte ${process.env.PORT || 3000}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

// Funkcia na vygenerovanie PDF
function generatePDF(result, month, year) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
    
    doc.fontSize(20).font('Helvetica-Bold').text('Mesačný Report Nabíjania', 50, 50);
    doc.fontSize(12).font('Helvetica').text(`${month}/${year}`, 50, 85);
    
    let yPosition = 120;
    const colWidth = 120;
    const rowHeight = 25;
    
    doc.rect(50, yPosition, colWidth, rowHeight).stroke();
    doc.fontSize(10).text('Charger ID', 55, yPosition + 5, { width: colWidth - 10 });
    
    doc.rect(50 + colWidth, yPosition, colWidth, rowHeight).stroke();
    doc.text('Total kWh', 55 + colWidth, yPosition + 5, { width: colWidth - 10 });
    
    doc.rect(50 + colWidth * 2, yPosition, colWidth, rowHeight).stroke();
    doc.text('Sessions', 55 + colWidth * 2, yPosition + 5, { width: colWidth - 10 });
    
    yPosition += rowHeight;
    
    result.rows.forEach(row => {
      const kwh = (row.total_wh / 1000).toFixed(2);
      
      doc.rect(50, yPosition, colWidth, rowHeight).stroke();
      doc.fontSize(10).text(row.charger_id, 55, yPosition + 5, { width: colWidth - 10 });
      
      doc.rect(50 + colWidth, yPosition, colWidth, rowHeight).stroke();
      doc.text(kwh + ' kWh', 55 + colWidth, yPosition + 5, { width: colWidth - 10 });
      
      doc.rect(50 + colWidth * 2, yPosition, colWidth, rowHeight).stroke();
      doc.text(row.sessions.toString(), 55 + colWidth * 2, yPosition + 5, { width: colWidth - 10 });
      
      yPosition += rowHeight;
    });
    
    const totalKwh = result.rows.reduce((sum, row) => sum + row.total_wh, 0) / 1000;
    yPosition += 20;
    doc.fontSize(11).font('Helvetica-Bold').text(`Celkovo: ${totalKwh.toFixed(2)} kWh`, 50, yPosition);
    
    doc.end();
  });
}

// Automated monthly report
cron.schedule('0 0 1 * *', async () => {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = lastMonth.getFullYear();
  const month = String(lastMonth.getMonth() + 1).padStart(2, '0');
  
  console.log(`Generujem report za ${month}/${year}`);
  
  try {
    const result = await pool.query(
      `SELECT charger_id, SUM(energy_wh) as total_wh, COUNT(*) as sessions
       FROM charge_sessions
       WHERE EXTRACT(YEAR FROM start_time) = $1 
       AND EXTRACT(MONTH FROM start_time) = $2
       GROUP BY charger_id
       ORDER BY charger_id`,
      [year, month]
    );

    const pdfBuffer = await generatePDF(result, month, year);
    
    const totalKwh = result.rows.reduce((sum, row) => sum + row.total_wh, 0) / 1000;
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.RECIPIENT_EMAIL,
      subject: `OCPP Report ${month}/${year}`,
      html: `
        <h2>Mesačný Report Nabíjania</h2>
        <p><strong>Mesiac:</strong> ${month}/${year}</p>
        <table border="1" style="border-collapse: collapse; padding: 10px; margin-top: 20px;">
          <tr style="background-color: #f0f0f0;">
            <th style="padding: 10px; text-align: left;">Charger ID</th>
            <th style="padding: 10px; text-align: left;">Total kWh</th>
            <th style="padding: 10px; text-align: left;">Sessions</th>
          </tr>
          ${result.rows.map(row => `
            <tr>
              <td style="padding: 10px;">${row.charger_id}</td>
              <td style="padding: 10px;">${(row.total_wh / 1000).toFixed(2)} kWh</td>
              <td style="padding: 10px;">${row.sessions}</td>
            </tr>
          `).join('')}
          <tr style="font-weight: bold; background-color: #f0f0f0;">
            <td style="padding: 10px;">CELKOVO</td>
            <td style="padding: 10px;">${totalKwh.toFixed(2)} kWh</td>
            <td style="padding: 10px;">${result.rows.reduce((sum, row) => sum + row.sessions, 0)}</td>
          </tr>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">Report vygenerovaný automaticky.</p>
      `,
      attachments: [
        {
          filename: `report_${month}_${year}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    };
    
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Email error:', err);
      } else {
        console.log('Email poslany:', info.response);
      }
    });
    
  } catch (err) {
    console.error('Report generation error:', err);
  }
});

console.log('Cron job pre mesačné reporty naplánovaný na 1. deň mesiac o 00:00');

// Endpoint na report JSON
app.get('/report/:year/:month', async (req, res) => {
  const { year, month } = req.params;
  try {
    const result = await pool.query(
      `SELECT charger_id, SUM(energy_wh) as total_wh, COUNT(*) as sessions
       FROM charge_sessions
       WHERE EXTRACT(YEAR FROM start_time) = $1 
       AND EXTRACT(MONTH FROM start_time) = $2
       GROUP BY charger_id`,
      [year, month]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint na report PDF
app.get('/report/:year/:month/pdf', async (req, res) => {
  const { year, month } = req.params;
  try {
    const result = await pool.query(
      `SELECT charger_id, SUM(energy_wh) as total_wh, COUNT(*) as sessions
       FROM charge_sessions
       WHERE EXTRACT(YEAR FROM start_time) = $1 
       AND EXTRACT(MONTH FROM start_time) = $2
       GROUP BY charger_id
       ORDER BY charger_id`,
      [year, month]
    );

    const pdfBuffer = await generatePDF(result, month, year);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report_${month}_${year}.pdf"`);
    res.send(pdfBuffer);
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});
