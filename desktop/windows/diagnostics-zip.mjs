import { crc32, deflateRawSync } from 'node:zlib'

// The exporter supplies a fixed, bounded set of files, so ZIP64 and streaming
// data descriptors are unnecessary. Use UTF-8 names and raw DEFLATE (method 8).
export function createZip(entries) {
  const files = [], directory = []
  let offset = 0, directorySize = 0
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename)
    const content = Buffer.from(text)
    const compressed = deflateRawSync(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    files.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    directorySize += central.length + name.length
    offset += local.length + name.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...directory, end])
}
