import { deflateSync } from 'zlib'
import { nativeImage, type NativeImage } from 'electron'

function crc32(buf: Buffer): number {
  let crc = ~0
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function circlePng(r: number, g: number, b: number, size = 16): Buffer {
  const rows: Buffer[] = []
  const cx = (size - 1) / 2
  const rad = size * 0.4
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cx
      const inside = dx * dx + dy * dy <= rad * rad
      const i = 1 + x * 4
      if (inside) {
        row[i] = r
        row[i + 1] = g
        row[i + 2] = b
        row[i + 3] = 255
      }
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export type TrayColor = 'green' | 'amber' | 'red'

export function colorForUsage(maxPercent: number | null): TrayColor {
  if (maxPercent == null) return 'green'
  if (maxPercent >= 90) return 'red'
  if (maxPercent >= 70) return 'amber'
  return 'green'
}

const RGB: Record<TrayColor, [number, number, number]> = {
  green: [16, 185, 129],
  amber: [245, 158, 11],
  red: [239, 68, 68]
}

export function trayIcon(color: TrayColor): NativeImage {
  const [r, g, b] = RGB[color]
  const image = nativeImage.createEmpty()
  image.addRepresentation({ width: 16, height: 16, scaleFactor: 1, buffer: circlePng(r, g, b, 16) })
  image.addRepresentation({ width: 32, height: 32, scaleFactor: 2, buffer: circlePng(r, g, b, 32) })
  return image
}
