'use strict';

const table = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let value = i;

  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
  }

  table[i] = value >>> 0;
}

function crc32(buffers) {
  let crc = 0xFFFFFFFF;

  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i += 1) {
      crc = table[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function hashPath(value) {
  const buffer = Buffer.from(value, 'utf8');
  let hash = 0x811C9DC5;

  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

module.exports = {
  crc32,
  hashPath
};