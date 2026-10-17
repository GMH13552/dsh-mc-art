    async function payload(root, project, kind, id, have, cellsOverride, neighbours) {
      const dir = project.dir
      const namespace = project.namespace
      // On by default, because it is what the game does.  The viewer can turn it
      // off to see the extraction's own union -- which is the only way to tell
      // "our rules are wrong" from "the picture is right and I misremembered".
      const neighbourAware = neighbours !== false
      const load = preloads.get(namespace)
      if (load === undefined) return { error: 'project not loaded: ' + namespace }
      let quads = []
      let refs = []
      let palette = []
      let cells = null
      // kind==='block' 时回给客户端的"这个方块一共有哪几个模型"，方便逐个看。
      let blockModel = null
      let blockModels = []

      if (kind === 'block') {
        const found = (await blockIds(load)).filter((block) => block.id === id)[0]
        if (found === undefined) return { error: 'block not found: ' + id }
        blockModel = found.model
        blockModels = found.models
        const built = await projectElements(project, load, found.model)
        const elements = built.elements
        quads = elements === undefined ? undefined : quadsFromElements(elements, note)
        // **空 quads 也是画不出来。** 以前这里返回一个"成功"对象、`quads` 是 `[]`，
        // 于是取景框一片空白、屏幕上一个字都没有（实测 `mist_ladder`：模型是零厚度平面、
        // 两个面用的都是原版贴图 `block/ladder`，贴图在项目包里没有 → 面被静默丢掉）。
        // 任何"取不到"都必须上报告，不许静默。
        if (elements === undefined || quads.length === 0) {
          // 两条要分开：`elements` 有但一个面都没解出来（贴图/朝向）vs 整条链根本没有
          // `elements`。后者以前落进 `unknown`（等于没诊断）。
          if (elements !== undefined) built.noQuads = true
          else built.noElements = true
          // 画不出来时给一份**准确**的报告：结构化诊断（客户端按它渲染）+ ≤20 行可复制文本。
          //
          // **0.1.26 的教训：绝不注入。** 那时这里 `agent.steer({role:'user', content:[…]})`
          // 写了一条没有 `source` 的消息，宿主把它当合法输入落进持久化日志的
          // `agent/inbox/spliced`，那个会话**再也加载不了**。往别人的持久化日志里写字，
          // 形状不对不是"没生效"，是**把日志写坏**。所以这条路上不写任何东西：报告只在屏幕上。
          const directory = await referenceDirectory(project)
          const failed = blockDiagnostic(load, namespace, id, found, built, directory)
          return { error: failed.lines.join('\n'), notified: false, notifyVia: null,
            diagnostic: { reason: failed.reason, block: namespace + ':' + id, missing: failed.missing,
              tried: failed.tried, referenceDirectory: directory } }
        }
        refs = [rel(root, load.assets + '/textures/block/' + id + '.png'),
          rel(root, load.assets + '/models/block/' + id + '.json'),
          rel(root, load.assets + '/blockstates/' + id + '.json')]
      } else if (kind === 'entity') {
        const source = (project.entities || []).filter((item) => item.id === id)[0]
        if (source === undefined) return { error: 'entity not found: ' + id }
        const full = (await readJson(dir + '/mc-art.atlas.json')) || {}
        const spec = (full.entities || []).filter((item) => item.id === id)[0]
        if (spec === undefined) return { error: 'entity spec missing: ' + id }
        for (const layer of spec.layers || []) {
          const path = load.assets + '/textures/' + layer.texture
          quads = quads.concat(entityQuads(layer.model, path, layer.mode || 'opaque'))
          refs.push(rel(root, path))
        }
        refs.push(rel(root, dir + '/mc-art.atlas.json'))
        refs = refs.concat((spec.refs || []).map((r) => rel(root, dir + '/' + r)))
      } else {
        const full = (await readJson(dir + '/mc-art.atlas.json')) || {}
        const list = kind === 'biome' ? (full.biomes || []) : (full.structures || [])
        const item = list.filter((entry) => entry.id === id)[0]
        if (item === undefined) return { error: kind + ' not found: ' + id }
        const source = cellsOverride === undefined || cellsOverride === null
          ? (item.cells || []) : normalizeCells(cellsOverride)
        const byCell = new Map()
        for (const cell of source) {
          if (!cell || !Array.isArray(cell.at) || typeof cell.block !== 'string') continue
          const key = cell.at[0] + ',' + cell.at[1] + ',' + cell.at[2]
          const previous = byCell.get(key)
          if (previous !== undefined && previous.block !== cell.block) {
            note('格子重叠 ' + key + '：' + previous.block + ' 与 ' + cell.block + '，以后者为准')
          }
          // Rebuilt cell by cell rather than passed through: dropping `variant`
          // here is silent in exactly the way it was silent in the viewer's own
          // editor -- every log in the structure straightens up and nothing
          // says why.
          const kept = { block: cell.block, at: cell.at }
          if (typeof cell.variant === 'string' && cell.variant !== '') kept.variant = cell.variant
          byCell.set(key, kept)
        }
        // Fixed order, so `pick.cell` is an index the viewer can send straight
        // back: after every edit the scene is re-fetched and indices refreshed.
        cells = Array.from(byCell.values())
        const cache = new Map()
        const counts = new Map()
        // Two passes, because a wall's own shape depends on its NEIGHBOURS and
        // a neighbour's shape depends on nothing (see `describeEntry`) -- so
        // every cell can be resolved first, and then each one asked about the
        // cells next to it.
        const slots = []
        const atCell = new Map()
        for (let index = 0; index < cells.length; index++) {
          const cell = cells[index]
          const reference = String(cell.block)
          const colon = reference.indexOf(':')
          const cellNamespace = colon >= 0 ? reference.slice(0, colon) : namespace
          const cellBlock = colon >= 0 ? reference.slice(colon + 1) : reference
          const fullName = cellNamespace + ':' + cellBlock
          counts.set(fullName, (counts.get(fullName) || 0) + 1)
          // A cell that turned its block is a different extraction from the
          // same block left alone, so the cache key carries the variant too.
          const cellKey = fullName + (cell.variant === null || cell.variant === undefined ? '' : '@' + cell.variant)
          let slot = cache.get(cellKey)
          if (slot === undefined) {
            slot = { load: undefined, entry: null, union: undefined,
              id: fullName, variant: cell.variant === undefined ? null : cell.variant }
            // A structure may hold a vanilla or mod block; a cell that cannot
            // be resolved is reported rather than silently dropped.
            const found = await entryFor(root, project, reference, cell.variant)
            if (found.error !== undefined) note('取不到 ' + fullName + '：' + found.error)
            else { slot.load = found.load; slot.entry = found.entry; slot.id = found.id }
            // The UNION of every apply stays cached and stays the fallback: it
            // is what the extraction itself shipped, and when a neighbour
            // cannot be derived the drawing has to fall back to something.
            cache.set(cellKey, slot)
          }
          slots.push(slot)
          atCell.set(neatKey(cell.at), slot)
        }
        // A coordinate the structure does not use is AIR, and air is a
        // neighbour like any other -- it is exactly what makes a lone wall keep
        // its post.  So a miss returns null rather than being skipped.
        const offsetAt = (index, dx, dy, dz) => {
          const cell = cells[index]
          const slot = atCell.get(neatKey([cell.at[0] + dx, cell.at[1] + dy, cell.at[2] + dz]))
          if (slot === undefined || slot.entry === null || slot.load === undefined) return null
          return describeEntry(slot.load, slot.entry, slot.id, slot.variant)
        }
        const unionOf = (slot) => {
          if (slot.union === undefined) {
            const built = quadsOfEntry(slot.load, slot.entry, note)
            slot.union = built === undefined ? [] : built
            if (slot.union.length === 0) note('no model for cell block ' + slot.id)
          }
          return slot.union
        }
        for (let index = 0; index < cells.length; index++) {
          const cell = cells[index]
          const slot = slots[index]
          let cellQuads = []
          if (slot.load !== undefined && slot.entry !== null) {
            let keep
            if (neighbourAware && slot.entry.multipart === true) {
              const whens = Array.isArray(slot.entry.whenList) ? slot.entry.whenList : []
              const family = entryFamily(slot.entry, slot.id)
              // `other` means we could not say WHICH rule applies.  Deriving
              // "no side connects" from a rule we do not have would delete the
              // arms of a block we simply failed to recognise -- a hole, and
              // the worst of the available answers.  So an unknown family keeps
              // the extraction's own union.
              if (whens.length > 0 && family !== 'other') {
                const self = { id: slot.id, family: family, whens: whens,
                  wooden: fenceWooden(slot.id) }
                const values = multipartValues(slot.entry.version, self,
                  (dx, dy, dz) => offsetAt(index, dx, dy, dz))
                keep = keepFlags(slot.entry, values)
              }
            }
            const built = keep === undefined
              ? unionOf(slot) : quadsOfEntry(slot.load, slot.entry, note, keep)
            cellQuads = built === undefined ? [] : built
          }
          // Tag every quad with the cell and face it came from: that pair is
          // what turns a click on the 2D image back into a grid coordinate.
          const tagged = translateQuads(cellQuads, cell.at).map((quad) => ({
            p: quad.p, uv: quad.uv, tex: quad.tex, shade: quad.shade, mode: quad.mode,
            shaded: quad.shaded, pick: { cell: index, face: quad.face || '' },
          }))
          quads = quads.concat(tagged)
        }
        palette = Array.from(counts.keys()).map((key) => {
          const at = key.indexOf(':')
          const cellNamespace = at >= 0 ? key.slice(0, at) : namespace
          const cellBlock = at >= 0 ? key.slice(at + 1) : key
          // A vanilla block's name comes from the extraction (the game's own lang
          // file), not from the project pack -- which has never heard of it.
          const fromReference = refNameOf(cellNamespace, cellBlock)
          return { block: key, label: fromReference || labelFor(cellNamespace, 'block', cellBlock), count: counts.get(key) }
        })
        palette.sort((a, b) => b.count - a.count)
        refs = [rel(root, dir + '/mc-art.atlas.json')].concat((item.refs || []).map((r) => rel(root, dir + '/' + r)))
      }

      const textureIds = []
      const seenTex = {}
      for (const quad of quads) if (seenTex[quad.tex] !== true) { seenTex[quad.tex] = true; textureIds.push(quad.tex) }
      const already = {}
      if (Array.isArray(have)) for (const path of have) already[path] = true
      const textures = {}
      for (const path of textureIds) {
        if (already[path] === true) continue
        const url = await textureUrlFor(path, project)
        if (url !== undefined) textures[path] = url
      }
      return { kind: kind, id: id, title: labelFor(namespace, kind, id),
        project: project.title || project.id,
        quads: quads, textureIds: textureIds, textures: textures,
        animations: animationsFor(textureIds), animationNotes: animationNotesFor(textureIds),
        cells: cells, faceStep: FACE_STEP,
        // 只有 kind==='block' 有值；结构 / 实体是 null / []（形状恒定，客户端好处理）。
        model: blockModel, models: blockModels,
        refs: refs, ref: refs[0], palette: palette, box: boxOfQuads(quads), errors: errors.slice(0, 8) }
    }

