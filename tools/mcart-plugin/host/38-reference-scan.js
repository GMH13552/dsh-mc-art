    // Add or remove a jar and this changes, so the scan is re-run; otherwise the
    // answer is reused instead of opening 29 jars every time the panel opens.
    async function referenceSignature(dir) {
      const pieces = [await dirSignature(dir), await dirSignature(dir + '/mods'), await dirSignature(dir + '/assets')]
      for (const version of await listDir(dir + '/versions')) {
        if (version.type !== 'directory') continue
        pieces.push(version.name)
        pieces.push(await dirSignature(dir + '/versions/' + version.name))
        pieces.push(await dirSignature(dir + '/versions/' + version.name + '/mods'))
      }
      return pieces.join('|')
    }

    const scanCache = new Map()
    async function scanReference(scanner, dir) {
      const empty = { root: dir, shape: '', namespaces: [], sources: [], textures: 0, error: null }
      if (dir === '') return empty
      if (scanner === null || scanner === undefined) {
        return Object.assign({}, empty, { error: '找不到扫描脚本 ' + SCAN_SCRIPT + '（从项目目录往上找了 5 层都没有）。' })
      }
      const signature = await referenceSignature(dir)
      const cached = scanCache.get(dir)
      if (cached !== undefined && cached.signature === signature) return cached.result
      const parsed = await runScanner(scanner, [dir], 180000, dir)
      if (parsed.error !== undefined) return Object.assign({}, empty, { error: String(parsed.error) })
      const result = { root: parsed.root, shape: parsed.shape || '', namespaces: parsed.namespaces || [],
        sources: parsed.sources || [], textures: parsed.textures || 0, error: null }
      scanCache.set(dir, { signature: signature, result: result })
      return result
    }

