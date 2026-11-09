// テスト用の PNG（RGB、無圧縮の行を deflate したもの）
import { deflateSync } from "node:zlib"

/**
 * w×h の PNG を作る。color を渡せばその単色、渡さなければ乱数で埋める。
 * 乱数の画像は圧縮が効かないので、大きなファイル（1MB を超えるものなど）を作れる。
 */
export function png(w: number, h: number, color?: [number, number, number]): Uint8Array {
  const pixels = () => (color ? Buffer.alloc(w * 3, Buffer.from(color)) : crypto.getRandomValues(Buffer.alloc(w * 3)))
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), pixels()])))
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
