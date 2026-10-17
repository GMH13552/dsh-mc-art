    // A manual edit arrives as a whole cell list, so the viewer can render the
    // result before anything is written back.  Everything is re-validated here:
    // the browser is not the authority on what a cell is.
    function normalizeCells(input) {
      const out = []
      if (!Array.isArray(input)) return out
      for (const cell of input) {
        if (!cell || typeof cell.block !== 'string' || cell.block === '') continue
        if (!Array.isArray(cell.at) || cell.at.length < 3) continue
        const at = [0, 1, 2].map((i) => Math.trunc(Number(cell.at[i])))
        if (!at.every((value) => isFinite(value))) continue
        // Only a real choice is written back: stamping `variant: null` on every
        // cell would put a key with no meaning into every saved atlas.
        const cellVariant = typeof cell.variant === 'string' && cell.variant !== '' ? cell.variant : null
        const kept = { block: cell.block, at: at }
        if (cellVariant !== null) kept.variant = cellVariant
        out.push(kept)
      }
      return out
    }

    const FACE_STEP = {
      down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1],
      south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
    }

    // A reference block is not part of any project's pack: it comes out of the
    // game's version jar or a mod jar, which is why the plugin cannot preload it
    // the way it preloads a project.  It is extracted when first asked for, and
    // `atlas.releaseRefs` drops it again once nothing references it.
    async function referenceDirectory(project) {
      const stored = (await readJson(project.dir + '/mc-art.settings.json')) || {}
      const reference = stored.reference !== null && typeof stored.reference === 'object' ? stored.reference : {}
      return typeof reference.directory === 'string' ? reference.directory : ''
    }

    // Re-stat-ing 30 jars on every single block would be silly, but never
    // re-checking would serve a stale block after the user adds a mod.
    async function refSignatureOf(dir) {
      const cached = refSignatures.get(dir)
      const now = Date.now()
      if (cached !== undefined && now - cached.at < 5000) return cached.value
      const value = await referenceSignature(dir)
      refSignatures.set(dir, { at: now, value: value })
      return value
    }

    function virtualLoad(namespace, parsed) {
      const models = new Map()
      for (const key of Object.keys(parsed.models || {})) {
        const colon = key.indexOf(':')
        const path = colon >= 0 ? key.slice(colon + 1) : key
        if (!models.has(path)) models.set(path, parsed.models[key])
      }
      const textures = new Map()
      const files = parsed.textureFiles || {}
      for (const reference of Object.keys(parsed.textures || {})) {
        const colon = reference.indexOf(':')
        let textureNamespace = colon >= 0 ? reference.slice(0, colon) : namespace
        let texturePath = colon >= 0 ? reference.slice(colon + 1) : reference
        // The extraction knows which archive actually answered; an unqualified
        // ref cannot say whether the pack's own namespace or vanilla won.
        const file = files[reference]
        if (typeof file === 'string') {
          const parts = file.split('/')
          if (parts.length > 3 && parts[0] === 'assets') {
            textureNamespace = parts[1]
            texturePath = parts.slice(3).join('/').replace(/\.png$/, '')
          }
        }
        const key = textureNamespace + ':' + texturePath
        const refKey = 'ref:' + key
        textures.set(key, refKey)
        referenceTextures.set(refKey, 'data:image/png;base64,' + parsed.textures[reference])
        const animation = (parsed.animations || {})[reference]
        if (animation !== undefined && animation !== null) referenceAnimations.set(refKey, animation)
        else referenceAnimations.delete(refKey)
      }
      return { dir: null, namespace: namespace, assets: null, models: models,
        textures: textures, virtual: true }
    }

    function refEntry(namespace, block) {
      return referenceBlocks.get(namespace + ':' + block)
    }

    function refNameOf(namespace, block) {
      const entry = refEntry(namespace, block)
      return entry === undefined ? undefined : entry.name
    }


