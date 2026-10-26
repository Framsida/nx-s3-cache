// Writes a reproducible zip (10, PKGL-2): entries sorted by name, stored without
// compression, with a fixed timestamp and fixed permissions. The bytes depend
// only on the input files, so the same release tag gives the same
// source_code_hash. Stored entries avoid depending on the zlib version.
//
//   node reproducible-zip.mjs <out.zip> <base dir> <file>...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';

const [outFile, baseDir, ...names] = process.argv.slice(2);
if (!outFile || !baseDir || names.length === 0) {
  console.error('usage: reproducible-zip.mjs <out.zip> <base dir> <file>...');
  process.exit(2);
}

// 1980-01-01 00:00:00, the earliest MS-DOS date.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UNIX_MODE_FILE = 0o100644;

const local = [];
const central = [];
let offset = 0;

for (const name of [...names].sort()) {
  const data = readFileSync(join(baseDir, name));
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  local.push(header, nameBytes, data);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(0, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt16LE(0, 30); // extra
  entry.writeUInt16LE(0, 32); // comment
  entry.writeUInt16LE(0, 34); // disk
  entry.writeUInt16LE(0, 36); // internal attributes
  entry.writeUInt32LE((UNIX_MODE_FILE << 16) >>> 0, 38);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);

  offset += header.length + nameBytes.length + data.length;
}

const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(names.length, 8);
end.writeUInt16LE(names.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.concat([...local, ...central, end]));
console.log(`Wrote ${outFile} (${names.length} files)`);
