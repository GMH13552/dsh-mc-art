/**
 * 本地文件系统垫片——**测试/开发侧的那一份**。
 *
 * 发布物的那一份内联在 `panel/lib/index.js` 里（`panel/build.mjs` 生成，因为发布包
 * 不能再依赖仓库里的 `tools/`）。两份必须是**同一个 API**，否则就会出现"测试里过、
 * 用户那儿不过"——那正是这次踩的坑（本地测试桩的 writeText 不建父目录，比
 * `dsh-fs-local` 严，于是门禁永远红不了）。
 *
 * 所以 `panel/entry-test.mjs` 里有一条**同名方法齐不齐**的检查：它把这份文件里的
 * 方法名和内联进 `lib/index.js` 的方法名逐个对齐，少一个就红。
 *
 * 方法名清单（两边必须一致）：
 *   available, mkdirp, stat, listDir, readText, readBytes, writeText, writeBase64, remove, move
 */
const promises = require('fs/promises')
const nodePath = require('path')

function makeLocalFs() {
  return {
    available: true,
    async mkdirp(path) { await promises.mkdir(path, { recursive: true }) },
    async stat(path) {
      try {
        const info = await promises.stat(path)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size, version: String(info.mtimeMs) }
      } catch (error) { return undefined }
    },
    async listDir(path) {
      try {
        const entries = await promises.readdir(path, { withFileTypes: true })
        const out = []
        for (const entry of entries) {
          let size, version
          try { const info = await promises.stat(path + '/' + entry.name); size = info.size; version = String(info.mtimeMs) } catch (error) {}
          out.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: size, version: version })
        }
        return out
      } catch (error) { return [] }
    },
    async readText(path) {
      try { return await promises.readFile(path, 'utf8') } catch (error) { return undefined }
    },
    async readBytes(path, maxBytes) {
      try {
        const buffer = await promises.readFile(path)
        if (maxBytes !== undefined && buffer.length > maxBytes) return undefined
        return new Uint8Array(buffer)
      } catch (error) { return undefined }
    },
    async writeText(path, text) {
      await promises.mkdir(nodePath.dirname(path), { recursive: true })
      await promises.writeFile(path, text, 'utf8')
    },
    async writeBase64(path, base64) {
      await promises.mkdir(nodePath.dirname(path), { recursive: true })
      await promises.writeFile(path, Buffer.from(base64, 'base64'))
    },
    async remove(path) { await promises.rm(path, { force: true }) },
    async move(from, to) {
      await promises.mkdir(nodePath.dirname(to), { recursive: true })
      await promises.rename(from, to)
    },
  }
}

module.exports = { makeLocalFs, SHIM_METHODS: ['available', 'mkdirp', 'stat', 'listDir', 'readText', 'readBytes', 'writeText', 'writeBase64', 'remove', 'move'] }
