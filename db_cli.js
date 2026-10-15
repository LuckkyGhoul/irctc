#!/usr/bin/env node

const readline = require('readline');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Resolve dependencies from extra_files/node_modules if moved
const extraModules = path.join(__dirname, 'extra_files', 'node_modules');
if (fs.existsSync(extraModules) && !module.paths.includes(extraModules)) {
  module.paths.unshift(extraModules);
}

const SERVER_HOST = 'localhost';
const SERVER_PORT = 8090;

// Execute query via running HTTP server
function queryViaServer(sql) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ sql });
    const req = http.request({
      host: SERVER_HOST,
      port: SERVER_PORT,
      path: '/api/admin/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Invalid response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
    req.write(postData);
    req.end();
  });
}

// Fallback: direct PGlite embedded execution if server is offline
let localDb = null;
async function queryViaDirectDb(sql) {
  if (!localDb) {
    const { PGlite } = require('@electric-sql/pglite');
    let dataDir = path.join(__dirname, 'data', 'postgres_db');
    if (!fs.existsSync(dataDir)) {
      const extraData = path.join(__dirname, 'extra_files', 'data', 'postgres_db');
      if (fs.existsSync(extraData)) {
        dataDir = extraData;
      }
    }
    localDb = new PGlite(dataDir);
  }
  const res = await localDb.query(sql);
  return {
    success: true,
    command: res.command,
    rowCount: res.rowCount !== undefined ? res.rowCount : (res.rows ? res.rows.length : 0),
    rows: res.rows || [],
    fields: res.fields ? res.fields.map(f => f.name) : (res.rows && res.rows[0] ? Object.keys(res.rows[0]) : [])
  };
}

// Execute SQL through whichever mode is available
async function runQuery(sql) {
  try {
    return await queryViaServer(sql);
  } catch (err) {
    // If server unreachable, use direct PGlite
    try {
      return await queryViaDirectDb(sql);
    } catch (dbErr) {
      return { success: false, error: dbErr.message };
    }
  }
}

// Format rows into a clean terminal table
function printTable(rows, fields) {
  if (!rows || rows.length === 0) {
    console.log('(0 rows)\n');
    return;
  }

  const cols = fields && fields.length > 0 ? fields : Object.keys(rows[0]);

  // Calculate column widths
  const widths = {};
  for (const c of cols) {
    widths[c] = c.length;
  }
  for (const row of rows) {
    for (const c of cols) {
      const valStr = row[c] === null || row[c] === undefined ? 'NULL' : String(row[c]);
      if (valStr.length > widths[c]) {
        widths[c] = Math.min(60, Math.max(widths[c], valStr.length));
      }
    }
  }

  // Header line
  const header = cols.map(c => c.padEnd(widths[c])).join(' | ');
  const sep = cols.map(c => '-'.repeat(widths[c])).join('-+-');

  console.log(header);
  console.log(sep);

  for (const row of rows) {
    const line = cols.map(c => {
      let valStr = row[c] === null || row[c] === undefined ? 'NULL' : String(row[c]);
      if (valStr.length > widths[c]) {
        valStr = valStr.substring(0, widths[c] - 3) + '...';
      }
      return valStr.padEnd(widths[c]);
    }).join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})\n`);
}

// Process meta-commands
async function handleMetaCommand(cmd) {
  const trimmed = cmd.trim();

  if (trimmed === '\\q' || trimmed === 'exit' || trimmed === 'quit') {
    console.log('Bye!');
    process.exit(0);
  }

  if (trimmed === 'help' || trimmed === '\\?') {
    console.log('\nAvailable Commands:');
    console.log('  \\dt or .tables           List all tables');
    console.log('  \\d <table_name>          Show columns/schema of table');
    console.log('  \\q or exit               Exit interactive terminal');
    console.log('  SELECT ...;              Execute standard SQL queries');
    console.log('  UPDATE / INSERT / DELETE Modify records in database\n');
    return true;
  }

  if (trimmed === '\\dt' || trimmed === '.tables') {
    const sql = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `;
    const res = await runQuery(sql);
    if (res.success) {
      console.log('\n--- Public Tables ---');
      printTable(res.rows, ['table_name']);
    } else {
      console.log('Error:', res.error);
    }
    return true;
  }

  if (trimmed.startsWith('\\d ') || trimmed.startsWith('.schema ')) {
    const tableName = trimmed.split(/\s+/)[1].replace(/['";]/g, '');
    const sql = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position;
    `;
    const res = await runQuery(sql);
    if (res.success && res.rows.length > 0) {
      console.log(`\n--- Schema for table: ${tableName} ---`);
      printTable(res.rows, ['column_name', 'data_type', 'is_nullable', 'column_default']);
    } else {
      console.log(`Table '${tableName}' not found or has no columns.\n`);
    }
    return true;
  }

  return false;
}

// Main execution
(async () => {
  const args = process.argv.slice(2);

  // If query passed via command line argument: e.g. node db_cli.js "SELECT * FROM trains;"
  if (args.length > 0) {
    const rawInput = args.join(' ').trim();
    if (await handleMetaCommand(rawInput)) return;

    const res = await runQuery(rawInput);
    if (res.success) {
      if (res.rows && res.rows.length > 0) {
        printTable(res.rows, res.fields);
      } else {
        console.log(`Query OK. ${res.command || 'Done'} (rowCount: ${res.rowCount || 0})\n`);
      }
    } else {
      console.error(`❌ Error: ${res.error}\n`);
      process.exit(1);
    }
    return;
  }

  // Interactive REPL Mode
  console.log('========================================================================');
  console.log('🚆 IRCTC PostgreSQL Database Terminal Shell (irctc_db)');
  console.log('========================================================================');
  console.log('Type SQL queries ending with ";" or use meta-commands:');
  console.log('  \\dt or .tables        List all tables');
  console.log('  \\d <table_name>       Describe table structure');
  console.log('  \\q or exit            Exit terminal shell');
  console.log('  help                  Show help');
  console.log('------------------------------------------------------------------------\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'irctc_db=> '
  });

  let buffer = '';

  rl.prompt();

  rl.on('line', async line => {
    const trimmed = line.trim();

    if (!buffer && (trimmed.startsWith('\\') || trimmed.startsWith('.') || ['exit', 'quit', 'help'].includes(trimmed))) {
      await handleMetaCommand(trimmed);
      rl.prompt();
      return;
    }

    buffer += (buffer ? ' ' : '') + line;

    if (buffer.trim().endsWith(';')) {
      const sqlToExec = buffer.trim();
      buffer = '';
      const res = await runQuery(sqlToExec);
      if (res.success) {
        if (res.rows && res.rows.length > 0) {
          printTable(res.rows, res.fields);
        } else {
          console.log(`Query OK: ${res.command || 'SUCCESS'} (affected: ${res.rowCount || 0})\n`);
        }
      } else {
        console.error(`❌ SQL Error: ${res.error}\n`);
      }
      rl.setPrompt('irctc_db=> ');
      rl.prompt();
    } else if (buffer.trim()) {
      rl.setPrompt('irctc_db-> ');
      rl.prompt();
    } else {
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('\nBye!');
    process.exit(0);
  });
})();
