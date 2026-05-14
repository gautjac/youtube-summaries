#!/usr/bin/env node
/**
 * r2-upload.cjs — small helper around @aws-sdk/client-s3 for Cloudflare R2.
 *
 * Reads these env vars:
 *   R2_ENDPOINT           https://<accountId>.r2.cloudflarestorage.com
 *   R2_BUCKET             podcast-app
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *
 * Exports:
 *   getClient()           -> S3Client (or null if env is incomplete)
 *   uploadFile(client, localPath, key) -> uploads file, returns true/false
 *   objectExists(client, key) -> HEAD request, returns bool
 *
 * Also usable as a CLI for ad-hoc uploads:
 *   node scripts/r2-upload.cjs <local-path> <r2-key>
 */

'use strict';

const fs = require('fs');
const path = require('path');

let S3Client, PutObjectCommand, HeadObjectCommand;
try {
  ({ S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3'));
} catch (err) {
  // The SDK is optional — scripts that don't touch R2 should still run.
  S3Client = null;
}

function getClient() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!S3Client) {
    throw new Error('@aws-sdk/client-s3 is not installed. Run `npm install`.');
  }
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucket() {
  return process.env.R2_BUCKET || 'podcast-app';
}

async function objectExists(client, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function uploadFile(client, localPath, key, { contentType = 'audio/mpeg', skipIfExists = true } = {}) {
  if (skipIfExists && await objectExists(client, key)) {
    return { uploaded: false, skipped: true, key };
  }
  const body = fs.readFileSync(localPath);
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return { uploaded: true, skipped: false, key, bytes: body.length };
}

module.exports = { getClient, getBucket, objectExists, uploadFile };

// ─── CLI mode ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const [localPath, key] = process.argv.slice(2);
  if (!localPath || !key) {
    console.error('Usage: node scripts/r2-upload.cjs <local-path> <r2-key>');
    process.exit(1);
  }
  const client = getClient();
  if (!client) {
    console.error('R2 credentials missing. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  if (!fs.existsSync(localPath)) {
    console.error(`File not found: ${localPath}`);
    process.exit(1);
  }
  uploadFile(client, localPath, key)
    .then(result => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch(err => {
      console.error('Upload failed:', err.message);
      process.exit(1);
    });
}
