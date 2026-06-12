'use strict';
const https = require('https');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'app.pakasir.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 201) {
          return reject(new Error(`Pakasir HTTP ${res.statusCode}: ${raw}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Pakasir timeout')); });
    req.on('error', e => reject(new Error('Network: ' + e.message)));
    req.write(postData);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.pakasir.com',
      port: 443,
      path,
      method: 'GET',
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Pakasir HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Pakasir timeout')); });
    req.on('error', e => reject(new Error('Network: ' + e.message)));
    req.end();
  });
}

async function createPayment({ apiKey, project, orderId, amount }) {
  const result = await post('/api/transactioncreate/qris', {
    project, order_id: orderId, amount, api_key: apiKey
  });

  const paymentNumber = result.payment?.payment_number || result.payment_number || result.qr_string || result.data?.payment_number;
  if (!paymentNumber) throw new Error('No payment number in response');

  return {
    paymentNumber,
    totalPayment: result.payment?.total_payment || result.total_payment || result.data?.total_payment || amount
  };
}

async function checkStatus({ apiKey, project, orderId, amount }) {
  const query = new URLSearchParams({ project, amount: String(amount), order_id: orderId, api_key: apiKey });
  const result = await get(`/api/transactiondetail?${query}`);

  let status = null;
  if (result.transaction?.status) status = result.transaction.status;
  else if (result.status) status = result.status;
  else if (result.data?.status) status = result.data.status;
  else if (result.success === true) status = 'success';
  else if (typeof result.success !== 'undefined') status = result.success ? 'success' : 'pending';

  return (status || 'pending').toLowerCase();
}

const SUCCESS_STATUSES = new Set(['completed', 'success', 'paid', 'settlement']);
const EXPIRED_STATUSES = new Set(['expired', 'canceled', 'cancelled']);

function isSuccess(status) { return SUCCESS_STATUSES.has(status); }
function isExpired(status) { return EXPIRED_STATUSES.has(status); }

module.exports = { createPayment, checkStatus, isSuccess, isExpired };
